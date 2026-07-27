/**
 * SocialShare — share buttons for a listing detail page.
 *
 * Provides:
 *  1. Twitter/X share button — opens a tweet pre-populated with
 *     the artwork title, price, and URL.
 *  2. Copy-link button — copies the listing URL to clipboard with
 *     momentary "Copied!" feedback.
 *
 * Props:
 *  - title     Artwork title (shown in the tweet text)
 *  - price     Price string to include in the tweet (e.g. "12.5 XLM")
 *  - url       Full URL to share (defaults to window.location.href)
 *  - className Extra Tailwind classes for the wrapper
 */

"use client";

import React, { useState, useCallback } from "react";
import { Share2, Check, Copy } from "lucide-react";

// ── Twitter icon (not in lucide-react v0.396) ─────────────────────────────────

function TwitterXIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.265 5.636L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
    </svg>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildTweetUrl(title: string, price: string, listingUrl: string): string {
  const text = price
    ? `Check out "${title}" — ${price} on Elcare-Hub 🎨`
    : `Check out "${title}" on Elcare-Hub 🎨`;
  const params = new URLSearchParams({
    text,
    url: listingUrl,
    via: "ElcareHub",
  });
  return `https://twitter.com/intent/tweet?${params.toString()}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface SocialShareProps {
  title: string;
  price?: string;
  url?: string;
  className?: string;
}

export function SocialShare({ title, price = "", url, className = "" }: SocialShareProps) {
  const [copied, setCopied] = useState(false);

  const resolveUrl = useCallback((): string => {
    if (url) return url;
    if (typeof window !== "undefined") return window.location.href;
    return "";
  }, [url]);

  const handleCopyLink = useCallback(async () => {
    const target = resolveUrl();
    try {
      await navigator.clipboard.writeText(target);
    } catch {
      // Clipboard API may be blocked — no-op
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [resolveUrl]);

  const handleTwitterShare = useCallback(() => {
    const target = resolveUrl();
    const tweetUrl = buildTweetUrl(title, price, target);
    window.open(tweetUrl, "_blank", "noopener,noreferrer,width=550,height=420");
  }, [title, price, resolveUrl]);

  return (
    <div
      className={`flex items-center gap-2 ${className}`}
      data-testid="social-share"
    >
      {/* Twitter / X */}
      <button
        type="button"
        onClick={handleTwitterShare}
        aria-label={`Share "${title}" on X (Twitter)`}
        data-testid="share-twitter-btn"
        className="flex items-center gap-2 h-11 px-4 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-xs font-bold text-white/60 hover:text-white transition-all"
      >
        <TwitterXIcon size={14} />
        <span className="hidden sm:inline">Share</span>
      </button>

      {/* Copy link */}
      <button
        type="button"
        onClick={handleCopyLink}
        aria-label="Copy listing link to clipboard"
        data-testid="share-copy-btn"
        className="flex items-center gap-2 h-11 px-4 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-xs font-bold transition-all"
        aria-pressed={copied}
      >
        {copied ? (
          <>
            <Check size={14} className="text-mint-400" />
            <span className="text-mint-400">Copied!</span>
          </>
        ) : (
          <>
            <Copy size={14} className="text-white/60" />
            <span className="text-white/60 hidden sm:inline">Copy link</span>
          </>
        )}
      </button>
    </div>
  );
}
