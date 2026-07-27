import { filterReducer, Filters, FilterAction } from "../components/FilterSidebar";

describe("filterReducer", () => {
  const initialState: Filters = {
    search: "",
    status: "All",
    collection: [],
    minPrice: "",
    maxPrice: "",
    artist: "",
    sort: "newest",
  };

  it("should handle SET_SEARCH", () => {
    const action: FilterAction = { type: "SET_SEARCH", payload: "art" };
    const nextState = filterReducer(initialState, action);
    expect(nextState.search).toBe("art");
  });

  it("should handle SET_STATUS", () => {
    const action: FilterAction = { type: "SET_STATUS", payload: "Active" };
    const nextState = filterReducer(initialState, action);
    expect(nextState.status).toBe("Active");
  });

  it("should handle TOGGLE_COLLECTION", () => {
    // Add collection
    const action1: FilterAction = { type: "TOGGLE_COLLECTION", payload: "C1" };
    const state1 = filterReducer(initialState, action1);
    expect(state1.collection).toEqual(["C1"]);

    // Add another collection
    const action2: FilterAction = { type: "TOGGLE_COLLECTION", payload: "C2" };
    const state2 = filterReducer(state1, action2);
    expect(state2.collection).toEqual(["C1", "C2"]);

    // Remove first collection
    const state3 = filterReducer(state2, action1);
    expect(state3.collection).toEqual(["C2"]);
  });

  it("should handle price ranges", () => {
    const state1 = filterReducer(initialState, { type: "SET_MIN_PRICE", payload: "10" });
    const state2 = filterReducer(state1, { type: "SET_MAX_PRICE", payload: "100" });
    expect(state2.minPrice).toBe("10");
    expect(state2.maxPrice).toBe("100");
  });

  it("should handle CLEAR_ALL", () => {
    const dirtyState: Filters = {
      search: "query",
      status: "Sold",
      collection: ["C1"],
      minPrice: "10",
      maxPrice: "50",
      artist: "ADDR1",
      sort: "price-low",
    };
    const nextState = filterReducer(dirtyState, { type: "CLEAR_ALL" });
    expect(nextState).toEqual({
      search: "",
      status: "All",
      collection: [],
      minPrice: "",
      maxPrice: "",
      artist: "",
      sort: "newest",
    });
  });
});
