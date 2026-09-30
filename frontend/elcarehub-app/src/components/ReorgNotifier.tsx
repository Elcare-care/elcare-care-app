"use client";

/**
 * ReorgNotifier — subscribes to the indexer SSE stream and shows a toast
 * whenever a REORG or CRITICAL_REORG event is received.
 *
 * On a REORG event a dismissible info toast is shown and the page data is
 * reloaded after 3 seconds so the user sees the corrected chain state.
 *
 * On a CRITICAL_REORG event a persistent error toast is shown informing the
 * user that the indexer is temporarily halted and an operator must intervene.
 *
 * This component renders nothing visible itself — it is mounted once in
 * RootLayout (inside ToastProvider) and manages the SSE lifecycle.
 */

import { useEffect, useRef } from "react";
import { useToast } from "@/components/ToastProvider";
import { config } from "@/lib/config";

/** Shape of the REORG SSE event emitted by the indexer. */
interface ReorgSSEEvent {
  type: "REORG" | "CRITICAL_REORG";
  from_ledger: number;
  to_ledger: number;
  timestamp: string;
  depth: number;
  message?: string;
}

/** How long to wait before triggering the page reload on a shallow re-org. */
const RELOAD_DELAY_MS = 3_000;

export function ReorgNotifier() {
  const { pushToast } = useToast();
  // Keep a stable ref to pushToast so the effect doesn't re-run on re-renders.
  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;

  useEffect(() => {
    // Guard: EventSource is not available in SSR/test environments.
    if (typeof EventSource === "undefined") return;

    const indexerUrl = config.indexerUrl;
    if (!indexerUrl) return;

    const streamUrl = `${indexerUrl}/events/stream`;
    let es: EventSource | null = null;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    function handleReorgEvent(raw: string) {
      let event: ReorgSSEEvent;
      try {
        event = JSON.parse(raw) as ReorgSSEEvent;
      } catch {
        return;
      }

      if (event.type === "REORG") {
        pushToastRef.current(
          "Blockchain reorganization detected — data is refreshing.",
          "info",
          // Keep toast visible until the reload clears it.
          RELOAD_DELAY_MS + 1_000
        );
        // Reload the page after 3 seconds so server components re-fetch data.
        reloadTimer = setTimeout(() => {
          if (!closed) {
            window.location.reload();
          }
        }, RELOAD_DELAY_MS);
      } else if (event.type === "CRITICAL_REORG") {
        const detail =
          event.message ??
          `Re-org depth ${event.depth} detected. Indexer is halted — operator intervention required.`;
        pushToastRef.current(
          `Critical reorganization detected — ${detail}`,
          "error",
          // Persistent: keep for 30 seconds (user must dismiss manually).
          30_000
        );
      }
    }

    function connect() {
      if (closed) return;

      try {
        es = new EventSource(streamUrl);
      } catch {
        // Failed to construct EventSource (e.g. invalid URL) — silently bail.
        return;
      }

      // Handle generic message events (server sends data: {...} without a named type).
      es.onmessage = (evt: MessageEvent) => {
        handleReorgEvent(evt.data as string);
      };

      // Handle named REORG events (server may also send: event: REORG\ndata: {...}).
      es.addEventListener("REORG", (evt: Event) => {
        handleReorgEvent((evt as MessageEvent).data as string);
      });

      // Handle named CRITICAL_REORG events.
      es.addEventListener("CRITICAL_REORG", (evt: Event) => {
        handleReorgEvent((evt as MessageEvent).data as string);
      });

      // Also listen on the onmessage path for bundled payloads.
      es.onerror = () => {
        // EventSource will attempt automatic reconnection; we don't need to
        // do anything here unless we want to log it.
      };
    }

    connect();

    return () => {
      closed = true;
      if (reloadTimer !== null) clearTimeout(reloadTimer);
      es?.close();
      es = null;
    };
  }, []);

  // This component renders nothing — it only manages the SSE subscription.
  return null;
}
