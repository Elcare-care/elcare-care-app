import { rpc } from '@stellar/stellar-sdk';
import {
  parseMarketplaceEvent,
  SchemaDecodeError,
  UnsupportedSchemaVersionError,
  type DecodedEvent,
} from './parser.js';
import { decodeErrorsCounter, eventDecodeErrorsCounter, unsupportedSchemaVersionCounter } from './metrics.js';
import { withRpcRetry } from './retry.js';
import { logger } from './logger.js';

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

/**
 * Extracts a stable event index from the Stellar event ID.
 * Stellar event IDs are formatted as "<ledger>-<txIndex>-<eventIndex>" or similar.
 * We use the last numeric segment as the index within the ledger.
 */
function extractEventIndex(event: RpcEvent, fallback: number): number {
  if (typeof event.id === 'string') {
    const parts = event.id.split('-');
    const last = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(last)) return last;
  }
  return fallback;
}

function decodeRpcEvent(event: RpcEvent, eventIndex: number): DecodedEvent | null {
  const topicStrings = event.topic.map((topic) => toBase64(topic));
  const contractId = event.contractId ?? '';
  const txHash = event.txHash ?? '';
  return parseMarketplaceEvent(
    topicStrings,
    toBase64(event.value),
    event.ledger,
    contractId,
    txHash,
    extractEventIndex(event, eventIndex)
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
          // ── Unsupported schema version (Issue #278) ───────────────────────
          // Distinct from a generic decode failure: the payload decoded fine
          // structurally, but its schema_version is ahead of what this
          // indexer build recognizes as safe. Count and log it separately so
          // it's investigable as an indexer/contract version-skew signal
          // rather than being buried in the generic decode-error counters.
          if (err instanceof UnsupportedSchemaVersionError) {
            unsupportedSchemaVersionCounter.inc({
              event_type: err.eventType,
              schema_version: String(err.schemaVersion),
            });
            logger.warn('Unsupported event schema version — skipping event, indexer may be behind the deployed contract', {
              ledger: (event as RpcEvent).ledger,
              eventIndex: idx,
              eventType: err.eventType,
              schemaVersion: err.schemaVersion,
              contractId: (event as RpcEvent).contractId,
              txHash: (event as RpcEvent).txHash,
              rawTopic: (event as RpcEvent).topic,
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
        }
      }

      paginationToken = response.paginationToken ?? null;
    } while (paginationToken);
  }

  return decodedEvents;
}