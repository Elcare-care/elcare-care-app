// ─────────────────────────────────────────────────────────────
// __tests__/auditLog.test.ts
//
// Tests for lib/auditLog.ts — event emission, sessionStorage
// persistence, Sentry breadcrumb forwarding, and explorer URL.
// ─────────────────────────────────────────────────────────────

import {
  emitAuditEvent,
  getSessionAuditLog,
  clearSessionAuditLog,
  explorerTxUrl,
} from "@/lib/auditLog";

// ── sessionStorage stub ───────────────────────────────────────

const sessionStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

Object.defineProperty(global, "sessionStorage", { value: sessionStorageMock });
Object.defineProperty(global, "window", { value: global, writable: true });

// Prevent dynamic import of @sentry/nextjs from failing in test
jest.mock("@sentry/nextjs", () => ({ addBreadcrumb: jest.fn() }), { virtual: true });

beforeEach(() => {
  sessionStorageMock.clear();
  jest.clearAllMocks();
});

// ── emitAuditEvent ────────────────────────────────────────────

describe("emitAuditEvent", () => {
  it("stores an event in sessionStorage", () => {
    emitAuditEvent("artist.revoke", "GADMIN1234567890", "success", {
      target: "GTAR…T001",
    });
    const log = getSessionAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("artist.revoke");
    expect(log[0].outcome).toBe("success");
  });

  it("pseudonymises the admin key (stores prefix only)", () => {
    const full = "GADMINXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    emitAuditEvent("session.start", full, "success");
    const log = getSessionAuditLog();
    const event = log[0];
    // Should NOT contain the full key
    expect(event.adminPrefix).not.toBe(full);
    // Should contain first 4 chars
    expect(event.adminPrefix.startsWith("GADM")).toBe(true);
  });

  it("stores '[unknown]' when adminKey is null", () => {
    emitAuditEvent("session.start", null, "success");
    const log = getSessionAuditLog();
    expect(log[0].adminPrefix).toBe("[unknown]");
  });

  it("redacts sensitive fields in extras", () => {
    emitAuditEvent("token.whitelist_add", "GADMIN", "success", {
      // @ts-expect-error — intentionally passing a sensitive key to test redaction
      secret: "should-be-gone",
      target: "CTOK…0001",
    });
    const log = getSessionAuditLog();
    const event = log[0] as Record<string, unknown>;
    expect(event.secret).toBe("[REDACTED]");
    expect(event.target).toBe("CTOK…0001");
  });

  it("records timestamp as ISO-8601", () => {
    emitAuditEvent("pause.global_enable", "GADMIN", "initiated");
    const log = getSessionAuditLog();
    expect(() => new Date(log[0].timestamp)).not.toThrow();
    expect(log[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("accumulates multiple events in order", () => {
    emitAuditEvent("artist.revoke", "GA", "initiated");
    emitAuditEvent("artist.revoke", "GA", "success");
    const log = getSessionAuditLog();
    expect(log).toHaveLength(2);
    expect(log[0].outcome).toBe("initiated");
    expect(log[1].outcome).toBe("success");
  });

  it("distinguishes wallet_rejection outcome", () => {
    emitAuditEvent("token.whitelist_remove", "GADMIN", "rejected", {
      errorMessage: "User rejected the request",
    });
    const log = getSessionAuditLog();
    expect(log[0].outcome).toBe("rejected");
    expect(log[0].errorMessage).toBe("User rejected the request");
  });
});

// ── clearSessionAuditLog ──────────────────────────────────────

describe("clearSessionAuditLog", () => {
  it("removes all stored events", () => {
    emitAuditEvent("session.start", "GADMIN", "success");
    expect(getSessionAuditLog()).toHaveLength(1);
    clearSessionAuditLog();
    expect(getSessionAuditLog()).toHaveLength(0);
  });
});

// ── explorerTxUrl ─────────────────────────────────────────────

describe("explorerTxUrl", () => {
  it("returns testnet explorer URL by default", () => {
    const url = explorerTxUrl("abc123");
    expect(url).toContain("testnet");
    expect(url).toContain("abc123");
  });

  it("returns mainnet explorer URL when network is mainnet", () => {
    const url = explorerTxUrl("abc123", "mainnet");
    expect(url).toContain("public");
    expect(url).toContain("abc123");
  });
});
