"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Activity,
  AlertTriangle,
  Brain,
  ChevronRight,
  Eye,
  Loader2,
  Shield,
  TrendingUp,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CortexStatus {
  name: string;
  status: string;
  security_posture?: string;
  threat_level?: string;
  cycle_count?: number;
  last_action_time?: string | null;
  active_directives?: string[];
  situational_assessment?: string;
}

interface CortexDecision {
  id: string;
  timestamp: string;
  decision?: string;
  response_summary?: string;
  confidence?: number;
}

interface FleetHealth {
  total: number;
  running: number;
  stopped: number;
  error: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const POSTURE_CONFIG: Record<
  string,
  { color: string; ring: string; bg: string; label: string }
> = {
  green: {
    color: "text-green-400",
    ring: "ring-green-500",
    bg: "bg-green-500",
    label: "SECURE",
  },
  normal: {
    color: "text-green-400",
    ring: "ring-green-500",
    bg: "bg-green-500",
    label: "NORMAL",
  },
  yellow: {
    color: "text-yellow-400",
    ring: "ring-yellow-500",
    bg: "bg-yellow-500",
    label: "ELEVATED",
  },
  elevated: {
    color: "text-yellow-400",
    ring: "ring-yellow-500",
    bg: "bg-yellow-500",
    label: "ELEVATED",
  },
  orange: {
    color: "text-orange-400",
    ring: "ring-orange-500",
    bg: "bg-orange-500",
    label: "HIGH",
  },
  high: {
    color: "text-orange-400",
    ring: "ring-orange-500",
    bg: "bg-orange-500",
    label: "HIGH",
  },
  red: {
    color: "text-red-400",
    ring: "ring-red-500",
    bg: "bg-red-500",
    label: "CRITICAL",
  },
  critical: {
    color: "text-red-400",
    ring: "ring-red-500",
    bg: "bg-red-500",
    label: "CRITICAL",
  },
};

/* ------------------------------------------------------------------ */
/*  PostureGauge                                                       */
/* ------------------------------------------------------------------ */

function PostureGauge({ posture }: { posture: string }) {
  const config = POSTURE_CONFIG[posture] || POSTURE_CONFIG.green;

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={cn(
          "relative flex h-20 w-20 items-center justify-center rounded-full ring-4",
          config.ring
        )}
      >
        {/* Glowing inner */}
        <div
          className={cn(
            "absolute inset-2 rounded-full opacity-20",
            config.bg
          )}
        />
        <Shield className={cn("relative h-8 w-8", config.color)} />
      </div>
      <span
        className={cn(
          "text-xs font-bold uppercase tracking-widest",
          config.color
        )}
      >
        {config.label}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  CortexOverview                                                     */
/* ------------------------------------------------------------------ */

export default function CortexOverview({
  className,
}: {
  className?: string;
}) {
  const [cortexStatus, setCortexStatus] = useState<CortexStatus | null>(null);
  const [decisions, setDecisions] = useState<CortexDecision[]>([]);
  const [fleetHealth, setFleetHealth] = useState<FleetHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [statusData, auditData, fleetData] = await Promise.allSettled([
        apiFetch<{ agents: CortexStatus[]; fleet: FleetHealth }>("/api/agents/status"),
        apiFetch<CortexDecision[]>(
          "/api/agents/audit?agent_name=sentinel_cortex&limit=5&action_type=decision"
        ),
        apiFetch<FleetHealth>("/api/agents/fleet"),
      ]);

      if (statusData.status === "fulfilled") {
        // Extract cortex agent from the fleet status list
        const allAgents = Array.isArray(statusData.value)
          ? statusData.value
          : statusData.value.agents ?? [];
        const cortex = allAgents.find(
          (a: CortexStatus) => a.name === "sentinel_cortex"
        );
        if (cortex) setCortexStatus(cortex);

        // Also extract fleet health from the same response if /fleet fails
        if (!fleetData || fleetData.status !== "fulfilled") {
          const fleet = (statusData.value as { fleet?: FleetHealth }).fleet;
          if (fleet) setFleetHealth(fleet);
        }
      }
      if (auditData.status === "fulfilled") {
        setDecisions(Array.isArray(auditData.value) ? auditData.value : []);
      }
      if (fleetData.status === "fulfilled") {
        setFleetHealth(fleetData.value);
      }

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch cortex data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 15_000);
    return () => clearInterval(timer);
  }, [fetchData]);

  if (loading) {
    return (
      <div className={cn("flex items-center justify-center py-12", className)}>
        <Loader2 className="h-6 w-6 animate-spin text-purple-400" />
        <span className="ml-2 text-sm text-gray-500">
          Loading Cortex overview...
        </span>
      </div>
    );
  }

  if (error && !cortexStatus) {
    return (
      <div className={cn("flex flex-col items-center justify-center py-12", className)}>
        <AlertTriangle className="mb-2 h-6 w-6 text-red-500" />
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={fetchData}
          className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  const posture =
    cortexStatus?.security_posture ||
    cortexStatus?.threat_level ||
    "normal";

  return (
    <div
      className={cn(
        "rounded-lg border border-gray-800 bg-gray-900/60",
        className
      )}
    >
      <div className="flex flex-col gap-6 p-5 lg:flex-row">
        {/* Left: Posture gauge + assessment */}
        <div className="flex items-start gap-5">
          <PostureGauge posture={posture} />
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex items-center gap-2">
              <Brain className="h-4 w-4 text-purple-400" />
              <h3 className="text-sm font-bold text-gray-200">
                Sentinel Cortex
              </h3>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize",
                  cortexStatus?.status === "running"
                    ? "bg-green-900/30 text-green-400 border border-green-800/40"
                    : "bg-gray-800 text-gray-500 border border-gray-700"
                )}
              >
                {cortexStatus?.status || "unknown"}
              </span>
            </div>

            {/* Situational assessment */}
            {cortexStatus?.situational_assessment && (
              <div className="rounded-md border border-purple-900/40 bg-purple-950/10 p-3">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-purple-500">
                  Situational Assessment
                </p>
                <p className="text-xs leading-relaxed text-purple-300">
                  {cortexStatus.situational_assessment}
                </p>
              </div>
            )}

            {/* Active directives */}
            {cortexStatus?.active_directives &&
              cortexStatus.active_directives.length > 0 && (
                <div>
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                    Active Directives
                  </p>
                  <ul className="space-y-1">
                    {cortexStatus.active_directives.map((d, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-1.5 text-xs text-gray-300"
                      >
                        <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-cyan-500" />
                        {d}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
          </div>
        </div>

        {/* Right: Fleet health + latest decisions */}
        <div className="flex flex-1 flex-col gap-4 lg:flex-row lg:gap-6">
          {/* Fleet health */}
          {fleetHealth && (
            <div className="rounded-md border border-gray-800 bg-gray-950/50 p-4 min-w-[180px]">
              <p className="mb-2.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                <Activity className="h-3 w-3" />
                Fleet Health
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-lg font-bold text-gray-200">
                    {fleetHealth.total}
                  </p>
                  <p className="text-[10px] text-gray-500">Total</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-green-400">
                    {fleetHealth.running}
                  </p>
                  <p className="text-[10px] text-gray-500">Running</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-gray-400">
                    {fleetHealth.stopped}
                  </p>
                  <p className="text-[10px] text-gray-500">Stopped</p>
                </div>
                <div>
                  <p
                    className={cn(
                      "text-lg font-bold",
                      fleetHealth.error > 0 ? "text-red-400" : "text-gray-400"
                    )}
                  >
                    {fleetHealth.error}
                  </p>
                  <p className="text-[10px] text-gray-500">Errors</p>
                </div>
              </div>
            </div>
          )}

          {/* Latest decisions */}
          <div className="flex-1 rounded-md border border-gray-800 bg-gray-950/50 p-4">
            <p className="mb-2.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-500">
              <Eye className="h-3 w-3" />
              Latest Assessments
            </p>
            {decisions.length === 0 ? (
              <p className="text-xs text-gray-600">No assessments yet</p>
            ) : (
              <div className="space-y-2">
                {decisions.slice(0, 3).map((d) => (
                  <div
                    key={d.id}
                    className="rounded border border-gray-800/60 bg-gray-900/40 px-3 py-2"
                  >
                    <p className="text-xs text-gray-300 line-clamp-2">
                      {d.decision || d.response_summary || "---"}
                    </p>
                    <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-600">
                      <span>{formatTimestamp(d.timestamp)}</span>
                      {d.confidence != null && (
                        <span className="font-mono text-cyan-400">
                          {Math.round(d.confidence * 100)}%
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Prediction section */}
      {decisions.length > 0 && decisions[0]?.response_summary && (
        <div className="border-t border-gray-800 px-5 py-3">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-amber-500">
            <TrendingUp className="h-3 w-3" />
            Predictive Assessment
          </div>
          <p className="mt-1 text-xs text-gray-400 leading-relaxed line-clamp-2">
            {decisions[0].response_summary}
          </p>
        </div>
      )}
    </div>
  );
}
