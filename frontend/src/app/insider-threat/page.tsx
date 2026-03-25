"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  UserX,
  Loader2,
  AlertTriangle,
  Eye,
  Flag,
  CheckCircle2,
  RefreshCw,
  Activity,
  ShieldAlert,
  X,
  Database,
  Clock,
  DoorOpen,
  Zap,
  LayoutGrid,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import type { InsiderThreatProfile } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Additional types for detail & anomaly views                        */
/* ------------------------------------------------------------------ */

interface AccessEventItem {
  id: string;
  door_id: string | null;
  event_type: string;
  timestamp: string | null;
}

interface ProfileDetail extends InsiderThreatProfile {
  recent_access_events: AccessEventItem[];
}

interface AnomalyItem {
  profile_id: string;
  user_id: string | null;
  anomaly_type: string;
  description: string;
  risk_score: number;
  timestamp: string | null;
}

interface BaselineResult {
  user_id: string;
  profile_id: string;
  baseline_access_pattern: Record<string, unknown>;
  status: string;
  message: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function riskScoreColor(score: number): string {
  if (score >= 80) return "text-red-400";
  if (score >= 60) return "text-orange-400";
  if (score >= 30) return "text-yellow-400";
  return "text-green-400";
}

function riskScoreBarColor(score: number): string {
  if (score >= 80) return "bg-red-500";
  if (score >= 60) return "bg-orange-500";
  if (score >= 30) return "bg-yellow-500";
  return "bg-green-500";
}

function riskScoreBgColor(score: number): string {
  if (score >= 80) return "bg-red-500/20 border-red-700/40";
  if (score >= 60) return "bg-orange-500/20 border-orange-700/40";
  if (score >= 30) return "bg-yellow-500/20 border-yellow-700/40";
  return "bg-green-500/20 border-green-700/40";
}

const STATUS_STYLES: Record<string, { color: string; icon: React.ReactNode }> =
  {
    monitoring: {
      color: "text-blue-400 bg-blue-900/30 border-blue-700/50",
      icon: <Eye className="h-3 w-3" />,
    },
    flagged: {
      color: "text-red-400 bg-red-900/30 border-red-700/50",
      icon: <Flag className="h-3 w-3" />,
    },
    cleared: {
      color: "text-green-400 bg-green-900/30 border-green-700/50",
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
  };

/* ------------------------------------------------------------------ */
/*  Access Pattern types                                               */
/* ------------------------------------------------------------------ */

interface AccessPatternData {
  /** hour (0-23) → day (0=Mon..6=Sun) → count */
  grid: number[][];
}

/* ------------------------------------------------------------------ */
/*  AccessPatternGrid                                                   */
/* ------------------------------------------------------------------ */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function AccessPatternGrid({ profileId }: { profileId?: string }) {
  const [grid, setGrid] = useState<number[][] | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setUnavailable(false);
    setGrid(null);

    const url = profileId
      ? `/api/insider-threat/access-patterns?profile_id=${profileId}`
      : "/api/insider-threat/access-patterns";

    apiFetch<AccessPatternData>(url)
      .then((data) => {
        if (!cancelled && data?.grid) setGrid(data.grid);
        else if (!cancelled) setUnavailable(true);
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [profileId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
        <span className="ml-2 text-xs text-gray-500">Loading access patterns...</span>
      </div>
    );
  }

  if (unavailable || !grid) {
    return (
      <p className="py-4 text-center text-xs text-gray-600">
        Access pattern data unavailable
      </p>
    );
  }

  /* Compute global average across all cells */
  const allCounts = grid.flatMap((row) => row);
  const total = allCounts.reduce((s, v) => s + v, 0);
  const avg = total / (allCounts.length || 1);
  const maxCount = Math.max(...allCounts, 1);

  return (
    <div className="overflow-x-auto">
      {/* Column headers: days */}
      <div className="grid" style={{ gridTemplateColumns: `40px repeat(7, 1fr)` }}>
        <div />
        {DAYS.map((d) => (
          <div key={d} className="text-center text-[9px] font-semibold uppercase tracking-wider text-gray-500 pb-1">
            {d}
          </div>
        ))}
      </div>

      {/* Rows: hours 0-23 */}
      <div className="space-y-0.5">
        {Array.from({ length: 24 }, (_, hour) => (
          <div
            key={hour}
            className="grid items-center"
            style={{ gridTemplateColumns: `40px repeat(7, 1fr)` }}
          >
            {/* Hour label */}
            <div className="text-right pr-2 text-[9px] font-mono text-gray-600">
              {String(hour).padStart(2, "0")}h
            </div>

            {/* Day cells */}
            {Array.from({ length: 7 }, (_, day) => {
              const count = grid[hour]?.[day] ?? 0;
              const intensity = count / maxCount;
              const isAnomalous = avg > 0 && count > avg * 2;

              return (
                <div key={day} className="px-0.5">
                  <div
                    title={`${DAYS[day]} ${String(hour).padStart(2,"0")}:00 — ${count} accesses${isAnomalous ? " (anomalous)" : ""}`}
                    className={cn(
                      "h-3.5 w-full rounded-[2px] transition-all cursor-default",
                      isAnomalous
                        ? "ring-1 ring-red-500 ring-offset-0"
                        : ""
                    )}
                    style={{
                      backgroundColor: count === 0
                        ? "rgba(31,41,55,0.6)"
                        : `rgba(6,182,212,${0.08 + intensity * 0.82})`,
                    }}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="mt-3 flex items-center justify-between px-10">
        <div className="flex items-center gap-1.5">
          <div className="h-2.5 w-5 rounded-sm bg-gray-800/60" />
          <span className="text-[9px] text-gray-600">None</span>
        </div>
        <div className="flex items-center gap-1">
          {[0.1, 0.3, 0.6, 1.0].map((v) => (
            <div
              key={v}
              className="h-2.5 w-5 rounded-sm"
              style={{ backgroundColor: `rgba(6,182,212,${0.08 + v * 0.82})` }}
            />
          ))}
          <span className="ml-1 text-[9px] text-gray-600">High</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="h-2.5 w-5 rounded-sm ring-1 ring-red-500" style={{ backgroundColor: "rgba(6,182,212,0.5)" }} />
          <span className="text-[9px] text-red-400">Anomalous (&gt;2× avg)</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  RiskMatrix (scatter-like visual)                                    */
/* ------------------------------------------------------------------ */

function RiskMatrix({ profiles }: { profiles: InsiderThreatProfile[] }) {
  /* Bucket profiles into risk ranges for display */
  const ranges = [
    { label: "Critical", min: 80, max: 100, color: "bg-red-500", border: "border-red-800" },
    { label: "High", min: 60, max: 79, color: "bg-orange-500", border: "border-orange-800" },
    { label: "Medium", min: 30, max: 59, color: "bg-yellow-500", border: "border-yellow-800" },
    { label: "Low", min: 0, max: 29, color: "bg-green-500", border: "border-green-800" },
  ];

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-5">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-cyan-400">
        <Activity className="h-4 w-4" />
        Risk Distribution Matrix
      </h2>

      <div className="grid grid-cols-4 gap-3">
        {ranges.map((range) => {
          const bucket = profiles.filter(
            (p) => p.risk_score >= range.min && p.risk_score <= range.max
          );
          return (
            <div
              key={range.label}
              className={cn(
                "rounded-lg border bg-gray-900/60 p-4 transition-all",
                range.border
              )}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                  {range.label}
                </span>
                <span className="text-xs text-gray-500">
                  {range.min}-{range.max}
                </span>
              </div>

              {/* Dot scatter */}
              <div className="flex flex-wrap gap-1.5 min-h-[48px]">
                {bucket.length === 0 && (
                  <span className="text-[10px] text-gray-600">
                    No profiles
                  </span>
                )}
                {bucket.map((p) => (
                  <div
                    key={p.id}
                    title={`${p.user_id || p.id.slice(0, 8)} - Score: ${p.risk_score}`}
                    className={cn(
                      "h-5 w-5 rounded-full flex items-center justify-center text-[8px] font-bold text-white cursor-default transition-transform hover:scale-125",
                      range.color
                    )}
                  >
                    {p.risk_score}
                  </div>
                ))}
              </div>

              {/* Count */}
              <div className="mt-3 flex items-center justify-between border-t border-gray-800 pt-2">
                <span className="text-[10px] text-gray-500">Profiles</span>
                <span className="text-sm font-bold text-gray-300">
                  {bucket.length}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  InsiderThreatPage                                                  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Computed risk score badge (from anomaly_count + behavioral_flags)  */
/* ------------------------------------------------------------------ */

function ComputedRiskBadge({ profile }: { profile: InsiderThreatProfile }) {
  /* Formula: anomaly_count * 10 + behavioral_flags.length * 15, capped at 100 */
  const computed = Math.min(
    profile.anomaly_count * 10 + profile.behavioral_flags.length * 15,
    100
  );
  const color =
    computed >= 60
      ? "text-red-400 bg-red-900/30 border-red-700/50"
      : computed >= 30
      ? "text-amber-400 bg-amber-900/30 border-amber-700/50"
      : "text-green-400 bg-green-900/30 border-green-700/50";
  return (
    <span
      title={`Computed: anomalies×10 + flags×15 = ${computed}`}
      className={cn(
        "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold border",
        color
      )}
    >
      <Activity className="h-2.5 w-2.5" />
      {computed}
    </span>
  );
}

export default function InsiderThreatPage() {
  const { addToast } = useToast();
  const [profiles, setProfiles] = useState<InsiderThreatProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("all");

  /* --- Access Patterns panel state --- */
  const [showAccessPatterns, setShowAccessPatterns] = useState(false);

  /* --- Detail panel state --- */
  const [selectedProfile, setSelectedProfile] = useState<ProfileDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  /* --- Baseline state --- */
  const [baselineLoading, setBaselineLoading] = useState(false);
  const [baselineResult, setBaselineResult] = useState<BaselineResult | null>(null);
  const [baselineError, setBaselineError] = useState<string | null>(null);

  /* --- Anomalies state --- */
  const [anomalies, setAnomalies] = useState<AnomalyItem[]>([]);
  const [anomaliesLoading, setAnomaliesLoading] = useState(false);

  /* --- Fetch data --- */
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<InsiderThreatProfile[]>(
        "/api/insider-threat/profiles"
      );
      setProfiles(data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to fetch insider threat profiles"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /* --- Fetch profile detail --- */
  const openProfileDetail = useCallback(async (profileId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    setBaselineResult(null);
    setBaselineError(null);
    try {
      const data = await apiFetch<ProfileDetail>(
        `/api/insider-threat/profiles/${profileId}`
      );
      setSelectedProfile(data);
    } catch (err) {
      setDetailError(
        err instanceof Error ? err.message : "Failed to load profile detail"
      );
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    setSelectedProfile(null);
    setDetailError(null);
    setBaselineResult(null);
    setBaselineError(null);
  }, []);

  /* --- Build baseline --- */
  const buildBaseline = useCallback(async (userId: string) => {
    setBaselineLoading(true);
    setBaselineResult(null);
    setBaselineError(null);
    try {
      const data = await apiFetch<BaselineResult>(
        `/api/insider-threat/baseline/${userId}`,
        { method: "POST", body: JSON.stringify({ lookback_days: 30 }) }
      );
      setBaselineResult(data);
      addToast("success", "Baseline built successfully");
      // Refresh the detail panel to show updated baseline
      if (selectedProfile) {
        const refreshed = await apiFetch<ProfileDetail>(
          `/api/insider-threat/profiles/${selectedProfile.id}`
        );
        setSelectedProfile(refreshed);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to build baseline";
      setBaselineError(msg);
      addToast("error", msg);
    } finally {
      setBaselineLoading(false);
    }
  }, [selectedProfile, addToast]);

  /* --- Fetch anomalies --- */
  const fetchAnomalies = useCallback(async () => {
    setAnomaliesLoading(true);
    try {
      const data = await apiFetch<AnomalyItem[]>(
        "/api/insider-threat/anomalies?hours=24&limit=20"
      );
      setAnomalies(data);
    } catch {
      // Silently fail — anomalies panel is supplementary
      setAnomalies([]);
    } finally {
      setAnomaliesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!loading && !error) {
      fetchAnomalies();
    }
  }, [loading, error, fetchAnomalies]);

  /* --- Derived --- */
  const filtered = useMemo(
    () =>
      filterStatus === "all"
        ? profiles
        : profiles.filter((p) => p.status === filterStatus),
    [profiles, filterStatus]
  );

  const flaggedCount = useMemo(
    () => profiles.filter((p) => p.status === "flagged").length,
    [profiles]
  );
  const monitoringCount = useMemo(
    () => profiles.filter((p) => p.status === "monitoring").length,
    [profiles]
  );
  const avgRisk = useMemo(
    () =>
      profiles.length > 0
        ? Math.round(
            profiles.reduce((sum, p) => sum + p.risk_score, 0) / profiles.length
          )
        : 0,
    [profiles]
  );

  /* --- Render --- */
  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-900/30 border border-red-800/50">
            <UserX className="h-5 w-5 text-red-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Insider Threat Detection
            </h1>
            <p className="text-xs text-gray-500">
              Behavioral analytics and risk profiling for internal personnel
            </p>
          </div>
        </div>

        {/* Quick stats */}
        <div className="hidden items-center gap-4 text-xs text-gray-500 md:flex">
          <span>
            <span className="font-semibold text-red-400">{flaggedCount}</span>{" "}
            flagged
          </span>
          <span className="text-gray-700">|</span>
          <span>
            <span className="font-semibold text-blue-400">
              {monitoringCount}
            </span>{" "}
            monitoring
          </span>
          <span className="text-gray-700">|</span>
          <span>
            Avg risk:{" "}
            <span className={cn("font-semibold", riskScoreColor(avgRisk))}>
              {avgRisk}
            </span>
          </span>
        </div>
      </div>

      {/* ---- Loading ---- */}
      {loading && (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          <span className="ml-3 text-sm text-gray-500">
            Loading threat profiles...
          </span>
        </div>
      )}

      {/* ---- Error ---- */}
      {!loading && error && (
        <div className="flex flex-1 flex-col items-center justify-center">
          <AlertTriangle className="mb-3 h-10 w-10 text-red-500" />
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={fetchData}
            className="mt-4 flex items-center gap-2 rounded-lg border border-gray-700 px-4 py-2 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      )}

      {/* ---- Main content ---- */}
      {!loading && !error && (
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
          {/* Risk Matrix */}
          <RiskMatrix profiles={profiles} />

          {/* Profiles Table */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/50">
            <div className="flex items-center justify-between border-b border-gray-800 px-5 py-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-cyan-400">
                <ShieldAlert className="h-4 w-4" />
                Threat Profiles
              </h2>

              {/* Status filter */}
              <div className="flex items-center gap-2">
                {["all", "monitoring", "flagged", "cleared"].map((s) => (
                  <button
                    key={s}
                    onClick={() => setFilterStatus(s)}
                    className={cn(
                      "rounded-lg px-3 py-1 text-[11px] font-medium transition-colors border",
                      filterStatus === s
                        ? "bg-cyan-900/40 text-cyan-400 border-cyan-700/50"
                        : "bg-gray-800 text-gray-500 border-gray-700/50 hover:text-gray-300"
                    )}
                  >
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    <th className="px-5 py-3">User ID</th>
                    <th className="px-5 py-3">Risk Score</th>
                    <th className="px-5 py-3">Computed Score</th>
                    <th className="px-5 py-3">Anomalies</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3">Behavioral Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-5 py-10 text-center text-gray-600"
                      >
                        No profiles match current filter
                      </td>
                    </tr>
                  )}
                  {filtered.map((profile) => {
                    const statusStyle =
                      STATUS_STYLES[profile.status] || STATUS_STYLES.monitoring;
                    const isSelected = selectedProfile?.id === profile.id;
                    return (
                      <tr
                        key={profile.id}
                        onClick={() => openProfileDetail(profile.id)}
                        className={cn(
                          "border-b border-gray-800/50 transition-colors cursor-pointer",
                          isSelected
                            ? "bg-cyan-950/30 hover:bg-cyan-950/40"
                            : "hover:bg-gray-900/80"
                        )}
                      >
                        {/* User ID */}
                        <td className="px-5 py-3">
                          <span className="font-mono text-xs text-gray-300">
                            {profile.user_id || profile.id.slice(0, 12)}
                          </span>
                        </td>

                        {/* Risk Score bar */}
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <div className="flex-1 max-w-[120px]">
                              <div className="h-2.5 rounded-full bg-gray-800">
                                <div
                                  className={cn(
                                    "h-2.5 rounded-full transition-all",
                                    riskScoreBarColor(profile.risk_score)
                                  )}
                                  style={{
                                    width: `${profile.risk_score}%`,
                                  }}
                                />
                              </div>
                            </div>
                            <span
                              className={cn(
                                "min-w-[32px] text-right font-mono text-xs font-bold",
                                riskScoreColor(profile.risk_score)
                              )}
                            >
                              {profile.risk_score}
                            </span>
                          </div>
                        </td>

                        {/* Computed Risk Score badge */}
                        <td className="px-5 py-3">
                          <ComputedRiskBadge profile={profile} />
                        </td>

                        {/* Anomaly count */}
                        <td className="px-5 py-3">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold",
                              profile.anomaly_count > 10
                                ? riskScoreBgColor(80)
                                : profile.anomaly_count > 5
                                ? riskScoreBgColor(50)
                                : "bg-gray-800 border-gray-700",
                              profile.anomaly_count > 10
                                ? "text-red-400"
                                : profile.anomaly_count > 5
                                ? "text-yellow-400"
                                : "text-gray-400"
                            )}
                          >
                            <AlertTriangle className="h-3 w-3" />
                            {profile.anomaly_count}
                          </span>
                        </td>

                        {/* Status badge */}
                        <td className="px-5 py-3">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider border",
                              statusStyle.color
                            )}
                          >
                            {statusStyle.icon}
                            {profile.status}
                          </span>
                        </td>

                        {/* Behavioral flags */}
                        <td className="px-5 py-3">
                          <div className="flex flex-wrap gap-1">
                            {profile.behavioral_flags.length === 0 && (
                              <span className="text-xs text-gray-600">
                                None
                              </span>
                            )}
                            {profile.behavioral_flags.map((flag, i) => (
                              <span
                                key={i}
                                className="rounded-full bg-gray-800 px-2.5 py-0.5 text-[10px] font-medium text-gray-400 border border-gray-700/60"
                              >
                                {flag}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* ---- Profile Detail Panel ---- */}
          {(selectedProfile || detailLoading || detailError) && (
            <div className="rounded-xl border border-gray-800 bg-gray-900/50">
              <div className="flex items-center justify-between border-b border-gray-800 px-5 py-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-cyan-400">
                  <Eye className="h-4 w-4" />
                  Profile Detail
                </h2>
                <button
                  onClick={closeDetail}
                  className="rounded-lg p-1 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="p-5">
                {detailLoading && (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-cyan-400" />
                    <span className="ml-2 text-xs text-gray-500">
                      Loading profile detail...
                    </span>
                  </div>
                )}

                {detailError && !detailLoading && (
                  <div className="flex flex-col items-center py-6">
                    <AlertTriangle className="mb-2 h-6 w-6 text-red-500" />
                    <p className="text-xs text-red-400">{detailError}</p>
                  </div>
                )}

                {selectedProfile && !detailLoading && (
                  <div className="space-y-5">
                    {/* Top row: key info + Build Baseline button */}
                    <div className="flex items-start justify-between gap-4">
                      <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-xs md:grid-cols-4">
                        <div>
                          <span className="text-gray-500">User ID</span>
                          <p className="mt-0.5 font-mono font-semibold text-gray-200">
                            {selectedProfile.user_id || "N/A"}
                          </p>
                        </div>
                        <div>
                          <span className="text-gray-500">Risk Score</span>
                          <p className={cn("mt-0.5 font-mono font-bold", riskScoreColor(selectedProfile.risk_score))}>
                            {selectedProfile.risk_score}
                          </p>
                        </div>
                        <div>
                          <span className="text-gray-500">Anomalies</span>
                          <p className="mt-0.5 font-mono font-semibold text-gray-200">
                            {selectedProfile.anomaly_count}
                          </p>
                        </div>
                        <div>
                          <span className="text-gray-500">Status</span>
                          <p className="mt-0.5">
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                                (STATUS_STYLES[selectedProfile.status] || STATUS_STYLES.monitoring).color
                              )}
                            >
                              {(STATUS_STYLES[selectedProfile.status] || STATUS_STYLES.monitoring).icon}
                              {selectedProfile.status}
                            </span>
                          </p>
                        </div>
                      </div>

                      {/* Build Baseline button */}
                      {selectedProfile.user_id && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            buildBaseline(selectedProfile.user_id!);
                          }}
                          disabled={baselineLoading}
                          className={cn(
                            "flex shrink-0 items-center gap-2 rounded-lg border px-4 py-2 text-xs font-medium transition-colors",
                            baselineLoading
                              ? "border-gray-700 bg-gray-800 text-gray-500 cursor-not-allowed"
                              : "border-cyan-700/50 bg-cyan-900/30 text-cyan-400 hover:bg-cyan-900/50"
                          )}
                        >
                          {baselineLoading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Database className="h-3.5 w-3.5" />
                          )}
                          Build Baseline
                        </button>
                      )}
                    </div>

                    {/* Baseline result / error */}
                    {baselineResult && (
                      <div className="rounded-lg border border-green-800/50 bg-green-900/20 px-4 py-3 text-xs text-green-400">
                        <CheckCircle2 className="mb-1 inline h-3.5 w-3.5 mr-1.5" />
                        {baselineResult.message}
                      </div>
                    )}
                    {baselineError && (
                      <div className="rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-3 text-xs text-red-400">
                        <AlertTriangle className="mb-1 inline h-3.5 w-3.5 mr-1.5" />
                        {baselineError}
                      </div>
                    )}

                    {/* Behavioral flags */}
                    {selectedProfile.behavioral_flags.length > 0 && (
                      <div>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                          Behavioral Flags
                        </span>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {selectedProfile.behavioral_flags.map((flag, i) => (
                            <span
                              key={i}
                              className="rounded-full bg-gray-800 px-2.5 py-0.5 text-[10px] font-medium text-gray-400 border border-gray-700/60"
                            >
                              {flag}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Baseline info */}
                    {selectedProfile.baseline_access_pattern &&
                      Object.keys(selectedProfile.baseline_access_pattern).length > 0 && (
                      <div>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                          Baseline Pattern
                        </span>
                        <div className="mt-1.5 grid grid-cols-2 gap-2 md:grid-cols-4">
                          {Object.entries(selectedProfile.baseline_access_pattern)
                            .filter(([, v]) => typeof v !== "object")
                            .slice(0, 4)
                            .map(([key, val]) => (
                              <div
                                key={key}
                                className="rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2"
                              >
                                <span className="text-[10px] text-gray-500">
                                  {key.replace(/_/g, " ")}
                                </span>
                                <p className="mt-0.5 font-mono text-xs font-semibold text-gray-300">
                                  {String(val)}
                                </p>
                              </div>
                            ))}
                        </div>
                      </div>
                    )}

                    {/* Recent access events */}
                    <div>
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                        Recent Access Events (48h)
                      </span>
                      {selectedProfile.recent_access_events.length === 0 ? (
                        <p className="mt-2 text-xs text-gray-600">
                          No recent access events found
                        </p>
                      ) : (
                        <div className="mt-2 max-h-52 overflow-y-auto rounded-lg border border-gray-800 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-gray-800 text-left text-[10px] font-medium uppercase tracking-wider text-gray-500">
                                <th className="px-3 py-2">Time</th>
                                <th className="px-3 py-2">Door</th>
                                <th className="px-3 py-2">Type</th>
                              </tr>
                            </thead>
                            <tbody>
                              {selectedProfile.recent_access_events.map((evt) => (
                                <tr
                                  key={evt.id}
                                  className="border-b border-gray-800/40 hover:bg-gray-900/40"
                                >
                                  <td className="px-3 py-1.5">
                                    <span className="inline-flex items-center gap-1 text-gray-400">
                                      <Clock className="h-3 w-3 text-gray-600" />
                                      {evt.timestamp
                                        ? new Date(evt.timestamp).toLocaleString("en-US", {
                                            month: "short",
                                            day: "numeric",
                                            hour: "2-digit",
                                            minute: "2-digit",
                                            hour12: false,
                                          })
                                        : "N/A"}
                                    </span>
                                  </td>
                                  <td className="px-3 py-1.5">
                                    <span className="inline-flex items-center gap-1 font-mono text-gray-300">
                                      <DoorOpen className="h-3 w-3 text-gray-600" />
                                      {evt.door_id || "unknown"}
                                    </span>
                                  </td>
                                  <td className="px-3 py-1.5">
                                    <span
                                      className={cn(
                                        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase border",
                                        evt.event_type === "denied" || evt.event_type === "forced" || evt.event_type === "tailgating"
                                          ? "text-red-400 bg-red-900/30 border-red-700/50"
                                          : evt.event_type === "held_open"
                                          ? "text-yellow-400 bg-yellow-900/30 border-yellow-700/50"
                                          : "text-green-400 bg-green-900/30 border-green-700/50"
                                      )}
                                    >
                                      {evt.event_type}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ---- Access Patterns Section ---- */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/50">
            <div className="flex items-center justify-between border-b border-gray-800 px-5 py-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-cyan-400">
                <LayoutGrid className="h-4 w-4" />
                Access Patterns
                <span className="text-[10px] text-gray-500 font-normal">
                  Hour × Day heatmap
                </span>
              </h2>
              <button
                onClick={() => setShowAccessPatterns((v) => !v)}
                className="flex items-center gap-1.5 rounded-lg border border-gray-700/50 px-3 py-1 text-[11px] text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
              >
                {showAccessPatterns ? "Hide" : "Show"}
              </button>
            </div>

            {showAccessPatterns && (
              <div className="p-5">
                <p className="mb-3 text-[10px] text-gray-600">
                  Aggregated access frequency by hour (0–23) and day. Red-bordered cells deviate &gt;2× from average.
                  {selectedProfile?.user_id && (
                    <span className="ml-1 text-cyan-600">
                      Showing data for: {selectedProfile.user_id}
                    </span>
                  )}
                </p>
                <AccessPatternGrid profileId={selectedProfile?.id} />
              </div>
            )}
          </div>

          {/* ---- Recent Anomalies Panel ---- */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/50">
            <div className="flex items-center justify-between border-b border-gray-800 px-5 py-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-cyan-400">
                <Zap className="h-4 w-4" />
                Recent Anomalies
                <span className="text-[10px] text-gray-500 font-normal">(24h)</span>
              </h2>
              <button
                onClick={fetchAnomalies}
                disabled={anomaliesLoading}
                className="flex items-center gap-1.5 rounded-lg border border-gray-700/50 px-3 py-1 text-[11px] text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
              >
                <RefreshCw className={cn("h-3 w-3", anomaliesLoading && "animate-spin")} />
                Refresh
              </button>
            </div>

            <div className="p-5">
              {anomaliesLoading && anomalies.length === 0 && (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-cyan-400" />
                  <span className="ml-2 text-xs text-gray-500">
                    Loading anomalies...
                  </span>
                </div>
              )}

              {!anomaliesLoading && anomalies.length === 0 && (
                <p className="py-6 text-center text-xs text-gray-600">
                  No anomalies detected in the last 24 hours
                </p>
              )}

              {anomalies.length > 0 && (
                <div className="space-y-2">
                  {anomalies.map((anomaly, i) => (
                    <div
                      key={`${anomaly.profile_id}-${i}`}
                      onClick={() => openProfileDetail(anomaly.profile_id)}
                      className={cn(
                        "flex items-start gap-3 rounded-lg border p-3 transition-colors cursor-pointer",
                        anomaly.risk_score >= 80
                          ? "border-red-800/50 bg-red-950/20 hover:bg-red-950/30"
                          : anomaly.risk_score >= 60
                          ? "border-orange-800/50 bg-orange-950/20 hover:bg-orange-950/30"
                          : "border-gray-800 bg-gray-900/40 hover:bg-gray-900/60"
                      )}
                    >
                      <div
                        className={cn(
                          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                          riskScoreBarColor(anomaly.risk_score)
                        )}
                      >
                        {Math.round(anomaly.risk_score)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-gray-400 border border-gray-700/60">
                            {anomaly.anomaly_type}
                          </span>
                          {anomaly.user_id && (
                            <span className="font-mono text-[10px] text-gray-500">
                              {anomaly.user_id.slice(0, 12)}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-gray-400 truncate">
                          {anomaly.description}
                        </p>
                      </div>
                      <span className="shrink-0 text-[10px] text-gray-600">
                        {anomaly.timestamp
                          ? new Date(anomaly.timestamp).toLocaleString("en-US", {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                              hour12: false,
                            })
                          : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
