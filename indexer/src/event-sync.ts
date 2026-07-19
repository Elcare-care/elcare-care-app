import { rpc } from '@stellar/stellar-sdk';
import { parseMarketplaceEvent, SchemaDecodeError, type DecodedEvent } from './parser.js';
import { decodeErrorsCounter, eventDecodeErrorsCounter } from './metrics.js';
import { withRetry } from './retry.js';

export const MAX_LEDGER_WINDOW = 17_000;
export const EVENT_PAGE_LIMIT = 100;

type RpcEvent = {
  topic: unknown[];
  value: unknown;
  ledger: number;
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

function decodeRpcEvent(event: RpcEvent): DecodedEvent | null {
  const topicStrings = event.topic.map((topic) => toBase64(topic));
  return parseMarketplaceEvent(topicStrings, toBase64(event.value), event.ledger);
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
      const response: any = await withRetry(
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
          const decoded = decodeRpcEvent(event);
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

  return decodedEvents;
}