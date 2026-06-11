import {
  DEFAULT_TOKEN,
  SUPPORTED_TOKENS,
  TokenConfig,
  getTokenConfigByAddress,
  isValidTokenAddress,
} from "@/config/tokens";
import { getTokenWhitelist } from "@/lib/contract";

export function resolveSupportedTokens(
  whitelistedAddresses: readonly string[]
): TokenConfig[] {
  const validWhitelist = whitelistedAddresses.filter(isValidTokenAddress);

  if (validWhitelist.length === 0) {
    return SUPPORTED_TOKENS;
  }

  const whitelist = new Set(validWhitelist);
  return SUPPORTED_TOKENS.filter((token) => whitelist.has(token.address));
}

export async function fetchSupportedTokens(): Promise<TokenConfig[]> {
  const whitelist = await getTokenWhitelist();
  return resolveSupportedTokens(whitelist);
}

export function ensureTokenOption(
  tokens: readonly TokenConfig[],
  tokenAddress: string
): TokenConfig[] {
  const configuredToken = getTokenConfigByAddress(tokenAddress);
  if (!configuredToken || tokens.some((token) => token.address === tokenAddress)) {
    return [...tokens];
  }

  return [...tokens, configuredToken];
}

export function getDefaultSupportedToken(tokens: readonly TokenConfig[]): TokenConfig {
  return tokens.find((token) => token.address === DEFAULT_TOKEN.address) ?? tokens[0] ?? DEFAULT_TOKEN;
}

export async function assertSupportedTokenAddress(
  tokenAddress: string | undefined,
  context: string
): Promise<TokenConfig> {
  const address = tokenAddress ?? DEFAULT_TOKEN.address;

  if (!isValidTokenAddress(address)) {
    throw new Error(`Invalid ${context} token address.`);
  }

  const configuredToken = getTokenConfigByAddress(address);
  if (!configuredToken) {
    throw new Error(`Unsupported ${context} token address.`);
  }

  const whitelist = (await getTokenWhitelist()).filter(isValidTokenAddress);
  if (whitelist.length > 0 && !whitelist.includes(configuredToken.address)) {
    throw new Error("Token address is not enabled in the current contract whitelist.");
  }

  return configuredToken;
}
