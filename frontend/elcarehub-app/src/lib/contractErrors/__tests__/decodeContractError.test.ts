import { decodeContractError, ALL_CONTRACT_NAMES } from "../decodeContractError";
import { CONTRACT_ERROR_CATALOG } from "../catalog";
import {
  SIMULATION_FIXTURES,
  UNKNOWN_CONTRACT_CODE_FIXTURE,
  AUTH_FIXTURES,
  RESOURCE_LIMIT_FIXTURES,
  NETWORK_FIXTURES,
  UNKNOWN_FIXTURE,
  submissionErrorFixture,
} from "../__fixtures__/errorFixtures";

describe("decodeContractError — full catalog coverage", () => {
  for (const contract of ALL_CONTRACT_NAMES) {
    describe(contract, () => {
      for (const def of CONTRACT_ERROR_CATALOG[contract]) {
        it(`decodes code ${def.code} (${def.name}) from a simulation failure`, () => {
          const decoded = decodeContractError(submissionErrorFixture(def.code), contract);
          expect(decoded.kind).toBe("contract");
          expect(decoded.code).toBe(def.code);
          expect(decoded.contract).toBe(contract);
          expect(decoded.retryable).toBe(def.retryable);
          expect(decoded.action).toBe(def.action);
          expect(decoded.message).toContain(def.message);
        });
      }
    });
  }
});

describe("decodeContractError — representative fixtures", () => {
  it("decodes a simulation-shaped fixture for every contract", () => {
    for (const contract of ALL_CONTRACT_NAMES) {
      const fixture = SIMULATION_FIXTURES[contract];
      const decoded = decodeContractError(fixture.error, contract);
      expect(decoded.kind).toBe("contract");
      expect(decoded.code).toBe(fixture.code);
    }
  });

  it("resolves the contract automatically when the caller doesn't specify one", () => {
    const fixture = SIMULATION_FIXTURES.launchpad;
    const decoded = decodeContractError(fixture.error);
    expect(decoded.kind).toBe("contract");
    expect(decoded.contract).toBe("launchpad");
    expect(decoded.code).toBe(fixture.code);
  });

  it("flags a well-formed but unmapped contract code as unknown_contract, never silently generic", () => {
    const decoded = decodeContractError(UNKNOWN_CONTRACT_CODE_FIXTURE, "marketplace");
    expect(decoded.kind).toBe("unknown_contract");
    expect(decoded.code).toBe(9999);
    expect(decoded.action).toBe("contact_support");
    expect(decoded.retryable).toBe(false);
  });

  it("classifies wallet rejections as retryable auth errors", () => {
    for (const fixture of AUTH_FIXTURES) {
      const decoded = decodeContractError(fixture);
      expect(decoded.kind).toBe("auth");
      expect(decoded.retryable).toBe(true);
      expect(decoded.action).toBe("retry");
    }
  });

  it("classifies simulation resource-budget failures distinctly from generic errors", () => {
    for (const fixture of RESOURCE_LIMIT_FIXTURES) {
      const decoded = decodeContractError(fixture);
      expect(decoded.kind).toBe("resource_limit");
      expect(decoded.action).toBe("adjust_input");
    }
  });

  it("classifies network/RPC failures as retryable", () => {
    for (const fixture of NETWORK_FIXTURES) {
      const decoded = decodeContractError(fixture);
      expect(decoded.kind).toBe("network");
      expect(decoded.retryable).toBe(true);
    }
  });

  it("falls back to a safe generic message for anything unrecognized", () => {
    const decoded = decodeContractError(UNKNOWN_FIXTURE);
    expect(decoded.kind).toBe("unknown");
    expect(decoded.message.length).toBeGreaterThan(0);
    expect(decoded.cause).toBe(UNKNOWN_FIXTURE);
  });

  it("never mixes up codes between contracts when the contract is specified", () => {
    // Code 4 means ListingNotActive on marketplace but InsufficientBalance on
    // the 1155 collection contract — passing the wrong contract must not
    // silently produce the other contract's message.
    const decoded = decodeContractError(submissionErrorFixture(4), "collection_nft_erc1155");
    expect(decoded.contract).toBe("collection_nft_erc1155");
    expect(decoded.message).toContain("Insufficient token balance");
  });
});

describe("catalog integrity", () => {
  it("has unique codes within each contract", () => {
    for (const contract of ALL_CONTRACT_NAMES) {
      const codes = CONTRACT_ERROR_CATALOG[contract].map((e) => e.code);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });

  it("has unique names within each contract", () => {
    for (const contract of ALL_CONTRACT_NAMES) {
      const names = CONTRACT_ERROR_CATALOG[contract].map((e) => e.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("gives every entry a non-empty user-safe message", () => {
    for (const contract of ALL_CONTRACT_NAMES) {
      for (const def of CONTRACT_ERROR_CATALOG[contract]) {
        expect(def.message.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
