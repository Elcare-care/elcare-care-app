/**
 * FilterSidebar.reset.test.tsx — Issue 1034
 *
 * Verifies the filter-reset behavior:
 *   • The "Reset all filters" button is present in the sidebar footer.
 *   • Clicking it dispatches CLEAR_ALL so local reducer state returns to defaults.
 *   • Clicking it also closes the mobile sidebar.
 *   • The sort select inside the sidebar round-trips correctly.
 *   • filterReducer CLEAR_ALL does not accidentally reset network or wallet state
 *     (it only touches the Filters shape).
 */
import React, { useReducer } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── Mocks ─────────────────────────────────────────────────────

jest.mock("lucide-react", () => ({
  X: () => <span data-testid="icon-x" />,
  Check: () => <span data-testid="icon-check" />,
}));

jest.mock("@/lib/indexer", () => ({
  getCollections: jest.fn().mockResolvedValue({ collections: [] }),
}));

import {
  FilterSidebar,
  filterReducer,
  Filters,
} from "@/components/FilterSidebar";

// ── Helpers ───────────────────────────────────────────────────

const DEFAULT_FILTERS: Filters = {
  search: "",
  status: "All",
  collection: [],
  minPrice: "",
  maxPrice: "",
  artist: "",
  sort: "newest",
};

const DIRTY_FILTERS: Filters = {
  search: "mask",
  status: "Active",
  collection: ["C1"],
  minPrice: "10",
  maxPrice: "500",
  artist: "GADDR1",
  sort: "price-low",
};

/** Wraps FilterSidebar in a local reducer so we can inspect state changes. */
function SidebarHarness({
  initialFilters = DEFAULT_FILTERS,
  isOpen = true,
}: {
  initialFilters?: Filters;
  isOpen?: boolean;
}) {
  const [filters, dispatch] = useReducer(filterReducer, initialFilters);
  return (
    <div>
      <FilterSidebar
        filters={filters}
        dispatch={dispatch}
        isOpen={isOpen}
        setIsOpen={jest.fn()}
      />
      {/* Expose current sort for assertion */}
      <span data-testid="current-sort">{filters.sort}</span>
      <span data-testid="current-status">{filters.status}</span>
      <span data-testid="current-min">{filters.minPrice}</span>
    </div>
  );
}

// ── Tests ─────────────────────────────────────────────────────

describe("FilterSidebar — reset button (Issue 1034)", () => {
  it("renders a Reset all filters button in the sidebar footer", () => {
    render(<SidebarHarness />);
    expect(
      screen.getByRole("button", { name: /reset all filters/i })
    ).toBeInTheDocument();
  });

  it("Reset all filters button has data-testid=filter-reset-all", () => {
    render(<SidebarHarness />);
    expect(screen.getByTestId("filter-reset-all")).toBeInTheDocument();
  });

  it("clicking Reset clears all filter fields back to defaults", async () => {
    const user = userEvent.setup();
    render(<SidebarHarness initialFilters={DIRTY_FILTERS} />);

    // Verify dirty state is active
    expect(screen.getByTestId("current-sort").textContent).toBe("price-low");
    expect(screen.getByTestId("current-status").textContent).toBe("Active");
    expect(screen.getByTestId("current-min").textContent).toBe("10");

    await user.click(screen.getByTestId("filter-reset-all"));

    expect(screen.getByTestId("current-sort").textContent).toBe("newest");
    expect(screen.getByTestId("current-status").textContent).toBe("All");
    expect(screen.getByTestId("current-min").textContent).toBe("");
  });

  it("clicking Reset calls setIsOpen(false) to close the mobile drawer", async () => {
    const user = userEvent.setup();
    const setIsOpen = jest.fn();

    const [filters, dispatch] = [DEFAULT_FILTERS, jest.fn()] as [Filters, React.Dispatch<any>];

    render(
      <FilterSidebar
        filters={filters}
        dispatch={dispatch}
        isOpen={true}
        setIsOpen={setIsOpen}
      />
    );

    await user.click(screen.getByTestId("filter-reset-all"));
    expect(setIsOpen).toHaveBeenCalledWith(false);
  });

  it("clicking Reset dispatches CLEAR_ALL (not a novel action type)", async () => {
    const user = userEvent.setup();
    const dispatch = jest.fn();

    render(
      <FilterSidebar
        filters={DEFAULT_FILTERS}
        dispatch={dispatch}
        isOpen={true}
        setIsOpen={jest.fn()}
      />
    );

    await user.click(screen.getByTestId("filter-reset-all"));
    expect(dispatch).toHaveBeenCalledWith({ type: "CLEAR_ALL" });
  });
});

describe("filterReducer CLEAR_ALL (Issue 1034)", () => {
  it("resets all filter fields to their defaults", () => {
    const next = filterReducer(DIRTY_FILTERS, { type: "CLEAR_ALL" });
    expect(next).toEqual<Filters>({
      search: "",
      status: "All",
      collection: [],
      minPrice: "",
      maxPrice: "",
      artist: "",
      sort: "newest",
    });
  });

  it("does not modify any key outside of Filters (network / wallet state untouched)", () => {
    // The Filters type has exactly the fields checked above — CLEAR_ALL
    // must not add extra keys that could collide with caller state.
    const next = filterReducer(DIRTY_FILTERS, { type: "CLEAR_ALL" });
    expect(Object.keys(next)).toEqual(Object.keys(DEFAULT_FILTERS));
  });

  it("is idempotent — calling CLEAR_ALL twice returns the same defaults", () => {
    const once = filterReducer(DIRTY_FILTERS, { type: "CLEAR_ALL" });
    const twice = filterReducer(once, { type: "CLEAR_ALL" });
    expect(twice).toEqual(once);
  });
});

describe("FilterSidebar — sort control (Issue 1034)", () => {
  it("renders a sort select inside the sidebar", () => {
    render(<SidebarHarness />);
    expect(screen.getByRole("combobox", { name: /sort/i })).toBeInTheDocument();
  });

  it("changing the sort select dispatches SET_SORT", async () => {
    const user = userEvent.setup();
    const dispatch = jest.fn();

    render(
      <FilterSidebar
        filters={DEFAULT_FILTERS}
        dispatch={dispatch}
        isOpen={true}
        setIsOpen={jest.fn()}
      />
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: /sort/i }),
      "price-high"
    );

    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_SORT",
      payload: "price-high",
    });
  });

  it("current sort value is reflected in the select", () => {
    render(
      <FilterSidebar
        filters={{ ...DEFAULT_FILTERS, sort: "oldest" }}
        dispatch={jest.fn()}
        isOpen={true}
        setIsOpen={jest.fn()}
      />
    );
    const select = screen.getByRole("combobox", { name: /sort/i }) as HTMLSelectElement;
    expect(select.value).toBe("oldest");
  });
});
