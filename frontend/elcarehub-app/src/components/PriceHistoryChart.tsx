/**
 * PriceHistoryChart — SVG sparkline + price-change table for a listing.
 *
 * Renders without any external charting library: pure SVG path
 * constructed from normalised (x, y) coordinates, plus an accessible
 * HTML table of all historical price changes with dates and delta badges.
 *
 * Props:
 *  - points     Array of PriceHistoryPoint data points from the indexer
 *  - isLoading  Show a skeleton whilst data is loading
 *  - error      Error message to display
 *  - className  Optional extra Tailwind classes for the wrapper
 */

"use client";

import React, { useMemo, useState } from "react";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Loader2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { PriceHistoryPoint } from "@/lib/indexer";

// ── Helpers ───────────────────────────────────────────────────────────────────

function stroopStringToXlm(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? n / 10_000_000 : 0;
}

function formatXlm(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ── SVG Sparkline builder ─────────────────────────────────────────────────────

interface SparklineData {
  path: string;
  fillPath: string;
  dots: Array<{ cx: number; cy: number; price: number; ts: number }>;
  trend: "up" | "down" | "flat";
  minPrice: number;
  maxPrice: number;
  firstPrice: number;
  lastPrice: number;
}

function buildSparkline(
  points: PriceHistoryPoint[],
  width: number,
  height: number,
  padding: number
): SparklineData | null {
  if (points.length < 2) return null;

  const prices = points.map((p) => stroopStringToXlm(p.price));
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const priceRange = maxP - minP || 1;

  const innerW = width - padding * 2;
  const innerH = height - padding * 2;

  const coords = points.map((p, i) => {
    const x = padding + (i / (points.length - 1)) * innerW;
    const y = padding + (1 - (prices[i] - minP) / priceRange) * innerH;
    return { x, y, price: prices[i], ts: p.timestamp };
  });

  const path = coords
    .map(
      (c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(2)},${c.y.toFixed(2)}`
    )
    .join(" ");

  const fillPath = [
    path,
    `L ${coords[coords.length - 1].x.toFixed(2)},${(
      height - padding
    ).toFixed(2)}`,
    `L ${coords[0].x.toFixed(2)},${(height - padding).toFixed(2)}`,
    "Z",
  ].join(" ");

  const firstPrice = prices[0];
  const lastPrice = prices[prices.length - 1];
  const diff = lastPrice - firstPrice;
  const trend: "up" | "down" | "flat" =
    diff > 0.0001 ? "up" : diff < -0.0001 ? "down" : "flat";

  return {
    path,
    fillPath,
    dots: coords.map((c) => ({ cx: c.x, cy: c.y, price: c.price, ts: c.ts })),
    trend,
    minPrice: minP,
    maxPrice: maxP,
    firstPrice,
    lastPrice,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

interface PriceHistoryChartProps {
  points: PriceHistoryPoint[];
  isLoading?: boolean;
  error?: string | null;
  className?: string;
}

const SVG_W = 320;
const SVG_H = 80;
const PADDING = 8;
const TABLE_PREVIEW_ROWS = 5;

export function PriceHistoryChart({
  points,
  isLoading = false,
  error = null,
  className = "",
}: PriceHistoryChartProps) {
  const [tableExpanded, setTableExpanded] = useState(false);

  const sparkline = useMemo(
    () => buildSparkline(points, SVG_W, SVG_H, PADDING),
    [points]
  );

  const trendColor =
    sparkline?.trend === "up"
      ? {
          stroke: "#68d9b3",
          fill: "url(#sparkGradientUp)",
          text: "text-mint-400",
        }
      : sparkline?.trend === "down"
      ? {
          stroke: "#e27d60",
          fill: "url(#sparkGradientDown)",
          text: "text-terracotta-400",
        }
      : {
          stroke: "#9ca3af",
          fill: "url(#sparkGradientFlat)",
          text: "text-white/40",
        };

  const pctChange =
    sparkline && sparkline.firstPrice > 0
      ? (
          ((sparkline.lastPrice - sparkline.firstPrice) /
            sparkline.firstPrice) *
          100
        ).toFixed(1)
      : null;

  const visibleRows = tableExpanded ? points : points.slice(0, TABLE_PREVIEW_ROWS);
  const hasMoreRows = points.length > TABLE_PREVIEW_ROWS;

  return (
    <div
      className={`rounded-2xl bg-white/5 border border-white/5 p-4 space-y-4 ${className}`}
      data-testid="price-history-chart"
    >
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.25em] font-bold text-white/40">
          Price History
        </span>
        {sparkline && pctChange !== null && (
          <span
            className={`flex items-center gap-1 text-xs font-bold ${trendColor.text}`}
            data-testid="price-change-badge"
          >
            {sparkline.trend === "up" ? (
              <TrendingUp size={13} />
            ) : sparkline.trend === "down" ? (
              <TrendingDown size={13} />
            ) : (
              <Minus size={13} />
            )}
            {sparkline.trend === "up" ? "+" : ""}
            {pctChange}%
          </span>
        )}
      </div>

      {/* ── Chart area ── */}
      {isLoading ? (
        <div
          className="flex items-center justify-center"
          style={{ height: SVG_H }}
          data-testid="price-chart-loading"
        >
          <Loader2 size={20} className="animate-spin text-brand-400/60" />
        </div>
      ) : error ? (
        <div
          className="flex items-center justify-center text-[11px] text-terracotta-400/70 italic"
          style={{ height: SVG_H }}
          data-testid="price-chart-error"
        >
          {error}
        </div>
      ) : !sparkline ? (
        <div
          className="flex items-center justify-center text-[11px] text-white/20 italic"
          style={{ height: SVG_H }}
          data-testid="price-chart-empty"
        >
          Not enough price data yet
        </div>
      ) : (
        <>
          <svg
            width="100%"
            viewBox={`0 0 ${SVG_W} ${SVG_H}`}
            aria-label="Price history sparkline"
            role="img"
            data-testid="price-sparkline-svg"
            className="overflow-visible"
          >
            <defs>
              <linearGradient
                id="sparkGradientUp"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor="#68d9b3" stopOpacity="0.25" />
                <stop offset="100%" stopColor="#68d9b3" stopOpacity="0" />
              </linearGradient>
              <linearGradient
                id="sparkGradientDown"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor="#e27d60" stopOpacity="0.25" />
                <stop offset="100%" stopColor="#e27d60" stopOpacity="0" />
              </linearGradient>
              <linearGradient
                id="sparkGradientFlat"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor="#9ca3af" stopOpacity="0.15" />
                <stop offset="100%" stopColor="#9ca3af" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Fill area under the line */}
            <path
              d={sparkline.fillPath}
              fill={trendColor.fill}
              data-testid="sparkline-fill"
            />

            {/* Sparkline */}
            <path
              d={sparkline.path}
              fill="none"
              stroke={trendColor.stroke}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              data-testid="sparkline-path"
            />

            {/* Dots — first and last only */}
            {[
              sparkline.dots[0],
              sparkline.dots[sparkline.dots.length - 1],
            ].map((dot, i) => (
              <circle
                key={i}
                cx={dot.cx}
                cy={dot.cy}
                r={3}
                fill={trendColor.stroke}
                stroke="rgba(0,0,0,0.3)"
                strokeWidth={1}
                data-testid={
                  i === 0 ? "sparkline-dot-first" : "sparkline-dot-last"
                }
              />
            ))}
          </svg>

          {/* Min / Max labels */}
          <div className="flex justify-between mt-2">
            <div className="text-[10px] text-white/30 font-mono">
              <span className="text-white/20 mr-1">Low</span>
              {formatXlm(sparkline.minPrice)} XLM
            </div>
            <div className="text-[10px] text-white/30 font-mono text-right">
              <span className="text-white/20 mr-1">High</span>
              {formatXlm(sparkline.maxPrice)} XLM
            </div>
          </div>

          {/* Date range */}
          <div className="flex justify-between mt-1">
            <span className="text-[9px] text-white/20 font-mono">
              {formatDate(sparkline.dots[0].ts)}
            </span>
            <span className="text-[9px] text-white/20 font-mono">
              {formatDate(sparkline.dots[sparkline.dots.length - 1].ts)}
            </span>
          </div>
        </>
      )}

      {/* ── Price change table ── */}
      {!isLoading && !error && points.length > 0 && (
        <div
          className="border-t border-white/5 pt-3"
          data-testid="price-history-table"
        >
          <table
            className="w-full text-[11px]"
            aria-label="Price change history"
          >
            <thead>
              <tr className="text-white/30 uppercase tracking-wider">
                <th className="text-left font-bold pb-2">Date</th>
                <th className="text-right font-bold pb-2">Old Price</th>
                <th className="text-right font-bold pb-2">New Price</th>
                <th className="text-right font-bold pb-2">Change</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((pt, i) => {
                const newXlm = stroopStringToXlm(pt.price);
                const oldXlm = pt.oldPrice
                  ? stroopStringToXlm(pt.oldPrice)
                  : null;
                const delta =
                  oldXlm !== null && oldXlm > 0
                    ? ((newXlm - oldXlm) / oldXlm) * 100
                    : null;
                const isUp = delta !== null && delta > 0.001;
                const isDown = delta !== null && delta < -0.001;

                return (
                  <tr
                    key={i}
                    className="border-t border-white/5 hover:bg-white/5 transition-colors"
                    data-testid="price-history-row"
                  >
                    <td className="py-2 text-white/50 font-mono">
                      {formatDate(pt.timestamp)}
                    </td>
                    <td className="py-2 text-right text-white/40 font-mono">
                      {oldXlm !== null ? `${formatXlm(oldXlm)} XLM` : "—"}
                    </td>
                    <td className="py-2 text-right text-white font-mono font-semibold">
                      {formatXlm(newXlm)} XLM
                    </td>
                    <td className="py-2 text-right">
                      {delta !== null ? (
                        <span
                          className={`inline-flex items-center gap-0.5 font-bold ${
                            isUp
                              ? "text-mint-400"
                              : isDown
                              ? "text-terracotta-400"
                              : "text-white/30"
                          }`}
                          data-testid="price-delta-badge"
                        >
                          {isUp ? (
                            <TrendingUp size={10} />
                          ) : isDown ? (
                            <TrendingDown size={10} />
                          ) : (
                            <Minus size={10} />
                          )}
                          {isUp ? "+" : ""}
                          {delta.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-white/20">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {hasMoreRows && (
            <button
              onClick={() => setTableExpanded((v) => !v)}
              className="mt-2 w-full flex items-center justify-center gap-1 text-[10px] text-white/30 hover:text-white/60 transition-colors py-1"
              aria-expanded={tableExpanded}
              data-testid="price-table-expand-btn"
            >
              {tableExpanded ? (
                <>
                  <ChevronUp size={12} /> Show less
                </>
              ) : (
                <>
                  <ChevronDown size={12} /> Show {points.length - TABLE_PREVIEW_ROWS} more
                </>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
