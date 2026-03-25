"use client";

import { useState } from "react";
import { Clock, Camera, ChevronDown, ChevronRight } from "lucide-react";
import { cn, severityColor, formatTimestamp } from "@/lib/utils";

interface TimelineEvent {
  id: string;
  event_type: string;
  description: string | null;
  severity: string;
  camera_id: string;
  timestamp: string;
}

interface TimelineViewProps {
  events: TimelineEvent[];
  className?: string;
}

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-red-500 shadow-red-500/50",
  high: "bg-orange-500 shadow-orange-500/50",
  medium: "bg-yellow-500 shadow-yellow-500/50",
  low: "bg-blue-400 shadow-blue-400/50",
  info: "bg-gray-400 shadow-gray-400/50",
};

export default function TimelineView({ events, className }: TimelineViewProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (events.length === 0) {
    return (
      <div className={cn("flex flex-col items-center justify-center py-12 text-center", className)}>
        <Clock className="mb-3 h-10 w-10 text-gray-700" />
        <p className="text-sm text-gray-500">No events in timeline</p>
      </div>
    );
  }

  // Sort newest first
  const sorted = [...events].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return (
    <div className={cn("relative pl-6", className)}>
      {/* Vertical line */}
      <div className="absolute left-[11px] top-0 bottom-0 w-0.5 bg-gray-700" />

      <div className="space-y-4">
        {sorted.map((event) => {
          const isExpanded = expandedId === event.id;
          return (
            <div key={event.id} className="relative">
              {/* Dot */}
              <div
                className={cn(
                  "absolute -left-6 top-3 h-3 w-3 rounded-full shadow-sm",
                  SEVERITY_DOT[event.severity] || SEVERITY_DOT.info
                )}
              />

              {/* Card */}
              <button
                onClick={() => setExpandedId(isExpanded ? null : event.id)}
                className="w-full rounded-lg border border-gray-800 bg-gray-900/60 p-3 text-left transition-colors hover:bg-gray-900"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {isExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-500" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-500" />
                    )}
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                        severityColor(event.severity)
                      )}
                    >
                      {event.event_type}
                    </span>
                  </div>
                  <span className="flex items-center gap-1 text-[10px] text-gray-500 font-mono shrink-0">
                    <Clock className="h-3 w-3" />
                    {formatTimestamp(event.timestamp)}
                  </span>
                </div>

                {event.description && (
                  <p
                    className={cn(
                      "mt-2 text-xs leading-relaxed text-gray-400",
                      !isExpanded && "line-clamp-2"
                    )}
                  >
                    {event.description}
                  </p>
                )}

                <div className="mt-2 flex items-center gap-1 text-[10px] text-gray-600">
                  <Camera className="h-3 w-3" />
                  <span>{event.camera_id.slice(0, 8)}</span>
                </div>
              </button>

              {/* Expanded details */}
              {isExpanded && (
                <div className="mt-1 ml-5 rounded-lg border border-gray-800 bg-gray-900/40 p-3 space-y-2">
                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                    <div>
                      <span className="text-gray-600 uppercase">Event ID</span>
                      <p className="text-gray-400 font-mono">{event.id.slice(0, 12)}</p>
                    </div>
                    <div>
                      <span className="text-gray-600 uppercase">Camera</span>
                      <p className="text-gray-400 font-mono">{event.camera_id}</p>
                    </div>
                    <div>
                      <span className="text-gray-600 uppercase">Severity</span>
                      <p className={severityColor(event.severity)}>{event.severity}</p>
                    </div>
                    <div>
                      <span className="text-gray-600 uppercase">Timestamp</span>
                      <p className="text-gray-400">
                        {new Date(event.timestamp).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  {event.description && (
                    <div>
                      <span className="text-[10px] text-gray-600 uppercase">
                        Full Description
                      </span>
                      <p className="mt-1 text-xs leading-relaxed text-gray-300">
                        {event.description}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
