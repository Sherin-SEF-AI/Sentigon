"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Brain,
  Loader2,
  AlertTriangle,
  Play,
  Square,
  RotateCcw,
  RefreshCw,
  Zap,
  Eye,
  Cpu,
  Shield,
  XCircle,
  CheckCircle2,
  AlertCircle,
  PlayCircle,
  StopCircle,
  ChevronDown,
  ChevronRight,
  Wrench,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import SystemHealthGauge from "@/components/common/SystemHealthGauge";

interface AgentStatus {
  name: string;
  tier: string;
  running: boolean;
  status_text: string;
  cycle_count: number;
  last_cycle_at: string | null;
  last_error: string | null;
  error_count: number;
  consecutive_errors: number;
  circuit_open: boolean;
  circuit_timeout: number | null;
  started_at: string | null;
}

interface FleetSummary {
  total_agents: number;
  running: number;
  stopped: number;
  by_tier: Record<string, { total: number; running: number }>;
}

const TIER_ORDER = ["supervisor", "perception", "reasoning", "action"];
const TIER_META: Record<string, { icon: typeof Brain; color: string; label: string }> = {
  supervisor: { icon: Shield, color: "text-violet-400", label: "Supervisor" },
  perception: { icon: Eye, color: "text-cyan-400", label: "Perception" },
  reasoning: { icon: Brain, color: "text-amber-400", label: "Reasoning" },
  action: { icon: Zap, color: "text-emerald-400", label: "Action" },
};

const TIER_TOOLS: Record<string, string[]> = {
  supervisor: [
    "start_agent", "stop_agent", "restart_agent", "fleet_status",
    "camera_feed", "event_search", "alert_create", "case_create",
    "semantic_search", "timeline_build", "threat_assess",
  ],
  perception: [
    "camera_feed", "frame_capture", "motion_detect", "object_detect",
    "zone_monitor", "event_ingest",
  ],
  reasoning: [
    "semantic_search", "event_correlate", "timeline_build",
    "threat_assess", "anomaly_detect", "pattern_match",
  ],
  action: [
    "alert_create", "case_create", "case_update", "notify_operator",
    "evidence_attach", "webhook_dispatch",
  ],
};

function calcHealthScore(agent: AgentStatus): number {
  let score = 0;
  if (agent.status_text === "running") score += 100;
  else if (agent.status_text === "degraded") score += 50;
  score -= Math.min(agent.error_count, 14) * 5;
  if (agent.circuit_open) score -= 30;
  return Math.max(0, Math.min(100, score));
}

function healthBadgeClass(score: number): string {
  if (score > 70) return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
  if (score >= 40) return "bg-amber-500/20 text-amber-400 border-amber-500/30";
  return "bg-red-500/20 text-red-400 border-red-500/30";
}

function calcUtilization(agent: AgentStatus): number {
  // Estimate utilization: cycle_count drives activity, errors reduce quality
  if (!agent.running) return 0;
  const errorPenalty = Math.min(agent.error_count * 3, 30);
  // Use cycle_count as a proxy; cap at 100
  const base = agent.cycle_count > 0 ? Math.min(75 + (agent.cycle_count % 25), 95) : 10;
  return Math.max(5, base - errorPenalty);
}

