import { Address } from "@stellar/stellar-sdk";
import { config } from "@/lib/config";

export interface TokenConfig {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
}

type TokenSymbol = "XLM" | "USDC" | "AFRI";

const NATIVE_TOKEN_SYMBOL: TokenSymbol = "XLM";

const TOKEN_METADATA: Record<TokenSymbol, Omit<TokenConfig, "address">> = {
  XLM: {
    symbol: "XLM",
    name: "Stellar Lumens",
    decimals: 7,
  },
  USDC: {
    symbol: "USDC",
    name: "USDC",
    decimals: 7,
  },
  AFRI: {
    symbol: "AFRI",
    name: "ELCARE-HUB Token",
    decimals: 7,
  },
};

const TOKEN_ADDRESSES_BY_NETWORK: Record<string, Partial<Record<TokenSymbol, string>>> = {
  testnet: {
    XLM:
      process.env.NEXT_PUBLIC_NATIVE_TOKEN_CONTRACT_ID ??
      "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    USDC:
      process.env.NEXT_PUBLIC_USDC_TOKEN_CONTRACT_ID ??
      "CCW67Z72VRYZUM3BWHXYG6PVDZ4NMLN73Y7U7E4S3W4M7I5VBDQXWIXI",
    AFRI:
      process.env.NEXT_PUBLIC_AFRI_TOKEN_CONTRACT_ID ??
      "CAS3J7GYLGXGR6AK3VTQBDG2YZQOEFV2TKEBKH6A76EABR76W3G6AB7C",
  },
  mainnet: {
    XLM: process.env.NEXT_PUBLIC_NATIVE_TOKEN_CONTRACT_ID ?? "",
    USDC: process.env.NEXT_PUBLIC_USDC_TOKEN_CONTRACT_ID ?? "",
    AFRI: process.env.NEXT_PUBLIC_AFRI_TOKEN_CONTRACT_ID ?? "",
  },
};

export function isValidTokenAddress(address: string): boolean {
  try {
    new Address(address);
    return true;
  } catch {
    return false;
  }
}

function getTokenAddress(symbol: TokenSymbol): string | null {
  const networkKey = config.network.toLowerCase();
  const address = TOKEN_ADDRESSES_BY_NETWORK[networkKey]?.[symbol];
  if (!address || !isValidTokenAddress(address)) {
    return null;
  }
  return address;
}

function buildTokenConfig(symbol: TokenSymbol): TokenConfig | null {
  const address = getTokenAddress(symbol);
  if (!address) {
    return null;
  }

  return {
    ...TOKEN_METADATA[symbol],
    address,
  };
}

export const SUPPORTED_TOKENS: TokenConfig[] = (
  Object.keys(TOKEN_METADATA) as TokenSymbol[]
)
  .map(buildTokenConfig)
  .filter((token): token is TokenConfig => token !== null);

function getTokenConfigBySymbol(symbol: TokenSymbol): TokenConfig | undefined {
  return SUPPORTED_TOKENS.find((token) => token.symbol === symbol);
}

const resolvedDefaultToken =
  getTokenConfigBySymbol(NATIVE_TOKEN_SYMBOL) ?? SUPPORTED_TOKENS[0];

if (!resolvedDefaultToken) {
  throw new Error(`No supported tokens are configured for network "${config.network}".`);
}

export const DEFAULT_TOKEN = resolvedDefaultToken;

export function getNativeTokenConfig(): TokenConfig {
  const token = getTokenConfigBySymbol(NATIVE_TOKEN_SYMBOL);
  if (!token) {
    throw new Error(`Native token "${NATIVE_TOKEN_SYMBOL}" is not configured.`);
  }

  return token;
}

export function getTokenConfigByAddress(address: string): TokenConfig | undefined {
  return SUPPORTED_TOKENS.find((token) => token.address === address);
}
