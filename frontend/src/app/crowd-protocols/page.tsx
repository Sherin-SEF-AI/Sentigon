"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  Users,
  Loader2,
  AlertTriangle,
  ShieldCheck,
  Zap,
  ChevronRight,
  Play,
  Square,
  Radio,
  Settings2,
  Check,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import MetricSparkline from "@/components/common/MetricSparkline";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CrowdProtocol {
  id: string;
  name: string;
  description: string;
  severity: string;
  status: "active" | "standby" | "triggered" | "resolved";
  tension_level: number;
  recommended_actions: string[];
  crowd_state?: string;
  updated_at?: string;
}

interface CrowdProtocolsResponse {
  protocols: CrowdProtocol[];
  current_tension: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function tensionColor(level: number): { bar: string; text: string; label: string } {
  if (level >= 80) return { bar: "bg-red-500", text: "text-red-400", label: "Critical" };
  if (level >= 60) return { bar: "bg-orange-500", text: "text-orange-400", label: "High" };
  if (level >= 30) return { bar: "bg-yellow-500", text: "text-yellow-400", label: "Elevated" };
  return { bar: "bg-green-500", text: "text-green-400", label: "Normal" };
}

const STATUS_BADGE: Record<string, string> = {
  active: "bg-blue-900/40 text-blue-400 border-blue-800",
  standby: "bg-gray-800 text-gray-400 border-gray-700",
  triggered: "bg-red-900/40 text-red-400 border-red-800",
  resolved: "bg-green-900/40 text-green-400 border-green-800",
};

const SEVERITY_BADGE: Record<string, string> = {
  critical: "bg-red-900/40 text-red-400 border-red-800",
  high: "bg-orange-900/40 text-orange-400 border-orange-800",
  medium: "bg-yellow-900/40 text-yellow-400 border-yellow-800",
  low: "bg-blue-900/40 text-blue-400 border-blue-800",
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const ESCALATION_LS_KEY = "sentinel_crowd_escalation_rule";
const MAX_HISTORY = 20;

interface EscalationRule {
  threshold: number;
  durationMinutes: number;
}

function loadEscalationRule(): EscalationRule {
  if (typeof window === "undefined") return { threshold: 75, durationMinutes: 5 };
  try {
    const raw = localStorage.getItem(ESCALATION_LS_KEY);
    if (raw) return JSON.parse(raw) as EscalationRule;
  } catch { /* ignore */ }
  return { threshold: 75, durationMinutes: 5 };
}

export default function CrowdProtocolsPage() {
  const { addToast } = useToast();
  const [protocols, setProtocols] = useState<CrowdProtocol[]>([]);
  const [tension, setTension] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Per-protocol action loading state
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Tension history sparkline (last 20 readings)
  const [tensionHistory, setTensionHistory] = useState<number[]>([]);

  // Auto-escalation rule state
  const [escalationRule, setEscalationRule] = useState<EscalationRule>(() => loadEscalationRule());
  const [showEscalationConfig, setShowEscalationConfig] = useState(false);
  const [editThreshold, setEditThreshold] = useState(String(escalationRule.threshold));
  const [editDuration, setEditDuration] = useState(String(escalationRule.durationMinutes));

  // Tracks how long tension has been above threshold for auto-escalation
  const escalationTimerRef = useRef<NodeJS.Timeout | null>(null);
  const tensionAboveThresholdSince = useRef<number | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<CrowdProtocolsResponse>("/api/crowd-protocols/");
      setProtocols(data.protocols || []);
      const newTension = data.current_tension ?? 0;
      setTension(newTension);
      // Append to history, keep last MAX_HISTORY readings
      setTensionHistory((prev) => {
        const updated = [...prev, newTension];
        return updated.length > MAX_HISTORY ? updated.slice(updated.length - MAX_HISTORY) : updated;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch crowd protocols");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-escalation: monitor tension against the rule
  useEffect(() => {
    const thresholdExceeded = tension >= escalationRule.threshold;
    if (thresholdExceeded) {
      if (tensionAboveThresholdSince.current === null) {
        tensionAboveThresholdSince.current = Date.now();
      }
      const elapsedMs = Date.now() - tensionAboveThresholdSince.current;
      const thresholdMs = escalationRule.durationMinutes * 60_000;
      if (elapsedMs >= thresholdMs) {
        addToast("error", `AUTO-ESCALATION: Tension ${tension} has exceeded ${escalationRule.threshold} for ${escalationRule.durationMinutes}min — immediate response required.`);
        // Reset timer so it doesn't fire every render
        tensionAboveThresholdSince.current = null;
      }
    } else {
      tensionAboveThresholdSince.current = null;
    }
    return () => {
      if (escalationTimerRef.current) clearTimeout(escalationTimerRef.current);
    };
  }, [tension, escalationRule, addToast]);

  // Save escalation rule to localStorage whenever it changes
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(ESCALATION_LS_KEY, JSON.stringify(escalationRule));
    }
  }, [escalationRule]);

  /* --- Activate a protocol --- */
  const handleActivate = useCallback(
    async (protocol: CrowdProtocol) => {
      const confirmed = window.confirm(
        `Activate "${protocol.name}"?\n\nThis will mark the protocol as active and initiate the recommended actions.`
      );
      if (!confirmed) return;

      setActionLoading(protocol.id);
      try {
        const updated = await apiFetch<CrowdProtocol>(
          `/api/crowd-protocols/${protocol.id}/activate`,
          { method: "POST" }
        );
        setProtocols((prev) =>
          prev.map((p) => (p.id === protocol.id ? { ...p, ...updated } : p))
        );
        addToast("success", `"${protocol.name}" activated successfully.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Activation failed";
        addToast("error", `Failed to activate "${protocol.name}": ${msg}`);
      } finally {
        setActionLoading(null);
      }
    },
    [addToast]
  );

  /* --- Deactivate a protocol --- */
  const handleDeactivate = useCallback(
    async (protocol: CrowdProtocol) => {
      const confirmed = window.confirm(
        `Deactivate "${protocol.name}"?\n\nThe protocol will be returned to standby.`
      );
      if (!confirmed) return;

      setActionLoading(protocol.id);
      try {
        const updated = await apiFetch<CrowdProtocol>(
          `/api/crowd-protocols/${protocol.id}/deactivate`,
          { method: "POST" }
        );
        setProtocols((prev) =>
          prev.map((p) => (p.id === protocol.id ? { ...p, ...updated } : p))
        );
        addToast("info", `"${protocol.name}" deactivated — now on standby.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Deactivation failed";
        addToast("error", `Failed to deactivate "${protocol.name}": ${msg}`);
      } finally {
        setActionLoading(null);
      }
    },
    [addToast]
  );

  const handleSaveEscalationRule = useCallback(() => {
    const threshold = Math.min(100, Math.max(1, Number(editThreshold) || 75));
    const durationMinutes = Math.max(1, Number(editDuration) || 5);
    setEscalationRule({ threshold, durationMinutes });
    setShowEscalationConfig(false);
    addToast("success", `Auto-escalation rule saved: tension > ${threshold} for ${durationMinutes}min.`);
  }, [editThreshold, editDuration, addToast]);

  const tc = useMemo(() => tensionColor(tension), [tension]);
  const activeProtocols = useMemo(
    () => protocols.filter((p) => p.status === "active" || p.status === "triggered"),
    [protocols]
  );

  return (
    <div className="min-h-screen bg-gray-950 p-6">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
          <Users className="h-5 w-5 text-cyan-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-cyan-400 tracking-wide">
            Crowd Management Protocols
          </h1>
          <p className="text-xs text-gray-500">
            Real-time tension monitoring and protocol management
          </p>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          <p className="mt-3 text-sm text-gray-500">Loading crowd protocols...</p>
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="flex flex-col items-center justify-center py-20">
          <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={fetchData}
            className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && (
        <div className="space-y-6">
          {/* ---- Tension Meter ---- */}
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
                Current Tension Level
              </h2>
              <div className="flex items-center gap-4">
                {/* Sparkline for tension history */}
                {tensionHistory.length >= 2 && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-wider text-gray-600">History</span>
                    <MetricSparkline
                      data={tensionHistory}
                      width={100}
                      height={28}
                      color={tension >= 80 ? "#ef4444" : tension >= 60 ? "#f97316" : tension >= 30 ? "#eab308" : "#22c55e"}
                      fill
                      showValue={false}
                    />
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className={cn("text-3xl font-bold font-mono", tc.text)}>
                    {tension}
                  </span>
                  <span className="text-sm text-gray-500">/ 100</span>
                </div>
              </div>
            </div>

            {/* Gauge bar */}
            <div className="relative h-6 w-full overflow-hidden rounded-full bg-gray-800">
              {/* Gradient background track */}
              <div
                className="absolute inset-0 opacity-20"
                style={{
                  background:
                    "linear-gradient(to right, #22c55e 0%, #22c55e 30%, #eab308 30%, #eab308 60%, #f97316 60%, #f97316 80%, #ef4444 80%, #ef4444 100%)",
                }}
              />
              {/* Active fill */}
              <div
                className={cn("h-full rounded-full transition-all duration-700 ease-out", tc.bar)}
                style={{ width: `${Math.min(100, Math.max(0, tension))}%` }}
              />
              {/* Marker ticks */}
              <div className="absolute top-0 left-[30%] h-full w-px bg-gray-700" />
              <div className="absolute top-0 left-[60%] h-full w-px bg-gray-700" />
              <div className="absolute top-0 left-[80%] h-full w-px bg-gray-700" />
            </div>

            {/* Scale labels */}
            <div className="mt-2 flex justify-between text-[10px] text-gray-600">
              <span>0 - Normal</span>
              <span>30 - Elevated</span>
              <span>60 - High</span>
              <span>80 - Critical</span>
              <span>100</span>
            </div>

            {/* Status label */}
            <div className="mt-4 flex items-center justify-center">
              <span
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold border",
                  tension >= 80
                    ? "bg-red-900/30 text-red-400 border-red-800/50"
                    : tension >= 60
                    ? "bg-orange-900/30 text-orange-400 border-orange-800/50"
                    : tension >= 30
                    ? "bg-yellow-900/30 text-yellow-400 border-yellow-800/50"
                    : "bg-green-900/30 text-green-400 border-green-800/50"
                )}
              >
                <Zap className="h-4 w-4" />
                Tension: {tc.label}
              </span>
            </div>
          </div>

          {/* ---- Auto-Escalation Rule Config ---- */}
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-gray-500" />
                <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
                  Auto-Escalation Rule
                </h2>
                {/* Current rule badge */}
                <span className="inline-flex items-center gap-1 rounded border border-orange-800/60 bg-orange-900/30 px-2 py-0.5 text-[10px] font-semibold text-orange-400">
                  <Zap className="h-2.5 w-2.5" />
                  Tension &gt; {escalationRule.threshold} for {escalationRule.durationMinutes}min
                </span>
              </div>
              <button
                onClick={() => {
                  setEditThreshold(String(escalationRule.threshold));
                  setEditDuration(String(escalationRule.durationMinutes));
                  setShowEscalationConfig(!showEscalationConfig);
                }}
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                {showEscalationConfig ? "Cancel" : "Configure"}
              </button>
            </div>

            {showEscalationConfig && (
              <div className="flex items-end gap-3 flex-wrap">
                <div>
                  <label className="mb-1 block text-[11px] text-gray-500">
                    Tension Threshold (1–100)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={editThreshold}
                    onChange={(e) => setEditThreshold(e.target.value)}
                    className="w-24 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-orange-700 focus:outline-none focus:ring-1 focus:ring-orange-700"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-gray-500">
                    Sustained Duration (minutes)
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={editDuration}
                    onChange={(e) => setEditDuration(e.target.value)}
                    className="w-24 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-orange-700 focus:outline-none focus:ring-1 focus:ring-orange-700"
                  />
                </div>
                <button
                  onClick={handleSaveEscalationRule}
                  className="flex items-center gap-1.5 rounded-lg bg-orange-900/40 border border-orange-800/60 px-3 py-2 text-xs font-semibold text-orange-400 hover:bg-orange-800/50 transition-colors"
                >
                  <Check className="h-3.5 w-3.5" />
                  Save Rule
                </button>
              </div>
            )}

            {!showEscalationConfig && (
              <p className="text-xs text-gray-600">
                An alert will fire if crowd tension exceeds{" "}
                <span className="text-orange-400 font-semibold">{escalationRule.threshold}</span>{" "}
                for{" "}
                <span className="text-orange-400 font-semibold">{escalationRule.durationMinutes} minute{escalationRule.durationMinutes !== 1 ? "s" : ""}</span>{" "}
                continuously. Rule persists across sessions.
              </p>
            )}
          </div>

          {/* ---- Active Protocols Panel ---- */}
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-5">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-gray-400">
              <ShieldCheck className="h-4 w-4" />
              Protocol Status
              <span className="ml-1 rounded bg-gray-800 px-2 py-0.5 text-[10px] font-mono text-gray-500">
                {activeProtocols.length} active
              </span>
            </h2>

            {protocols.length === 0 ? (
              <p className="py-8 text-center text-sm text-gray-600">
                No protocols configured
              </p>
            ) : (
              <div className="space-y-2">
                {protocols.map((p) => {
                  const isActive = p.status === "active" || p.status === "triggered";
                  const isThisLoading = actionLoading === p.id;
                  return (
                    <div
                      key={p.id}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors",
                        isActive
                          ? "border-blue-800/60 bg-blue-950/20"
                          : "border-gray-800 bg-gray-950/50 hover:border-gray-700"
                      )}
                    >
                      {/* Active pulse indicator */}
                      {isActive ? (
                        <span className="relative flex h-2.5 w-2.5 shrink-0">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
                          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500" />
                        </span>
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-gray-600" />
                      )}

                      <span className="flex-1 text-sm font-medium text-gray-200">
                        {p.name}
                      </span>

                      <span
                        className={cn(
                          "inline-flex shrink-0 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                          SEVERITY_BADGE[p.severity] || "bg-gray-800 text-gray-400 border-gray-700"
                        )}
                      >
                        {p.severity}
                      </span>

                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                          STATUS_BADGE[p.status] || "bg-gray-800 text-gray-400 border-gray-700"
                        )}
                      >
                        {isActive && <Radio className="h-2.5 w-2.5" />}
                        {p.status}
                      </span>

                      {/* Action button */}
                      {isActive ? (
                        <button
                          onClick={() => handleDeactivate(p)}
                          disabled={isThisLoading}
                          title="Deactivate Protocol"
                          className={cn(
                            "flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors border",
                            "bg-gray-800 text-gray-400 border-gray-700",
                            "hover:bg-gray-700 hover:text-gray-200 hover:border-gray-600",
                            "disabled:opacity-50 disabled:cursor-not-allowed"
                          )}
                        >
                          {isThisLoading ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Square className="h-3 w-3" />
                          )}
                          Deactivate
                        </button>
                      ) : (
                        <button
                          onClick={() => handleActivate(p)}
                          disabled={isThisLoading}
                          title="Activate Protocol"
                          className={cn(
                            "flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors border",
                            "bg-cyan-900/40 text-cyan-400 border-cyan-800/60",
                            "hover:bg-cyan-800/50 hover:text-cyan-300 hover:border-cyan-700",
                            "disabled:opacity-50 disabled:cursor-not-allowed"
                          )}
                        >
                          {isThisLoading ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Play className="h-3 w-3" />
                          )}
                          Activate
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ---- Recommendation Cards ---- */}
          <div>
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-400">
              Recommended Actions
            </h2>

            {protocols.length === 0 ? (
              <p className="py-8 text-center text-sm text-gray-600">
                No recommendations available
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {protocols.map((p) => {
                  const isActive = p.status === "active" || p.status === "triggered";
                  const isThisLoading = actionLoading === p.id;
                  return (
                    <div
                      key={p.id}
                      className={cn(
                        "rounded-lg border bg-gray-900/60 p-5 transition-colors",
                        isActive
                          ? "border-blue-800/60 ring-1 ring-blue-800/30"
                          : "border-gray-800 hover:border-gray-700"
                      )}
                    >
                      {/* Card header */}
                      <div className="mb-3 flex items-start justify-between gap-2">
                        <h3 className="text-sm font-semibold text-gray-200">
                          {p.name}
                        </h3>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {isActive && (
                            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider border border-blue-800 bg-blue-900/40 text-blue-400">
                              <Radio className="h-2 w-2" />
                              Active
                            </span>
                          )}
                          <span
                            className={cn(
                              "inline-flex shrink-0 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                              SEVERITY_BADGE[p.severity] || "bg-gray-800 text-gray-400 border-gray-700"
                            )}
                          >
                            {p.severity}
                          </span>
                        </div>
                      </div>

                      {/* Description */}
                      <p className="mb-4 text-xs leading-relaxed text-gray-400">
                        {p.description}
                      </p>

                      {/* Recommended actions */}
                      {p.recommended_actions && p.recommended_actions.length > 0 && (
                        <div className="mb-4">
                          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                            Actions
                          </h4>
                          <ul className="space-y-1.5">
                            {p.recommended_actions.map((action, i) => (
                              <li
                                key={i}
                                className="flex items-start gap-2 text-xs text-gray-300"
                              >
                                <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-500" />
                                {action}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Card action button */}
                      {isActive ? (
                        <button
                          onClick={() => handleDeactivate(p)}
                          disabled={isThisLoading}
                          className={cn(
                            "mt-auto flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors border",
                            "bg-gray-800 text-gray-400 border-gray-700",
                            "hover:bg-gray-700 hover:text-gray-200",
                            "disabled:opacity-50 disabled:cursor-not-allowed"
                          )}
                        >
                          {isThisLoading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Square className="h-3.5 w-3.5" />
                          )}
                          Deactivate Protocol
                        </button>
                      ) : (
                        <button
                          onClick={() => handleActivate(p)}
                          disabled={isThisLoading}
                          className={cn(
                            "mt-auto flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors border",
                            "bg-cyan-900/40 text-cyan-400 border-cyan-800/60",
                            "hover:bg-cyan-800/50 hover:text-cyan-300",
                            "disabled:opacity-50 disabled:cursor-not-allowed"
                          )}
                        >
                          {isThisLoading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Play className="h-3.5 w-3.5" />
                          )}
                          Activate Protocol
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
