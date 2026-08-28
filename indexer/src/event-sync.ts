import { rpc } from '@stellar/stellar-sdk';
import { parseMarketplaceEvent, SchemaDecodeError, UnsupportedSchemaVersionError, type DecodedEvent } from './parser.js';
import {
  decodeErrorsCounter,
  eventDecodeErrorsCounter,
  deadLetterCreatedTotal,
  unsupportedSchemaVersionCounter,
  rpcPagesFetchedTotal,
  rpcRateLimitedTotal,
  rpcAdaptivePageSizeGauge,
} from './metrics.js';
import { withRpcRetry } from './retry.js';
import { logger } from './logger.js';
import prismaWrite from './prisma-write.js';

export const MAX_LEDGER_WINDOW = 17_000;
export const EVENT_PAGE_LIMIT = 100;
const MIN_PAGE_SIZE = 10;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5_000;
const PAGE_SIZE_RECOVERY_THRESHOLD = 3;

type RpcEvent = {
  topic: unknown[];
  value: unknown;
  ledger: number;
  contractId?: string;
  txHash?: string;
  id?: string; // Stellar event ID encodes position info
};

function toBase64(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    value &&
    typeof value === 'object' &&
    'toXDR' in value &&
    typeof (value as { toXDR: (format: string) => string }).toXDR === 'function'
  ) {
    return (value as { toXDR: (format: string) => string }).toXDR('base64');
  }
  return String(value);
}

export interface EventOrdering {
  txIndex: number;
  eventIndex: number;
}

/**
 * Extracts the intra-ledger ordering key from the Stellar event ID.
 *
 * Stellar event IDs are formatted as "<toid>-<eventIndex>", where the TOID
 * packs (ledgerSequence << 32 | txApplicationOrder << 12 | operationIndex).
 * txApplicationOrder gives the transaction's position within the ledger; the
 * suffix gives the event's position within the transaction.
 *
 * Falls back to (0, array position) when the id is absent or unparseable —
 * the RPC returns events in application order, so array position preserves
 * the correct relative order within a page.
 */
export function extractEventOrdering(event: RpcEvent, fallback: number): EventOrdering {
  if (typeof event.id === 'string') {
    const parts = event.id.split('-');
    if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
      const suffix = parseInt(parts[parts.length - 1], 10);
      try {
        const toid = BigInt(parts[0]);
        const txIndex = Number((toid >> 12n) & 0xfffffn);
        return { txIndex, eventIndex: isNaN(suffix) ? fallback : suffix };
      } catch {
        // fall through to fallback
      }
    }
  }
  return { txIndex: 0, eventIndex: fallback };
}

function decodeRpcEvent(event: RpcEvent, arrayIndex: number): DecodedEvent | null {
  const topicStrings = event.topic.map((topic) => toBase64(topic));
  const contractId = event.contractId ?? '';
  const txHash = event.txHash ?? '';
  const { txIndex, eventIndex } = extractEventOrdering(event, arrayIndex);
  return parseMarketplaceEvent(
    topicStrings,
    toBase64(event.value),
    event.ledger,
    contractId,
    txHash,
    eventIndex,
    typeof event.id === 'string' ? event.id : '',
    txIndex
  );
}

/**
 * Total order for applying a batch: (ledgerSequence, txIndex, eventIndex).
 * Returns a new array; the input is not mutated.
 */
export function sortDecodedEvents<T extends {
  ledgerSequence: number;
  txIndex?: number;
  eventIndex?: number;
}>(events: T[]): T[] {
  return [...events].sort(
    (a, b) =>
      a.ledgerSequence - b.ledgerSequence ||
      (a.txIndex ?? 0) - (b.txIndex ?? 0) ||
      (a.eventIndex ?? 0) - (b.eventIndex ?? 0)
  );
}

const MAX_TOPIC_CHARS  = 512;
const MAX_VALUE_CHARS  = 2000;
const MAX_ERROR_CHARS  = 1000;

/**
 * Extracts just the eventIndex from the Stellar event ID.
 * Convenience wrapper around extractEventOrdering for dead-letter persistence.
 */
function extractEventIndex(event: RpcEvent, fallback: number): number {
  return extractEventOrdering(event, fallback).eventIndex;
}

