import { DEFAULT_TOKEN, SUPPORTED_TOKENS } from "@/config/tokens";
import {
  assertSupportedTokenAddress,
  resolveSupportedTokens,
} from "@/lib/token-support";
import { getTokenWhitelist } from "@/lib/contract";

jest.mock("@/lib/contract", () => ({
  getTokenWhitelist: jest.fn(),
}));

describe("token support", () => {
  const whitelistedButUnconfiguredToken =
    "CD3FSSR667WES5YVVUZZ22LFRQ2RB5NGJGGQEGSPP4OXWLJJV5EFHIIR";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keeps configured tokens when no whitelist addresses are available", () => {
    expect(resolveSupportedTokens([])).toEqual(SUPPORTED_TOKENS);
  });

  it("filters configured tokens against the contract whitelist", () => {
    const token = SUPPORTED_TOKENS[1] ?? DEFAULT_TOKEN;
    expect(resolveSupportedTokens([token.address])).toEqual([token]);
  });

  it("rejects malformed token addresses before contract calls", async () => {
    await expect(
      assertSupportedTokenAddress("not-a-contract-address", "listing")
    ).rejects.toThrow("Invalid listing token address.");
  });

  it("rejects configured tokens that are not in the current whitelist", async () => {
    (getTokenWhitelist as jest.Mock).mockResolvedValue([whitelistedButUnconfiguredToken]);

    await expect(
      assertSupportedTokenAddress(DEFAULT_TOKEN.address, "listing")
    ).rejects.toThrow("Token address is not enabled in the current contract whitelist.");
  });
});
