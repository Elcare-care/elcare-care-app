/**
 * Canonical payment-token registry + base-unit/decimal conversion helpers
 * for the indexer API (Issue #282: payment token decimal & asset validation).
 *
 * Every money value persisted by the indexer (Listing.price,
 * Auction.reservePrice / highestBid, Offer.amount, Bid.amount) is the *raw*
 * on-chain base-unit i128 value emitted by the marketplace contract (see
 * `contracts/soroban-marketplace/src/types.rs`) — the contract never scales
 * these amounts, and the indexer stores them unscaled too. The Postgres
 * `Decimal(32, 7)` column type is only headroom for i128-sized integers; it
 * does NOT mean the stored value has already been divided into human
 * (XLM/token) display units. A raw value of `100000000` is 10 XLM, not
 * "100000000.0000000" XLM.
 *
 * So that API consumers never have to re-derive decimals themselves (and
 * risk the exact "wrong precision" bug this issue is about), every money
 * field returned by `/listings`, `/auctions`, and `/offers` is accompanied
 * by a sibling `<field>Decimal` string computed here from the row's `token`
 * address. Decimals are looked up against this registry — which mirrors the
 * frontend's canonical table (`frontend/elcarehub-app/src/config/tokens.ts`)
 * — falling back to 7 decimal places for any address not present, matching
 * the fixed precision Stellar uses for both the native XLM asset and every
 * Stellar Asset Contract (SAC) wrapping a classic asset.
 */

/** Default decimal precision for Stellar native XLM and any classic-asset SAC. */
export const DEFAULT_TOKEN_DECIMALS = 7;

/**
 * Optional JSON map of `{"<contract address>": <decimals>}` overrides for
 * any future whitelisted token whose precision differs from the Stellar
 * default. Empty by default — every token whitelisted today uses 7
 * decimals. Set via the `TOKEN_DECIMALS_JSON` env var.
 */
function loadDecimalOverrides(): Record<string, number> {
  const raw = process.env.TOKEN_DECIMALS_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, number>;
    }
  } catch {
    // Malformed overrides must never crash the API — fall back to defaults.
  }
  return {};
}

const DECIMAL_OVERRIDES = loadDecimalOverrides();

/** Known decimal precision for a payment-token contract address. */
export function getTokenDecimals(tokenAddress: string | null | undefined): number {
  if (tokenAddress) {
    const override = DECIMAL_OVERRIDES[tokenAddress];
    if (Number.isInteger(override) && override >= 0 && override <= 18) {
      return override;
    }
  }
  return DEFAULT_TOKEN_DECIMALS;
}

/**
 * Convert a raw base-unit amount (as stored — a Prisma `Decimal`, string, or
 * number that is always integer-valued on-chain) to a human-readable
 * decimal string using `decimals` places.
 *
 * Pure string/BigInt arithmetic throughout — the value is never routed
 * through a JS `Number`, so precision survives even for i128-range amounts
 * beyond `Number.MAX_SAFE_INTEGER`.
 */
export function baseUnitsToDecimalString(
  raw: unknown,
  decimals: number = DEFAULT_TOKEN_DECIMALS
): string {
  if (raw === null || raw === undefined) return '0';
  const str = typeof raw === 'string' ? raw : String(raw);
  // Raw on-chain amounts are always integers; strip a fixed-scale
  // "X.0000000"-style suffix the DB column may have produced.
  const integerPart = str.split('.')[0] || '0';
  const negative = integerPart.startsWith('-');
  const digits = negative ? integerPart.slice(1) : integerPart;
  const value = digits === '' ? 0n : BigInt(digits);

  if (decimals <= 0) {
    return negative && value !== 0n ? `-${value}` : `${value}`;
  }

  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = value % scale;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  const sign = negative && value !== 0n ? '-' : '';
  return fracStr ? `${sign}${whole}.${fracStr}` : `${sign}${whole}`;
}

/**
 * Return a shallow copy of `row` with a `<moneyField>Decimal` sibling added
 * for each `[moneyField, tokenField]` pair, computed via
 * `baseUnitsToDecimalString` using the decimals registered for
 * `row[tokenField]`. Skips a pair when the money field is absent.
 */
export function withDecimalAmounts<T extends Record<string, unknown>>(
  row: T,
  fields: ReadonlyArray<readonly [moneyField: string, tokenField: string]>
): T & Record<string, string> {
  const out: Record<string, unknown> = { ...row };
  for (const [moneyField, tokenField] of fields) {
    const value = row[moneyField];
    if (value === undefined || value === null) continue;
    const decimals = getTokenDecimals(row[tokenField] as string | undefined);
    out[`${moneyField}Decimal`] = baseUnitsToDecimalString(value, decimals);
  }
  return out as T & Record<string, string>;
}