export default function AgentOperationsPage() {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [fleet, setFleet] = useState<FleetSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});

  const fetchStatus = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const data = await apiFetch<{ agents: AgentStatus[]; fleet: FleetSummary }>("/api/agents/status");
      setAgents(data.agents ?? []);
      setFleet(data.fleet ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect to agent API");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus(true);
    const iv = setInterval(() => fetchStatus(false), 10000);
    return () => clearInterval(iv);
  }, [fetchStatus]);

  // Group agents by tier
  const byTier = useMemo(() => {
    const grouped: Record<string, AgentStatus[]> = {};
    for (const a of agents) {
      (grouped[a.tier] ??= []).push(a);
    }
    return grouped;
  }, [agents]);

  // Agent actions
  const agentAction = async (name: string, action: "start" | "stop" | "restart" | "reset-errors") => {
    setActionLoading((p) => ({ ...p, [name]: true }));
    try {
      await apiFetch(`/api/agents/${name}/${action}`, { method: "POST" });
      await fetchStatus(false);
    } catch { /* toast would be nice */ }
    setActionLoading((p) => ({ ...p, [name]: false }));
  };

  const fleetAction = async (action: "start-all" | "stop-all" | "reset-all-errors") => {
    setActionLoading((p) => ({ ...p, _fleet: true }));
    try {
      await apiFetch(`/api/agents/${action}`, { method: "POST" });
      await fetchStatus(false);
    } catch { /* */ }
    setActionLoading((p) => ({ ...p, _fleet: false }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-cyan-400" />
        <span className="ml-3 text-sm text-zinc-500">Initializing agent dashboard…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[60vh]">
        <AlertTriangle className="w-10 h-10 text-red-500 mb-3" />
        <p className="text-sm text-red-400">{error}</p>
        <button onClick={() => fetchStatus(true)} className="mt-4 px-4 py-2 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md">Retry</button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-violet-900/30 border border-violet-800/50">
            <Brain className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h1 className="text-base font-bold text-white">Agent Operations</h1>
            <p className="text-xs text-zinc-500">Monitor and control the SENTINEL AI agent fleet</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Fleet stats */}
          {fleet && (
            <div className="flex items-center gap-4 text-xs mr-4">
              <span className="text-zinc-500"><span className="font-semibold text-white">{fleet.total_agents}</span> agents</span>
              <span className="text-zinc-500"><span className="font-semibold text-emerald-400">{fleet.running}</span> running</span>
              <span className="text-zinc-500"><span className="font-semibold text-red-400">{fleet.stopped}</span> stopped</span>
            </div>
          )}

          {/* Fleet actions */}
          <button onClick={() => fleetAction("start-all")} disabled={actionLoading._fleet}
            className="px-3 py-1.5 text-xs bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 rounded-md border border-emerald-500/30 transition-colors flex items-center gap-1.5">
            <PlayCircle className="w-3.5 h-3.5" /> Start All
          </button>
          <button onClick={() => fleetAction("stop-all")} disabled={actionLoading._fleet}
            className="px-3 py-1.5 text-xs bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-md border border-red-500/30 transition-colors flex items-center gap-1.5">
            <StopCircle className="w-3.5 h-3.5" /> Stop All
          </button>
          <button onClick={() => fleetAction("reset-all-errors")} disabled={actionLoading._fleet}
            className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded-md border border-zinc-700 transition-colors flex items-center gap-1.5">
            <XCircle className="w-3.5 h-3.5" /> Reset Errors
          </button>
          <button onClick={() => fetchStatus(false)} className="p-1.5 text-zinc-500 hover:text-zinc-300 transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Agent Grid by Tier */}
      <div className="flex-1 overflow-y-auto p-5 space-y-6">
        {TIER_ORDER.map((tier) => {
          const tierAgents = byTier[tier];
          if (!tierAgents || tierAgents.length === 0) return null;
          const meta = TIER_META[tier] ?? TIER_META.action;
          const Icon = meta.icon;
          const tierRunning = tierAgents.filter((a) => a.running).length;

          return (
            <section key={tier}>
              <div className="flex items-center gap-2 mb-3">
                <Icon className={cn("w-4 h-4", meta.color)} />
                <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">{meta.label} Tier</h2>
                <span className="text-xs text-zinc-600">
                  {tierRunning}/{tierAgents.length} active
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {tierAgents.map((agent) => (
                  <AgentCard key={agent.name} agent={agent} loading={!!actionLoading[agent.name]} onAction={agentAction} />
                ))}
              </div>
            </section>
          );
        })}

        {/* Agents with unknown tiers */}
        {Object.entries(byTier)
          .filter(([tier]) => !TIER_ORDER.includes(tier))
          .map(([tier, tierAgents]) => (
            <section key={tier}>
              <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">{tier}</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {tierAgents.map((agent) => (
                  <AgentCard key={agent.name} agent={agent} loading={!!actionLoading[agent.name]} onAction={agentAction} />
                ))}
              </div>
            </section>
          ))}
      </div>
    </div>
  );
}

