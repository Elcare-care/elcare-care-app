// ─────────────────────────────────────────────────────────────────────────────
// __tests__/TxStatusPage.test.tsx
//
// Issue #301: Unit tests for the transaction status and recovery page.
// Covers success, failure, pending, unknown hash, and stale-indexer cases.
// ─────────────────────────────────────────────────────────────────────────────

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock("next/link", () => {
  const Link = ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  );
  Link.displayName = "Link";
  return Link;
});

jest.mock("@/lib/config", () => ({
  config: { indexerUrl: "http://localhost:4000", network: "testnet" },
}));

// ── Helper ────────────────────────────────────────────────────────────────────

const VALID_HASH = "a".repeat(64);

function buildResponse(overrides = {}) {
  return {
    hash: VALID_HASH,
    chain_status: "success",
    indexer_status: "confirmed",
    stale_indexer: false,
    explorer_url: `https://stellar.expert/explorer/testnet/tx/${VALID_HASH}`,
    events: [],
    related_resources: {},
    network: "testnet",
    ...overrides,
  };
}

function mockFetch(body: unknown, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

// Lazy-import so mocks take effect
async function renderPage(hash = VALID_HASH) {
  const { default: TxStatusPage } = await import(
    "../app/tx/[hash]/page"
  );
  return render(<TxStatusPage params={{ hash }} />);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TxStatusPage — success state", () => {
  beforeEach(() => {
    mockFetch(buildResponse());
  });

  it("renders loading state initially", async () => {
    const { unmount } = await renderPage();
    // The loading spinner text should appear briefly
    expect(screen.queryByText(/looking up transaction/i)).not.toBeNull();
    unmount();
  });

  it("shows chain status confirmed and indexer confirmed", async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText(/chain status/i)).toBeInTheDocument();
      expect(screen.getAllByText(/success|confirmed/).length).toBeGreaterThan(0);
    });
  });

  it("renders the explorer link with testnet URL", async () => {
    await renderPage();
    await waitFor(() => {
      const link = screen.getByRole("link", { name: /view on stellar expert/i });
      expect(link.getAttribute("href")).toContain("testnet");
      expect(link.getAttribute("href")).toContain(VALID_HASH);
    });
  });

  it("does NOT show the stale-indexer warning", async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.queryByText(/indexer is still catching up/i)).toBeNull();
    });
  });
});

describe("TxStatusPage — failed transaction", () => {
  beforeEach(() => {
    mockFetch(buildResponse({ chain_status: "failed", indexer_status: "not_found" }));
  });

  it("shows failed chain status badge", async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getAllByText(/failed/).length).toBeGreaterThan(0);
    });
  });

  it("shows the safe-to-retry failed-transaction warning", async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText(/transaction failed on-chain/i)).toBeInTheDocument();
      expect(screen.getByText(/safe to retry/i)).toBeInTheDocument();
    });
  });
});

describe("TxStatusPage — stale indexer", () => {
  beforeEach(() => {
    mockFetch(
      buildResponse({
        chain_status: "success",
        indexer_status: "pending",
        stale_indexer: true,
      })
    );
  });

  it("shows the stale-indexer warning", async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText(/indexer is still catching up/i)).toBeInTheDocument();
    });
  });

  it("does NOT say it is safe to retry (to avoid double-payment)", async () => {
    await renderPage();
    await waitFor(() => {
      // The dangerous retry message must NOT appear for stale indexer
      expect(screen.queryByText(/transaction failed on-chain/i)).toBeNull();
    });
  });
});

describe("TxStatusPage — unknown hash", () => {
  beforeEach(() => {
    mockFetch(
      buildResponse({ chain_status: "unknown", indexer_status: "not_found" })
    );
  });

  it("shows unknown status warning without encouraging a retry", async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText(/status unknown/i)).toBeInTheDocument();
      // Warn against double-payment
      expect(screen.getByText(/do not re-submit/i)).toBeInTheDocument();
    });
  });
});

describe("TxStatusPage — invalid hash format", () => {
  it("shows an error for a short hash without fetching", async () => {
    await renderPage("short-hash");
    await waitFor(() => {
      expect(screen.getByText(/invalid transaction hash/i)).toBeInTheDocument();
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("TxStatusPage — API error", () => {
  beforeEach(() => {
    mockFetch({ error: { message: "Not found" } }, 404);
  });

  it("shows not found error message", async () => {
    await renderPage();
    await waitFor(() => {
      expect(
        screen.getByText(/transaction not found on this network/i)
      ).toBeInTheDocument();
    });
  });
});

describe("TxStatusPage — related resources", () => {
  it("renders listing link when listing_id is present", async () => {
    mockFetch(
      buildResponse({
        related_resources: { listing_id: "42" },
        events: [
          {
            id: 1,
            eventType: "ARTWORK_SOLD",
            listingId: "42",
            actor: "GTEST",
            ledgerSequence: 100,
          },
        ],
      })
    );

    await renderPage();
    await waitFor(() => {
      expect(screen.getByText(/view listing #42/i)).toBeInTheDocument();
    });
  });
});

describe("TxStatusPage — refresh button", () => {
  it("calls fetch again when refresh button is clicked", async () => {
    mockFetch(buildResponse());
    await renderPage();

    await waitFor(() => screen.getByText(/refresh status/i));

    const fetchCallsBefore = (global.fetch as jest.Mock).mock.calls.length;

    await act(async () => {
      await userEvent.click(screen.getByText(/refresh status/i));
    });

    expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThan(
      fetchCallsBefore
    );
  });
});
