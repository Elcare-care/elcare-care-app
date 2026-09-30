// ─────────────────────────────────────────────────────────────
// __tests__/errors.test.ts
//
// Unit tests for lib/errors.ts — isNetworkError and isServerError predicates.
// ─────────────────────────────────────────────────────────────

import { isNetworkError, isServerError } from "@/lib/errors";

// ── Helpers to build Axios-like error shapes ──────────────────

function makeNetworkError() {
  return {
    isAxiosError: true as const,
    request: {},      // request was sent …
    response: undefined, // … but no response arrived
    message: "Network Error",
  };
}

function makeAxiosResponseError(status: number) {
  return {
    isAxiosError: true as const,
    request: {},
    response: { status, data: {} },
    message: `Request failed with status code ${status}`,
  };
}

// ── isNetworkError ────────────────────────────────────────────

describe("isNetworkError", () => {
  it("returns true for an Axios error with no response", () => {
    expect(isNetworkError(makeNetworkError())).toBe(true);
  });

  it("returns false for an Axios 500 response error", () => {
    expect(isNetworkError(makeAxiosResponseError(500))).toBe(false);
  });

  it("returns false for an Axios 4xx response error", () => {
    expect(isNetworkError(makeAxiosResponseError(404))).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isNetworkError(new Error("oops"))).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isNetworkError("Network Error")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isNetworkError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isNetworkError(undefined)).toBe(false);
  });
});

// ── isServerError ─────────────────────────────────────────────

describe("isServerError", () => {
  it("returns true for an Axios 500 error", () => {
    expect(isServerError(makeAxiosResponseError(500))).toBe(true);
  });

  it("returns true for an Axios 503 error", () => {
    expect(isServerError(makeAxiosResponseError(503))).toBe(true);
  });

  it("returns true for an Axios 599 error", () => {
    expect(isServerError(makeAxiosResponseError(599))).toBe(true);
  });

  it("returns false for an Axios 4xx error", () => {
    expect(isServerError(makeAxiosResponseError(422))).toBe(false);
  });

  it("returns false for an Axios 400 error", () => {
    expect(isServerError(makeAxiosResponseError(400))).toBe(false);
  });

  it("returns false for a network-level Axios error (no response)", () => {
    expect(isServerError(makeNetworkError())).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isServerError(new Error("Internal Server Error"))).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isServerError("500 Internal Server Error")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isServerError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isServerError(undefined)).toBe(false);
  });
});
