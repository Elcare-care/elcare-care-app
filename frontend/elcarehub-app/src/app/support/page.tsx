/**
 * app/support/page.tsx
 *
 * Work item B — Support center landing page.
 * Displays the report form with category guidance, SLA expectations,
 * and clear documentation of what the platform can and cannot resolve.
 */

"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { LifeBuoy, Info, ExternalLink } from "lucide-react";
import { SupportForm } from "@/components/SupportForm";
import type { SupportFormContext } from "@/components/SupportForm";

function SupportPageContent() {
  const params = useSearchParams();

  const context: SupportFormContext = {
    listingId:         params.get("listing_id")          ?? undefined,
    auctionId:         params.get("auction_id")          ?? undefined,
    txHash:            params.get("tx")                  ?? undefined,
    ipfsCid:           params.get("cid")                 ?? undefined,
    collectionAddress: params.get("collection")          ?? undefined,
  };

  return (
    <div className="min-h-screen bg-midnight-950 pt-24 pb-16">
      <div className="mx-auto max-w-2xl px-4 sm:px-6">

        {/* Header */}
        <div className="mb-8 space-y-2">
          <div className="flex items-center gap-3">
            <LifeBuoy className="h-6 w-6 text-brand-400" aria-hidden="true" />
            <h1 className="text-3xl font-bold text-white">Support Center</h1>
          </div>
          <p className="text-gray-400">
            Report an issue with a listing, auction, collection, or transaction.
            We review every report and respond based on the category SLA below.
          </p>
        </div>

        {/* Platform limits info box */}
        <div className="mb-8 rounded-2xl border border-brand-500/20 bg-brand-500/5 p-5 space-y-3">
          <div className="flex items-start gap-3">
            <Info className="h-5 w-5 text-brand-400 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-2 text-sm text-gray-300">
              <p className="font-semibold text-white">What this platform can and cannot do</p>
              <ul className="space-y-1 list-disc list-inside text-gray-400">
                <li>We can hide content from our UI, block addresses, and fix display bugs.</li>
                <li>We cannot reverse confirmed on-chain transactions — blockchain transfers are irreversible.</li>
                <li>We cannot delete content from IPFS gateways we do not control.</li>
                <li>We cannot access or modify wallet contents, private keys, or seed phrases.</li>
              </ul>
              <a
                href="/help"
                className="inline-flex items-center gap-1 text-brand-400 underline hover:text-brand-300 text-xs"
              >
                Read the full Help & Limitations guide <ExternalLink size={11} aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>

        {/* Context banner (when linked from a resource page) */}
        {(context.listingId || context.auctionId || context.txHash || context.collectionAddress) && (
          <div className="mb-6 rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-gray-300">
            <span className="font-semibold text-white">Reporting context pre-filled: </span>
            {context.listingId    && <span>Listing #{context.listingId} </span>}
            {context.auctionId    && <span>Auction #{context.auctionId} </span>}
            {context.txHash       && <span className="font-mono">Tx {context.txHash.slice(0, 12)}… </span>}
            {context.collectionAddress && <span className="font-mono">{context.collectionAddress.slice(0, 10)}… </span>}
          </div>
        )}

        {/* Form */}
        <div className="bg-midnight-900 border border-white/5 rounded-2xl p-6">
          <SupportForm context={context} />
        </div>

        {/* Response policy summary */}
        <div className="mt-8 space-y-3">
          <h2 className="text-lg font-semibold text-white">Response Policy</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            {[
              { label: 'Spam or Scam',           sla: '4 h',   color: 'text-red-400' },
              { label: 'Display Bug',            sla: '8 h',   color: 'text-orange-400' },
              { label: 'Unauthorized Listing',   sla: '24 h',  color: 'text-yellow-400' },
              { label: 'Transaction Confusion',  sla: '24 h',  color: 'text-yellow-400' },
              { label: 'Metadata Dispute',       sla: '48 h',  color: 'text-blue-400' },
              { label: 'IPFS Availability',      sla: '48 h',  color: 'text-blue-400' },
              { label: 'Other',                  sla: '72 h',  color: 'text-gray-400' },
            ].map(({ label, sla, color }) => (
              <div key={label} className="flex justify-between items-center rounded-lg bg-white/5 px-4 py-2">
                <span className="text-gray-300">{label}</span>
                <span className={`font-semibold ${color}`}>{sla}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-500">
            SLAs are first-response targets during business hours. Resolution time depends on category complexity.
            Reports are triaged in the order received. Escalated issues may involve chain explorers
            or legal review and can take longer.
          </p>
        </div>

      </div>
    </div>
  );
}

export default function SupportPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-midnight-950 pt-24 flex items-center justify-center">
        <p className="text-gray-400">Loading support center…</p>
      </div>
    }>
      <SupportPageContent />
    </Suspense>
  );
}