/**
 * Thrown when the RPC returns the same pagination cursor twice in a row,
 * indicating an infinite loop would occur without intervention.
 * The affected ledger range is halted; replay must be triggered manually.
 */
export class RepeatedCursorError extends Error {
  constructor(
    public readonly cursor: string,
    public readonly windowStart: number,
    public readonly windowEnd: number,
  ) {
    super(
      `[RepeatedCursorError] Pagination cursor "${cursor}" repeated in window ` +
      `[${windowStart}, ${windowEnd}] — halting range to prevent infinite loop`
    );
    this.name = 'RepeatedCursorError';
  }
}

async function persistDeadLetter(event: RpcEvent, fallbackIdx: number, err: unknown, errorCodeOverride?: string): Promise<void> {
  const errorCode = errorCodeOverride
    ?? (err instanceof SchemaDecodeError ? 'SCHEMA_DECODE'
      : err instanceof UnsupportedSchemaVersionError ? 'UNSUPPORTED_SCHEMA_VERSION'
      : 'UNKNOWN');
  const rawMsg    = err instanceof Error ? err.message : String(err);
  // Redact stack-frame paths before storing
  const errorMessage = rawMsg.replace(/\s+at\s+\S+:\d+:\d+/g, '').slice(0, MAX_ERROR_CHARS);

  const rawTopics  = (event.topic ?? []).map((t) => String(toBase64(t)).slice(0, MAX_TOPIC_CHARS));
  const rawValue   = String(toBase64(event.value ?? '')).slice(0, MAX_VALUE_CHARS);
  const eventIndex = extractEventIndex(event, fallbackIdx);

  await (prismaWrite as any).deadLetterEvent.upsert({
    where: {
      contractId_ledgerSequence_txHash_eventIndex: {
        contractId:     event.contractId ?? '',
        ledgerSequence: event.ledger,
        txHash:         event.txHash    ?? '',
        eventIndex,
      },
    },
    create: {
      network:        process.env.STELLAR_NETWORK  ?? '',
      contractId:     event.contractId ?? '',
      ledgerSequence: event.ledger,
      txHash:         event.txHash    ?? '',
      eventIndex,
      rawTopics,
      rawValue,
      errorCode,
      errorMessage,
      parserVersion:  process.env.npm_package_version ?? '',
    },
    update: { attempts: { increment: 1 }, errorMessage },
  });

  deadLetterCreatedTotal.inc({ error_code: errorCode });
}

