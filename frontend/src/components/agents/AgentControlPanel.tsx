"use client";

import { useState, useCallback } from "react";
import {
  AlertTriangle,
  Cpu,
  Loader2,
  Play,
  RefreshCw,
  Square,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AgentStatusInfo {
  name: string;
  display_name?: string;
  tier?: string;
  status: "running" | "stopped" | "error" | "starting";
  description?: string;
  model?: string;
  cycle_count?: number;
  error_count?: number;
  errors?: string[];
  last_action_time?: string | null;
  uptime_seconds?: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const STATUS_STYLES: Record<string, { dot: string; text: string; bg: string }> = {
  running: {
    dot: "bg-green-500",
    text: "text-green-400",
    bg: "bg-green-900/20 border-green-800/40",
  },
  stopped: {
    dot: "bg-gray-500",
    text: "text-gray-400",
    bg: "bg-gray-800 border-gray-700",
  },
  error: {
    dot: "bg-red-500",
    text: "text-red-400",
    bg: "bg-red-900/20 border-red-800/40",
  },
  starting: {
    dot: "bg-yellow-500",
    text: "text-yellow-400",
    bg: "bg-yellow-900/20 border-yellow-800/40",
  },
};

const TIER_COLORS: Record<string, string> = {
  perception: "text-cyan-400",
  reasoning: "text-amber-400",
  action: "text-green-400",
  supervisor: "text-purple-400",
};

/* ------------------------------------------------------------------ */
/*  AgentControlPanel                                                  */
/* ------------------------------------------------------------------ */

export default function AgentControlPanel({
  agentName,
  status,
  className,
}: {
  agentName: string;
  status: AgentStatusInfo;
  className?: string;
}) {
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [currentStatus, setCurrentStatus] = useState(status.status);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleAction = useCallback(
    async (action: "start" | "stop" | "restart") => {
      setLoadingAction(action);
      setActionError(null);
      try {
        const result = await apiFetch<{ status: string }>(
          `/api/agents/${agentName}/${action}`,
          { method: "POST" }
        );
        if (result?.status) {
          setCurrentStatus(result.status as AgentStatusInfo["status"]);
        } else {
          // Optimistic update
          if (action === "start") setCurrentStatus("running");
          else if (action === "stop") setCurrentStatus("stopped");
          else setCurrentStatus("starting");
        }
      } catch (err) {
        setActionError(
          err instanceof Error ? err.message : `Failed to ${action} agent`
        );
      } finally {
        setLoadingAction(null);
      }
    },
    [agentName]
  );

  const st = STATUS_STYLES[currentStatus] || STATUS_STYLES.stopped;
  const tierColor = TIER_COLORS[status.tier || ""] || "text-gray-400";

  return (
    <div
      className={cn(
        "rounded-lg border border-gray-800 bg-gray-900/60",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-gray-800 px-4 py-3">
        <Cpu className="h-4 w-4 text-cyan-400" />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-200">
            {status.display_name || agentName}
          </h3>
          {status.tier && (
            <p
              className={cn(
                "text-[10px] font-bold uppercase tracking-widest",
                tierColor
              )}
            >
              {status.tier} tier
            </p>
          )}
        </div>

        {/* Status badge */}
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold capitalize",
            st.bg,
            st.text
          )}
        >
          <span className="relative flex h-2 w-2">
            {currentStatus === "running" && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
            )}
            <span className={cn("relative inline-flex h-2 w-2 rounded-full", st.dot)} />
          </span>
          {currentStatus}
        </span>
      </div>

      {/* Info section */}
      <div className="px-4 py-3 space-y-3">
        {/* Description */}
        {status.description && (
          <p className="text-xs text-gray-400 leading-relaxed">
            {status.description}
          </p>
        )}

        {/* Metadata grid */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          {status.model && (
            <>
              <span className="text-gray-500">Model</span>
              <span className="truncate font-mono text-gray-300">
                {status.model}
              </span>
            </>
          )}
          {status.cycle_count != null && (
            <>
              <span className="text-gray-500">Cycles</span>
              <span className="font-mono text-gray-300">
                {status.cycle_count.toLocaleString()}
              </span>
            </>
          )}
          {status.uptime_seconds != null && (
            <>
              <span className="text-gray-500">Uptime</span>
              <span className="font-mono text-gray-300">
                {Math.floor(status.uptime_seconds / 3600)}h{" "}
                {Math.floor((status.uptime_seconds % 3600) / 60)}m
              </span>
            </>
          )}
          {status.error_count != null && status.error_count > 0 && (
            <>
              <span className="text-gray-500">Errors</span>
              <span className="font-semibold text-red-400">
                {status.error_count}
              </span>
            </>
          )}
        </div>

        {/* Error details */}
        {status.errors && status.errors.length > 0 && (
          <div className="rounded-md border border-red-800/50 bg-red-950/20 p-2.5 space-y-1">
            <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-red-400">
              <AlertTriangle className="h-3 w-3" />
              Error Details
            </p>
            {status.errors.slice(0, 5).map((err, i) => (
              <p key={i} className="text-xs text-red-300 leading-relaxed">
                {err}
              </p>
            ))}
          </div>
        )}

        {/* Action error */}
        {actionError && (
          <div className="rounded-md border border-red-800/50 bg-red-950/20 px-3 py-2">
            <p className="text-xs text-red-400">{actionError}</p>
          </div>
        )}

        {/* Control buttons */}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => handleAction("start")}
            disabled={loadingAction !== null || currentStatus === "running"}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold transition-colors",
              "bg-green-900/40 text-green-400 border border-green-800/60",
              "hover:bg-green-800/50 hover:text-green-300",
              "disabled:opacity-40 disabled:cursor-not-allowed"
            )}
          >
            {loadingAction === "start" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Start
          </button>

          <button
            onClick={() => handleAction("stop")}
            disabled={loadingAction !== null || currentStatus === "stopped"}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold transition-colors",
              "bg-red-900/40 text-red-400 border border-red-800/60",
              "hover:bg-red-800/50 hover:text-red-300",
              "disabled:opacity-40 disabled:cursor-not-allowed"
            )}
          >
            {loadingAction === "stop" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
            Stop
          </button>

          <button
            onClick={() => handleAction("restart")}
            disabled={loadingAction !== null}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold transition-colors",
              "bg-gray-800 text-gray-400 border border-gray-700",
              "hover:bg-gray-700 hover:text-gray-300",
              "disabled:opacity-40 disabled:cursor-not-allowed"
            )}
          >
            {loadingAction === "restart" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Restart
          </button>
        </div>
      </div>
    </div>
  );
}
