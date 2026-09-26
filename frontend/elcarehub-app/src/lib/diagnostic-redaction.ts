/**
 * Safe diagnostic payload creation and redaction for support requests.
 * 
 * This module ensures that diagnostic information shared with support does not
 * leak private keys, seed phrases, session tokens, or other credentials.
 * 
 * See: docs/guides/support-triage.md
 */

export interface DiagnosticPayload {
  type: 'transaction_failure' | 'wallet_connection_failure' | 'indexer_lag' | 'generic_error';
  timestamp: string;
  network: string;
  txHash?: string;
  publicAddress?: string;
  walletType?: string;
  errorCode?: string;
  errorMessage?: string;
  requestId?: string;
  userAgent: string;
  appVersion: string;
  route?: string;
}

export interface DiagnosticContext {
  txHash?: string;
  publicAddress?: string;
  walletType?: string;
  errorCode?: string;
  errorMessage?: string;
  requestId?: string;
  route?: string;
}

/**
 * Creates a safe diagnostic payload from transaction or wallet context.
 * 
 * This function explicitly includes ONLY safe-to-share fields and omits
 * private keys, seed phrases, session tokens, and credential-bearing URLs.
 * 
 * Safe fields:
 * - Transaction hash (public blockchain data)
 * - Public Stellar address (G... format)
 * - Error codes and messages
 * - Network identifier
 * - Wallet type (Freighter, LOBSTR, Magic.link)
 * - Request ID (application correlation)
 * 
 * @param context - Transaction or wallet context
 * @returns Safe diagnostic payload ready for clipboard or support submission
 */
export function createSafeDiagnostic(context: DiagnosticContext): DiagnosticPayload {
  return {
    type: 'transaction_failure',
    timestamp: new Date().toISOString(),
    network: process.env.NEXT_PUBLIC_STELLAR_NETWORK || 'unknown',
    txHash: context.txHash,
    publicAddress: context.publicAddress,
    walletType: context.walletType,
    errorCode: context.errorCode,
    errorMessage: context.errorMessage,
    requestId: context.requestId,
    route: context.route,
    userAgent: navigator.userAgent,
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION || 'unknown',
  };
}

/**
 * Copies a diagnostic payload to the user's clipboard as formatted JSON.
 * 
 * @param payload - Diagnostic payload to copy
 * @throws Error if clipboard API is not available or write fails
 */
export async function copyDiagnosticToClipboard(payload: DiagnosticPayload): Promise<void> {
  const formatted = JSON.stringify(payload, null, 2);
  await navigator.clipboard.writeText(formatted);
}

/**
 * Redacts private keys from a string for logging or display purposes.
 * 
 * This function replaces Stellar private keys (S...) with [REDACTED_PRIVATE_KEY].
 * 
 * @param input - String potentially containing private keys
 * @returns String with private keys redacted
 */
export function redactPrivateKeys(input: string): string {
  // Stellar private keys start with 'S' and are 56 characters (base32)
  return input.replace(/\bS[A-Z2-7]{55}\b/g, '[REDACTED_PRIVATE_KEY]');
}

/**
 * Redacts Magic.link API keys from a string for logging or display purposes.
 * 
 * @param input - String potentially containing Magic.link keys
 * @returns String with API keys redacted
 */
export function redactMagicApiKeys(input: string): string {
  // Magic.link publishable keys: pk_live_... or pk_test_...
  return input.replace(/\bpk_(live|test)_[a-zA-Z0-9]+/g, '[REDACTED_MAGIC_KEY]');
}

/**
 * Redacts Bearer tokens from a string for logging or display purposes.
 * 
 * @param input - String potentially containing Bearer tokens
 * @returns String with tokens redacted
 */
export function redactBearerTokens(input: string): string {
  return input.replace(/\bBearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED_TOKEN]');
}

/**
 * Applies all redaction rules to a string.
 * 
 * Use this for logging error messages or user-provided text that may
 * accidentally contain credentials.
 * 
 * @param input - String to redact
 * @returns Redacted string safe for logging or support
 */
export function redactSensitiveData(input: string): string {
  let redacted = input;
  redacted = redactPrivateKeys(redacted);
  redacted = redactMagicApiKeys(redacted);
  redacted = redactBearerTokens(redacted);
  return redacted;
}
