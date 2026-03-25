"use client";

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <div
      className={`animate-pulse bg-zinc-800 rounded ${className}`}
    />
  );
}

interface SkeletonTextProps {
  lines?: number;
  className?: string;
}

const LINE_WIDTHS = ["w-full", "w-11/12", "w-4/5", "w-9/12", "w-10/12", "w-3/4"];

export function SkeletonText({ lines = 3, className = "" }: SkeletonTextProps) {
  return (
    <div className={`space-y-2.5 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={`h-3 ${LINE_WIDTHS[i % LINE_WIDTHS.length]}`}
        />
      ))}
    </div>
  );
}

interface SkeletonCardProps {
  className?: string;
  showFooter?: boolean;
}

export function SkeletonCard({ className = "", showFooter = false }: SkeletonCardProps) {
  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-900 p-4 ${className}`}>
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <Skeleton className="w-10 h-10 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-2.5 w-1/4" />
        </div>
      </div>

      {/* Body text lines */}
      <SkeletonText lines={3} className="mb-4" />

      {/* Footer */}
      {showFooter && (
        <div className="flex items-center justify-between pt-3 border-t border-zinc-800">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-16 rounded-md" />
        </div>
      )}
    </div>
  );
}

interface SkeletonChartProps {
  bars?: number;
  className?: string;
}

export function SkeletonChart({ bars = 7, className = "" }: SkeletonChartProps) {
  const BAR_HEIGHTS = ["h-12", "h-20", "h-16", "h-24", "h-10", "h-28", "h-18", "h-14", "h-22"];

  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-900 p-4 ${className}`}>
      {/* Chart title */}
      <Skeleton className="h-4 w-32 mb-6" />

      {/* Bars */}
      <div className="flex items-end gap-2 h-32">
        {Array.from({ length: bars }).map((_, i) => (
          <Skeleton
            key={i}
            className={`flex-1 ${BAR_HEIGHTS[i % BAR_HEIGHTS.length]} rounded-t`}
          />
        ))}
      </div>

      {/* X-axis labels */}
      <div className="flex gap-2 mt-2">
        {Array.from({ length: bars }).map((_, i) => (
          <Skeleton key={i} className="flex-1 h-2" />
        ))}
      </div>
    </div>
  );
}

interface SkeletonTableProps {
  rows?: number;
  columns?: number;
  className?: string;
}

export function SkeletonTable({ rows = 5, columns = 4, className = "" }: SkeletonTableProps) {
  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden ${className}`}>
      {/* Header row */}
      <div className="flex gap-4 p-3 border-b border-zinc-800 bg-zinc-800/50">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="flex-1 h-3" />
        ))}
      </div>

      {/* Data rows */}
      {Array.from({ length: rows }).map((_, rowIdx) => (
        <div
          key={rowIdx}
          className="flex gap-4 p-3 border-b border-zinc-800/50 last:border-b-0"
        >
          {Array.from({ length: columns }).map((_, colIdx) => (
            <Skeleton
              key={colIdx}
              className={`flex-1 h-3 ${
                colIdx === 0 ? "w-2/3" : ""
              }`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

interface SkeletonVideoProps {
  className?: string;
}

export function SkeletonVideo({ className = "" }: SkeletonVideoProps) {
  return (
    <div
      className={`relative rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden aspect-video ${className}`}
    >
      <Skeleton className="absolute inset-0 rounded-none" />

      {/* Play icon */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="w-12 h-12 rounded-full bg-zinc-700/50 flex items-center justify-center animate-pulse">
          <svg
            className="w-5 h-5 text-zinc-500 ml-0.5"
            fill="currentColor"
            viewBox="0 0 24 24"
          >
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-zinc-900/80">
        <div className="flex items-center gap-2">
          <Skeleton className="w-2 h-2 rounded-full" />
          <Skeleton className="flex-1 h-1.5" />
          <Skeleton className="w-10 h-2.5" />
        </div>
      </div>
    </div>
  );
}
