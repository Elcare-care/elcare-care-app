#!/usr/bin/env bash
# compare-cache-vs-db.sh — READ-ONLY stale-cache diagnostic (Issue #1060)
#
# Compares the Redis-cached response for one listing or auction against the
# PostgreSQL row. Only the identifier, status, updatedAtLedger, and updatedAt
# are compared.
#
# READ-ONLY GUARANTEES
#   Redis:      only GET, TTL, and EXISTS are issued.
#   PostgreSQL: the session runs with default_transaction_read_only=on, and
#               only a SELECT is issued.
#   HTTP:       none. The script reads Redis directly, so it does not prime
#               or refresh the cache.
#   Output:     ids, status, ledger numbers, and timestamps only. No wallet
#               addresses, metadata, or connection strings are printed.
#
# Usage:
#   REDIS_URL=redis://localhost:6379 \
#   DATABASE_URL=postgresql://... \
#   scripts/diagnostics/compare-cache-vs-db.sh listing 42
#
#   scripts/diagnostics/compare-cache-vs-db.sh auction 7
#
# Exit codes: 0 = match or no cache entry, 1 = mismatch (stale), 2 = usage/tool error

set -euo pipefail

usage() { echo "usage: $0 <listing|auction> <numeric id>" >&2; exit 2; }

KIND="${1:-}"; ID="${2:-}"
[[ "$ID" =~ ^[0-9]+$ ]] || usage
case "$KIND" in
  listing) PATH_SEG="listings"; TABLE='"Listing"'; ID_COL='"listingId"' ;;
  auction) PATH_SEG="auctions"; TABLE='"Auction"'; ID_COL='"auctionId"' ;;
  *) usage ;;
esac

for bin in redis-cli psql jq; do
  command -v "$bin" >/dev/null || { echo "missing required tool: $bin" >&2; exit 2; }
done
: "${REDIS_URL:?REDIS_URL must be set}"
: "${DATABASE_URL:?DATABASE_URL must be set}"

# Exact key written by cacheMiddleware for a query-string-free detail request,
# and the same key the poller invalidates (indexer/src/poller.ts).
CACHE_KEY="cache:/${PATH_SEG}/${ID}"

# ── Redis (read-only) ─────────────────────────────────────────────────────────
EXISTS=$(redis-cli -u "$REDIS_URL" --no-auth-warning EXISTS "$CACHE_KEY")
if [[ "$EXISTS" != "1" ]]; then
  echo "cache_key=${CACHE_KEY} present=false"
  echo "RESULT: no cache entry. Reads go to PostgreSQL, so they cannot be stale."
  exit 0
fi
TTL=$(redis-cli -u "$REDIS_URL" --no-auth-warning TTL "$CACHE_KEY")
CACHED_JSON=$(redis-cli -u "$REDIS_URL" --no-auth-warning --raw GET "$CACHE_KEY")

ID_FIELD="${ID_COL//\"/}"
CACHE_ROW=$(jq -r --arg f "$ID_FIELD" \
  '[(.[$f]|tostring), .status, (.updatedAtLedger|tostring), .updatedAt] | @tsv' \
  <<<"$CACHED_JSON")

# ── PostgreSQL (read-only session) ────────────────────────────────────────────
DB_ROW=$(PGOPTIONS='-c default_transaction_read_only=on' \
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -F $'\t' -c \
  "SELECT ${ID_COL}::text, status::text, \"updatedAtLedger\"::text,
          to_char(\"updatedAt\", 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
     FROM ${TABLE} WHERE ${ID_COL} = ${ID};")

SYNC_LEDGER=$(PGOPTIONS='-c default_transaction_read_only=on' \
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -c \
  'SELECT "lastLedger" FROM "SyncState" WHERE id = 1;')

printf 'cache_key=%s present=true ttl_seconds=%s sync_last_ledger=%s\n' "$CACHE_KEY" "$TTL" "${SYNC_LEDGER:-unknown}"
printf '%-8s %-12s %-12s %-18s %s\n' source id status updatedAtLedger updatedAt
printf '%-8s %s\n' redis "$(tr '\t' ' ' <<<"$CACHE_ROW")"
printf '%-8s %s\n' postgres "$(tr '\t' ' ' <<<"${DB_ROW:-<row not found>}")"

if [[ "$CACHE_ROW" == "$DB_ROW" ]]; then
  echo "RESULT: MATCH"
  exit 0
fi
echo "RESULT: MISMATCH. The cache is stale for up to ${TTL}s more. See docs/runbooks/stale-cache-diagnostic.md step 4."
exit 1
