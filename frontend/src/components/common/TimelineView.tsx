"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

export interface TimelineEvent {
  id: string;
  timestamp: string;
  title: string;
  description?: string;
  type?: string;
  severity?: "critical" | "high" | "medium" | "low" | "info";
  icon?: React.ReactNode;
  metadata?: Record<string, string>;
}

interface TimelineViewProps {
  events: TimelineEvent[];
  /** Compact mode - single line per event */
  compact?: boolean;
  /** Max visible events before "Show More" */
  maxVisible?: number;
  /** Click handler */
  onEventClick?: (event: TimelineEvent) => void;
}

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-red-500 ring-red-500/30",
  high: "bg-orange-500 ring-orange-500/30",
  medium: "bg-amber-500 ring-amber-500/30",
  low: "bg-blue-500 ring-blue-500/30",
  info: "bg-gray-500 ring-gray-500/30",
};

const SEVERITY_LINE: Record<string, string> = {
  critical: "border-red-800",
  high: "border-orange-800",
  medium: "border-amber-800",
  low: "border-blue-800",
  info: "border-gray-800",
};

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return ts;
  }
}

function formatDate(ts: string): string {
  try {
    return new Date(ts).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

export default function TimelineView({
  events,
  compact = false,
  maxVisible = 20,
  onEventClick,
}: TimelineViewProps) {
  const [expanded, setExpanded] = useState(false);
  const sorted = [...events].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  const visible = expanded ? sorted : sorted.slice(0, maxVisible);
  const hasMore = sorted.length > maxVisible;

  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-800 bg-gray-900/20 px-4 py-6 text-center">
        <p className="text-xs text-gray-600">No timeline events</p>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Vertical line */}
      <div className="absolute left-3 top-3 bottom-3 w-px bg-gray-800" />

      <div className="space-y-0">
        {visible.map((event, idx) => {
          const sev = event.severity || "info";
          const dotClass = SEVERITY_DOT[sev] || SEVERITY_DOT.info;

          return (
            <div
              key={event.id}
              className={`relative flex gap-3 pl-1 ${
                onEventClick
                  ? "cursor-pointer hover:bg-gray-900/60 rounded-lg"
                  : ""
              } ${compact ? "py-1" : "py-2"}`}
              onClick={() => onEventClick?.(event)}
            >
              {/* Dot */}
              <div className="relative z-10 flex items-start pt-1">
                <div
                  className={`h-2.5 w-2.5 rounded-full ring-2 shrink-0 ${dotClass}`}
                />
              </div>

              {/* Content */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  {event.icon && (
                    <span className="text-gray-500">{event.icon}</span>
                  )}
                  <span className="text-xs font-medium text-gray-200 truncate">
                    {event.title}
                  </span>
                  {event.type && (
                    <span className="text-[9px] rounded-full border border-gray-700 bg-gray-800 px-1.5 py-0.5 text-gray-500 uppercase tracking-wider">
                      {event.type}
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-gray-600 tabular-nums shrink-0">
                    {formatDate(event.timestamp)} {formatTime(event.timestamp)}
                  </span>
                </div>

                {!compact && event.description && (
                  <p className="mt-0.5 text-[11px] text-gray-500 line-clamp-2">
                    {event.description}
                  </p>
                )}

                {!compact && event.metadata && Object.keys(event.metadata).length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-2">
                    {Object.entries(event.metadata).map(([k, v]) => (
                      <span
                        key={k}
                        className="text-[9px] text-gray-600"
                      >
                        <span className="text-gray-500">{k}:</span> {v}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {hasMore && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-2 flex items-center gap-1 text-[10px] text-cyan-500 hover:text-cyan-400 transition-colors pl-7"
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3 w-3" /> Show less
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" /> Show {sorted.length - maxVisible} more
            </>
          )}
        </button>
      )}
    </div>
  );
}