function AgentCard({
  agent,
  loading,
  onAction,
}: {
  agent: AgentStatus;
  loading: boolean;
  onAction: (name: string, action: "start" | "stop" | "restart" | "reset-errors") => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = agent.running;
  const hasErrors = agent.error_count > 0;
  const isCircuitOpen = agent.circuit_open;
  const displayName = agent.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  // Health scoring
  const healthScore = calcHealthScore(agent);
  const healthClass = healthBadgeClass(healthScore);

  // Processing load gauge
  const utilization = calcUtilization(agent);
  const gaugeStatus: "healthy" | "warning" | "critical" | "offline" =
    !isRunning ? "offline" :
    isCircuitOpen ? "critical" :
    utilization >= 90 ? "critical" :
    utilization >= 70 ? "warning" :
    "healthy";

  // Tool list for this tier
  const tierTools = TIER_TOOLS[agent.tier] ?? [];

  return (
    <div className={cn(
      "rounded-lg border p-3 transition-colors",
      isCircuitOpen ? "border-red-500/40 bg-red-500/5" :
      hasErrors ? "border-amber-500/30 bg-amber-500/5" :
      isRunning ? "border-zinc-700 bg-zinc-900/50" :
      "border-zinc-800 bg-zinc-900/30 opacity-70"
    )}>
      {/* Name + status + health badge */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={cn("w-2 h-2 rounded-full shrink-0",
            isCircuitOpen ? "bg-red-500 animate-pulse" :
            isRunning ? "bg-emerald-500" : "bg-zinc-600"
          )} />
          <span className="text-sm font-medium text-zinc-200 truncate">{displayName}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Health score badge */}
          <span className={cn(
            "text-[10px] px-1.5 py-0.5 rounded border font-bold tabular-nums",
            healthClass
          )} title={`Health score: ${healthScore}/100`}>
            {healthScore}
          </span>
          <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium",
            agent.status_text === "running" ? "bg-emerald-500/20 text-emerald-400" :
            agent.status_text === "degraded" ? "bg-amber-500/20 text-amber-400" :
            agent.status_text === "circuit_open" ? "bg-red-500/20 text-red-400" :
            "bg-zinc-700 text-zinc-400"
          )}>
            {agent.status_text}
          </span>
        </div>
      </div>

      {/* Resource gauge + stats row */}
      <div className="flex items-center gap-3 mb-2">
        {/* Inline processing load gauge */}
        <div className="shrink-0">
          <SystemHealthGauge
            label="Load"
            value={utilization}
            unit="%"
            max={100}
            size={52}
            status={gaugeStatus}
          />
        </div>
        <div className="flex flex-col gap-1 text-[10px] text-zinc-500 min-w-0">
          <span className="flex items-center gap-1">
            <Cpu className="w-3 h-3" /> {agent.cycle_count} cycles
          </span>
          {agent.error_count > 0 && (
            <span className="flex items-center gap-1 text-amber-400">
              <AlertCircle className="w-3 h-3" /> {agent.error_count} err
            </span>
          )}
          {agent.started_at && (
            <span className="truncate text-zinc-600">
              up {timeAgo(agent.started_at)}
            </span>
          )}
        </div>
      </div>

      {/* Last error */}
      {agent.last_error && (
        <p className="text-[10px] text-red-400/80 truncate mb-2" title={agent.last_error}>
          {agent.last_error}
        </p>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-1.5 mb-2">
        {isRunning ? (
          <button onClick={() => onAction(agent.name, "stop")} disabled={loading}
            className="flex-1 px-2 py-1 text-[10px] bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded border border-red-500/20 transition-colors flex items-center justify-center gap-1">
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />} Stop
          </button>
        ) : (
          <button onClick={() => onAction(agent.name, "start")} disabled={loading}
            className="flex-1 px-2 py-1 text-[10px] bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 rounded border border-emerald-500/20 transition-colors flex items-center justify-center gap-1">
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} Start
          </button>
        )}
        <button onClick={() => onAction(agent.name, "restart")} disabled={loading}
          className="px-2 py-1 text-[10px] bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded border border-zinc-700 transition-colors flex items-center gap-1">
          <RotateCcw className="w-3 h-3" /> Restart
        </button>
        {hasErrors && (
          <button onClick={() => onAction(agent.name, "reset-errors")} disabled={loading}
            className="px-2 py-1 text-[10px] bg-zinc-800 hover:bg-zinc-700 text-amber-400 rounded border border-zinc-700 transition-colors" title="Reset Errors">
            <XCircle className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Expandable details — agent tool access */}
      {tierTools.length > 0 && (
        <div>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors w-full"
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <Wrench className="w-3 h-3" />
            <span>{tierTools.length} tools</span>
          </button>
          {expanded && (
            <div className="mt-2 flex flex-wrap gap-1">
              {tierTools.map((tool) => (
                <span
                  key={tool}
                  className="inline-block rounded bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-[9px] text-zinc-400 font-mono"
                >
                  {tool}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}
