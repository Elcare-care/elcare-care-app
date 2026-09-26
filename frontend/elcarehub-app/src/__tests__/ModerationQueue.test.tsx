/**
 * Tests for ModerationQueue component — Issue #534
 *
 * All fetch calls are mocked globally so the suite runs without
 * any network access or server-side API routes.
 */

import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ModerationQueue from "@/components/ModerationQueue";
import type { ModerationRecord } from "@/lib/moderation";

// ── Fixtures ──────────────────────────────────────────────────

const PENDING_RECORD: ModerationRecord = {
  cid: "bafybeig000pending",
  kind: "IMAGE",
  state: "PENDING",
  updatedAt: "2026-08-01T10:00:00.000Z",
  reportCount: 0,
  uploaderAddress: "GARTIST1",
};

const REPORTED_RECORD: ModerationRecord = {
  cid: "bafybeig001reported",
  kind: "METADATA",
  state: "REPORTED",
  updatedAt: "2026-08-02T11:00:00.000Z",
  reportCount: 2,
  uploaderAddress: "GARTIST2",
};

const QUARANTINED_RECORD: ModerationRecord = {
  cid: "bafybeig002quarantined",
  kind: "IMAGE",
  state: "QUARANTINED",
  updatedAt: "2026-08-03T12:00:00.000Z",
  reportCount: 3,
  uploaderAddress: "GARTIST3",
};

const APPROVED_RECORD: ModerationRecord = {
  cid: "bafybeig003approved",
  kind: "IMAGE",
  state: "APPROVED",
  updatedAt: "2026-08-04T13:00:00.000Z",
  reportCount: 0,
};

const REJECTED_RECORD: ModerationRecord = {
  cid: "bafybeig004rejected",
  kind: "METADATA",
  state: "REJECTED",
  updatedAt: "2026-08-05T14:00:00.000Z",
  reportCount: 5,
};

const ALL_RECORDS = [
  PENDING_RECORD,
  REPORTED_RECORD,
  QUARANTINED_RECORD,
  APPROVED_RECORD,
  REJECTED_RECORD,
];

// ── Mock helpers ──────────────────────────────────────────────

/** Returns a GET fetch mock that resolves with the given records. */
function makeFetchGet(records: ModerationRecord[]) {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => records,
  });
}

/** Returns a fetch mock that handles GET and PATCH. */
function makeFetch(
  getRecords: ModerationRecord[],
  patchRecord: ModerationRecord = PENDING_RECORD
) {
  return jest.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (!init || init.method === "GET" || !init.method) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => getRecords,
      });
    }
    if (init.method === "PATCH") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => patchRecord,
      });
    }
    return Promise.reject(new Error("Unexpected method"));
  });
}

// ── Tests ─────────────────────────────────────────────────────

