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

// ── Canonical asset identity + base/display unit conversion (Issue #282) ────
//
// The marketplace contract treats every `price`/`amount`/bid as an opaque
// i128 *base unit* (no decimal scaling — see
// `contracts/soroban-marketplace/src/types.rs`). Precision/display policy
// therefore lives entirely here, off-chain: this is the single canonical
// registry the whole frontend must go through to know a token's decimals,
// and the only place that should convert between base units and a
// human-readable amount. Do this with BigInt/string arithmetic ONLY — never
// `Number`/`parseFloat` on a raw base-unit value, which silently loses
// precision once the value exceeds `Number.MAX_SAFE_INTEGER` (~9e15, i.e.
// ~900M XLM at 7 decimals) and can otherwise produce off-by-a-rounding-error
// display amounts.

/** Distinguishes the on-chain representation behind a `TokenConfig`. */
export type AssetKind = "native" | "sac" | "unknown";

/** Canonical identity of one accepted payment asset. */
export interface AssetIdentity {
  /** "native" = the XLM Stellar Asset Contract; "sac" = a whitelisted
   *  SAC wrapping some other asset; "unknown" = not present in the
   *  canonical registry (must be rejected before checkout/settlement). */
  kind: AssetKind;
  /** Canonical Stellar contract address for this asset. */
  address: string;
  /** Ticker shown in the UI (e.g. "XLM", "USDC"). */
  symbol: string;
  /** Display name (e.g. "Stellar Lumens"). */
  name: string;
  /** Number of decimal places between one base unit and one display unit. */
  decimals: number;
}

/**
 * Resolve the canonical asset identity for a contract address, or `null`
 * when the address is not a recognized payment token. Callers that are
 * about to charge/settle an amount in this token MUST treat `null` as a
 * hard failure — an "unsupported asset form" per Issue #282's acceptance
 * criteria — rather than falling back to a default precision.
 */
export function getAssetIdentity(address: string): AssetIdentity | null {
  const token = getTokenConfigByAddress(address);
  if (!token) return null;
  return {
    kind: token.symbol === NATIVE_TOKEN_SYMBOL ? "native" : "sac",
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
  };
}

/** True iff `address` resolves to a known asset in the canonical registry. */
export function isSupportedAsset(address: string): boolean {
  return getTokenConfigByAddress(address) !== undefined;
}

/**
 * Convert a base-unit amount (bigint, e.g. stroops) to a decimal display
 * string using `decimals` places. Pure BigInt/string arithmetic — safe for
 * i128-range values that exceed `Number.MAX_SAFE_INTEGER`.
 *
 * e.g. baseUnitsToDisplay(100_000_000n, 7) === "10"
 *      baseUnitsToDisplay(1n, 7)           === "0.0000001"
 */
export function baseUnitsToDisplay(baseUnits: bigint, decimals: number): string {
  const negative = baseUnits < 0n;
  const abs = negative ? -baseUnits : baseUnits;
  if (decimals <= 0) return negative ? `-${abs}` : `${abs}`;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fracStr ? `${sign}${whole}.${fracStr}` : `${sign}${whole}`;
}

/**
 * Convert a decimal display string (e.g. "12.5000000", possibly typed by a
 * user) to a base-unit bigint using `decimals` places. Parses the string
 * directly — never routes it through `Number`/`parseFloat` — so precision
 * cannot be lost even for amounts beyond `Number.MAX_SAFE_INTEGER`.
 *
 * Throws if `amount` is not a plain decimal number string.
 */
export function displayToBaseUnits(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (trimmed === "" || !/^-?\d*\.?\d*$/.test(trimmed) || trimmed === "-" || trimmed === ".") {
    throw new Error(`Invalid decimal amount: "${amount}"`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholeRaw, fracRaw = ""] = unsigned.split(".");
  const whole = wholeRaw === "" ? "0" : wholeRaw;
  if (fracRaw.length > decimals) {
    throw new Error(
      `Amount "${amount}" has more than ${decimals} decimal places for this token.`
    );
  }
  const fracPadded = fracRaw.padEnd(decimals, "0");
  const scale = 10n ** BigInt(decimals);
  const result = BigInt(whole) * scale + (fracPadded ? BigInt(fracPadded || "0") : 0n);
  return negative ? -result : result;
}
