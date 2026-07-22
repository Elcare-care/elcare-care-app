import { rpc } from '@stellar/stellar-sdk';
import { parseMarketplaceEvent, SchemaDecodeError, type DecodedEvent } from './parser.js';
import { decodeErrorsCounter, eventDecodeErrorsCounter } from './metrics.js';
import { withRpcRetry } from './retry.js';

export const MAX_LEDGER_WINDOW = 17_000;
export const EVENT_PAGE_LIMIT = 100;

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

  for (let windowStart = startLedger; windowStart <= endLedger; windowStart += MAX_LEDGER_WINDOW) {
    const windowEnd = Math.min(windowStart + MAX_LEDGER_WINDOW - 1, endLedger);
    let paginationToken: string | null = null;

    do {
      const response: any = await withRpcRetry(
        () => server.getEvents({
          startLedger: windowStart,
          endLedger: windowEnd,
          filters: [{ type: 'contract', contractIds }],
          limit: EVENT_PAGE_LIMIT,
          ...(paginationToken ? { cursor: paginationToken } : {}),
        } as any),
        { operation: 'getEvents', maxAttempts: 5, baseDelayMs: 500 }
      );

      for (const [idx, event] of (response.events ?? []).entries()) {
        try {
          const decoded = decodeRpcEvent(event, idx);
          if (decoded) decodedEvents.push(decoded);
        } catch (err) {
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
        }
      }

      paginationToken = response.paginationToken ?? null;
    } while (paginationToken);
  }

  // Deliver the batch in deterministic application order.
  return sortDecodedEvents(decodedEvents);
}