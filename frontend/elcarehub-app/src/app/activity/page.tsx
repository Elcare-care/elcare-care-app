// ─────────────────────────────────────────────────────────────
// app/activity/page.tsx — Platform activity feed
//
// Displays recent marketplace events: listings created, sales,
// auctions finalized, offers accepted, etc. Useful for discovery
// and tracking trending activity.
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect } from "react";
import { Activity as ActivityIcon, Clock, TrendingUp } from "lucide-react";
import { Breadcrumb } from "@/components/Breadcrumb";
import { ResourceState } from "@/components/PageStates";

export default function ActivityPage() {
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Placeholder loader
    const timer = setTimeout(() => setIsLoading(false), 800);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 pt-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8">
        <Breadcrumb items={[{ label: "Activity" }]} className="mb-6" />

        <div className="flex items-center gap-3 mb-8">
          <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-brand-500/10">
            <ActivityIcon size={24} className="text-brand-600" />
          </div>
          <div>
            <h1 className="text-2xl font-display font-bold text-gray-900">
              Platform Activity
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Recent marketplace events and trending actions
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-3 animate-pulse">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="h-20 rounded-2xl bg-white border border-gray-100"
              />
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center">
            <TrendingUp size={40} className="mx-auto text-gray-300 mb-3" />
            <h2 className="text-lg font-semibold text-gray-700">
              Activity feed coming soon
            </h2>
            <p className="text-sm text-gray-500 mt-2 max-w-md mx-auto">
              This page will display real-time marketplace activity: new
              listings, sales, bids, and offer acceptances.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
