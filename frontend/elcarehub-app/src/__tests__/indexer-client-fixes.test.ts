/**
 * Indexer client fixes for issues #771, #772, #773 and #774.
 */
import axios from "axios";
import {
  getWalletActivity,
  getAuctionBidHistory,
  recordAuctionBidCount,
  summariseSSEEvent,
  UNKNOWN_BIDDER,
} from "@/lib/indexer";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.get.mockReset();
});

// ── #771 getWalletActivity limit ─────────────────────────────────────────────

describe("getWalletActivity limit", () => {
  function requestedUrl(): string {
    return String(mockedAxios.get.mock.calls[0][0]);
  }

  it("defaults to limit=50", async () => {
    mockedAxios.get.mockResolvedValue({ data: [], status: 200 });
    await getWalletActivity("GUSER01");
    expect(requestedUrl()).toContain("/activity?limit=50");
  });

  it("uses the limit the caller passes", async () => {
    mockedAxios.get.mockResolvedValue({ data: [], status: 200 });
    await getWalletActivity("GUSER01", 10);
    expect(requestedUrl()).toContain("/activity?limit=10");
  });
});

// ── #772 histogram snapshot timeout ──────────────────────────────────────────

describe("recordAuctionBidCount snapshot POST", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends the POST with an abort signal", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    recordAuctionBidCount(3, "http://indexer.test");
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://indexer.test/metrics/histogram");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
  });

  it.each(["TimeoutError", "AbortError"])(
    "drops a %s silently",
    async (name) => {
      const err = new Error("timed out");
      err.name = name;
      global.fetch = jest.fn().mockRejectedValue(err) as unknown as typeof fetch;
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const error = jest.spyOn(console, "error").mockImplementation(() => {});

      expect(() => recordAuctionBidCount(3, "http://indexer.test")).not.toThrow();
      await new Promise((r) => setTimeout(r, 0));

      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      warn.mockRestore();
      error.mockRestore();
    },
  );
});

// ── #773 summariseSSEEvent ───────────────────────────────────────────────────

describe("summariseSSEEvent ROYALTY_SETTLEMENT", () => {
  const artist = "GARTISTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZ7Q";

  it("names the single recipient and the amount", () => {
    const text = summariseSSEEvent({
      type: "ROYALTY_SETTLEMENT",
      data: {
        id: 7,
        recipients: [{ address: artist, percentage: 1000 }],
        total_amount: 25_000_000,
        token: "CTOKEN",
      },
    });
    expect(text).toBe("Royalty of 2.5 XLM paid to GART…AZ7Q");
  });

  it("counts multiple recipients", () => {
    const text = summariseSSEEvent({
      type: "ROYALTY_SETTLEMENT",
      data: {
        recipients: [
          { address: artist, percentage: 500 },
          { address: "GOTHER", percentage: 500 },
        ],
        total_amount: 10_000_000,
      },
    });
    expect(text).toBe("Royalty of 1 XLM paid to 2 recipients");
  });

  it("falls back when data is missing", () => {
    expect(summariseSSEEvent({ type: "ROYALTY_SETTLEMENT" })).toBe(
      "Royalty of ? paid to artist",
    );
  });

  it("does not fall through to the generic default for any known type", () => {
    // LISTING_UPDATED was the other type without a case.
    expect(summariseSSEEvent({ type: "LISTING_UPDATED", listingId: 4 })).toBe(
      "Listing #4 updated",
    );
  });
});

// ── #774 parseBidRecords missing bidder ──────────────────────────────────────

describe("getAuctionBidHistory missing bidder", () => {
  it("maps a missing bidder to UNKNOWN and warns", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockedAxios.get.mockResolvedValue({
      data: [
        { ledger: 10, bidder: "GBIDDER1", amount: 100 },
        { ledger: 11, amount: 200 },
        { ledger: 12, bidder: "", amount: 300 },
      ],
      status: 200,
    });

    const page = await getAuctionBidHistory(1);

    expect(page.bids.map((b) => b.bidder)).toEqual([
      "GBIDDER1",
      UNKNOWN_BIDDER,
      UNKNOWN_BIDDER,
    ]);
    expect(UNKNOWN_BIDDER).toBe("UNKNOWN");
    const bidderWarnings = warn.mock.calls.filter(
      (c) => c[0] === "[parseBidRecords] bid record missing bidder",
    );
    expect(bidderWarnings).toHaveLength(2);
    warn.mockRestore();
  });

  it("does not warn when every bid has a bidder", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockedAxios.get.mockResolvedValue({
      data: [{ ledger: 10, bidder: "GBIDDER1", amount: 100 }],
      status: 200,
    });

    await getAuctionBidHistory(1);

    expect(
      warn.mock.calls.some((c) => c[0] === "[parseBidRecords] bid record missing bidder"),
    ).toBe(false);
    warn.mockRestore();
  });
});
