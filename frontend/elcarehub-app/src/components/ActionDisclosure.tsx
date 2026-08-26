"use client";

/**
 * components/ActionDisclosure.tsx
 *
 * Work item C — Plain-language disclosure panel shown before irreversible
 * financial actions (purchase, bid, offer, mint, deploy).
 *
 * Accessibility:
 *   • role="group" with aria-labelledby ties the checkbox to the disclosure
 *   • The checkbox has aria-required and aria-describedby pointing at the list
 *   • The disclosure notice persists until dismissed; it cannot be bypassed
 *     by direct route navigation (the parent component must check blocksAction)
 *
 * Usage:
 *   const { blocksAction, acknowledged, acknowledge, disclosure } = useDisclosure('purchase');
 *
 *   <ActionDisclosure
 *     disclosure={disclosure}
 *     acknowledged={acknowledged}
 *     onAcknowledge={acknowledge}
 *   />
 *   <button disabled={blocksAction}>Pay</button>
 */

import { useId } from "react";
import { ExternalLink, ShieldAlert, Info } from "lucide-react";
import { DisclosureRecord } from "@/lib/disclosures";

interface ActionDisclosureProps {
  disclosure: DisclosureRecord;
  acknowledged: boolean;
  onAcknowledge: () => void;
  /** Extra className for outer wrapper */
  className?: string;
}

export function ActionDisclosure({
  disclosure,
  acknowledged,
  onAcknowledge,
  className = "",
}: ActionDisclosureProps) {
  const id = useId();
  const listId   = `${id}-risks`;
  const checkId  = `${id}-ack`;
  const titleId  = `${id}-title`;

  // Informational-only (no checkbox required)
  if (!disclosure.requiresAcknowledgement) {
    return (
      <div
        className={`rounded-xl border border-brand-500/20 bg-brand-500/5 p-4 space-y-3 ${className}`}
        data-testid={`disclosure-${disclosure.id}`}
        aria-label={disclosure.title}
      >
        <div className="flex items-start gap-2">
          <Info size={16} className="text-brand-400 shrink-0 mt-0.5" aria-hidden="true" />
          <p className="text-sm font-semibold text-brand-300">{disclosure.title}</p>
        </div>
        <ul id={listId} className="space-y-1.5 pl-2">
          {disclosure.risks.map((risk, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-gray-400">
              <span aria-hidden="true" className="mt-1 shrink-0 text-brand-400">•</span>
              {risk}
            </li>
          ))}
        </ul>
        <a
          href={disclosure.policyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-brand-400 underline hover:text-brand-300"
        >
          Full policy <ExternalLink size={10} aria-hidden="true" />
        </a>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className={`rounded-xl border ${
        acknowledged ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'
      } p-4 space-y-3 transition-colors ${className}`}
      data-testid={`disclosure-${disclosure.id}`}
    >
      {/* Header */}
      <div className="flex items-start gap-2">
        <ShieldAlert
          size={16}
          className={`shrink-0 mt-0.5 ${acknowledged ? 'text-green-600' : 'text-amber-600'}`}
          aria-hidden="true"
        />
        <p
          id={titleId}
          className={`text-sm font-semibold ${acknowledged ? 'text-green-800' : 'text-amber-800'}`}
        >
          {disclosure.title}
        </p>
      </div>

      {/* Risk list */}
      <ul id={listId} className="space-y-1.5 pl-2" aria-label="Risks and disclosures">
        {disclosure.risks.map((risk, i) => (
          <li key={i} className={`flex items-start gap-2 text-xs ${acknowledged ? 'text-green-700' : 'text-amber-700'}`}>
            <span aria-hidden="true" className="mt-1 shrink-0">•</span>
            {risk}
          </li>
        ))}
      </ul>

      {/* Policy link */}
      <a
        href={disclosure.policyUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center gap-1 text-xs underline ${acknowledged ? 'text-green-600 hover:text-green-800' : 'text-amber-600 hover:text-amber-800'}`}
      >
        Full policy <ExternalLink size={10} aria-hidden="true" />
      </a>

      {/* Acknowledgement checkbox */}
      <div className="flex items-start gap-3 pt-1 border-t border-current/10">
        <input
          type="checkbox"
          id={checkId}
          checked={acknowledged}
          onChange={(e) => { if (e.target.checked) onAcknowledge(); }}
          aria-required="true"
          aria-describedby={listId}
          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500 cursor-pointer shrink-0"
          data-testid={`disclosure-checkbox-${disclosure.id}`}
        />
        <label htmlFor={checkId} className={`text-xs cursor-pointer ${acknowledged ? 'text-green-700' : 'text-amber-700'}`}>
          I understand the risks above and wish to proceed.
        </label>
      </div>
    </div>
  );
}
