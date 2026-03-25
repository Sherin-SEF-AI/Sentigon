"use client";

import { useMemo, useCallback, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Camera,
} from "lucide-react";
import { cn, formatTimestamp } from "@/lib/utils";
import { useAlerts } from "@/hooks/useAlerts";
import type { Alert, Severity } from "@/lib/types";

function timeAgo(iso: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(iso).getTime()) / 1000
  );
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

const severityDot: Record<Severity, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-blue-400",
  info: "bg-gray-400",
};

interface AlertCardProps {
  alert: Alert;
  onAcknowledge?: (id: string) => void;
  onDismiss?: (id: string) => void;
}

function AlertCard({ alert, onAcknowledge, onDismiss }: AlertCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isCritical = alert.severity === "critical";
  const isActionable =
    alert.status === "new" || alert.status === "acknowledged";

  return (
    <div
      className={cn(
        "group relative rounded border transition-all duration-150 cursor-pointer",
        "bg-gray-900/40 hover:bg-gray-900/70",
        isCritical && alert.status === "new"
          ? "border-red-800/30"
          : "border-gray-800/30",
        isCritical && alert.status === "new" && "animate-pulse-alert"
      )}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Severity accent line */}
      <div
        className={cn(
          "absolute left-0 top-0 h-full w-0.5 rounded-l-md",
          severityDot[alert.severity]
        )}
      />

      <div className="pl-2 pr-1.5 py-0.5">
        {/* Single-line: severity dot + title + actions + time */}
        <div className="flex items-center gap-1">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full shrink-0",
              severityDot[alert.severity]
            )}
          />
          <p className="text-[10px] font-medium leading-none text-gray-200 truncate flex-1 min-w-0">
            {alert.title}
          </p>
          {/* Inline actions — always visible for actionable alerts */}
          {isActionable && (
            <div className="flex items-center gap-0.5 shrink-0">
              {alert.status === "new" && onAcknowledge && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onAcknowledge(alert.id);
                  }}
                  className="rounded px-1 py-px text-[7px] font-bold uppercase tracking-wider text-yellow-500 hover:bg-yellow-900/40 transition-colors"
                  title="Acknowledge"
                >
                  ACK
                </button>
              )}
              {onDismiss && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDismiss(alert.id);
                  }}
                  className="rounded px-1 py-px text-[7px] font-bold uppercase tracking-wider text-gray-500 hover:bg-gray-800/60 transition-colors"
                  title="Dismiss"
                >
                  DIS
                </button>
              )}
            </div>
          )}
          {(alert.status === "resolved" || alert.status === "dismissed") && (
            <span
              className={cn(
                "rounded px-1 py-px text-[7px] font-bold uppercase tracking-wider shrink-0",
                alert.status === "resolved"
                  ? "text-emerald-500"
                  : "text-gray-600"
              )}
            >
              {alert.status === "resolved" ? "RES" : "DIS"}
            </span>
          )}
          <span className="text-[8px] text-gray-600 font-mono shrink-0 tabular-nums">
            {timeAgo(alert.created_at)}
          </span>
        </div>

        {/* Sub-line: camera + threat type (only if exists, single line) */}
        {(alert.source_camera || alert.threat_type) && (
          <div className="flex items-center gap-1 ml-2.5 text-[8px] text-gray-500 leading-none mt-px">
            {alert.source_camera && (
              <>
                <Camera className="h-2 w-2 shrink-0" />
                <span className="truncate max-w-[60px]">{alert.source_camera}</span>
              </>
            )}
            {alert.threat_type && (
              <>
                <span className="text-gray-700">·</span>
                <span className="truncate">{alert.threat_type}</span>
              </>
            )}
            {alert.confidence > 0 && (
              <span className="text-gray-600 tabular-nums">
                {Math.round(alert.confidence * 100)}%
              </span>
            )}
          </div>
        )}

        {/* Expanded details — only description */}
        {expanded && alert.description && (
          <p className="text-[9px] leading-tight text-gray-500 mt-0.5 ml-2.5 line-clamp-2">
            {alert.description}
          </p>
        )}
      </div>
    </div>
  );
}

interface AlertFeedProps {
  limit?: number;
  className?: string;
}

export function AlertFeed({ limit = 50, className }: AlertFeedProps) {
  const { alerts, loading, connected, acknowledgeAlert, dismissAlert } =
    useAlerts(limit);
  const [filter, setFilter] = useState<"all" | "critical" | "high">("all");

  const sorted = useMemo(
    () =>
      [...alerts]
        .sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        )
        .filter((a) => {
          if (filter === "all") return true;
          if (filter === "critical") return a.severity === "critical";
          if (filter === "high")
            return a.severity === "critical" || a.severity === "high";
          return true;
        }),
    [alerts, filter]
  );

  const critCount = useMemo(
    () => alerts.filter((a) => a.severity === "critical" && a.status === "new").length,
    [alerts]
  );

  const handleAcknowledge = useCallback(
    (id: string) => {
      acknowledgeAlert(id).catch((err: Error) => {
        console.warn("Acknowledge failed:", err.message);
      });
    },
    [acknowledgeAlert]
  );

  const handleDismiss = useCallback(
    (id: string) => {
      dismissAlert(id).catch((err: Error) => {
        console.warn("Dismiss failed:", err.message);
      });
    },
    [dismissAlert]
  );

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-l border-gray-800/60 bg-gray-950 min-h-0 overflow-hidden",
        className
      )}
    >
      {/* Header — fixed at top */}
      <div className="flex items-center justify-between border-b border-gray-800/60 px-2 py-1 shrink-0">
        <div className="flex items-center gap-1">
          <AlertTriangle className="h-2.5 w-2.5 text-amber-400" />
          <h2 className="text-[9px] font-bold uppercase tracking-widest text-gray-400">
            Alerts
          </h2>
          {critCount > 0 && (
            <span className="flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-red-600 px-0.5 text-[7px] font-bold text-white animate-pulse">
              {critCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {/* Filter buttons */}
          <div className="flex items-center rounded bg-gray-900/60 border border-gray-800/40 p-0.5">
            {(["all", "high", "critical"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider transition-colors",
                  filter === f
                    ? "bg-gray-800 text-gray-200"
                    : "text-gray-600 hover:text-gray-400"
                )}
              >
                {f}
              </button>
            ))}
          </div>
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full shrink-0",
              connected
                ? "bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.6)]"
                : "bg-red-500 animate-pulse"
            )}
          />
          <span className="font-mono text-[9px] text-gray-600">
            {sorted.length}
          </span>
        </div>
      </div>

      {/* Alert list — scrolls independently */}
      <div className="flex-1 min-h-0 space-y-px overflow-y-auto px-1.5 py-1">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
          </div>
        )}

        {!loading && sorted.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <CheckCircle2 className="mb-1.5 h-6 w-6 text-emerald-800" />
            <p className="text-[10px] text-gray-600">No active alerts</p>
          </div>
        )}

        {sorted.map((alert) => (
          <AlertCard
            key={alert.id}
            alert={alert}
            onAcknowledge={handleAcknowledge}
            onDismiss={handleDismiss}
          />
        ))}
      </div>

      {/* Footer — fixed at bottom */}
      <div className="border-t border-gray-800/60 px-2 py-0.5 shrink-0">
        <p className="text-center text-[8px] text-gray-700 font-mono">
          {formatTimestamp(new Date().toISOString())}
        </p>
      </div>
    </aside>
  );
}
