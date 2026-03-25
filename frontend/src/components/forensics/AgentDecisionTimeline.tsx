"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Brain,
  ChevronDown,
  Clock,
  Loader2,
  MessageSquare,
  Send,
  Wrench,
  Zap,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AgentAction {
  id: string;
  timestamp: string;
  offset_seconds?: number;
  agent_name: string;
  action_type: "tool_call" | "decision" | "message_sent" | string;
  tool_name: string | null;
  tool_params: Record<string, unknown> | null;
  decision_summary: string;
  response_summary: string | null;
  latency_ms: number | null;
}

interface AgentDecisionTimelineProps {
  incidentId: string;
  currentOffset?: number;
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CARD = "rounded-lg border border-gray-800 bg-gray-900/60 backdrop-blur p-4";

const ACTION_ICONS: Record<string, typeof Wrench> = {
  tool_call: Wrench,
  decision: Brain,
  message_sent: Send,
};

const ACTION_COLORS: Record<string, { icon: string; dot: string; border: string }> = {
  tool_call: {
    icon: "text-blue-400",
    dot: "bg-blue-400 shadow-blue-400/50",
    border: "border-blue-800/40",
  },
  decision: {
    icon: "text-purple-400",
    dot: "bg-purple-400 shadow-purple-400/50",
    border: "border-purple-800/40",
  },
  message_sent: {
    icon: "text-cyan-400",
    dot: "bg-cyan-400 shadow-cyan-400/50",
    border: "border-cyan-800/40",
  },
};

const DEFAULT_ACTION_COLOR = {
  icon: "text-gray-400",
  dot: "bg-gray-400 shadow-gray-400/50",
  border: "border-gray-700/40",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatOffsetTime(seconds: number | undefined): string {
  if (seconds == null) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/*  ActionEntry                                                        */
/* ------------------------------------------------------------------ */

function ActionEntry({
  action,
  isActive,
  expanded,
  onToggle,
}: {
  action: AgentAction;
  isActive: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const colors = ACTION_COLORS[action.action_type] || DEFAULT_ACTION_COLOR;
  const Icon = ACTION_ICONS[action.action_type] || Zap;
  const entryRef = useRef<HTMLDivElement>(null);

  /* Auto-scroll into view when active */
  useEffect(() => {
    if (isActive && entryRef.current) {
      entryRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [isActive]);

  return (
    <div ref={entryRef} className="relative flex gap-3">
      {/* Dot on vertical line */}
      <div className="relative flex flex-col items-center">
        <div
          className={cn(
            "h-3.5 w-3.5 rounded-full border-2 shadow-sm transition-all duration-200",
            colors.dot,
            isActive
              ? "scale-125 ring-2 ring-cyan-400/40 border-cyan-400"
              : "border-gray-900"
          )}
        />
        {/* Connecting line */}
        <div className="flex-1 w-0.5 bg-gray-800" />
      </div>

      {/* Content */}
      <div
        className={cn(
          "mb-3 flex-1 rounded-lg border transition-all duration-200 cursor-pointer",
          isActive
            ? "border-cyan-700/60 bg-cyan-950/20 ring-1 ring-cyan-800/30"
            : cn("bg-gray-900/40 hover:bg-gray-900/60", colors.border)
        )}
      >
        <button onClick={onToggle} className="w-full px-3 py-2.5 text-left">
          {/* Header row */}
          <div className="flex items-center gap-2">
            <Icon className={cn("h-3.5 w-3.5 shrink-0", colors.icon)} />

            {/* Agent badge */}
            <span className="shrink-0 rounded bg-gray-800/80 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-400">
              {action.agent_name}
            </span>

            {/* Action type badge */}
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                colors.icon,
                "bg-gray-800/40"
              )}
            >
              {action.action_type.replace("_", " ")}
            </span>

            {/* Tool name */}
            {action.tool_name && (
              <span className="shrink-0 font-mono text-[10px] text-blue-300/80">
                {action.tool_name}
              </span>
            )}

            <span className="flex-1" />

            {/* Offset timestamp */}
            <span className="flex items-center gap-1 shrink-0 text-[10px] font-mono text-gray-500">
              <Clock className="h-2.5 w-2.5" />
              +{formatOffsetTime(action.offset_seconds)}
            </span>

            <ChevronDown
              className={cn(
                "h-3 w-3 shrink-0 text-gray-700 transition-transform duration-150",
                expanded && "rotate-180"
              )}
            />
          </div>

          {/* Summary */}
          <p
            className={cn(
              "mt-1.5 text-xs leading-relaxed",
              isActive ? "text-gray-200" : "text-gray-400",
              !expanded && "line-clamp-2"
            )}
          >
            {action.decision_summary}
          </p>
        </button>

        {/* Expanded details */}
        {expanded && (
          <div className="border-t border-gray-800/60 px-3 py-2.5 space-y-2">
            <div className="grid grid-cols-2 gap-3 text-[10px]">
              <div>
                <span className="text-gray-600 uppercase">Timestamp</span>
                <p className="text-gray-400 font-mono">
                  {formatTimestamp(action.timestamp)}
                </p>
              </div>
              <div>
                <span className="text-gray-600 uppercase">Offset</span>
                <p className="text-gray-400 font-mono">
                  +{(action.offset_seconds ?? 0).toFixed(1)}s
                </p>
              </div>
              {action.tool_name && (
                <div>
                  <span className="text-gray-600 uppercase">Tool</span>
                  <p className="text-blue-300 font-mono">{action.tool_name}</p>
                </div>
              )}
              {action.latency_ms != null && (
                <div>
                  <span className="text-gray-600 uppercase">Latency</span>
                  <p className="text-gray-400 font-mono">{action.latency_ms}ms</p>
                </div>
              )}
            </div>

            {action.tool_params && (
              <div>
                <span className="text-[10px] text-gray-600 uppercase">Parameters</span>
                <pre className="mt-1 overflow-x-auto rounded border border-gray-800 bg-gray-950 p-2 text-[10px] text-gray-400 font-mono">
                  {JSON.stringify(action.tool_params, null, 2)}
                </pre>
              </div>
            )}

            {action.response_summary && (
              <div>
                <span className="text-[10px] text-gray-600 uppercase">Response</span>
                <p className="mt-0.5 text-xs text-gray-300 leading-relaxed">
                  {action.response_summary}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AgentDecisionTimeline                                              */
/* ------------------------------------------------------------------ */

export default function AgentDecisionTimeline({
  incidentId,
  currentOffset,
  className,
}: AgentDecisionTimelineProps) {
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  /* --- Fetch actions --- */
  const fetchActions = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<AgentAction[]>(
        `/api/incident-replay/incidents/${incidentId}/agent-actions`
      );
      setActions(data);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agent actions");
    } finally {
      setLoading(false);
    }
  }, [incidentId]);

  useEffect(() => {
    fetchActions();
  }, [fetchActions]);

  /* --- Determine active action based on currentOffset --- */
  const activeActionId = useMemo(() => {
    if (currentOffset == null || actions.length === 0) return null;

    // Find the last action at or before the current offset
    let closest: AgentAction | null = null;
    for (const action of actions) {
      if ((action.offset_seconds ?? 0) <= currentOffset) {
        if (!closest || (action.offset_seconds ?? 0) > (closest.offset_seconds ?? 0)) {
          closest = action;
        }
      }
    }
    return closest?.id ?? null;
  }, [actions, currentOffset]);

  /* --- Sorted actions --- */
  const sorted = useMemo(
    () =>
      [...actions].sort((a, b) => (a.offset_seconds ?? 0) - (b.offset_seconds ?? 0)),
    [actions]
  );

  /* --- Stats --- */
  const actionTypeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of actions) {
      counts[a.action_type] = (counts[a.action_type] || 0) + 1;
    }
    return counts;
  }, [actions]);

  return (
    <div className={cn("flex flex-col", className)}>
      {/* Header */}
      <div className={cn(CARD, "mb-3")}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="h-5 w-5 text-purple-400" />
            <h3 className="text-sm font-bold text-gray-100">
              Agent Decision Timeline
            </h3>
            <span className="rounded-full bg-gray-800 px-2 py-0.5 text-[10px] font-mono text-gray-400">
              {actions.length}
            </span>
          </div>

          {/* Action type summary */}
          <div className="flex items-center gap-2">
            {Object.entries(actionTypeCounts).map(([type, count]) => {
              const colors = ACTION_COLORS[type] || DEFAULT_ACTION_COLOR;
              const Icon = ACTION_ICONS[type] || Zap;
              return (
                <span
                  key={type}
                  className="flex items-center gap-1 text-[10px] text-gray-500"
                >
                  <Icon className={cn("h-3 w-3", colors.icon)} />
                  {count}
                </span>
              );
            })}
          </div>
        </div>

        {/* Current position indicator */}
        {currentOffset != null && (
          <div className="mt-2 flex items-center gap-2 text-[10px] text-gray-500">
            <div className="h-px flex-1 bg-gray-800" />
            <span className="flex items-center gap-1 font-mono">
              <Clock className="h-3 w-3 text-cyan-400" />
              Playback at +{formatOffsetTime(currentOffset)}
            </span>
            <div className="h-px flex-1 bg-gray-800" />
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-3 rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-purple-400" />
        </div>
      )}

      {/* Empty state */}
      {!loading && sorted.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Brain className="mb-3 h-10 w-10 text-gray-700" />
          <p className="text-sm text-gray-500">No agent decisions recorded</p>
          <p className="mt-1 text-xs text-gray-600">
            Agent actions will appear here during incident replay
          </p>
        </div>
      )}

      {/* Timeline */}
      {!loading && sorted.length > 0 && (
        <div
          ref={scrollContainerRef}
          className="relative flex-1 overflow-y-auto pl-2 pr-1"
        >
          {/* Vertical line */}
          <div className="absolute left-[8.5px] top-0 bottom-0 w-0.5 bg-gray-800" />

          {sorted.map((action) => (
            <ActionEntry
              key={action.id}
              action={action}
              isActive={activeActionId === action.id}
              expanded={expandedId === action.id}
              onToggle={() =>
                setExpandedId(expandedId === action.id ? null : action.id)
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
