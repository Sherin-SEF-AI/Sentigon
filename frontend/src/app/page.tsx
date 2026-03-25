"use client";

import { useEffect, useCallback, useState, useRef, useMemo } from "react";
import {
  PanelRightClose,
  PanelRightOpen,
  Power,
  Loader2,
  Zap,
  Gauge,
  Brain,
  Sparkles,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  BarChart3,
  AlertCircle,
  ClipboardCheck,
  ChevronRight,
  Activity,
  Camera,
} from "lucide-react";
import { AgenticVideoWall } from "@/components/soc/AgenticVideoWall";
import { AlertFeed } from "@/components/soc/AlertFeed";
import { SOCMetricsBar } from "@/components/soc/SOCMetricsBar";
import { ThreatIndicator } from "@/components/soc/ThreatIndicator";
import SLACountdown from "@/components/common/SLACountdown";
import SystemHealthGauge from "@/components/common/SystemHealthGauge";
import { useWebSocket } from "@/hooks/useWebSocket";
import { cn, apiFetch } from "@/lib/utils";
import type { SOCMetrics, WSMessage, Alert } from "@/lib/types";

interface FleetSummary {
  total_agents: number;
  running: number;
  stopped: number;
}

const PERF_MODES = [
  { key: "ultra_fast", label: "Ultra Fast", abbr: "UF", icon: Zap, color: "text-orange-400", bg: "bg-orange-900/20", border: "border-orange-500/40", desc: "YOLO only, zero AI latency" },
  { key: "low_latency", label: "Low Latency", abbr: "LL", icon: Gauge, color: "text-amber-400", bg: "bg-amber-900/20", border: "border-amber-500/40", desc: "Gemini Flash, quick analysis" },
  { key: "standard", label: "Standard", abbr: "STD", icon: Brain, color: "text-cyan-400", bg: "bg-cyan-900/20", border: "border-cyan-500/40", desc: "Gemini 2.5 Flash (Recommended)" },
  { key: "advanced", label: "Advanced", abbr: "ADV", icon: Sparkles, color: "text-purple-400", bg: "bg-purple-900/20", border: "border-purple-500/40", desc: "Gemini Pro, deep reasoning" },
  { key: "max_accuracy", label: "Max Accuracy", abbr: "MAX", icon: ShieldCheck, color: "text-red-400", bg: "bg-red-900/20", border: "border-red-500/40", desc: "Max depth, forensic grade" },
];

