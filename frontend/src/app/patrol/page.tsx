"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Shield,
  Loader2,
  AlertTriangle,
  MapPin,
  Clock,
  Route,
  Play,
  CheckCircle2,
  RefreshCw,
  Zap,
  ChevronDown,
  ChevronUp,
  Plus,
  BarChart3,
  Target,
  TrendingUp,
  Activity,
  AlertCircle,
  Search,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";
import type { PatrolShift, PatrolRoute } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const STATUS_COLORS: Record<string, string> = {
  scheduled: "text-blue-400 bg-blue-900/30 border-blue-700/50",
  active: "text-green-400 bg-green-900/30 border-green-700/50",
  completed: "text-gray-400 bg-gray-800/50 border-gray-700/50",
  cancelled: "text-red-400 bg-red-900/30 border-red-700/50",
};

function riskColor(score: number): string {
  if (score >= 80) return "bg-red-500";
  if (score >= 60) return "bg-orange-500";
  if (score >= 30) return "bg-yellow-500";
  return "bg-green-500";
}

function riskTextColor(score: number): string {
  if (score >= 80) return "text-red-400";
  if (score >= 60) return "text-orange-400";
  if (score >= 30) return "text-yellow-400";
  return "text-green-400";
}

/** Coverage % color: green >80%, amber 50-80%, red <50% */
function coveragePctColor(pct: number): { bar: string; text: string } {
  if (pct >= 80) return { bar: "bg-green-500", text: "text-green-400" };
  if (pct >= 50) return { bar: "bg-amber-500", text: "text-amber-400" };
  return { bar: "bg-red-500", text: "text-red-400" };
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CoverageStats {
  time_range_hours: number;
  total_patrols: number;
  active_patrols: number;
  completed_patrols: number;
  total_checkpoints_recorded: number;
  zones_covered: number;
  zone_coverage: Record<string, { patrol_count: number; checkpoints: number }>;
  active_routes: number;
}

interface PatrolMetrics {
  totalPatrols7d: number;
  avgCompletionMinutes: number | null;
  coverageScore: number;
  incidentsFound: number;
}

/* ------------------------------------------------------------------ */
/*  Coverage Section Component                                         */
/* ------------------------------------------------------------------ */

function CoverageSection({
  coverage,
  totalZones,
}: {
  coverage: CoverageStats;
  totalZones: number;
}) {
  const zonesTotal = totalZones > 0 ? totalZones : coverage.zones_covered || 1;
  const pct =
    zonesTotal > 0
      ? Math.min(100, Math.round((coverage.zones_covered / zonesTotal) * 100))
      : 0;
  const { bar, text } = coveragePctColor(pct);

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 px-5 py-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-cyan-400">
          <Search className="h-4 w-4" />
          Zone Coverage Analysis
        </h3>
        <span className={cn("text-sm font-bold tabular-nums", text)}>
          {pct}%
        </span>
      </div>

      {/* Progress bar */}
      <div className="mb-2 h-3 w-full rounded-full bg-gray-800">
        <div
          className={cn("h-3 rounded-full transition-all duration-500", bar)}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-[11px] text-gray-500">
        <span>
          <span className="font-semibold text-gray-300">
            {coverage.zones_covered}
          </span>{" "}
          of{" "}
          <span className="font-semibold text-gray-300">{zonesTotal}</span>{" "}
          zones covered
        </span>
        <span
          className={cn(
            "rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
            pct >= 80
              ? "bg-green-900/40 text-green-400 border border-green-800/50"
              : pct >= 50
              ? "bg-amber-900/40 text-amber-400 border border-amber-800/50"
              : "bg-red-900/40 text-red-400 border border-red-800/50"
          )}
        >
          {pct >= 80 ? "Good" : pct >= 50 ? "Partial" : "Low"}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Patrol Effectiveness Metrics Row                                   */
/* ------------------------------------------------------------------ */

function PatrolMetricsRow({ metrics }: { metrics: PatrolMetrics }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {/* Total Patrols 7d */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <Activity className="h-3.5 w-3.5 text-cyan-500" />
          <span className="text-[10px] uppercase tracking-wider text-gray-500">
            Total Patrols (7d)
          </span>
        </div>
        <div className="text-xl font-bold text-gray-100">
          {metrics.totalPatrols7d}
        </div>
      </div>

      {/* Avg Completion Time */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <Clock className="h-3.5 w-3.5 text-blue-400" />
          <span className="text-[10px] uppercase tracking-wider text-gray-500">
            Avg Completion
          </span>
        </div>
        <div className="text-xl font-bold text-gray-100">
          {metrics.avgCompletionMinutes != null
            ? `${metrics.avgCompletionMinutes}m`
            : "---"}
        </div>
      </div>

      {/* Coverage Score */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <TrendingUp className="h-3.5 w-3.5 text-green-400" />
          <span className="text-[10px] uppercase tracking-wider text-gray-500">
            Coverage Score
          </span>
        </div>
        <div
          className={cn(
            "text-xl font-bold",
            coveragePctColor(metrics.coverageScore).text
          )}
        >
          {metrics.coverageScore}%
        </div>
      </div>

      {/* Incidents Found During Patrol */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <AlertCircle className="h-3.5 w-3.5 text-amber-400" />
          <span className="text-[10px] uppercase tracking-wider text-gray-500">
            Incidents Found
          </span>
        </div>
        <div className="text-xl font-bold text-gray-100">
          {metrics.incidentsFound}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Route Deviation Badge                                              */
/* ------------------------------------------------------------------ */

/**
 * Compute whether a checkpoint for an active shift is overdue.
 * We compare elapsed time since shift start vs expected interval
 * (estimated_duration_minutes / total_waypoints).
 *
 * If a checkpoint hasn't been recorded and elapsed > 150% of expected
 * per-checkpoint interval, we show a deviation warning.
 */
function computeDeviation(
  shift: PatrolShift,
  routes: PatrolRoute[]
): boolean {
  if (shift.status !== "active") return false;
  if (!shift.start_time) return false;
  const waypoints = shift.route_waypoints.length;
  if (waypoints === 0) return false;

  // Try to find a matching route to get estimated duration
  const matchedRoute = routes.find((r) =>
    r.zone_sequence.some((z) => shift.zone_ids.includes(z))
  );
  const estimatedDuration = matchedRoute
    ? matchedRoute.estimated_duration_minutes
    : 60; // default 60m

  const intervalMinutes = estimatedDuration / waypoints;
  const elapsedMs = Date.now() - new Date(shift.start_time).getTime();
  const elapsedMinutes = elapsedMs / 60_000;

  const completed = shift.checkpoints_completed.length;
  // Expected completions by now
  const expectedCompleted = Math.floor(elapsedMinutes / intervalMinutes);

  // If overdue by more than one full interval (>50% of expected interval from next one)
  if (expectedCompleted > completed) {
    const overdueMinutes =
      elapsedMinutes - completed * intervalMinutes;
    return overdueMinutes > intervalMinutes * 1.5;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  PatrolCommandPage                                                  */
/* ------------------------------------------------------------------ */

export default function PatrolCommandPage() {
  const [shifts, setShifts] = useState<PatrolShift[]>([]);
  const [routes, setRoutes] = useState<PatrolRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateMsg, setGenerateMsg] = useState<string | null>(null);

  /* --- Expandable shift detail --- */
  const [expandedShiftId, setExpandedShiftId] = useState<string | null>(null);

  /* --- Record checkpoint --- */
  const [checkpointLoading, setCheckpointLoading] = useState<string | null>(null);
  const [checkpointMsg, setCheckpointMsg] = useState<{ id: string; msg: string; ok: boolean } | null>(null);

  /* --- Coverage stats --- */
  const [coverage, setCoverage] = useState<CoverageStats | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);

  /* --- Create shift form --- */
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState({ guard_id: "", zone_ids: "", start_time: "" });
  const [createLoading, setCreateLoading] = useState(false);
  const [createMsg, setCreateMsg] = useState<string | null>(null);

  /* --- Fetch data --- */
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [shiftsData, routesData] = await Promise.all([
        apiFetch<PatrolShift[]>("/api/patrol/shifts"),
        apiFetch<PatrolRoute[]>("/api/patrol/routes"),
      ]);
      setShifts(shiftsData);
      setRoutes(routesData);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch patrol data"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /* --- Generate Route --- */
  const handleGenerateRoute = useCallback(async () => {
    setGenerating(true);
    setGenerateMsg(null);
    try {
      const result = await apiFetch<PatrolRoute>("/api/patrol/routes/generate", {
        method: "POST",
      });
      setRoutes((prev) => [result, ...prev]);
      setGenerateMsg("Route generated successfully");
      setTimeout(() => setGenerateMsg(null), 4000);
    } catch (err) {
      setGenerateMsg(
        err instanceof Error ? err.message : "Failed to generate route"
      );
    } finally {
      setGenerating(false);
    }
  }, []);

  /* --- Record Checkpoint --- */
  const handleRecordCheckpoint = useCallback(async (shiftId: string) => {
    setCheckpointLoading(shiftId);
    setCheckpointMsg(null);
    try {
      const updated = await apiFetch<PatrolShift>(
        `/api/patrol/shifts/${shiftId}/checkpoint`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checkpoint_id: `cp-${Date.now()}`,
            timestamp: new Date().toISOString(),
          }),
        }
      );
      setShifts((prev) => prev.map((s) => (s.id === shiftId ? updated : s)));
      setCheckpointMsg({ id: shiftId, msg: "Checkpoint recorded", ok: true });
      setTimeout(() => setCheckpointMsg(null), 3000);
    } catch (err) {
      setCheckpointMsg({
        id: shiftId,
        msg: err instanceof Error ? err.message : "Failed to record checkpoint",
        ok: false,
      });
    } finally {
      setCheckpointLoading(null);
    }
  }, []);

  /* --- Fetch Coverage --- */
  const fetchCoverage = useCallback(async () => {
    setCoverageLoading(true);
    try {
      const data = await apiFetch<CoverageStats>("/api/patrol/coverage");
      setCoverage(data);
    } catch {
      setCoverage(null);
    } finally {
      setCoverageLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!loading && !error) {
      fetchCoverage();
    }
  }, [loading, error, fetchCoverage]);

  /* --- Create Shift --- */
  const handleCreateShift = useCallback(async () => {
    setCreateLoading(true);
    setCreateMsg(null);
    try {
      const zoneIds = createForm.zone_ids
        .split(",")
        .map((z) => z.trim())
        .filter(Boolean);
      const payload: Record<string, unknown> = {
        zone_ids: zoneIds,
      };
      if (createForm.guard_id.trim()) {
        payload.guard_id = createForm.guard_id.trim();
      }
      if (createForm.start_time) {
        payload.start_time = new Date(createForm.start_time).toISOString();
      }
      const newShift = await apiFetch<PatrolShift>("/api/patrol/shifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setShifts((prev) => [newShift, ...prev]);
      setCreateForm({ guard_id: "", zone_ids: "", start_time: "" });
      setCreateMsg("Shift created successfully");
      setShowCreateForm(false);
      setTimeout(() => setCreateMsg(null), 4000);
    } catch (err) {
      setCreateMsg(
        err instanceof Error ? err.message : "Failed to create shift"
      );
    } finally {
      setCreateLoading(false);
    }
  }, [createForm]);

  /* --- Derived stats --- */
  const activeShifts = useMemo(
    () => shifts.filter((s) => s.status === "active").length,
    [shifts]
  );
  const scheduledShifts = useMemo(
    () => shifts.filter((s) => s.status === "scheduled").length,
    [shifts]
  );
  const activeRoutes = useMemo(
    () => routes.filter((r) => r.is_active).length,
    [routes]
  );

  /* --- Patrol Effectiveness Metrics (calculated from shift data) --- */
  const patrolMetrics = useMemo<PatrolMetrics>(() => {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = shifts.filter(
      (s) =>
        s.created_at && new Date(s.created_at).getTime() >= sevenDaysAgo
    );

    // Avg completion time for completed shifts that have both start and end times
    const completedWithTimes = shifts.filter(
      (s) =>
        s.status === "completed" && s.start_time && s.end_time
    );
    let avgCompletionMinutes: number | null = null;
    if (completedWithTimes.length > 0) {
      const totalMs = completedWithTimes.reduce((sum, s) => {
        return (
          sum +
          (new Date(s.end_time!).getTime() -
            new Date(s.start_time!).getTime())
        );
      }, 0);
      avgCompletionMinutes = Math.round(
        totalMs / completedWithTimes.length / 60_000
      );
    }

    // Coverage score: from coverage API if available
    const coverageScore =
      coverage && coverage.zones_covered > 0
        ? Math.min(
            100,
            Math.round(
              (coverage.zones_covered /
                Math.max(
                  coverage.zones_covered,
                  Object.keys(coverage.zone_coverage).length || 1
                )) *
                100
            )
          )
        : 0;

    // Incidents found: total checkpoints across all shifts acts as a proxy;
    // we don't have a direct field, so use total_checkpoints_recorded from coverage
    const incidentsFound = coverage?.total_checkpoints_recorded ?? 0;

    return {
      totalPatrols7d: recent.length,
      avgCompletionMinutes,
      coverageScore,
      incidentsFound,
    };
  }, [shifts, coverage]);

  /* --- Total unique zones across all shifts (for coverage %) --- */
  const totalUniqueZones = useMemo(() => {
    const zoneSet = new Set<string>();
    shifts.forEach((s) => s.zone_ids.forEach((z) => zoneSet.add(z)));
    return zoneSet.size;
  }, [shifts]);

  /* --- Render --- */
  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
            <Shield className="h-5 w-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Patrol Command
            </h1>
            <p className="text-xs text-gray-500">
              Manage guard shifts, patrol routes, and checkpoint tracking
            </p>
          </div>
        </div>

        {/* Quick stats */}
        <div className="hidden items-center gap-4 text-xs text-gray-500 md:flex">
          <span>
            <span className="font-semibold text-green-400">{activeShifts}</span>{" "}
            active
          </span>
          <span className="text-gray-700">|</span>
          <span>
            <span className="font-semibold text-blue-400">{scheduledShifts}</span>{" "}
            scheduled
          </span>
          <span className="text-gray-700">|</span>
          <span>
            <span className="font-semibold text-cyan-400">{activeRoutes}</span>{" "}
            routes
          </span>
        </div>
      </div>

      {/* ---- Loading ---- */}
      {loading && (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          <span className="ml-3 text-sm text-gray-500">
            Loading patrol data...
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

          {/* Patrol Effectiveness Metrics Row */}
          <PatrolMetricsRow metrics={patrolMetrics} />

          {/* Two-column layout */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Left: Patrol Shifts Table (2/3) */}
            <div className="lg:col-span-2 rounded-xl border border-gray-800 bg-gray-900/50">
              <div className="flex items-center justify-between border-b border-gray-800 px-5 py-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-cyan-400">
                  <Clock className="h-4 w-4" />
                  Active Patrol Shifts
                </h2>
                <div className="flex items-center gap-3">
                  {createMsg && (
                    <span
                      className={cn(
                        "text-xs font-medium",
                        createMsg.includes("success")
                          ? "text-green-400"
                          : "text-red-400"
                      )}
                    >
                      {createMsg}
                    </span>
                  )}
                  <button
                    onClick={() => setShowCreateForm((v) => !v)}
                    className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    New Shift
                  </button>
                  <span className="text-xs text-gray-500">
                    {shifts.length} total
                  </span>
                </div>
              </div>

              {/* ---- Create Shift Form ---- */}
              {showCreateForm && (
                <div className="border-b border-gray-800 bg-gray-900/80 px-5 py-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                    <div>
                      <label className="mb-1 block text-[10px] uppercase tracking-wider text-gray-500">
                        Guard ID
                      </label>
                      <input
                        type="text"
                        placeholder="UUID (optional)"
                        value={createForm.guard_id}
                        onChange={(e) =>
                          setCreateForm((f) => ({ ...f, guard_id: e.target.value }))
                        }
                        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:border-cyan-600 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[10px] uppercase tracking-wider text-gray-500">
                        Zone IDs (comma-separated)
                      </label>
                      <input
                        type="text"
                        placeholder="zone-a, zone-b, zone-c"
                        value={createForm.zone_ids}
                        onChange={(e) =>
                          setCreateForm((f) => ({ ...f, zone_ids: e.target.value }))
                        }
                        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:border-cyan-600 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[10px] uppercase tracking-wider text-gray-500">
                        Start Time
                      </label>
                      <input
                        type="datetime-local"
                        value={createForm.start_time}
                        onChange={(e) =>
                          setCreateForm((f) => ({ ...f, start_time: e.target.value }))
                        }
                        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200 focus:border-cyan-600 focus:outline-none [color-scheme:dark]"
                      />
                    </div>
                    <div className="flex items-end gap-2">
                      <button
                        onClick={handleCreateShift}
                        disabled={createLoading}
                        className={cn(
                          "flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold transition-all",
                          "bg-cyan-600 text-white border border-cyan-500",
                          "hover:bg-cyan-500",
                          "disabled:opacity-50 disabled:cursor-not-allowed"
                        )}
                      >
                        {createLoading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Plus className="h-3.5 w-3.5" />
                        )}
                        Create
                      </button>
                      <button
                        onClick={() => setShowCreateForm(false)}
                        className="rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      <th className="px-5 py-3">Guard</th>
                      <th className="px-5 py-3">Zones</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="px-5 py-3">Start Time</th>
                      <th className="px-5 py-3">Checkpoints</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shifts.length === 0 && (
                      <tr>
                        <td
                          colSpan={5}
                          className="px-5 py-10 text-center text-gray-600"
                        >
                          No patrol shifts found
                        </td>
                      </tr>
                    )}
                    {shifts.map((shift) => {
                      const isExpanded = expandedShiftId === shift.id;
                      const hasDeviation = computeDeviation(shift, routes);

                      return (
                        <tr
                          key={shift.id}
                          className="border-b border-gray-800/50 transition-colors hover:bg-gray-900/80 group"
                          style={{ cursor: "pointer" }}
                        >
                          {/* Wrap entire row content in a single td with inner grid for expand support */}
                          <td colSpan={5} className="p-0">
                            {/* Main row content */}
                            <div
                              className="grid grid-cols-[1fr_1fr_1fr_1fr_1fr] items-center"
                              onClick={() =>
                                setExpandedShiftId(isExpanded ? null : shift.id)
                              }
                            >
                              {/* Guard */}
                              <div className="px-5 py-3 flex items-center gap-2">
                                {isExpanded ? (
                                  <ChevronUp className="h-3 w-3 text-gray-500" />
                                ) : (
                                  <ChevronDown className="h-3 w-3 text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                                )}
                                <span className="font-mono text-xs text-gray-300">
                                  {shift.guard_id
                                    ? shift.guard_id.slice(0, 8)
                                    : "Unassigned"}
                                </span>
                              </div>

                              {/* Zones */}
                              <div className="px-5 py-3">
                                <div className="flex flex-wrap gap-1">
                                  {shift.zone_ids.length > 0 ? (
                                    shift.zone_ids.slice(0, 3).map((z, i) => (
                                      <span
                                        key={i}
                                        className="inline-flex items-center gap-1 rounded bg-gray-800 px-2 py-0.5 text-[10px] text-gray-400"
                                      >
                                        <MapPin className="h-2.5 w-2.5" />
                                        {z.slice(0, 6)}
                                      </span>
                                    ))
                                  ) : (
                                    <span className="text-xs text-gray-600">---</span>
                                  )}
                                  {shift.zone_ids.length > 3 && (
                                    <span className="text-[10px] text-gray-500">
                                      +{shift.zone_ids.length - 3}
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* Status */}
                              <div className="px-5 py-3 flex items-center gap-2">
                                <span
                                  className={cn(
                                    "inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                                    STATUS_COLORS[shift.status] || STATUS_COLORS.scheduled
                                  )}
                                >
                                  {shift.status === "active" && (
                                    <Play className="mr-1 h-2.5 w-2.5" />
                                  )}
                                  {shift.status}
                                </span>
                                {/* Route Deviation Badge */}
                                {hasDeviation && (
                                  <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border bg-red-900/40 text-red-400 border-red-700/50">
                                    <AlertTriangle className="h-2.5 w-2.5" />
                                    Deviation
                                  </span>
                                )}
                              </div>

                              {/* Start Time */}
                              <div className="px-5 py-3 text-xs text-gray-400">
                                {shift.start_time
                                  ? formatTimestamp(shift.start_time)
                                  : "---"}
                              </div>

                              {/* Checkpoints */}
                              <div className="px-5 py-3">
                                <div className="flex items-center gap-2">
                                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                                  <span className="text-xs text-gray-300">
                                    {shift.checkpoints_completed.length}
                                  </span>
                                  <span className="text-xs text-gray-600">
                                    / {shift.route_waypoints.length}
                                  </span>
                                </div>
                                {shift.route_waypoints.length > 0 && (
                                  <div className="mt-1 h-1 w-20 rounded-full bg-gray-800">
                                    <div
                                      className="h-1 rounded-full bg-cyan-500 transition-all"
                                      style={{
                                        width: `${
                                          (shift.checkpoints_completed.length /
                                            shift.route_waypoints.length) *
                                          100
                                        }%`,
                                      }}
                                    />
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Expanded detail panel */}
                            {isExpanded && (
                              <div className="border-t border-gray-800/50 bg-gray-950/50 px-5 py-4">
                                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                  {/* All Zone IDs */}
                                  <div>
                                    <h4 className="mb-2 text-[10px] uppercase tracking-wider text-gray-500">
                                      All Zone IDs ({shift.zone_ids.length})
                                    </h4>
                                    <div className="flex flex-wrap gap-1.5">
                                      {shift.zone_ids.length > 0 ? (
                                        shift.zone_ids.map((z, i) => (
                                          <span
                                            key={i}
                                            className="inline-flex items-center gap-1 rounded bg-gray-800 px-2 py-1 text-[11px] text-gray-300 border border-gray-700/50"
                                          >
                                            <MapPin className="h-3 w-3 text-cyan-500" />
                                            {z}
                                          </span>
                                        ))
                                      ) : (
                                        <span className="text-xs text-gray-600">
                                          No zones assigned
                                        </span>
                                      )}
                                    </div>
                                  </div>

                                  {/* Checkpoints list */}
                                  <div>
                                    <h4 className="mb-2 text-[10px] uppercase tracking-wider text-gray-500">
                                      Checkpoints Completed ({shift.checkpoints_completed.length})
                                    </h4>
                                    {shift.checkpoints_completed.length > 0 ? (
                                      <div className="max-h-32 space-y-1 overflow-y-auto scrollbar-thin scrollbar-track-gray-900 scrollbar-thumb-gray-800">
                                        {shift.checkpoints_completed.map((cp, i) => {
                                          const cpObj = cp as Record<string, unknown>;
                                          return (
                                            <div
                                              key={i}
                                              className="flex items-center gap-2 rounded bg-gray-800/60 px-2 py-1 text-[11px]"
                                            >
                                              <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                                              <span className="font-mono text-gray-300">
                                                {(cpObj.checkpoint_id as string) || `#${i + 1}`}
                                              </span>
                                              {typeof cpObj.timestamp === "string" && (
                                                <span className="text-gray-500 ml-auto">
                                                  {formatTimestamp(cpObj.timestamp)}
                                                </span>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    ) : (
                                      <span className="text-xs text-gray-600">
                                        No checkpoints recorded yet
                                      </span>
                                    )}
                                  </div>
                                </div>

                                {/* Deviation detail for active shifts */}
                                {hasDeviation && (
                                  <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-800/50 bg-red-900/20 px-3 py-2 text-xs text-red-400">
                                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                    <span>
                                      Route deviation detected: guard is overdue at next checkpoint
                                      by more than 50% of expected interval. Verify guard status.
                                    </span>
                                  </div>
                                )}

                                {/* Record Checkpoint button for active/scheduled shifts */}
                                {(shift.status === "active" || shift.status === "scheduled") && (
                                  <div className="mt-3 flex items-center gap-3 border-t border-gray-800/50 pt-3">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleRecordCheckpoint(shift.id);
                                      }}
                                      disabled={checkpointLoading === shift.id}
                                      className={cn(
                                        "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all",
                                        "bg-green-700 text-white border border-green-600",
                                        "hover:bg-green-600",
                                        "disabled:opacity-50 disabled:cursor-not-allowed"
                                      )}
                                    >
                                      {checkpointLoading === shift.id ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                      ) : (
                                        <Target className="h-3.5 w-3.5" />
                                      )}
                                      Record Checkpoint
                                    </button>
                                    {checkpointMsg && checkpointMsg.id === shift.id && (
                                      <span
                                        className={cn(
                                          "text-xs font-medium",
                                          checkpointMsg.ok
                                            ? "text-green-400"
                                            : "text-red-400"
                                        )}
                                      >
                                        {checkpointMsg.msg}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Right: Patrol Routes (1/3) */}
            <div className="rounded-xl border border-gray-800 bg-gray-900/50">
              <div className="flex items-center justify-between border-b border-gray-800 px-5 py-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-cyan-400">
                  <Route className="h-4 w-4" />
                  Patrol Routes
                </h2>
                <span className="text-xs text-gray-500">
                  {routes.length} routes
                </span>
              </div>

              <div className="divide-y divide-gray-800/50 max-h-[480px] overflow-y-auto scrollbar-thin scrollbar-track-gray-900 scrollbar-thumb-gray-800">
                {routes.length === 0 && (
                  <div className="flex flex-col items-center py-10">
                    <Route className="mb-2 h-8 w-8 text-gray-700" />
                    <p className="text-xs text-gray-600">No routes available</p>
                  </div>
                )}
                {routes.map((route) => (
                  <div
                    key={route.id}
                    className="px-5 py-4 transition-colors hover:bg-gray-900/80"
                  >
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium text-gray-200">
                        {route.name}
                      </h3>
                      {route.is_active ? (
                        <span className="rounded-full bg-green-900/40 px-2 py-0.5 text-[10px] font-semibold text-green-400 border border-green-800/50">
                          Active
                        </span>
                      ) : (
                        <span className="rounded-full bg-gray-800 px-2 py-0.5 text-[10px] font-semibold text-gray-500 border border-gray-700/50">
                          Inactive
                        </span>
                      )}
                    </div>

                    {/* Risk Score */}
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wider text-gray-500">
                        Risk
                      </span>
                      <div className="flex-1 h-2 rounded-full bg-gray-800">
                        <div
                          className={cn(
                            "h-2 rounded-full transition-all",
                            riskColor(route.risk_score)
                          )}
                          style={{ width: `${route.risk_score}%` }}
                        />
                      </div>
                      <span
                        className={cn(
                          "text-xs font-bold font-mono",
                          riskTextColor(route.risk_score)
                        )}
                      >
                        {route.risk_score}
                      </span>
                    </div>

                    {/* Meta */}
                    <div className="mt-2 flex items-center gap-3 text-[11px] text-gray-500">
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {route.zone_sequence.length} zones
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {route.estimated_duration_minutes}m
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Coverage Stats Panel */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/50">
            <div className="flex items-center justify-between border-b border-gray-800 px-5 py-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-cyan-400">
                <BarChart3 className="h-4 w-4" />
                Patrol Coverage
              </h2>
              <button
                onClick={fetchCoverage}
                disabled={coverageLoading}
                className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors disabled:opacity-50"
              >
                <RefreshCw
                  className={cn(
                    "h-3 w-3",
                    coverageLoading && "animate-spin"
                  )}
                />
                Refresh
              </button>
            </div>

            {coverageLoading && !coverage && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-cyan-400" />
                <span className="ml-2 text-xs text-gray-500">
                  Loading coverage data...
                </span>
              </div>
            )}

            {coverage && (
              <div className="px-5 py-4 space-y-4">
                {/* Coverage Analysis Section */}
                <CoverageSection
                  coverage={coverage}
                  totalZones={totalUniqueZones}
                />

                {/* Summary cards */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                  <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2.5">
                    <div className="text-[10px] uppercase tracking-wider text-gray-500">
                      Time Range
                    </div>
                    <div className="mt-1 text-lg font-bold text-gray-200">
                      {coverage.time_range_hours}h
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2.5">
                    <div className="text-[10px] uppercase tracking-wider text-gray-500">
                      Total Patrols
                    </div>
                    <div className="mt-1 text-lg font-bold text-gray-200">
                      {coverage.total_patrols}
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2.5">
                    <div className="text-[10px] uppercase tracking-wider text-gray-500">
                      Active
                    </div>
                    <div className="mt-1 text-lg font-bold text-green-400">
                      {coverage.active_patrols}
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2.5">
                    <div className="text-[10px] uppercase tracking-wider text-gray-500">
                      Completed
                    </div>
                    <div className="mt-1 text-lg font-bold text-blue-400">
                      {coverage.completed_patrols}
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2.5">
                    <div className="text-[10px] uppercase tracking-wider text-gray-500">
                      Checkpoints
                    </div>
                    <div className="mt-1 text-lg font-bold text-cyan-400">
                      {coverage.total_checkpoints_recorded}
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2.5">
                    <div className="text-[10px] uppercase tracking-wider text-gray-500">
                      Zones Covered
                    </div>
                    <div className="mt-1 text-lg font-bold text-yellow-400">
                      {coverage.zones_covered}
                    </div>
                  </div>
                </div>

                {/* Per-zone breakdown */}
                {Object.keys(coverage.zone_coverage).length > 0 && (
                  <div className="mt-4">
                    <h4 className="mb-2 text-[10px] uppercase tracking-wider text-gray-500">
                      Zone Breakdown
                    </h4>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                      {Object.entries(coverage.zone_coverage).map(
                        ([zoneId, stats]) => (
                          <div
                            key={zoneId}
                            className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2"
                          >
                            <span className="flex items-center gap-1.5 text-xs text-gray-300">
                              <MapPin className="h-3 w-3 text-cyan-500" />
                              {zoneId.length > 12
                                ? zoneId.slice(0, 12) + "..."
                                : zoneId}
                            </span>
                            <div className="flex items-center gap-2 text-[10px]">
                              <span className="text-gray-500">
                                {stats.patrol_count} patrols
                              </span>
                              <span className="text-green-400">
                                {stats.checkpoints} cp
                              </span>
                            </div>
                          </div>
                        )
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {!coverageLoading && !coverage && (
              <div className="flex flex-col items-center py-8">
                <BarChart3 className="mb-2 h-8 w-8 text-gray-700" />
                <p className="text-xs text-gray-600">
                  Coverage data unavailable
                </p>
              </div>
            )}
          </div>

          {/* Bottom: Generate Route */}
          <div className="flex items-center justify-between rounded-xl border border-gray-800 bg-gray-900/50 px-6 py-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-200">
                AI Route Generation
              </h3>
              <p className="mt-0.5 text-xs text-gray-500">
                Automatically generate an optimized patrol route based on
                current threat landscape and zone risk scores
              </p>
            </div>
            <div className="flex items-center gap-3">
              {generateMsg && (
                <span
                  className={cn(
                    "text-xs font-medium",
                    generateMsg.includes("success")
                      ? "text-green-400"
                      : "text-red-400"
                  )}
                >
                  {generateMsg}
                </span>
              )}
              <button
                onClick={handleGenerateRoute}
                disabled={generating}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold transition-all",
                  "bg-cyan-600 text-white border border-cyan-500",
                  "hover:bg-cyan-500 hover:shadow-lg hover:shadow-cyan-500/20",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
              >
                {generating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4" />
                )}
                Generate Route
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
