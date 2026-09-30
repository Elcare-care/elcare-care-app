import { Page } from '@playwright/test';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

// ─────────────────────────────────────────────────────────────
// tests/live-e2e/helpers/real-signer.ts
//
// Unlike tests/e2e/freighter-mock.ts (which fakes the wallet AND every
// contract call via NEXT_PUBLIC_E2E_MOCK_CHAIN), this shims only the
// wallet extension surface with a REAL signer backed by a real funded
// testnet keypair. Every contract call, RPC round trip, and event the
// indexer picks up is genuine — this is what actually exercises the
// system boundaries mocked tests can't reach.
//
// Implementation note: `window.freighter` is injected via
// `page.addInitScript` matching the public Freighter extension contract
// that `@stellar/freighter-api` (the frontend's real dependency) wraps.
// The actual Ed25519 signing happens on the Node side via
// `page.exposeFunction`, since that's where `@stellar/stellar-sdk`'s
// Keypair is available — the browser-side shim is just a thin relay.
// If a future `@stellar/freighter-api` upgrade changes its expected
// return shapes, this is the first place to check.
// ─────────────────────────────────────────────────────────────

export interface RealSignerOptions {
  publicKey: string;
  secretKey: string;
  networkPassphrase: string;
}

/**
 * Installs a real-signing `window.freighter` shim on the page. Call before
 * `page.goto(...)` for every test that needs the app to submit a real,
 * signed transaction (as opposed to tests/e2e's fully mocked chain).
 */
export async function installRealSigner(page: Page, options: RealSignerOptions): Promise<void> {
  const { publicKey, secretKey, networkPassphrase } = options;
  const keypair = Keypair.fromSecret(secretKey);

  // Runs in the Node/Playwright process — has real access to stellar-sdk.
  await page.exposeFunction('__liveE2eSignTransaction', async (xdr: string, passphrase: string) => {
    const tx = TransactionBuilder.fromXDR(xdr, passphrase);
    tx.sign(keypair);
    return tx.toXDR();
  });

  await page.addInitScript(
    ({ pk, passphrase }) => {
      (window as any).freighter = {
        isConnected: async () => true,
        isAllowed: async () => true,
        setAllowed: async () => true,
        getAddress: async () => ({ address: pk }),
        getPublicKey: async () => pk,
        getNetwork: async () => ({ network: 'TESTNET', networkPassphrase: passphrase }),
        getNetworkDetails: async () => ({
          network: 'TESTNET',
          networkPassphrase: passphrase,
        }),
        signTransaction: async (xdr: string, opts?: { networkPassphrase?: string }) => {
          const signedXdr = await (window as any).__liveE2eSignTransaction(
            xdr,
            opts?.networkPassphrase ?? passphrase
          );
          return { signedTxXdr: signedXdr, signerAddress: pk };
        },
      };
      // Some code paths probe for a Starlight-branded global before falling
      // back to `window.freighter` — mirror that so `isFreighterInstalled()`
      // resolves the same way it would with the real extension present.
      (window as any).starlight = (window as any).freighter;
    },
    { pk: publicKey, passphrase: networkPassphrase }
  );
}