export async function collectMarketplaceEvents(
  server: rpc.Server,
  contractIds: string[],
  startLedger: number,
  endLedger: number
): Promise<DecodedEvent[]> {
  if (contractIds.length === 0 || startLedger > endLedger) {
    return [];
  }

  const decodedEvents: DecodedEvent[] = [];

  // Adaptive page size: starts at EVENT_PAGE_LIMIT, shrinks on rate-limit
  // responses, and recovers toward the maximum after consecutive successes.
  let currentPageSize = EVENT_PAGE_LIMIT;
  let consecutivePageSuccesses = 0;
  rpcAdaptivePageSizeGauge.set(currentPageSize);

  for (let windowStart = startLedger; windowStart <= endLedger; windowStart += MAX_LEDGER_WINDOW) {
    const windowEnd = Math.min(windowStart + MAX_LEDGER_WINDOW - 1, endLedger);
    let paginationToken: string | null = null;
    // Track cursors seen in this window to detect infinite-loop repetition.
    const seenCursors = new Set<string>();

    do {
      let response: any;

      try {
        response = await withRpcRetry(
          () => server.getEvents({
            startLedger: windowStart,
            endLedger: windowEnd,
            filters: [{ type: 'contract', contractIds }],
            limit: currentPageSize,
            ...(paginationToken ? { cursor: paginationToken } : {}),
          } as any),
          { operation: 'getEvents', maxAttempts: 5, baseDelayMs: 500 }
        );
      } catch (fetchErr: unknown) {
        // Detect rate-limit responses and reduce page size before re-throwing
        // so the caller's backoff loop sees the updated size on the next attempt.
        const status = (fetchErr as any)?.response?.status ?? (fetchErr as any)?.status ?? (fetchErr as any)?.statusCode;
        if (status === 429) {
          rpcRateLimitedTotal.inc();
          consecutivePageSuccesses = 0;
          currentPageSize = Math.max(Math.floor(currentPageSize / 2), MIN_PAGE_SIZE);
          rpcAdaptivePageSizeGauge.set(currentPageSize);

          // Honour a Retry-After hint when present; otherwise use the default.
          const retryAfterSec = Number((fetchErr as any)?.response?.headers?.['retry-after'] ?? 0);
          const backoffMs = retryAfterSec > 0 ? retryAfterSec * 1000 : DEFAULT_RATE_LIMIT_BACKOFF_MS;
          logger.warn('[EventSync] Rate-limited by RPC provider — backing off', {
            backoffMs, newPageSize: currentPageSize, windowStart, windowEnd,
          });
          await new Promise((r) => setTimeout(r, backoffMs));
        }
        throw fetchErr;
      }

      rpcPagesFetchedTotal.inc();
      consecutivePageSuccesses++;

      // Recover page size toward the maximum after sustained successes.
      if (consecutivePageSuccesses >= PAGE_SIZE_RECOVERY_THRESHOLD && currentPageSize < EVENT_PAGE_LIMIT) {
        currentPageSize = Math.min(currentPageSize * 2, EVENT_PAGE_LIMIT);
        rpcAdaptivePageSizeGauge.set(currentPageSize);
        consecutivePageSuccesses = 0;
      }

      for (const [idx, event] of (response.events ?? []).entries()) {
        try {
          const decoded = decodeRpcEvent(event, idx);
          if (decoded) decodedEvents.push(decoded);
        } catch (err) {
          // ── Unsupported schema version (Issue #278 / #488) ────────────────
          // Quarantine the event in dead-letter with UNSUPPORTED_SCHEMA_VERSION
          // so operators can replay it after deploying a decoder update — do NOT
          // just skip it or lump it into the generic decode-error counters.
          if (err instanceof UnsupportedSchemaVersionError) {
            unsupportedSchemaVersionCounter.inc({
              event_type: err.eventType,
              schema_version: String(err.schemaVersion),
            });
            logger.warn('[EventSync] Unsupported schema version — quarantining event for replay after decoder update', {
              ledger: (event as RpcEvent).ledger,
              eventIndex: idx,
              eventType: err.eventType,
              schemaVersion: err.schemaVersion,
              contractId: (event as RpcEvent).contractId,
              txHash: (event as RpcEvent).txHash,
            });
            // Persist with explicit error code so replay tooling can filter by version errors.
            persistDeadLetter(event as RpcEvent, idx, err, 'UNSUPPORTED_SCHEMA_VERSION').catch((dlErr) => {
              logger.error('[EventSync] Failed to persist unsupported-version dead-letter record:', { dlErr });
            });
            continue;
          }

          // Always increment the legacy unlabeled counter for backward compat.
          decodeErrorsCounter.inc();

          // Increment the per-event-type labeled counter when the schema decoder
          // identifies the event type before failing; fall back to 'unknown'.
          const eventType =
            err instanceof SchemaDecodeError ? err.eventType : 'unknown';
          eventDecodeErrorsCounter.inc({ event_type: eventType });

          // Log at warn level with the raw event for post-mortem; never crash the batch.
          console.warn({
            msg: '[EventSync] Failed to decode event — skipping',
            ledger: (event as RpcEvent).ledger,
            eventIndex: idx,
            eventType,
            error: err instanceof Error ? err.message : String(err),
            rawTopic: (event as RpcEvent).topic,
          });

          // Persist durable diagnostic record (fire-and-forget — must not block the batch).
          persistDeadLetter(event as RpcEvent, idx, err).catch((dlErr) => {
            console.error('[EventSync] Failed to persist dead-letter record:', dlErr);
          });
        }
      }

      const nextToken: string | null = response.paginationToken ?? null;

      // Repeated-cursor guard (Issue #487): a cursor appearing twice means the
      // provider is looping. Halt this window range with an actionable error
      // rather than spinning forever.
      if (nextToken !== null) {
        if (seenCursors.has(nextToken)) {
          throw new RepeatedCursorError(nextToken, windowStart, windowEnd);
        }
        seenCursors.add(nextToken);
      }

      paginationToken = nextToken;
    } while (paginationToken);
  }

  // Deliver the batch in deterministic application order.
  return sortDecodedEvents(decodedEvents);
}