export default function SOCDashboard() {
  const [metrics, setMetrics] = useState<SOCMetrics | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [fleet, setFleet] = useState<FleetSummary | null>(null);
  const [toggling, setToggling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Performance mode
  const [perfMode, setPerfMode] = useState("standard");
  const [perfDropdownOpen, setPerfDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Pending actions + degraded agents + operation mode
  const [pendingCount, setPendingCount] = useState(0);
  const [degradedCount, setDegradedCount] = useState(0);
  const [opMode, setOpMode] = useState<string | null>(null);

  // Analytics strip
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [eventsOverTime, setEventsOverTime] = useState<{ timestamp: string; count: number }[]>([]);
  const [alertsBySeverity, setAlertsBySeverity] = useState<{ severity: string; count: number }[]>([]);
  const [zoneOccupancy, setZoneOccupancy] = useState<{ zone_name: string; current_occupancy: number; max_occupancy: number | null; occupancy_pct: number | null }[]>([]);

  // Intelligence widgets
  const [postureScore, setPostureScore] = useState<{score: number; grade: string; components: Record<string, {score: number; detail: string}>} | null>(null);
  const [predictions, setPredictions] = useState<{temporal_predictions: {threat_type: string; zone: string; probability: number; hour: string; day_of_week: string}[]; overall_threat_forecast: string} | null>(null);

  // Alert grouping (for incident cards)
  const [sidebarAlerts, setSidebarAlerts] = useState<Alert[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // SLA countdown — unresolved alerts for top-3 urgent
  // (derived from sidebarAlerts, no extra fetch needed)

  // System health gauges
  const [systemHealth, setSystemHealth] = useState<{
    backend?: { cpu_pct: number; memory_pct: number; disk_pct: number; status: string };
    database?: { status: string };
    gpu?: { gpu_utilization_pct: number; vram_used_pct: number; status: string };
    agents?: { healthy: number; total: number };
  } | null>(null);

  // ── SLA deadline calculator (ms per severity) ──────────────────────
  const SLA_MS: Record<string, number> = {
    critical: 15 * 60 * 1000,
    high: 30 * 60 * 1000,
    medium: 2 * 60 * 60 * 1000,
    low: 4 * 60 * 60 * 1000,
  };

  function slaDeadline(alert: Alert): string {
    const base = new Date(alert.created_at).getTime();
    const window = SLA_MS[alert.severity] ?? SLA_MS.medium;
    return new Date(base + window).toISOString();
  }

  // ── Alert grouping: same source_camera + within 5 min of each other ─
  const incidentGroups = useMemo(() => {
    if (!sidebarAlerts.length) return [];
    const unresolvedBySrc: Record<string, Alert[]> = {};
    for (const a of sidebarAlerts) {
      if (a.status === "resolved" || a.status === "dismissed") continue;
      const key = a.source_camera ?? "__no_camera__";
      if (!unresolvedBySrc[key]) unresolvedBySrc[key] = [];
      unresolvedBySrc[key].push(a);
    }

    const groups: { id: string; camera: string | null; alerts: Alert[]; topSeverity: string }[] = [];
    for (const [camera, alerts] of Object.entries(unresolvedBySrc)) {
      // Sort by time, then cluster within 5-min windows
      const sorted = [...alerts].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      let cluster: Alert[] = [];
      for (const alert of sorted) {
        if (!cluster.length) { cluster.push(alert); continue; }
        const firstMs = new Date(cluster[0].created_at).getTime();
        const thisMs = new Date(alert.created_at).getTime();
        if (thisMs - firstMs <= 5 * 60 * 1000) {
          cluster.push(alert);
        } else {
          // Flush existing cluster
          const sevOrder = ["critical", "high", "medium", "low", "info"];
          const topSev = cluster.reduce((best, a) => {
            return sevOrder.indexOf(a.severity) < sevOrder.indexOf(best) ? a.severity : best;
          }, "info");
          groups.push({ id: `${camera}:${cluster[0].id}`, camera: camera === "__no_camera__" ? null : camera, alerts: cluster, topSeverity: topSev });
          cluster = [alert];
        }
      }
      if (cluster.length) {
        const sevOrder = ["critical", "high", "medium", "low", "info"];
        const topSev = cluster.reduce((best, a) => {
          return sevOrder.indexOf(a.severity) < sevOrder.indexOf(best) ? a.severity : best;
        }, "info");
        groups.push({ id: `${camera}:${cluster[0].id}`, camera: camera === "__no_camera__" ? null : camera, alerts: cluster, topSeverity: topSev });
      }
    }
    // Sort groups: critical first
    const sevOrder = ["critical", "high", "medium", "low", "info"];
    return groups.sort((a, b) => sevOrder.indexOf(a.topSeverity) - sevOrder.indexOf(b.topSeverity));
  }, [sidebarAlerts]);

  // ── Top-3 most urgent unresolved alerts for SLA row ────────────────
  const urgentAlerts = useMemo(() => {
    const sevOrder = ["critical", "high", "medium", "low", "info"];
    return [...sidebarAlerts]
      .filter((a) => a.status !== "resolved" && a.status !== "dismissed")
      .sort((a, b) => {
        const sevDiff = sevOrder.indexOf(a.severity) - sevOrder.indexOf(b.severity);
        if (sevDiff !== 0) return sevDiff;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      })
      .slice(0, 3);
  }, [sidebarAlerts]);

  // ── Fetch initial metrics ───────────────────────────────────────────
  useEffect(() => {
    apiFetch<SOCMetrics>("/api/analytics/soc-metrics")
      .then(setMetrics)
      .catch((err: Error) => {
        console.warn("Metrics fetch failed:", err.message);
      });
  }, []);

  // Fetch fleet status
  const fetchFleet = useCallback(async () => {
    try {
      const data = await apiFetch<FleetSummary>("/api/agents/fleet");
      setFleet(data);
    } catch { /* agents router may not be loaded */ }
  }, []);

  // Fetch performance mode
  const fetchPerfMode = useCallback(async () => {
    try {
      const data = await apiFetch<{ mode: string }>("/api/operation-mode/performance");
      setPerfMode(data.mode);
    } catch { /* optional */ }
  }, []);

  // AI Provider
  const [aiProvider, setAiProvider] = useState("auto");
  const fetchAiProvider = useCallback(async () => {
    try {
      const data = await apiFetch<{ provider: string }>("/api/operation-mode/ai-provider");
      setAiProvider(data.provider);
    } catch { /* optional */ }
  }, []);

  // Fetch pending actions count
  const fetchPending = useCallback(async () => {
    try {
      const d = await apiFetch<{ count: number }>("/api/operation-mode/pending-actions/count");
      setPendingCount(d.count);
    } catch { /* optional */ }
  }, []);

  // Fetch degraded agent count
  const fetchAgentHealth = useCallback(async () => {
    try {
      const data = await apiFetch<{ agents: { status_text: string }[] }>("/api/agents/status");
      const bad = (data.agents ?? []).filter(
        (a) => a.status_text === "degraded" || a.status_text === "circuit_open"
      );
      setDegradedCount(bad.length);
    } catch { /* agents router may not be loaded */ }
  }, []);

  // Fetch operation mode
  const fetchOpMode = useCallback(async () => {
    try {
      const d = await apiFetch<{ mode: string }>("/api/operation-mode");
      setOpMode(d.mode);
    } catch { /* optional */ }
  }, []);

  useEffect(() => {
    fetchFleet();
    fetchPerfMode();
    fetchAiProvider();
    fetchPending();
    fetchAgentHealth();
    fetchOpMode();
    const startPolling = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        fetchFleet();
        fetchPending();
        fetchAgentHealth();
      }, 10000);
    };
    startPolling();

    // Pause polling when tab is inactive to save resources
    const handleVisibility = () => {
      if (document.hidden) {
        if (pollRef.current) clearInterval(pollRef.current);
      } else {
        fetchFleet();
        fetchPending();
        fetchAgentHealth();
        startPolling();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchFleet, fetchPerfMode, fetchAiProvider, fetchPending, fetchAgentHealth, fetchOpMode]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setPerfDropdownOpen(false);
      }
    };
    if (perfDropdownOpen) {
      document.addEventListener("mousedown", handler);
      return () => document.removeEventListener("mousedown", handler);
    }
  }, [perfDropdownOpen]);

  const isOn = (fleet?.running ?? 0) > 0;

  const handleToggle = async () => {
    if (toggling) return;
    setToggling(true);
    try {
      const endpoint = isOn ? "/api/agents/stop-all" : "/api/agents/start-all";
      const result = await apiFetch<FleetSummary & { status: string }>(
        endpoint,
        { method: "POST" }
      );
      setFleet({
        total_agents: result.total_agents,
        running: result.running,
        stopped: result.stopped,
      });
    } catch (err) {
      console.error("Toggle failed:", err);
    } finally {
      setToggling(false);
      setTimeout(fetchFleet, 2000);
    }
  };

  const handleSwitchPerfMode = async (mode: string) => {
    setPerfDropdownOpen(false);
    try {
      await apiFetch("/api/operation-mode/performance", {
        method: "PUT",
        body: JSON.stringify({ mode }),
      });
      setPerfMode(mode);
    } catch (err) {
      console.error("Performance mode switch failed:", err);
    }
  };

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.channel === "metrics" || msg.channel === "metric") {
      setMetrics(msg.data as unknown as SOCMetrics);
    }
  }, []);

  useWebSocket({ channels: ["metrics"], onMessage: handleMessage });

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "b" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSidebarOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Lazy-load analytics when strip is opened
  useEffect(() => {
    if (!analyticsOpen) return;
    apiFetch<{ data: { timestamp: string; count: number }[] }>("/api/analytics/events-over-time?hours=24")
      .then((r) => setEventsOverTime(r.data ?? []))
      .catch((err) => { console.warn("[dashboard] API call failed:", err); });
    apiFetch<{ data: { severity: string; count: number }[] }>("/api/analytics/alerts-by-severity")
      .then((r) => setAlertsBySeverity(r.data ?? []))
      .catch((err) => { console.warn("[dashboard] API call failed:", err); });
    apiFetch<{ data: { zone_name: string; current_occupancy: number; max_occupancy: number | null; occupancy_pct: number | null }[] }>("/api/analytics/zone-occupancy")
      .then((r) => setZoneOccupancy((r.data ?? []).slice(0, 5)))
      .catch((err) => { console.warn("[dashboard] API call failed:", err); });
    apiFetch("/api/intelligence/posture-score")
      .then((r: any) => setPostureScore(r))
      .catch((err) => { console.warn("[dashboard] API call failed:", err); });
    apiFetch("/api/intelligence/predictions")
      .then((r: any) => setPredictions(r))
      .catch((err) => { console.warn("[dashboard] API call failed:", err); });
  }, [analyticsOpen]);

  // ── Fetch alerts for grouping + SLA row ────────────────────────────
  useEffect(() => {
    const fetchAlerts = () => {
      apiFetch<Alert[]>("/api/alerts?limit=100")
        .then(setSidebarAlerts)
        .catch((err) => { console.warn("[dashboard] API call failed:", err); });
    };
    fetchAlerts();
    const iv = setInterval(fetchAlerts, 30000);
    return () => clearInterval(iv);
  }, []);

  // ── Fetch system health gauges ──────────────────────────────────────
  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const d = await apiFetch<typeof systemHealth>("/api/health/deep");
        setSystemHealth(d);
      } catch { /* health deep may be unavailable during startup */ }
    };
    fetchHealth();
    const iv = setInterval(fetchHealth, 15000);
    return () => clearInterval(iv);
  }, []);

  const currentPerfMode = PERF_MODES.find((m) => m.key === perfMode) || PERF_MODES[2];
  const PerfIcon = currentPerfMode.icon;

  return (
    <div className="flex h-full flex-col">
      {/* Top metrics bar - compact */}
      <div className="border-b border-gray-800/40 px-3 py-1.5 flex items-center gap-2">
        {/* Power toggle */}
        <button
          onClick={handleToggle}
          disabled={toggling}
          className={cn(
            "relative flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-200 shrink-0 border",
            toggling && "opacity-70 cursor-wait",
            isOn
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 hover:border-emerald-500/50"
              : "border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:border-red-500/50"
          )}
          title={isOn ? "Stop SENTINEL AI" : "Start SENTINEL AI"}
        >
          {toggling ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Power className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">
            {toggling
              ? isOn ? "Stopping..." : "Starting..."
              : isOn ? "ON" : "OFF"}
          </span>
          {fleet && !toggling && (
            <span className={cn(
              "text-[10px] tabular-nums",
              isOn ? "text-emerald-500/70" : "text-red-500/70"
            )}>
              {fleet.running}/{fleet.total_agents}
            </span>
          )}
        </button>

        {/* Degraded agents warning */}
        {degradedCount > 0 && (
          <a
            href="/agents"
            className="flex items-center gap-1 rounded-md border border-orange-500/30 bg-orange-500/10 px-1.5 py-1 text-[10px] font-bold text-orange-400 hover:bg-orange-500/20 transition-all shrink-0"
            title={`${degradedCount} agent${degradedCount > 1 ? "s" : ""} degraded`}
          >
            <AlertCircle className="h-3 w-3" />
            {degradedCount}
          </a>
        )}

        {/* Pending HITL actions */}
        {pendingCount > 0 && (
          <a
            href="/pending-actions"
            className="relative flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-bold text-amber-400 hover:bg-amber-500/20 transition-all shrink-0"
            title={`${pendingCount} pending action${pendingCount > 1 ? "s" : ""}`}
          >
            <span className="absolute -top-1.5 -right-1.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-red-600 px-0.5 text-[7px] font-bold text-white animate-pulse">
              {pendingCount}
            </span>
            <ClipboardCheck className="h-3 w-3" />
            <span className="hidden sm:inline">HITL</span>
          </a>
        )}

        {/* Performance mode indicator + dropdown */}
        <div className="relative shrink-0" ref={dropdownRef}>
          <button
            onClick={() => setPerfDropdownOpen(!perfDropdownOpen)}
            className={cn(
              "flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-wider border transition-all",
              currentPerfMode.bg, currentPerfMode.border, currentPerfMode.color,
              "hover:opacity-80"
            )}
            title={`Performance: ${currentPerfMode.label}`}
          >
            <PerfIcon className="h-3 w-3" />
            <span className="hidden sm:inline">{currentPerfMode.abbr}</span>
            <ChevronDown className={cn(
              "h-2.5 w-2.5 transition-transform",
              perfDropdownOpen && "rotate-180"
            )} />
          </button>

          {/* Dropdown */}
          {perfDropdownOpen && (
            <div className="absolute left-0 top-full mt-1 z-50 w-52 rounded-lg border border-gray-700/60 bg-gray-900/95 backdrop-blur-lg shadow-xl overflow-hidden">
              <div className="px-3 py-1.5 border-b border-gray-800/50">
                <span className="text-[9px] font-bold uppercase tracking-widest text-gray-500">
                  Performance Mode
                </span>
              </div>
              {PERF_MODES.map((mode) => {
                const ModeIcon = mode.icon;
                const isActive = perfMode === mode.key;
                return (
                  <button
                    key={mode.key}
                    onClick={() => handleSwitchPerfMode(mode.key)}
                    className={cn(
                      "flex items-center gap-2.5 w-full px-3 py-2 text-left transition-colors",
                      isActive
                        ? `${mode.bg} ${mode.color}`
                        : "text-gray-400 hover:bg-gray-800/60 hover:text-gray-200"
                    )}
                  >
                    <ModeIcon className={cn("h-3.5 w-3.5 shrink-0", isActive ? mode.color : "text-gray-500")} />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold">{mode.label}</div>
                      <div className="text-[9px] text-gray-500 truncate">{mode.desc}</div>
                    </div>
                    {isActive && (
                      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", mode.color.replace("text-", "bg-"))} />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* AI Provider badge */}
        <span
          className={cn(
            "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider border shrink-0",
            aiProvider === "gemini"
              ? "border-blue-500/40 bg-blue-900/20 text-blue-400"
              : "border-purple-500/40 bg-purple-900/20 text-purple-400"
          )}
          title={`AI Provider: ${aiProvider}${aiProvider === "gemini" ? " (primary)" : " (fallback)"}`}
        >
          {aiProvider === "gemini" ? "GEMINI" : "OLLAMA"}
        </span>

        <div className="w-px h-4 bg-gray-800/60 shrink-0" />

        <SOCMetricsBar
          initialMetrics={metrics ?? undefined}
          className="flex-1"
        />
        <ThreatIndicator
          level={metrics?.threat_level ?? "normal"}
          compact
        />
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="rounded p-1 text-gray-500 hover:bg-gray-800/60 hover:text-gray-300 transition-colors shrink-0"
          title={sidebarOpen ? "Hide alerts (Ctrl+B)" : "Show alerts (Ctrl+B)"}
        >
          {sidebarOpen ? (
            <PanelRightClose className="h-4 w-4" />
          ) : (
            <PanelRightOpen className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* Analytics strip — collapsible */}
      <div className="shrink-0 border-b border-gray-800/30">
        <button
          onClick={() => setAnalyticsOpen(!analyticsOpen)}
          className="flex w-full items-center gap-2 px-3 py-1 text-[9px] font-bold uppercase tracking-widest text-gray-600 hover:text-gray-400 hover:bg-gray-900/40 transition-colors"
        >
          <BarChart3 className="h-3 w-3" />
          Analytics
          {analyticsOpen ? <ChevronUp className="h-2.5 w-2.5 ml-auto" /> : <ChevronDown className="h-2.5 w-2.5 ml-auto" />}
        </button>
        {analyticsOpen && (
          <div className="grid grid-cols-5 gap-3 px-3 pb-2">
            {/* Events sparkline */}
            <div className="rounded-md border border-gray-800/50 bg-gray-900/40 p-2">
              <p className="text-[8px] font-bold uppercase tracking-wider text-gray-500 mb-1">Events (24h)</p>
              {eventsOverTime.length > 1 ? (
                <svg viewBox="0 0 200 40" className="w-full h-8" preserveAspectRatio="none">
                  {(() => {
                    const maxC = Math.max(...eventsOverTime.map((d) => d.count), 1);
                    const pts = eventsOverTime.map((d, i) =>
                      `${(i / (eventsOverTime.length - 1)) * 200},${40 - (d.count / maxC) * 36}`
                    ).join(" ");
                    return (
                      <>
                        <polyline points={pts} fill="none" stroke="#22d3ee" strokeWidth="1.5" strokeLinejoin="round" />
                        <polyline points={`0,40 ${pts} 200,40`} fill="url(#sparkGrad)" stroke="none" />
                        <defs>
                          <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.2" />
                            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
                          </linearGradient>
                        </defs>
                      </>
                    );
                  })()}
                </svg>
              ) : (
                <p className="text-[9px] text-gray-600 h-8 flex items-center">No data</p>
              )}
              <p className="text-[9px] text-gray-400 mt-0.5 tabular-nums">
                {eventsOverTime.reduce((s, d) => s + d.count, 0).toLocaleString()} total
              </p>
            </div>

            {/* Alerts by severity */}
            <div className="rounded-md border border-gray-800/50 bg-gray-900/40 p-2">
              <p className="text-[8px] font-bold uppercase tracking-wider text-gray-500 mb-1">Alerts by Severity</p>
              {alertsBySeverity.length > 0 ? (
                <div className="space-y-1">
                  {alertsBySeverity.map((s) => {
                    const maxC = Math.max(...alertsBySeverity.map((x) => x.count), 1);
                    const color = s.severity === "critical" ? "bg-red-500" : s.severity === "high" ? "bg-orange-500" : s.severity === "medium" ? "bg-yellow-500" : s.severity === "low" ? "bg-blue-400" : "bg-gray-500";
                    return (
                      <div key={s.severity} className="flex items-center gap-1.5">
                        <span className="text-[8px] text-gray-500 w-12 text-right capitalize truncate">{s.severity}</span>
                        <div className="flex-1 h-2.5 bg-gray-800/60 rounded-sm overflow-hidden">
                          <div className={cn("h-full rounded-sm", color)} style={{ width: `${(s.count / maxC) * 100}%` }} />
                        </div>
                        <span className="text-[9px] text-gray-400 tabular-nums w-6">{s.count}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[9px] text-gray-600 h-8 flex items-center">No data</p>
              )}
            </div>

            {/* Zone occupancy top-5 */}
            <div className="rounded-md border border-gray-800/50 bg-gray-900/40 p-2">
              <p className="text-[8px] font-bold uppercase tracking-wider text-gray-500 mb-1">Zone Occupancy (Top 5)</p>
              {zoneOccupancy.length > 0 ? (
                <div className="space-y-1">
                  {zoneOccupancy.map((z) => {
                    const pct = z.occupancy_pct ?? (z.max_occupancy ? (z.current_occupancy / z.max_occupancy) * 100 : 0);
                    const color = pct > 80 ? "bg-red-500" : pct > 50 ? "bg-yellow-500" : "bg-emerald-500";
                    return (
                      <div key={z.zone_name} className="flex items-center gap-1.5">
                        <span className="text-[8px] text-gray-500 w-16 text-right truncate" title={z.zone_name}>{z.zone_name}</span>
                        <div className="flex-1 h-2.5 bg-gray-800/60 rounded-sm overflow-hidden">
                          <div className={cn("h-full rounded-sm", color)} style={{ width: `${Math.min(pct, 100)}%` }} />
                        </div>
                        <span className="text-[9px] text-gray-400 tabular-nums w-8">{Math.round(pct)}%</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[9px] text-gray-600 h-8 flex items-center">No data</p>
              )}
            </div>

            {/* Security Posture Score */}
            <div className="rounded-md border border-gray-800/50 bg-gray-900/40 p-2">
              <p className="text-[8px] font-bold uppercase tracking-wider text-gray-500 mb-1">Security Posture</p>
              {postureScore ? (
                <div className="flex items-center gap-2">
                  <div className="relative h-10 w-10 shrink-0">
                    <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90">
                      <circle cx="18" cy="18" r="16" fill="none" stroke="#1f2937" strokeWidth="3" />
                      <circle cx="18" cy="18" r="16" fill="none" strokeWidth="3" strokeDasharray={`${postureScore.score} ${100 - postureScore.score}`} strokeLinecap="round"
                        stroke={postureScore.score >= 90 ? "#10b981" : postureScore.score >= 75 ? "#22d3ee" : postureScore.score >= 60 ? "#eab308" : postureScore.score >= 40 ? "#f97316" : "#ef4444"}
                      />
                    </svg>
                    <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-white tabular-nums">{postureScore.score}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className={cn("text-xs font-bold", postureScore.grade === "EXCELLENT" ? "text-emerald-400" : postureScore.grade === "GOOD" ? "text-cyan-400" : postureScore.grade === "FAIR" ? "text-yellow-400" : "text-red-400")}>
                      {postureScore.grade}
                    </span>
                    <div className="space-y-0.5 mt-0.5">
                      {Object.entries(postureScore.components || {}).slice(0, 3).map(([key, val]: [string, any]) => (
                        <div key={key} className="flex items-center gap-1">
                          <span className="text-[7px] text-gray-600 w-12 truncate">{key.replace(/_/g, " ")}</span>
                          <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${val.score}%`, backgroundColor: val.score >= 80 ? "#10b981" : val.score >= 50 ? "#eab308" : "#ef4444" }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-[9px] text-gray-600 h-8 flex items-center">Loading...</p>
              )}
            </div>

            {/* Predictive Threats */}
            <div className="rounded-md border border-gray-800/50 bg-gray-900/40 p-2">
              <p className="text-[8px] font-bold uppercase tracking-wider text-gray-500 mb-1">Threat Forecast</p>
              {predictions ? (
                <div>
                  <div className="flex items-center gap-1 mb-1.5">
                    <span className={cn("h-1.5 w-1.5 rounded-full", predictions.overall_threat_forecast === "critical" ? "bg-red-500 animate-pulse" : predictions.overall_threat_forecast === "elevated" ? "bg-yellow-500" : "bg-emerald-500")} />
                    <span className={cn("text-[10px] font-bold uppercase", predictions.overall_threat_forecast === "critical" ? "text-red-400" : predictions.overall_threat_forecast === "elevated" ? "text-yellow-400" : "text-emerald-400")}>
                      {predictions.overall_threat_forecast}
                    </span>
                  </div>
                  {predictions.temporal_predictions.length > 0 ? (
                    <div className="space-y-1">
                      {predictions.temporal_predictions.slice(0, 3).map((p, i) => (
                        <div key={i} className="flex items-center gap-1 text-[8px]">
                          <span className="text-gray-500 w-8 truncate">{p.hour}</span>
                          <span className="text-gray-400 flex-1 truncate">{p.threat_type}</span>
                          <span className={cn("font-bold tabular-nums", p.probability > 0.7 ? "text-red-400" : p.probability > 0.3 ? "text-yellow-400" : "text-gray-500")}>
                            {Math.round(p.probability * 100)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[8px] text-gray-600">No patterns detected</p>
                  )}
                </div>
              ) : (
                <p className="text-[9px] text-gray-600 h-8 flex items-center">Loading...</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── SLA Countdown row — top 3 urgent unresolved alerts ─── */}
      {urgentAlerts.length > 0 && (
        <div className="shrink-0 border-b border-gray-800/30 px-3 py-1 flex items-center gap-2 overflow-x-auto">
          <Activity className="h-3 w-3 text-amber-400 shrink-0" />
          <span className="text-[8px] font-bold uppercase tracking-widest text-gray-600 shrink-0">SLA</span>
          {urgentAlerts.map((alert) => (
            <div key={alert.id} className="flex items-center gap-1.5 shrink-0">
              <span className="text-[9px] text-gray-400 max-w-[120px] truncate" title={alert.title}>{alert.title}</span>
              <SLACountdown
                deadline={slaDeadline(alert)}
                severity={alert.severity as "critical" | "high" | "medium" | "low"}
                compact
              />
            </div>
          ))}
        </div>
      )}

      {/* ── System Health Gauges row ───────────────────────────── */}
      {systemHealth && (
        <div className="shrink-0 border-b border-gray-800/30 px-3 py-1 flex items-center gap-4">
          <SystemHealthGauge
            label="Backend"
            value={systemHealth.backend?.cpu_pct ?? 0}
            unit="%"
            size={56}
            status={
              systemHealth.backend?.status === "healthy" ? "healthy"
              : systemHealth.backend?.status === "degraded" ? "warning"
              : systemHealth.backend ? "critical"
              : "offline"
            }
          />
          <SystemHealthGauge
            label="Memory"
            value={systemHealth.backend?.memory_pct ?? 0}
            unit="%"
            size={56}
            status={
              !systemHealth.backend ? "offline"
              : (systemHealth.backend.memory_pct ?? 0) >= 90 ? "critical"
              : (systemHealth.backend.memory_pct ?? 0) >= 70 ? "warning"
              : "healthy"
            }
          />
          <SystemHealthGauge
            label="Disk"
            value={systemHealth.backend?.disk_pct ?? 0}
            unit="%"
            size={56}
            status={
              !systemHealth.backend ? "offline"
              : (systemHealth.backend.disk_pct ?? 0) >= 90 ? "critical"
              : (systemHealth.backend.disk_pct ?? 0) >= 70 ? "warning"
              : "healthy"
            }
          />
          <SystemHealthGauge
            label="GPU"
            value={systemHealth.gpu?.gpu_utilization_pct ?? 0}
            unit="%"
            size={56}
            status={
              !systemHealth.gpu ? "offline"
              : systemHealth.gpu.status === "healthy" ? "healthy"
              : systemHealth.gpu.status === "degraded" ? "warning"
              : "critical"
            }
          />
          {/* Incident groups summary — minimal, beside gauges */}
          {incidentGroups.length > 0 && (
            <div className="flex-1 min-w-0 ml-2 border-l border-gray-800/40 pl-3">
              <p className="text-[8px] font-bold uppercase tracking-widest text-gray-600 mb-1">
                Active Incidents ({incidentGroups.length})
              </p>
              <div className="flex flex-col gap-0.5 max-h-14 overflow-y-auto">
                {incidentGroups.slice(0, 5).map((grp) => {
                  const isOpen = expandedGroups.has(grp.id);
                  const severityColor =
                    grp.topSeverity === "critical" ? "text-red-400 border-red-700/40 bg-red-900/15"
                    : grp.topSeverity === "high" ? "text-orange-400 border-orange-700/40 bg-orange-900/15"
                    : grp.topSeverity === "medium" ? "text-yellow-400 border-yellow-700/40 bg-yellow-900/15"
                    : "text-blue-400 border-blue-700/40 bg-blue-900/15";
                  return (
                    <div key={grp.id}>
                      <button
                        onClick={() => setExpandedGroups((prev) => {
                          const next = new Set(prev);
                          if (next.has(grp.id)) next.delete(grp.id);
                          else next.add(grp.id);
                          return next;
                        })}
                        className={cn(
                          "flex items-center gap-1.5 w-full rounded px-1.5 py-0.5 border text-left transition-colors",
                          severityColor
                        )}
                      >
                        <ChevronRight className={cn("h-2.5 w-2.5 shrink-0 transition-transform", isOpen && "rotate-90")} />
                        {grp.camera && <Camera className="h-2 w-2 shrink-0 opacity-60" />}
                        <span className="text-[9px] font-medium truncate flex-1">
                          {grp.camera ?? "No Camera"} — {grp.alerts[0].title}
                        </span>
                        <span className="text-[8px] font-bold tabular-nums shrink-0 rounded-full bg-black/30 px-1">
                          {grp.alerts.length}
                        </span>
                      </button>
                      {isOpen && (
                        <div className="ml-4 mt-0.5 space-y-px">
                          {grp.alerts.map((a) => (
                            <div key={a.id} className="flex items-center gap-1 text-[8px] text-gray-500 px-1">
                              <span className={cn(
                                "h-1 w-1 rounded-full shrink-0",
                                a.severity === "critical" ? "bg-red-500"
                                : a.severity === "high" ? "bg-orange-500"
                                : a.severity === "medium" ? "bg-yellow-500"
                                : "bg-blue-400"
                              )} />
                              <span className="truncate flex-1">{a.title}</span>
                              <span className="text-gray-700 tabular-nums shrink-0">
                                {new Date(a.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main content: Video wall + optional Alert sidebar */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Video wall — fixed position, never moves */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          <AgenticVideoWall />
        </div>

        {/* Right sidebar: Alerts — fixed position with internal scroll */}
        {sidebarOpen && (
          <div className="flex w-72 flex-col border-l border-gray-800/40 xl:w-80 min-h-0 overflow-hidden">
            <AlertFeed className="h-full border-l-0" />
          </div>
        )}
      </div>

      {/* System status footer */}
      <div className="flex items-center gap-4 border-t border-gray-800/30 px-3 py-1 text-[9px] text-gray-600 shrink-0">
        <span>
          Mode:{" "}
          <span className={cn("font-bold uppercase", opMode === "autonomous" ? "text-emerald-500" : "text-amber-500")}>
            {opMode ?? "---"}
          </span>
        </span>
        <span className="text-gray-800">|</span>
        <span>
          Fleet: <span className="text-gray-400 font-mono">{fleet?.running ?? 0}/{fleet?.total_agents ?? 0}</span> agents
        </span>
        {degradedCount > 0 && (
          <>
            <span className="text-gray-800">|</span>
            <span className="text-orange-500">{degradedCount} degraded</span>
          </>
        )}
        {pendingCount > 0 && (
          <>
            <span className="text-gray-800">|</span>
            <span className="text-amber-400">{pendingCount} pending</span>
          </>
        )}
      </div>
    </div>
  );
}
