/**
 * Tests for useFilterUrlSync hook — URL <-> filter state sync.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { useFilterUrlSync, FilterUrlSync } from "@/hooks/useFilterUrlSync";
import type { Filters } from "@/components/FilterSidebar";

// ── Mocks ──────────────────────────────────────────────────

const mockReplace = jest.fn();

let mockSearchParams = new URLSearchParams();
let mockPathname = "/explore";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
  usePathname: () => mockPathname,
}));

beforeEach(() => {
  mockReplace.mockClear();
  mockSearchParams = new URLSearchParams();
  mockPathname = "/explore";
});

// ── Helper component to exercise the hook ─────────────────

function TestConsumer({
  onHook,
}: {
  onHook: (api: FilterUrlSync) => void;
}) {
  const api = useFilterUrlSync();
  // Give the parent a chance to inspect / call the hook
  React.useEffect(() => {
    onHook(api);
  }, [api, onHook]);
  return <div data-testid="consumer">ok</div>;
}

function renderConsumer() {
  let api!: FilterUrlSync;
  const onHook = jest.fn((a: FilterUrlSync) => {
    api = a;
  });
  render(<TestConsumer onHook={onHook} />);
  return { api: () => api, onHook };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The full set of URL query keys the hook ever intentionally writes. */
const ALLOWED_URL_KEYS = new Set([
  "q", "status", "collection", "minPrice", "maxPrice", "artist", "sort", "page",
]);

/** The URL string passed to router.replace on the most recent call. */
function lastReplaceUrl(): string {
  const calls = mockReplace.mock.calls;
  return (calls[calls.length - 1]?.[0] as string) ?? "";
}

/** Asserts every query key the hook wrote is one it intends to manage. */
function expectOnlyIntendedKeys(): void {
  const qs = lastReplaceUrl().split("?")[1] ?? "";
  const keys = qs ? [...new URLSearchParams(qs).keys()] : [];
  expect(keys.every((k) => ALLOWED_URL_KEYS.has(k))).toBe(true);
}

// ── Tests ──────────────────────────────────────────────────

