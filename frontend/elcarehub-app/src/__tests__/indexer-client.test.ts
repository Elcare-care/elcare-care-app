/**
 * Indexer client: tests use mocked HTTP (axios) and assert mapping + guards.
 */
import axios from "axios";
import {
  getWalletActivity,
  getRoyaltyStats,
  getListingActivity,
  getCollections,
} from "@/lib/indexer";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("getWalletActivity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.get.mockReset();
  });

  it("maps ARTWORK_SOLD to PURCHASE for the buyer address", async () => {
    mockedAxios.get.mockResolvedValue({
      data: [
        {
          id: 1,
          eventType: "ARTWORK_SOLD",
          actor: "GARTIST1",
          listingId: "42",
          data: { artist: "GARTIST1", buyer: "GUSER01", price: 5000000 },
          ledgerSequence: 1000,
          ledgerTimestamp: "2020-01-01T00:00:00.000Z",
        },
      ],
      status: 200,
    });

    const result = await getWalletActivity("GUSER01");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("PURCHASE");
    expect(result[0].listing_id).toBe(42);
  });

  it("returns an empty list when the indexer is unreachable (graceful)", async () => {
    mockedAxios.get.mockRejectedValue(new Error("Network error"));
    const result = await getWalletActivity("GUSER01");
    expect(result).toEqual([]);
  });
});

describe("getRoyaltyStats", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.get.mockReset();
  });

  it("returns parsed body when the shape is valid", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        totalEarned: "12.5",
        payoutCount: 3,
        lastPayout: 1700000000000,
      },
      status: 200,
    });
    const stats = await getRoyaltyStats("GARTIST1");
    expect(stats.totalEarned).toBe("12.5");
    expect(stats.payoutCount).toBe(3);
  });

  it("falls back to zero stats on invalid payload", async () => {
    mockedAxios.get.mockResolvedValue({ data: { oops: true }, status: 200 });
    const stats = await getRoyaltyStats("GARTIST1");
    expect(stats.payoutCount).toBe(0);
    expect(stats.totalEarned).toBe("0");
  });
});

describe("getListingActivity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.get.mockReset();
  });

  it("returns mapped listing history events", async () => {
    mockedAxios.get.mockResolvedValue({
      data: [
        {
          id: 1,
          eventType: "LISTING_CREATED",
          actor: "GART",
          listingId: "5",
          data: { artist: "GART", price: 1000 },
          ledgerSequence: 10,
          ledgerTimestamp: "2020-01-01T00:00:00.000Z",
        },
      ],
      status: 200,
    });
    const ev = await getListingActivity(5);
    expect(ev[0].listing_id).toBe(5);
    expect(ev[0].type).toBe("LISTED");
  });
});

describe("getCollections", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.get.mockReset();
  });

  it("returns typed collection rows and total", async () => {
    mockedAxios.get.mockResolvedValue({
      data: [
        {
          id: 1,
          contractAddress: "CCONTRACT",
          kind: "normal_721",
          creator: "GART",
          name: "A",
          symbol: "A",
          deployedAtLedger: 1,
        },
        { not: "a collection row" },
      ],
      status: 200,
    });
    const { collections, total } = await getCollections();
    expect(total).toBe(1);
    expect(collections[0].kind).toBe("normal_721");
  });
});
