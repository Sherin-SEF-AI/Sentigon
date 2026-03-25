"use client";

import { useState } from "react";
import {
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  MapPin,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ThresholdAdjustmentViewerProps {
  adjustments: Record<string, Record<string, number>>;
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CARD = "rounded-lg border border-gray-800 bg-gray-900/60 backdrop-blur p-4";

const MAX_BAR_VALUE = 1.0;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatValue(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}

function getBarColor(value: number): {
  bg: string;
  text: string;
  border: string;
} {
  if (value > 0) {
    return {
      bg: "bg-green-500/30",
      text: "text-green-400",
      border: "border-green-700/50",
    };
  }
  if (value < 0) {
    return {
      bg: "bg-red-500/30",
      text: "text-red-400",
      border: "border-red-700/50",
    };
  }
  return {
    bg: "bg-gray-500/30",
    text: "text-gray-400",
    border: "border-gray-700/50",
  };
}

function getDirectionIcon(value: number) {
  if (value > 0) return TrendingUp;
  if (value < 0) return TrendingDown;
  return Minus;
}

/* ------------------------------------------------------------------ */
/*  Adjustment Bar                                                     */
/* ------------------------------------------------------------------ */

function AdjustmentBar({
  name,
  value,
}: {
  name: string;
  value: number;
}) {
  const colors = getBarColor(value);
  const DirectionIcon = getDirectionIcon(value);
  const absValue = Math.abs(value);
  const barWidthPercent = Math.min((absValue / MAX_BAR_VALUE) * 100, 100);

  return (
    <div className="group flex items-center gap-3 py-1.5">
      {/* Label */}
      <div className="flex w-44 shrink-0 items-center gap-2">
        <DirectionIcon
          className={cn("h-3.5 w-3.5 shrink-0", colors.text)}
        />
        <span className="truncate text-xs font-medium text-gray-300">
          {name.replace(/_/g, " ")}
        </span>
      </div>

      {/* Bar container -- centered around midpoint */}
      <div className="relative flex h-6 flex-1 items-center">
        {/* Background track */}
        <div className="absolute inset-0 rounded-md bg-gray-800/50" />

        {/* Center line (baseline = 0) */}
        <div className="absolute left-1/2 top-0 h-full w-px bg-gray-600" />

        {/* Bar -- extends left for negative, right for positive */}
        {value !== 0 && (
          <div
            className={cn(
              "absolute top-1 bottom-1 rounded transition-all duration-300",
              colors.bg,
              value > 0 ? "left-1/2" : "right-1/2"
            )}
            style={{
              width: `${barWidthPercent / 2}%`,
            }}
          />
        )}
      </div>

      {/* Value */}
      <span
        className={cn(
          "w-16 shrink-0 text-right font-mono text-xs font-semibold",
          colors.text
        )}
      >
        {formatValue(value)}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Zone Section                                                       */
/* ------------------------------------------------------------------ */

function ZoneSection({
  zoneId,
  thresholds,
  defaultExpanded = false,
}: {
  zoneId: string;
  thresholds: Record<string, number>;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const entries = Object.entries(thresholds);
  const positiveCount = entries.filter(([, v]) => v > 0).length;
  const negativeCount = entries.filter(([, v]) => v < 0).length;

  return (
    <div
      className={cn(
        "rounded-lg border transition-colors duration-200",
        expanded
          ? "border-gray-700 bg-gray-900/80"
          : "border-gray-800 bg-gray-900/40 hover:bg-gray-900/60"
      )}
    >
      {/* Zone header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-gray-500" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-gray-500" />
        )}

        <MapPin className="h-4 w-4 shrink-0 text-cyan-400" />

        <span className="flex-1 text-sm font-semibold text-gray-200">
          {zoneId}
        </span>

        {/* Summary badges */}
        <div className="flex items-center gap-2">
          {positiveCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded border border-green-800/50 bg-green-900/20 px-2 py-0.5 text-[10px] font-semibold text-green-400">
              <TrendingUp className="h-3 w-3" />
              {positiveCount}
            </span>
          )}
          {negativeCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded border border-red-800/50 bg-red-900/20 px-2 py-0.5 text-[10px] font-semibold text-red-400">
              <TrendingDown className="h-3 w-3" />
              {negativeCount}
            </span>
          )}
          <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] font-medium text-gray-500">
            {entries.length} adjustment{entries.length !== 1 ? "s" : ""}
          </span>
        </div>
      </button>

      {/* Expanded threshold bars */}
      {expanded && (
        <div className="border-t border-gray-800 px-4 py-3 space-y-0.5">
          {entries.length === 0 ? (
            <p className="py-2 text-center text-xs text-gray-600">
              No threshold adjustments for this zone.
            </p>
          ) : (
            <>
              {/* Legend */}
              <div className="mb-2 flex items-center justify-between text-[9px] font-medium uppercase tracking-widest text-gray-600">
                <span>Threshold</span>
                <div className="flex items-center gap-4">
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-sm bg-red-500/40" />
                    Lowered
                  </span>
                  <span className="text-gray-700">|</span>
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-sm bg-green-500/40" />
                    Raised
                  </span>
                  <span className="ml-2">Delta</span>
                </div>
              </div>

              {entries
                .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
                .map(([key, value]) => (
                  <AdjustmentBar key={key} name={key} value={value} />
                ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

export default function ThresholdAdjustmentViewer({
  adjustments,
  className,
}: ThresholdAdjustmentViewerProps) {
  const zoneIds = Object.keys(adjustments);

  const totalAdjustments = zoneIds.reduce(
    (sum, z) => sum + Object.keys(adjustments[z]).length,
    0
  );

  return (
    <div className={cn(CARD, className)}>
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-cyan-400" />
          <h3 className="text-sm font-bold text-gray-200">
            Threshold Adjustments
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-gray-800 px-2.5 py-0.5 text-[10px] font-semibold text-gray-400">
            {zoneIds.length} zone{zoneIds.length !== 1 ? "s" : ""}
          </span>
          <span className="rounded-full bg-cyan-900/30 border border-cyan-800/50 px-2.5 py-0.5 text-[10px] font-semibold text-cyan-400">
            {totalAdjustments} adjustment{totalAdjustments !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* Zone list */}
      {zoneIds.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10">
          <SlidersHorizontal className="mb-2 h-8 w-8 text-gray-700" />
          <p className="text-sm font-medium text-gray-400">
            No threshold adjustments
          </p>
          <p className="mt-1 text-xs text-gray-600">
            Adjustments will appear here when threat context modifies zone thresholds
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {zoneIds.map((zoneId, index) => (
            <ZoneSection
              key={zoneId}
              zoneId={zoneId}
              thresholds={adjustments[zoneId]}
              defaultExpanded={index === 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}