describe("useFilterUrlSync", () => {
  // ── Reading initial state from URL ─────────────────────

  it("reads default filter values when URL has no params", () => {
    const { api } = renderConsumer();
    const { initialFilters } = api();
    expect(initialFilters).toEqual<Filters>({
      search: "",
      status: "All",
      collection: [],
      minPrice: "",
      maxPrice: "",
      artist: "",
      sort: "newest",
    });
  });

  it("reads initial page 1 when no page param", () => {
    const { api } = renderConsumer();
    expect(api().initialPage).toBe(1);
  });

  it("parses search from ?q= param", () => {
    mockSearchParams = new URLSearchParams("q=landscape");
    const { api } = renderConsumer();
    expect(api().initialFilters.search).toBe("landscape");
  });

  it("parses status from ?status= param", () => {
    mockSearchParams = new URLSearchParams("status=Active");
    const { api } = renderConsumer();
    expect(api().initialFilters.status).toBe("Active");
  });

  it("restores an auction status query and clears only that parameter", () => {
    mockSearchParams = new URLSearchParams("status=Finalized&campaign=spring");
    const { api } = renderConsumer();

    expect(api().initialFilters.status).toBe("Finalized");
    api().syncQueryParam("status", null);

    expect(mockReplace).toHaveBeenCalledWith("/explore?campaign=spring", {
      scroll: false,
    });
  });

  it("parses collection from ?collection= params", () => {
    mockSearchParams = new URLSearchParams("collection=C1&collection=C2");
    const { api } = renderConsumer();
    expect(api().initialFilters.collection).toEqual(["C1", "C2"]);
  });

  it("parses artist from ?artist= param", () => {
    mockSearchParams = new URLSearchParams("artist=ADDR1");
    const { api } = renderConsumer();
    expect(api().initialFilters.artist).toBe("ADDR1");
  });

  it("parses price range from ?minPrice=&maxPrice= params", () => {
    mockSearchParams = new URLSearchParams("minPrice=10&maxPrice=100");
    const { api } = renderConsumer();
    expect(api().initialFilters.minPrice).toBe("10");
    expect(api().initialFilters.maxPrice).toBe("100");
  });

  it("parses sort from ?sort= param", () => {
    mockSearchParams = new URLSearchParams("sort=price-low");
    const { api } = renderConsumer();
    expect(api().initialFilters.sort).toBe("price-low");
  });

  it("parses page from ?page= param", () => {
    mockSearchParams = new URLSearchParams("page=3");
    const { api } = renderConsumer();
    expect(api().initialPage).toBe(3);
  });

  it("reads all combined params", () => {
    mockSearchParams = new URLSearchParams(
      "q=portrait&status=Active&collection=Photography&minPrice=5&maxPrice=50&sort=price-high&artist=A1&page=2",
    );
    const { api } = renderConsumer();
    expect(api().initialFilters).toEqual<Filters>({
      search: "portrait",
      status: "Active",
      collection: ["Photography"],
      minPrice: "5",
      maxPrice: "50",
      artist: "A1",
      sort: "price-high",
    });
    expect(api().initialPage).toBe(2);
  });

  // ── syncToUrl ──────────────────────────────────────────

  it("syncToUrl calls router.replace with correct params", () => {
    const { api } = renderConsumer();
    const filters: Filters = {
      search: "landscape",
      status: "Active",
      collection: [],
      minPrice: "10",
      maxPrice: "",
      artist: "",
      sort: "newest",
    };
    api().syncToUrl(filters, 1);
    expect(mockReplace).toHaveBeenCalledWith(
      "/explore?q=landscape&status=Active&minPrice=10",
      { scroll: false },
    );
  });

  it("syncToUrl omits default values from the URL", () => {
    const { api } = renderConsumer();
    const filters: Filters = {
      search: "",
      status: "All",
      collection: [],
      minPrice: "",
      maxPrice: "",
      artist: "",
      sort: "newest",
    };
    api().syncToUrl(filters, 1);
    expect(mockReplace).toHaveBeenCalledWith("/explore", {
      scroll: false,
    });
  });

  it("syncToUrl includes multiple collections", () => {
    const { api } = renderConsumer();
    const filters: Filters = {
      search: "",
      status: "All",
      collection: ["C1", "C2"],
      minPrice: "",
      maxPrice: "",
      artist: "",
      sort: "newest",
    };
    api().syncToUrl(filters, 1);
    expect(mockReplace).toHaveBeenCalledWith("/explore?collection=C1&collection=C2", {
      scroll: false,
    });
  });

  it("syncToUrl includes sort when non-default", () => {
    const { api } = renderConsumer();
    const filters: Filters = {
      search: "",
      status: "All",
      collection: [],
      minPrice: "",
      maxPrice: "",
      artist: "",
      sort: "price-low",
    };
    api().syncToUrl(filters, 1);
    expect(mockReplace).toHaveBeenCalledWith("/explore?sort=price-low", {
      scroll: false,
    });
  });

  // ── Regression: Returning to results / restoring filter state (Issue #867) ──

  it("restores all URL-backed filter selections when returning to results", () => {
    // Simulate user navigating to a listing and hitting browser back / returning
    // to results page with URL query parameters preserved
    mockSearchParams = new URLSearchParams(
      "q=modern+mask&status=Active&collection=sculptures&minPrice=20&maxPrice=150&artist=GARTIST1&sort=price-low&page=2"
    );
    const { api } = renderConsumer();
    const { initialFilters, initialPage } = api();

    expect(initialFilters).toEqual<Filters>({
      search: "modern mask",
      status: "Active",
      collection: ["sculptures"],
      minPrice: "20",
      maxPrice: "150",
      artist: "GARTIST1",
      sort: "price-low",
    });
    expect(initialPage).toBe(2);
  });

  it("maintains URL query synchronization without unexpected reloading or state drops", () => {
    const { api } = renderConsumer();
    const activeFilters: Filters = {
      search: "african pattern",
      status: "Active",
      collection: ["Origins"],
      minPrice: "10",
      maxPrice: "500",
      artist: "GARTIST2",
      sort: "price-high",
    };

    api().syncToUrl(activeFilters, 3);

    expect(mockReplace).toHaveBeenCalledWith(
      "/explore?q=african+pattern&status=Active&collection=Origins&minPrice=10&maxPrice=500&artist=GARTIST2&sort=price-high&page=3",
      { scroll: false }
    );
  });

  // ── Valid, unknown, and duplicate values — only intended URL keys remain ──

  it("syncToUrl with all valid values leaves only the intended URL keys", () => {
    const { api } = renderConsumer();
    const filters: Filters = {
      search: "bronze",
      status: "Active",
      collection: ["Benin"],
      minPrice: "5",
      maxPrice: "50",
      artist: "GART",
      sort: "price-low",
    };
    api().syncToUrl(filters, 3);
    expect(mockReplace).toHaveBeenCalledWith(
      "/explore?q=bronze&status=Active&collection=Benin&minPrice=5&maxPrice=50&artist=GART&sort=price-low&page=3",
      { scroll: false }
    );
    expectOnlyIntendedKeys();
  });

  it("syncToUrl drops unknown URL params, leaving only the intended keys", () => {
    mockSearchParams = new URLSearchParams("q=test&foo=unknown&bar=baz&page=2");
    const { api } = renderConsumer();

    // Unknown params are not read into Filters…
    expect(api().initialFilters.search).toBe("test");
    // …and are dropped when the filters are pushed back to the URL.
    api().syncToUrl(
      {
        search: "test",
        status: "All",
        collection: [],
        minPrice: "",
        maxPrice: "",
        artist: "",
        sort: "newest",
      },
      2,
    );
    expect(mockReplace).toHaveBeenCalledWith("/explore?q=test&page=2", {
      scroll: false,
    });
    expectOnlyIntendedKeys();
  });

  it("duplicate single-value params collapse to one on read and on sync", () => {
    mockSearchParams = new URLSearchParams(
      "q=a&q=b&page=1&page=2&sort=price-low&sort=price-high",
    );
    const { api } = renderConsumer();

    // Reading takes the first value of each duplicated single-value param.
    expect(api().initialFilters.search).toBe("a");
    expect(api().initialPage).toBe(1);
    expect(api().initialFilters.sort).toBe("price-low");

    // Syncing writes each single-value key at most once (page=1 is default → omitted).
    api().syncToUrl(api().initialFilters, api().initialPage);
    expect(mockReplace).toHaveBeenCalledWith("/explore?q=a&sort=price-low", {
      scroll: false,
    });
    expectOnlyIntendedKeys();
  });

  it("duplicate collection values are preserved as the intended multi-value key", () => {
    mockSearchParams = new URLSearchParams("collection=C1&collection=C2&collection=C1&foo=drop");
    const { api } = renderConsumer();

    expect(api().initialFilters.collection).toEqual(["C1", "C2", "C1"]);
    api().syncToUrl(
      {
        search: "",
        status: "All",
        collection: ["C1", "C2", "C1"],
        minPrice: "",
        maxPrice: "",
        artist: "",
        sort: "newest",
      },
      1,
    );
    expect(mockReplace).toHaveBeenCalledWith(
      "/explore?collection=C1&collection=C2&collection=C1",
      { scroll: false },
    );
    // `collection` is an intended key even when repeated; the unknown `foo` is gone.
    expectOnlyIntendedKeys();
  });
});
