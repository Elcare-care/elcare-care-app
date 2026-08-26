// ─────────────────────────────────────────────────────────────
// app/privacy/page.tsx — Privacy Policy
// ─────────────────────────────────────────────────────────────

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — ElcareHub",
  description:
    "How ElcareHub collects, uses, and protects your data, and your rights regarding blockchain and IPFS records.",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-midnight-950 pt-24 pb-16 text-white">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <h1 className="text-4xl font-display font-bold mb-2">Privacy Policy</h1>
        <p className="text-white/40 text-sm mb-10">Last updated: July 2026</p>

        <div className="prose prose-invert prose-sm max-w-none space-y-8">

          {/* 1 */}
          <section>
            <h2 className="text-xl font-bold text-white mb-3">1. What data we collect and why</h2>
            <div className="space-y-4 text-white/70 leading-relaxed">
              <p>
                ElcareHub is a non-custodial marketplace. We do not create accounts,
                store passwords, or hold funds on your behalf. The data we collect is
                limited to what is necessary for the platform to function.
              </p>

              <table className="w-full text-sm border border-white/10 rounded-xl overflow-hidden">
                <thead className="bg-white/5">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold text-white/80">Data</th>
                    <th className="text-left px-3 py-2 font-semibold text-white/80">Purpose</th>
                    <th className="text-left px-3 py-2 font-semibold text-white/80">Retention</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  <tr>
                    <td className="px-3 py-2">Wallet public key</td>
                    <td className="px-3 py-2">Identify listings, offers, and bids you created</td>
                    <td className="px-3 py-2">Retained in indexer while listings exist; pseudonymised in analytics</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2">Transaction hashes</td>
                    <td className="px-3 py-2">Link on-chain activity to indexer records</td>
                    <td className="px-3 py-2">Retained indefinitely in indexer (mirrors public chain)</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2">NFT metadata (title, image CID)</td>
                    <td className="px-3 py-2">Display artwork in the marketplace</td>
                    <td className="px-3 py-2">Stored on IPFS — permanent and immutable (see section 5)</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2">Page views and click events</td>
                    <td className="px-3 py-2">Product analytics (PostHog) — consent required</td>
                    <td className="px-3 py-2">90 days in PostHog; never sent if analytics is disabled</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2">Error and performance data</td>
                    <td className="px-3 py-2">Bug reports (Sentry)</td>
                    <td className="px-3 py-2">90 days in Sentry; IP is not retained; wallet addresses are pseudonymised</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2">Admin audit events</td>
                    <td className="px-3 py-2">Accountability for privileged operations</td>
                    <td className="px-3 py-2">Session lifetime in browser sessionStorage; cleared on logout</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2">Rate-limit counters</td>
                    <td className="px-3 py-2">Abuse prevention on the indexer API</td>
                    <td className="px-3 py-2">60 seconds (Redis TTL); not logged beyond the window</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* 2 */}
          <section>
            <h2 className="text-xl font-bold text-white mb-3">2. Wallet addresses and pseudonymisation</h2>
            <div className="text-white/70 leading-relaxed space-y-3">
              <p>
                Your Stellar public key is a pseudonymous identifier — it does not
                directly identify a natural person, but it is linked to all on-chain
                activity associated with that key.
              </p>
              <p>
                In analytics events and error reports, we use only the first 4 and last
                4 characters of your key (e.g. <code className="text-brand-400">GCAT…ZXAB</code>).
                The full address is never sent to PostHog or Sentry.
              </p>
              <p>
                In the indexer database, the full public key is stored because it is
                required to serve listings and activity feeds. This mirrors the
                public blockchain record.
              </p>
            </div>
          </section>

          {/* 2b */}
          <section>
            <h2 className="text-xl font-bold text-white mb-3">2b. Wallet Persistence and Privacy Controls</h2>
            <div className="text-white/70 leading-relaxed space-y-3">
              <p>
                ElcareHub offers privacy-conscious wallet persistence controls to respect your preferences.
              </p>
              
              <div className="bg-white/5 border border-white/10 rounded-lg p-4 space-y-3">
                <h3 className="font-semibold text-white">Remember Wallet Setting</h3>
                <p>
                  By default, ElcareHub stores your wallet connector type (Freighter, Lobstr, or Magic) 
                  in browser localStorage, allowing automatic reconnection on your next visit. This setting 
                  can be disabled in <strong>Settings › Privacy › Remember Wallet</strong>.
                </p>
                
                <p className="text-sm">
                  <strong>When enabled:</strong> Your wallet connection persists across browser sessions. 
                  We store only your wallet address (public key), connector type, and connection timestamp—
                  never your private keys or signing data.
                </p>

                <p className="text-sm">
                  <strong>When disabled:</strong> Your wallet connection uses sessionStorage instead, 
                  clearing automatically when you close your browser. This provides maximum privacy for 
                  each session.
                </p>
              </div>

              <div className="bg-white/5 border border-white/10 rounded-lg p-4 space-y-3">
                <h3 className="font-semibold text-white">What We Never Store</h3>
                <ul className="text-sm space-y-2 list-inside">
                  <li>✓ Private keys or seed phrases (your wallet extension keeps these)</li>
                  <li>✓ Signatures or signing requests</li>
                  <li>✓ Raw blockchain provider responses containing transient tokens</li>
                  <li>✓ Transaction hashes or approval states (stored only on-chain or in indexer)</li>
                  <li>✓ Session tokens or authentication credentials</li>
                </ul>
              </div>

              <div className="bg-white/5 border border-white/10 rounded-lg p-4 space-y-3">
                <h3 className="font-semibold text-white">Session Expiration</h3>
                <p className="text-sm">
                  Persisted wallet sessions expire after 7 days of inactivity. Upon expiration, 
                  your connection data is automatically cleared, and you will be prompted to reconnect 
                  on your next visit. You can clear this data manually by disconnecting in the app 
                  or disabling "Remember Wallet" in settings.
                </p>
              </div>

              <div className="bg-white/5 border border-white/10 rounded-lg p-4 space-y-3">
                <h3 className="font-semibold text-white">Device and Browser Safety</h3>
                <p className="text-sm">
                  Browser localStorage and sessionStorage are accessible to JavaScript running on ElcareHub's domain. 
                  To minimize risk:
                </p>
                <ul className="text-sm space-y-2 list-inside">
                  <li>• Disable "Remember Wallet" if using shared or untrusted devices</li>
                  <li>• Regularly clear browser data or use private browsing mode</li>
                  <li>• Keep your browser and wallet extension updated</li>
                  <li>• Never store large amounts of assets in a browser-connected wallet</li>
                </ul>
              </div>
            </div>
          </section>

          {/* 3 */}
          <section>
            <h2 className="text-xl font-bold text-white mb-3">3. Analytics — your choice</h2>
            <div className="text-white/70 leading-relaxed space-y-3">
              <p>
                We use PostHog for product analytics. Analytics is <strong className="text-white">disabled by
                default</strong>. You can enable or disable it at any time in{" "}
                <Link href="/settings" className="text-brand-400 hover:underline">
                  Settings → Privacy → Analytics
                </Link>.
              </p>
              <p>
                When analytics is enabled:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Page views are recorded (sensitive URL parameters are stripped).</li>
                <li>Marketplace interactions (listing created, purchase, bid) are recorded as aggregate events.</li>
                <li>No full wallet address, email address, or IP address is sent.</li>
              </ul>
              <p>
                When analytics is disabled, no data of any kind is sent to PostHog.
                Your choice persists in <code className="text-brand-400">localStorage</code> and is
                applied immediately — no page reload required.
              </p>
            </div>
          </section>

          {/* 4 */}
          <section>
            <h2 className="text-xl font-bold text-white mb-3">4. Error monitoring (Sentry)</h2>
            <div className="text-white/70 leading-relaxed space-y-3">
              <p>
                We use Sentry to capture unhandled errors and performance issues.
                Sentry is always active (not consent-gated) because we need it to
                identify crashes that affect users.
              </p>
              <p>
                We have configured Sentry to:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Never send PII (<code className="text-brand-400">sendDefaultPii: false</code>).</li>
                <li>Strip <code className="text-brand-400">Authorization</code> and <code className="text-brand-400">Cookie</code> headers from request contexts.</li>
                <li>Mask all text and block all media in session replays.</li>
                <li>Drop wallet-rejection errors (user-cancelled transactions) — these are not actionable bugs.</li>
              </ul>
              <p>
                Error data is retained for 90 days in Sentry and then deleted.
              </p>
            </div>
          </section>

          {/* 5 */}
          <section>
            <h2 className="text-xl font-bold text-white mb-3">5. Blockchain and IPFS records — what cannot be deleted</h2>
            <div className="text-white/70 leading-relaxed space-y-3">
              <p>
                ElcareHub is built on the Stellar blockchain. Any action you take that
                results in a signed transaction — creating a listing, placing a bid,
                accepting an offer — is permanently recorded on the public blockchain.
                This record cannot be deleted by us or by you.
              </p>
              <p>
                NFT artwork metadata (title, description, image) is stored on IPFS.
                IPFS is a content-addressed, decentralised storage network.
                Once content is pinned and its CID is referenced in a contract, it is
                effectively permanent. We cannot delete content from IPFS on your behalf.
              </p>
              <p>
                If you are a creator, please ensure that artwork metadata you submit
                does not contain personal information you would need to remove later.
              </p>
            </div>
          </section>

          {/* 6 */}
          <section>
            <h2 className="text-xl font-bold text-white mb-3">6. Admin audit logs</h2>
            <div className="text-white/70 leading-relaxed space-y-3">
              <p>
                Privileged administrative actions (moderation, token whitelist changes,
                circuit-breaker toggles, admin key rotation) are recorded as structured
                audit events. These records contain:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>The action name and outcome (success / rejected / failed).</li>
                <li>The pseudonymised admin address prefix (first 4 + last 4 chars).</li>
                <li>The transaction hash if the action produced one.</li>
                <li>The network and contract ID.</li>
              </ul>
              <p>
                Audit events are stored in <code className="text-brand-400">sessionStorage</code> for the
                duration of the admin session. They are cleared on logout, session expiry,
                or browser tab close. They are also forwarded as Sentry breadcrumbs
                for correlation with error reports.
              </p>
              <p>
                No private keys, signatures, raw transaction payloads, or secret values
                are ever recorded in audit events.
              </p>
            </div>
          </section>

          {/* 7 */}
          <section>
            <h2 className="text-xl font-bold text-white mb-3">7. Third-party services</h2>
            <div className="text-white/70 leading-relaxed">
              <ul className="list-disc pl-5 space-y-2">
                <li><strong className="text-white">Stellar / Soroban RPC</strong> — Used to submit and read transactions. All interactions are with the public blockchain.</li>
                <li><strong className="text-white">Pinata / IPFS</strong> — Used to store and serve NFT metadata. Data pinned to IPFS is public and immutable.</li>
                <li><strong className="text-white">PostHog</strong> — Analytics (opt-in only). See section 3.</li>
                <li><strong className="text-white">Sentry</strong> — Error monitoring. See section 4.</li>
                <li><strong className="text-white">Vercel</strong> — Frontend hosting. Vercel may log request metadata per their privacy policy.</li>
                <li><strong className="text-white">Magic.link</strong> — Optional email/passkey wallet. Magic's own privacy policy applies if you choose this login method.</li>
              </ul>
            </div>
          </section>

          {/* 8 */}
          <section>
            <h2 className="text-xl font-bold text-white mb-3">8. Your rights</h2>
            <div className="text-white/70 leading-relaxed space-y-3">
              <p>
                For mutable platform data (indexer records, analytics), you can request
                deletion by contacting us. We will remove your wallet address from our
                indexer database and revoke any associated records where technically possible.
              </p>
              <p>
                For immutable data (blockchain transactions, IPFS-pinned metadata),
                deletion is not technically possible. We will explain which records
                are affected if you make a request.
              </p>
              <p>
                To exercise any privacy right, contact:{" "}
                <a
                  href="mailto:privacy@elcarehub.art"
                  className="text-brand-400 hover:underline"
                >
                  privacy@elcarehub.art
                </a>
              </p>
            </div>
          </section>

          {/* 9 */}
          <section>
            <h2 className="text-xl font-bold text-white mb-3">9. Changes to this policy</h2>
            <p className="text-white/70 leading-relaxed">
              We will update this page when our data practices change and note the
              revision date at the top. Material changes will be announced in the
              application changelog.
            </p>
          </section>

        </div>

        <div className="mt-12 pt-6 border-t border-white/10 flex flex-wrap gap-4 text-sm text-white/40">
          <Link href="/settings" className="hover:text-brand-400 transition-colors">
            Manage Analytics Consent
          </Link>
          <span>·</span>
          <Link href="/help" className="hover:text-brand-400 transition-colors">
            Help & FAQ
          </Link>
        </div>
      </div>
    </div>
  );
}
