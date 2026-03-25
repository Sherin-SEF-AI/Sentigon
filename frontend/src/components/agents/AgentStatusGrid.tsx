"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  Clock,
  Cpu,
  Loader2,
  Play,
  RefreshCw,
  Square,
  Zap,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AgentStatus {
  name: string;
  display_name?: string;
  tier: "perception" | "reasoning" | "action" | "supervisor";
  status: "running" | "stopped" | "error" | "starting";
  status_text?: "running" | "degraded" | "circuit_open" | "stopped" | "error";
  cycle_count: number;
  last_action_time: string | null;
  error_count: number;
  consecutive_errors?: number;
  circuit_open?: boolean;
  circuit_timeout?: number | null;
  errors?: string[];
  description?: string;
  model?: string;
  uptime_seconds?: number;
  last_error?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TIER_CONFIG: Record<
  string,
  { color: string; border: string; bg: string; label: string }
> = {
  perception: {
    color: "text-cyan-400",
    border: "border-cyan-500",
    bg: "bg-cyan-500/10",
    label: "Perception Tier",
  },
  reasoning: {
    color: "text-amber-400",
    border: "border-amber-500",
    bg: "bg-amber-500/10",
    label: "Reasoning Tier",
  },
  action: {
    color: "text-green-400",
    border: "border-green-500",
    bg: "bg-green-500/10",
    label: "Action Tier",
  },
  supervisor: {
    color: "text-purple-400",
    border: "border-purple-500",
    bg: "bg-purple-500/10",
    label: "Supervisor Tier",
  },
};

const STATUS_DOT: Record<string, string> = {
  running: "bg-green-500",
  stopped: "bg-gray-500",
  error: "bg-red-500",
  starting: "bg-yellow-500",
  degraded: "bg-amber-500",
  circuit_open: "bg-orange-500",
};

/* ------------------------------------------------------------------ */
/*  AgentCard                                                          */
/* ------------------------------------------------------------------ */

function AgentCard({
  agent,
  expanded,
  onToggle,
  onAction,
  actionLoading,
}: {
  agent: AgentStatus;
  expanded: boolean;
  onToggle: () => void;
  onAction: (name: string, action: string) => void;
  actionLoading: string | null;
}) {
  const tier = TIER_CONFIG[agent.tier] || TIER_CONFIG.perception;
  const isActioning = actionLoading === agent.name;

  return (
    <div
      className={cn(
        "rounded-lg border border-gray-800 bg-gray-900/60 transition-all duration-200",
        expanded && "ring-1 ring-gray-700"
      )}
    >
      {/* Tier color band */}
      <div className={cn("h-1 rounded-t-lg", tier.border, tier.bg)} />

      {/* Card body */}
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {/* Status dot — uses status_text for richer state display */}
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          {(agent.status_text || agent.status) === "running" && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
          )}
          <span
            className={cn(
              "relative inline-flex h-2.5 w-2.5 rounded-full",
              STATUS_DOT[agent.status_text || agent.status] || "bg-gray-500"
            )}
          />
        </span>

        {/* Agent name */}
        <div className="flex-1 min-w-0">
          <p className="truncate text-sm font-semibold text-gray-200">
            {agent.display_name || agent.name}
          </p>
          <p className={cn("text-[10px] font-medium uppercase tracking-wider", tier.color)}>
            {agent.tier}
          </p>
        </div>

        {/* Cycle count */}
        <div className="flex items-center gap-1 text-xs text-gray-500">
          <Zap className="h-3 w-3" />
          <span className="font-mono">{agent.cycle_count}</span>
        </div>

        {/* Error badge */}
        {agent.error_count > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-red-900/30 border border-red-800/50 px-2 py-0.5 text-[10px] font-bold text-red-400">
            <AlertTriangle className="h-2.5 w-2.5" />
            {agent.error_count}
          </span>
        )}

        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-gray-600 transition-transform duration-200",
            expanded && "rotate-180"
          )}
        />
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-gray-800 px-4 py-3 space-y-3">
          {/* Meta info */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-gray-500">Status</span>
              <p
                className={cn(
                  "font-semibold capitalize",
                  (agent.status_text || agent.status) === "running"
                    ? "text-green-400"
                    : (agent.status_text || agent.status) === "degraded"
                    ? "text-amber-400"
                    : (agent.status_text || agent.status) === "circuit_open"
                    ? "text-orange-400"
                    : (agent.status_text || agent.status) === "error"
                    ? "text-red-400"
                    : "text-gray-400"
                )}
              >
                {(agent.status_text || agent.status).replace("_", " ")}
              </p>
            </div>
            <div>
              <span className="text-gray-500">Cycles</span>
              <p className="font-mono text-gray-300">{agent.cycle_count}</p>
            </div>
            {agent.last_action_time && (
              <div>
                <span className="text-gray-500">Last Action</span>
                <p className="text-gray-300">
                  {formatTimestamp(agent.last_action_time)}
                </p>
              </div>
            )}
            {agent.model && (
              <div>
                <span className="text-gray-500">Model</span>
                <p className="truncate text-gray-300">{agent.model}</p>
              </div>
            )}
            {agent.uptime_seconds != null && (
              <div>
                <span className="text-gray-500">Uptime</span>
                <p className="text-gray-300">
                  {Math.floor(agent.uptime_seconds / 3600)}h{" "}
                  {Math.floor((agent.uptime_seconds % 3600) / 60)}m
                </p>
              </div>
            )}
            {agent.error_count > 0 && (
              <div>
                <span className="text-gray-500">Errors</span>
                <p className="font-semibold text-red-400">
                  {agent.error_count}
                  {agent.consecutive_errors ? ` (${agent.consecutive_errors} consecutive)` : ""}
                </p>
              </div>
            )}
          </div>

          {/* Circuit breaker state */}
          {agent.circuit_open && (
            <div className="rounded-md border border-orange-800/50 bg-orange-950/20 p-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-400">
                Circuit Breaker Open
              </p>
              <p className="text-xs text-orange-300">
                Agent is pausing API calls to prevent error storms.
                {agent.circuit_timeout && ` Retry in ~${Math.round(agent.circuit_timeout)}s.`}
              </p>
            </div>
          )}

          {/* Last error */}
          {agent.last_error && (
            <div className="rounded-md border border-red-800/50 bg-red-950/20 p-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-red-400">
                Last Error
              </p>
              <p className="truncate text-xs text-red-300">{agent.last_error}</p>
            </div>
          )}

          {/* Description */}
          {agent.description && (
            <p className="text-xs text-gray-400 leading-relaxed">
              {agent.description}
            </p>
          )}

          {/* Error details */}
          {agent.errors && agent.errors.length > 0 && (
            <div className="rounded-md border border-red-800/50 bg-red-950/20 p-2 space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-red-400">
                Recent Errors
              </p>
              {agent.errors.slice(0, 3).map((err, i) => (
                <p key={i} className="truncate text-xs text-red-300">
                  {err}
                </p>
              ))}
            </div>
          )}

          {/* Control buttons */}
          <div className="flex items-center gap-2 pt-1">
            {agent.status === "stopped" || agent.status === "error" ? (
              <button
                onClick={() => onAction(agent.name, "start")}
                disabled={isActioning}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                  "bg-green-900/40 text-green-400 border border-green-800/60",
                  "hover:bg-green-800/50 hover:text-green-300",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
              >
                {isActioning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Start
              </button>
            ) : (
              <button
                onClick={() => onAction(agent.name, "stop")}
                disabled={isActioning}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                  "bg-red-900/40 text-red-400 border border-red-800/60",
                  "hover:bg-red-800/50 hover:text-red-300",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
              >
                {isActioning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Square className="h-3.5 w-3.5" />
                )}
                Stop
              </button>
            )}
            <button
              onClick={() => onAction(agent.name, "restart")}
              disabled={isActioning}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                "bg-gray-800 text-gray-400 border border-gray-700",
                "hover:bg-gray-700 hover:text-gray-300",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              {isActioning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Restart
            </button>
            {agent.error_count > 0 && (
              <button
                onClick={() => onAction(agent.name, "reset-errors")}
                disabled={isActioning}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                  "bg-amber-900/40 text-amber-400 border border-amber-800/60",
                  "hover:bg-amber-800/50 hover:text-amber-300",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
              >
                {isActioning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5" />
                )}
                Reset Errors
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AgentStatusGrid                                                    */
/* ------------------------------------------------------------------ */

export default function AgentStatusGrid() {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  /* --- Fetch agents --- */
  const fetchAgents = useCallback(async () => {
    try {
      const data = await apiFetch<{ agents: AgentStatus[]; fleet: unknown }>("/api/agents/status");
      setAgents(Array.isArray(data) ? data : data.agents ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch agents");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAgents();
    const timer = setInterval(fetchAgents, 10_000);
    return () => clearInterval(timer);
  }, [fetchAgents]);

  /* --- Agent actions --- */
  const handleAction = useCallback(
    async (name: string, action: string) => {
      setActionLoading(name);
      try {
        await apiFetch(`/api/agents/${name}/${action}`, { method: "POST" });
        // Re-fetch after action
        await fetchAgents();
      } catch {
        // Silently handle
      } finally {
        setActionLoading(null);
      }
    },
    [fetchAgents]
  );

  /* --- Group by tier --- */
  const grouped = agents.reduce<Record<string, AgentStatus[]>>((acc, a) => {
    (acc[a.tier] ||= []).push(a);
    return acc;
  }, {});

  const tierOrder = ["supervisor", "perception", "reasoning", "action"];

  /* --- Render --- */
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
        <span className="ml-3 text-sm text-gray-500">Loading agent fleet...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={fetchAgents}
          className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Fleet summary bar */}
      <div className="flex items-center gap-4 text-xs text-gray-500">
        <div className="flex items-center gap-1.5">
          <Cpu className="h-3.5 w-3.5 text-cyan-400" />
          <span className="font-semibold text-gray-300">{agents.length}</span> agents
        </div>
        <div className="flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5 text-green-400" />
          <span className="font-semibold text-green-400">
            {agents.filter((a) => a.status === "running").length}
          </span>{" "}
          running
        </div>
        {agents.filter((a) => a.status === "error").length > 0 && (
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
            <span className="font-semibold text-red-400">
              {agents.filter((a) => a.status === "error").length}
            </span>{" "}
            errors
          </div>
        )}
        {agents.some((a) => a.error_count > 0) && (
          <button
            onClick={async () => {
              try {
                await apiFetch("/api/agents/reset-all-errors", { method: "POST" });
                await fetchAgents();
              } catch {
                // handled silently
              }
            }}
            className="flex items-center gap-1 rounded-lg border border-amber-800/60 bg-amber-900/30 px-2.5 py-1 text-amber-400 hover:bg-amber-800/40 hover:text-amber-300 transition-colors"
          >
            <AlertTriangle className="h-3 w-3" />
            <span>Reset All Errors</span>
          </button>
        )}
        <button
          onClick={fetchAgents}
          className="ml-auto flex items-center gap-1 text-gray-500 hover:text-gray-300 transition-colors"
        >
          <RefreshCw className="h-3 w-3" />
          <span>Refresh</span>
        </button>
      </div>

      {/* Grouped agent cards */}
      {tierOrder.map((tier) => {
        const tierAgents = grouped[tier];
        if (!tierAgents || tierAgents.length === 0) return null;
        const config = TIER_CONFIG[tier] || TIER_CONFIG.perception;

        return (
          <div key={tier}>
            <h3
              className={cn(
                "mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-widest",
                config.color
              )}
            >
              <span
                className={cn("h-1.5 w-1.5 rounded-full", config.border.replace("border-", "bg-"))}
              />
              {config.label}
              <span className="text-gray-600">({tierAgents.length})</span>
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {tierAgents.map((agent) => (
                <AgentCard
                  key={agent.name}
                  agent={agent}
                  expanded={expandedAgent === agent.name}
                  onToggle={() =>
                    setExpandedAgent(
                      expandedAgent === agent.name ? null : agent.name
                    )
                  }
                  onAction={handleAction}
                  actionLoading={actionLoading}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
