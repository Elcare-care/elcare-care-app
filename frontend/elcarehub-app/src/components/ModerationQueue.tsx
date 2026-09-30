// ─────────────────────────────────────────────────────────────
// components/ModerationQueue.tsx
//
// Issue #534 — Admin content moderation queue UI
//
// Displays all moderation records fetched from the
// /api/moderation/queue endpoint.  Admins can filter by state
// and take Approve / Quarantine / Reject actions inline.
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useCallback } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  Shield,
  Loader2,
} from "lucide-react";
import type { ModerationRecord, ModerationState } from "@/lib/moderation";

// ── Filter options ────────────────────────────────────────────

type FilterState = "ALL" | ModerationState;

const FILTERS: FilterState[] = [
  "ALL",
  "PENDING",
  "REPORTED",
  "QUARANTINED",
  "REJECTED",
];

// ── State badge helpers ───────────────────────────────────────

const STATE_BADGE: Record<
  ModerationState,
  { label: string; className: string }
> = {
  PENDING:     { label: "Pending",     className: "bg-blue-100 text-blue-700" },
  APPROVED:    { label: "Approved",    className: "bg-green-100 text-green-700" },
  REPORTED:    { label: "Reported",    className: "bg-orange-100 text-orange-700" },
  QUARANTINED: { label: "Quarantined", className: "bg-yellow-100 text-yellow-800" },
  REJECTED:    { label: "Rejected",    className: "bg-red-100 text-red-700" },
};

// ── Allowed transitions per state ────────────────────────────

type ActionKind = "APPROVE" | "QUARANTINE" | "REJECT";

const ALLOWED_ACTIONS: Record<ModerationState, ActionKind[]> = {
  PENDING:     ["APPROVE", "QUARANTINE"],
  REPORTED:    ["APPROVE", "QUARANTINE"],
  QUARANTINED: ["APPROVE", "REJECT"],
  APPROVED:    [],
  REJECTED:    [],
};

const ACTION_CONFIG: Record<
  ActionKind,
  { label: string; targetState: ModerationState; className: string; icon: React.ReactNode }
> = {
  APPROVE: {
    label: "Approve",
    targetState: "APPROVED",
    className:
      "bg-green-50 text-green-700 hover:bg-green-100 border border-green-200",
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
  },
  QUARANTINE: {
    label: "Quarantine",
    targetState: "QUARANTINED",
    className:
      "bg-yellow-50 text-yellow-800 hover:bg-yellow-100 border border-yellow-200",
    icon: <AlertTriangle className="h-3.5 w-3.5" />,
  },
  REJECT: {
    label: "Reject",
    targetState: "REJECTED",
    className:
      "bg-red-50 text-red-700 hover:bg-red-100 border border-red-200",
    icon: <XCircle className="h-3.5 w-3.5" />,
  },
};

// ── Helpers ───────────────────────────────────────────────────

/** Truncate a CID for display. */
function truncateCid(cid: string): string {
  if (cid.length <= 20) return cid;
  return `${cid.slice(0, 10)}…${cid.slice(-8)}`;
}

/** Format an ISO timestamp to a locale date-time string. */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ── Component ─────────────────────────────────────────────────

export default function ModerationQueue() {
  const [records, setRecords] = useState<ModerationRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterState>("ALL");
  const [actingOn, setActingOn] = useState<string | null>(null);

  // ── Fetch records from API ──────────────────────────────────

  const fetchRecords = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/moderation/queue");
      if (!res.ok) {
        throw new Error(`Failed to load moderation queue (${res.status}).`);
      }
      const data: ModerationRecord[] = await res.json();
      setRecords(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  // ── Apply admin action ──────────────────────────────────────

  const handleAction = async (
    cid: string,
    action: ActionKind
  ) => {
    const { targetState } = ACTION_CONFIG[action];
    setActingOn(cid);
    try {
      const res = await fetch("/api/moderation/queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cid,
          newState: targetState,
          actor: "admin",
          reason: `Admin ${action.toLowerCase()}d via moderation queue`,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(
          (json as { error?: string }).error ??
            `Request failed (${res.status}).`
        );
      }
      // Refresh list after successful action
      await fetchRecords();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setActingOn(null);
    }
  };

  // ── Filtered view ─────────────────────────────────────────

  const visible =
    filter === "ALL"
      ? records
      : records.filter((r) => r.state === filter);

  // ── Render ────────────────────────────────────────────────

  return (
    <div className="rounded-3xl bg-white p-8 shadow-sm border border-brand-100">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-indigo-100 p-2.5">
            <Shield className="h-6 w-6 text-indigo-600" />
          </div>
          <div>
            <h2 className="font-display text-2xl font-bold text-midnight-950">
              Content Moderation Queue
            </h2>
            <p className="mt-0.5 text-sm text-gray-500">
              Review and action uploaded IPFS assets.
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label="Refresh moderation queue"
          onClick={fetchRecords}
          disabled={isLoading}
          className="flex items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-all disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Filter row */}
      <div
        className="mb-6 flex flex-wrap gap-2"
        role="group"
        aria-label="Filter by moderation state"
      >
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={`rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-wide transition-all ${
              filter === f
                ? "bg-midnight-900 text-white shadow"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-xl bg-red-50 p-4 text-sm text-red-600 border border-red-100">
          <XCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-16 text-gray-400">
          <Loader2 className="h-6 w-6 animate-spin mr-3" data-testid="loading-spinner" />
          <span className="text-sm font-medium">Loading records…</span>
        </div>
      )}

      {/* Table */}
      {!isLoading && visible.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-gray-100">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/60">
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-400"
                >
                  CID
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-400"
                >
                  Kind
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-400"
                >
                  State
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-400"
                >
                  Reports
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-400"
                >
                  Updated
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wider text-gray-400"
                >
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {visible.map((record) => {
                const badge = STATE_BADGE[record.state];
                const actions = ALLOWED_ACTIONS[record.state];
                const isBusy = actingOn === record.cid;

                return (
                  <tr
                    key={record.cid}
                    className="hover:bg-gray-50/40 transition-colors"
                  >
                    {/* CID */}
                    <td
                      className="px-4 py-3 font-mono text-xs text-midnight-800"
                      title={record.cid}
                    >
                      {truncateCid(record.cid)}
                    </td>

                    {/* Kind */}
                    <td className="px-4 py-3">
                      <span className="rounded-md bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600 uppercase">
                        {record.kind}
                      </span>
                    </td>

                    {/* State badge */}
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </td>

                    {/* Report count */}
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {record.reportCount}
                    </td>

                    {/* Updated at */}
                    <td className="px-4 py-3 text-xs text-gray-400">
                      {formatDate(record.updatedAt)}
                    </td>

                    {/* Action buttons */}
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {isBusy ? (
                          <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                        ) : (
                          actions.map((action) => {
                            const cfg = ACTION_CONFIG[action];
                            return (
                              <button
                                key={action}
                                type="button"
                                aria-label={`${cfg.label} CID ${record.cid}`}
                                disabled={!!actingOn}
                                onClick={() => handleAction(record.cid, action)}
                                className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-all disabled:opacity-40 ${cfg.className}`}
                              >
                                {cfg.icon}
                                {cfg.label}
                              </button>
                            );
                          })
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && visible.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center text-gray-400">
          <Shield className="mb-3 h-10 w-10 opacity-20" />
          <p className="text-sm font-medium">
            {filter === "ALL"
              ? "No moderation records found."
              : `No records with state "${filter}".`}
          </p>
        </div>
      )}
    </div>
  );
}