describe("ModerationQueue", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── 1. Loading state ────────────────────────────────────────

  it("shows a loading spinner while fetching records", () => {
    // Never resolve the fetch so the loading state persists
    global.fetch = jest.fn().mockReturnValue(new Promise(() => {}));

    render(<ModerationQueue />);

    expect(screen.getByTestId("loading-spinner")).toBeInTheDocument();
  });

  // ── 2. Renders list of records ─────────────────────────────

  it("renders a table row for each record returned by the API", async () => {
    global.fetch = makeFetchGet(ALL_RECORDS);

    render(<ModerationQueue />);

    // Wait for loading to finish
    await waitFor(() =>
      expect(screen.queryByTestId("loading-spinner")).not.toBeInTheDocument()
    );

    // Each CID should appear in the table (truncated or full)
    expect(screen.getByTitle(PENDING_RECORD.cid)).toBeInTheDocument();
    expect(screen.getByTitle(REPORTED_RECORD.cid)).toBeInTheDocument();
    expect(screen.getByTitle(QUARANTINED_RECORD.cid)).toBeInTheDocument();
    expect(screen.getByTitle(APPROVED_RECORD.cid)).toBeInTheDocument();
    expect(screen.getByTitle(REJECTED_RECORD.cid)).toBeInTheDocument();

    // State badges
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Reported")).toBeInTheDocument();
    expect(screen.getByText("Quarantined")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("Rejected")).toBeInTheDocument();
  });

  // ── 3. Filter buttons ───────────────────────────────────────

  it("shows only PENDING records when the PENDING filter is clicked", async () => {
    global.fetch = makeFetchGet(ALL_RECORDS);
    const user = userEvent.setup();

    render(<ModerationQueue />);

    await waitFor(() =>
      expect(screen.queryByTestId("loading-spinner")).not.toBeInTheDocument()
    );

    await user.click(screen.getByRole("button", { name: /^pending$/i }));

    // Only the pending CID should now appear
    expect(screen.getByTitle(PENDING_RECORD.cid)).toBeInTheDocument();
    expect(screen.queryByTitle(REPORTED_RECORD.cid)).not.toBeInTheDocument();
    expect(screen.queryByTitle(QUARANTINED_RECORD.cid)).not.toBeInTheDocument();
    expect(screen.queryByTitle(APPROVED_RECORD.cid)).not.toBeInTheDocument();
    expect(screen.queryByTitle(REJECTED_RECORD.cid)).not.toBeInTheDocument();
  });

  // ── 4. Approve action ───────────────────────────────────────

  it("calls PATCH with APPROVED state when Approve is clicked", async () => {
    const updatedRecord: ModerationRecord = { ...PENDING_RECORD, state: "APPROVED" };
    // After the PATCH, the GET refresh should return the updated list
    const mockFetch = jest
      .fn()
      // First call: initial GET
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [PENDING_RECORD],
      })
      // Second call: PATCH
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => updatedRecord,
      })
      // Third call: GET refresh after action
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [updatedRecord],
      });

    global.fetch = mockFetch;
    const user = userEvent.setup();

    render(<ModerationQueue />);

    await waitFor(() =>
      expect(screen.queryByTestId("loading-spinner")).not.toBeInTheDocument()
    );

    const approveBtn = screen.getByRole("button", {
      name: new RegExp(`Approve CID ${PENDING_RECORD.cid}`, "i"),
    });
    await user.click(approveBtn);

    // Verify the PATCH call
    const patchCall = mockFetch.mock.calls.find(
      ([, init]) => init && (init as RequestInit).method === "PATCH"
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.cid).toBe(PENDING_RECORD.cid);
    expect(body.newState).toBe("APPROVED");
  });

  // ── 5. Reject action ────────────────────────────────────────

  it("calls PATCH with REJECTED state when Reject is clicked", async () => {
    const updatedRecord: ModerationRecord = {
      ...QUARANTINED_RECORD,
      state: "REJECTED",
    };
    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [QUARANTINED_RECORD],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => updatedRecord,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [updatedRecord],
      });

    global.fetch = mockFetch;
    const user = userEvent.setup();

    render(<ModerationQueue />);

    await waitFor(() =>
      expect(screen.queryByTestId("loading-spinner")).not.toBeInTheDocument()
    );

    const rejectBtn = screen.getByRole("button", {
      name: new RegExp(`Reject CID ${QUARANTINED_RECORD.cid}`, "i"),
    });
    await user.click(rejectBtn);

    const patchCall = mockFetch.mock.calls.find(
      ([, init]) => init && (init as RequestInit).method === "PATCH"
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.cid).toBe(QUARANTINED_RECORD.cid);
    expect(body.newState).toBe("REJECTED");
  });

  // ── 6. Empty state ──────────────────────────────────────────

  it("shows an empty state message when no records match the selected filter", async () => {
    // Only return an APPROVED record — filtering by PENDING should show empty state
    global.fetch = makeFetchGet([APPROVED_RECORD]);
    const user = userEvent.setup();

    render(<ModerationQueue />);

    await waitFor(() =>
      expect(screen.queryByTestId("loading-spinner")).not.toBeInTheDocument()
    );

    await user.click(screen.getByRole("button", { name: /^pending$/i }));

    expect(
      screen.getByText(/no records with state "PENDING"/i)
    ).toBeInTheDocument();
  });

  // ── 7. Refresh button ───────────────────────────────────────

  it("re-fetches records when the Refresh button is clicked", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [PENDING_RECORD],
      });

    global.fetch = mockFetch;
    const user = userEvent.setup();

    render(<ModerationQueue />);

    // Wait for the initial load
    await waitFor(() =>
      expect(screen.queryByTestId("loading-spinner")).not.toBeInTheDocument()
    );

    const initialCallCount = mockFetch.mock.calls.length;

    await user.click(screen.getByRole("button", { name: /refresh moderation queue/i }));

    await waitFor(() =>
      expect(mockFetch.mock.calls.length).toBeGreaterThan(initialCallCount)
    );
  });

  // ── 8. Empty state when API returns no records ──────────────

  it("shows empty state when the API returns an empty array", async () => {
    global.fetch = makeFetchGet([]);

    render(<ModerationQueue />);

    await waitFor(() =>
      expect(screen.queryByTestId("loading-spinner")).not.toBeInTheDocument()
    );

    expect(
      screen.getByText(/no moderation records found/i)
    ).toBeInTheDocument();
  });

  // ── 9. State badge color classes ────────────────────────────

  it("renders state badges with correct text for each state", async () => {
    global.fetch = makeFetchGet(ALL_RECORDS);

    render(<ModerationQueue />);

    await waitFor(() =>
      expect(screen.queryByTestId("loading-spinner")).not.toBeInTheDocument()
    );

    // Verify each badge label is present
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Reported")).toBeInTheDocument();
    expect(screen.getByText("Quarantined")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("Rejected")).toBeInTheDocument();
  });

  // ── 10. No action buttons for terminal states ───────────────

  it("does not render action buttons for APPROVED and REJECTED records", async () => {
    global.fetch = makeFetchGet([APPROVED_RECORD, REJECTED_RECORD]);

    render(<ModerationQueue />);

    await waitFor(() =>
      expect(screen.queryByTestId("loading-spinner")).not.toBeInTheDocument()
    );

    // No Approve/Quarantine/Reject buttons should exist
    expect(
      screen.queryByRole("button", {
        name: new RegExp(`Approve CID ${APPROVED_RECORD.cid}`, "i"),
      })
    ).not.toBeInTheDocument();

    expect(
      screen.queryByRole("button", {
        name: new RegExp(`Reject CID ${REJECTED_RECORD.cid}`, "i"),
      })
    ).not.toBeInTheDocument();
  });
});
