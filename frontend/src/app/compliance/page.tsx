"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  HardHat,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Camera,
  ChevronDown,
  ShieldCheck,
  ShieldX,
  ShieldAlert,
  Eye,
  CheckCheck,
  RefreshCw,
  MapPin,
  BarChart3,
  Filter,
  FileDown,
  Circle,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";
import { exportCSV } from "@/lib/export";
import { useToast } from "@/components/common/Toaster";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface PPEStats {
  total_checks: number;
  compliant: number;
  non_compliant: number;
  partially_compliant: number;
  compliance_rate: number;
  period_hours: number;
}

interface PPEEvent {
  id: string;
  camera_id: string;
  timestamp: string;
  status: "compliant" | "non_compliant" | "partially_compliant";
  required_ppe: string[];
  detected_ppe: string[];
  missing_ppe: string[];
  confidence: number;
  zone: string;
  acknowledged: boolean;
  remediation_status?: RemediationStatus;
}

interface ZoneCompliance {
  zone: string;
  total: number;
  compliant: number;
  non_compliant: number;
  partially_compliant: number;
  rate: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TABS = [
  { key: "events", label: "Compliance Events" },
  { key: "zones", label: "Zone Compliance" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All Statuses" },
  { value: "compliant", label: "Compliant" },
  { value: "non_compliant", label: "Non-Compliant" },
  { value: "partially_compliant", label: "Partially Compliant" },
];

type RemediationStatus = "pending" | "in_progress" | "done";

const REMEDIATION_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All Remediation" },
  { value: "pending", label: "Pending" },
  { value: "in_progress", label: "In Progress" },
  { value: "done", label: "Done" },
];

function remediationBadge(status: RemediationStatus | undefined): string {
  switch (status) {
    case "done":
      return "bg-green-900/40 text-green-400 border-green-800/60";
    case "in_progress":
      return "bg-blue-900/40 text-blue-400 border-blue-800/60";
    case "pending":
    default:
      return "bg-yellow-900/40 text-yellow-400 border-yellow-800/60";
  }
}

function remediationLabel(status: RemediationStatus | undefined): string {
  switch (status) {
    case "done":
      return "Done";
    case "in_progress":
      return "In Progress";
    case "pending":
    default:
      return "Pending";
  }
}

function nextRemediationStatus(current: RemediationStatus | undefined): RemediationStatus {
  if (!current || current === "pending") return "in_progress";
  if (current === "in_progress") return "done";
  return "pending";
}

const STAT_CARD =
  "rounded-lg border px-4 py-3 flex flex-col gap-1";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function timeAgo(iso: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(iso).getTime()) / 1000
  );
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function complianceStatusBadge(status: string): string {
  switch (status) {
    case "compliant":
      return "bg-green-900/40 text-green-400 border-green-800/60";
    case "non_compliant":
      return "bg-red-900/40 text-red-400 border-red-800/60";
    case "partially_compliant":
      return "bg-yellow-900/40 text-yellow-400 border-yellow-800/60";
    default:
      return "bg-gray-800 text-gray-400 border-gray-700";
  }
}

function complianceStatusLabel(status: string): string {
  switch (status) {
    case "compliant":
      return "Compliant";
    case "non_compliant":
      return "Non-Compliant";
    case "partially_compliant":
      return "Partial";
    default:
      return status;
  }
}

function complianceStatusIcon(status: string) {
  switch (status) {
    case "compliant":
      return ShieldCheck;
    case "non_compliant":
      return ShieldX;
    case "partially_compliant":
      return ShieldAlert;
    default:
      return ShieldAlert;
  }
}

function rateColor(rate: number): string {
  if (rate >= 90) return "text-green-400";
  if (rate >= 70) return "text-yellow-400";
  if (rate >= 50) return "text-orange-400";
  return "text-red-400";
}

function rateBarColor(rate: number): string {
  if (rate >= 90) return "bg-green-500";
  if (rate >= 70) return "bg-yellow-500";
  if (rate >= 50) return "bg-orange-500";
  return "bg-red-500";
}

function rateBorderColor(rate: number): string {
  if (rate >= 90) return "border-green-900/40";
  if (rate >= 70) return "border-yellow-900/40";
  if (rate >= 50) return "border-orange-900/40";
  return "border-red-900/40";
}

function rateBgColor(rate: number): string {
  if (rate >= 90) return "bg-green-950/20";
  if (rate >= 70) return "bg-yellow-950/20";
  if (rate >= 50) return "bg-orange-950/20";
  return "bg-red-950/20";
}

/* ------------------------------------------------------------------ */
/*  StatCard component                                                 */
/* ------------------------------------------------------------------ */

function StatCard({
  icon: Icon,
  label,
  value,
  valueColor,
  borderColor,
  bgColor,
  iconColor,
}: {
  icon: typeof BarChart3;
  label: string;
  value: string | number;
  valueColor?: string;
  borderColor?: string;
  bgColor?: string;
  iconColor?: string;
}) {
  return (
    <div
      className={cn(
        STAT_CARD,
        borderColor || "border-gray-800",
        bgColor || "bg-gray-900/60"
      )}
    >
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <Icon className={cn("h-3.5 w-3.5", iconColor)} />
        {label}
      </div>
      <p
        className={cn(
          "text-2xl font-bold tabular-nums",
          valueColor || "text-gray-100"
        )}
      >
        {value}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  PPECompliancePage                                                  */
/* ------------------------------------------------------------------ */

export default function PPECompliancePage() {
  const { addToast } = useToast();

  /* --- State --- */
  const [stats, setStats] = useState<PPEStats | null>(null);
  const [events, setEvents] = useState<PPEEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterCamera, setFilterCamera] = useState("");
  const [filterRemediation, setFilterRemediation] = useState("all");

  // Tab
  const [activeTab, setActiveTab] = useState<TabKey>("events");

  // UI state
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [exportingReport, setExportingReport] = useState(false);

  /* --- Fetch stats --- */
  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const data = await apiFetch<PPEStats>("/api/compliance/ppe/stats");
      setStats(data);
    } catch {
      // Stats fetch failure is non-critical
    } finally {
      setStatsLoading(false);
    }
  }, []);

  /* --- Fetch events --- */
  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (filterStatus !== "all") params.set("status", filterStatus);
      if (filterCamera.trim()) params.set("camera_id", filterCamera.trim());

      const data = await apiFetch<PPEEvent[]>(
        `/api/compliance/ppe?${params.toString()}`
      );
      setEvents(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch compliance events"
      );
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterCamera]);

  /* --- Initial load --- */
  useEffect(() => {
    fetchStats();
    fetchEvents();
  }, [fetchStats, fetchEvents]);

  /* --- Auto-refresh stats every 15s --- */
  useEffect(() => {
    const interval = setInterval(() => {
      fetchStats();
    }, 15000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  /* --- Acknowledge event --- */
  const handleAcknowledge = useCallback(
    async (eventId: string) => {
      setActionLoading(eventId);
      try {
        await apiFetch(`/api/compliance/ppe/${eventId}/acknowledge`, {
          method: "POST",
        });
        setEvents((prev) =>
          prev.map((e) =>
            e.id === eventId ? { ...e, acknowledged: true } : e
          )
        );
      } catch {
        // Silently handle
      } finally {
        setActionLoading(null);
      }
    },
    []
  );

  /* --- Refresh all data --- */
  const handleRefresh = useCallback(() => {
    fetchStats();
    fetchEvents();
  }, [fetchStats, fetchEvents]);

  /* --- Cycle remediation status for a non-compliant event --- */
  const handleRemediationCycle = useCallback(
    (eventId: string) => {
      let nextStatus: RemediationStatus = "pending";
      setEvents((prev) =>
        prev.map((e) => {
          if (e.id !== eventId) return e;
          nextStatus = nextRemediationStatus(e.remediation_status);
          return { ...e, remediation_status: nextStatus };
        })
      );
      apiFetch(`/api/compliance/ppe/${eventId}/acknowledge`, { method: "POST" })
        .then(() => {
          addToast("success", `Remediation status updated to "${nextStatus}".`);
        })
        .catch((err) => { console.warn("[compliance] API call failed:", err); });
    },
    [addToast]
  );

  /* --- Export compliance events as CSV --- */
  const handleGenerateReport = useCallback(async () => {
    if (events.length === 0) {
      addToast("error", "No compliance events to export.");
      return;
    }
    setExportingReport(true);
    try {
      const rows = events.map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        camera_id: e.camera_id,
        zone: e.zone,
        status: e.status,
        confidence: (e.confidence * 100).toFixed(1) + "%",
        required_ppe: e.required_ppe.join("; "),
        missing_ppe: e.missing_ppe.join("; "),
        acknowledged: e.acknowledged ? "Yes" : "No",
        remediation_status: e.remediation_status ?? "pending",
      }));
      exportCSV(
        rows as unknown as Record<string, unknown>[],
        `ppe_compliance_report_${new Date().toISOString().slice(0, 10)}.csv`,
        [
          { key: "id", label: "Event ID" },
          { key: "timestamp", label: "Timestamp" },
          { key: "camera_id", label: "Camera" },
          { key: "zone", label: "Zone" },
          { key: "status", label: "Compliance Status" },
          { key: "confidence", label: "Confidence" },
          { key: "required_ppe", label: "Required PPE" },
          { key: "missing_ppe", label: "Missing PPE" },
          { key: "acknowledged", label: "Acknowledged" },
          { key: "remediation_status", label: "Remediation Status" },
        ]
      );
      addToast("success", `Compliance report exported — ${rows.length} events.`);
    } catch {
      addToast("error", "Failed to generate report.");
    } finally {
      setExportingReport(false);
    }
  }, [events, addToast]);

  /* --- Derive zone compliance from events --- */
  const zoneCompliance = useMemo<ZoneCompliance[]>(() => {
    const zoneMap = new Map<
      string,
      { total: number; compliant: number; non_compliant: number; partially_compliant: number }
    >();

    for (const event of events) {
      const zone = event.zone || "Unknown";
      const existing = zoneMap.get(zone) || {
        total: 0,
        compliant: 0,
        non_compliant: 0,
        partially_compliant: 0,
      };

      existing.total += 1;
      if (event.status === "compliant") existing.compliant += 1;
      else if (event.status === "non_compliant") existing.non_compliant += 1;
      else if (event.status === "partially_compliant")
        existing.partially_compliant += 1;

      zoneMap.set(zone, existing);
    }

    return Array.from(zoneMap.entries())
      .map(([zone, data]) => ({
        zone,
        ...data,
        rate: data.total > 0 ? (data.compliant / data.total) * 100 : 0,
      }))
      .sort((a, b) => a.rate - b.rate);
  }, [events]);

  /* --- Derive camera list for filter --- */
  const cameraIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of events) {
      if (e.camera_id) ids.add(e.camera_id);
    }
    return Array.from(ids).sort();
  }, [events]);

  /* --- Filter events by remediation status (client-side) --- */
  const filteredEvents = useMemo(() => {
    if (filterRemediation === "all") return events;
    return events.filter(
      (e) => (e.remediation_status ?? "pending") === filterRemediation
    );
  }, [events, filterRemediation]);

  /* --- Non-compliant count for alert banner --- */
  const nonCompliantCount = stats?.non_compliant ?? 0;

  /* --- Render --- */
  return (
    <div className="flex h-full flex-col overflow-auto bg-gray-950 text-gray-100">
      {/* ---- Non-Compliant Alert Banner ---- */}
      {nonCompliantCount > 0 && (
        <div className="border-b border-red-900/50 bg-gradient-to-r from-red-950/80 via-orange-950/60 to-red-950/80 px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
            </span>
            <ShieldX className="h-5 w-5 text-red-400" />
            <span className="text-sm font-semibold text-red-300">
              {nonCompliantCount} non-compliant event
              {nonCompliantCount !== 1 ? "s" : ""} detected
            </span>
            <span className="text-xs text-red-400/70">
              -- Review required for PPE violations
            </span>
          </div>
        </div>
      )}

      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
            <HardHat className="h-5 w-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              PPE Compliance Dashboard
            </h1>
            <p className="text-xs text-gray-500">
              Monitor personal protective equipment compliance across all zones
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleGenerateReport}
            disabled={exportingReport || events.length === 0}
            className="flex items-center gap-2 rounded-lg border border-cyan-800/60 bg-cyan-900/20 px-3 py-2 text-xs text-cyan-400 transition-colors hover:bg-cyan-900/40 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {exportingReport ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileDown className="h-3.5 w-3.5" />
            )}
            Generate Report
          </button>
          <button
            onClick={handleRefresh}
            className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* ---- Stats Row ---- */}
      {statsLoading && !stats ? (
        <div className="grid grid-cols-2 gap-3 border-b border-gray-800 px-6 py-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="animate-pulse rounded-lg border border-gray-800 bg-gray-900/60 px-4 py-3 h-[76px]"
            />
          ))}
        </div>
      ) : stats ? (
        <div className="grid grid-cols-2 gap-3 border-b border-gray-800 px-6 py-4 md:grid-cols-4">
          <StatCard
            icon={BarChart3}
            label="Total Checks"
            value={stats.total_checks.toLocaleString()}
          />
          <StatCard
            icon={ShieldCheck}
            label="Compliant"
            value={stats.compliant.toLocaleString()}
            valueColor="text-green-400"
            borderColor="border-green-900/40"
            bgColor="bg-green-950/20"
            iconColor="text-green-400/80"
          />
          <StatCard
            icon={ShieldX}
            label="Non-Compliant"
            value={stats.non_compliant.toLocaleString()}
            valueColor="text-red-400"
            borderColor="border-red-900/40"
            bgColor="bg-red-950/20"
            iconColor="text-red-400/80"
          />
          <StatCard
            icon={Eye}
            label="Compliance Rate"
            value={`${(stats.compliance_rate ?? 0).toFixed(1)}%`}
            valueColor={rateColor(stats.compliance_rate ?? 0)}
            borderColor="border-cyan-900/40"
            bgColor="bg-cyan-950/20"
            iconColor="text-cyan-400/80"
          />
        </div>
      ) : null}

      {/* ---- Tab Navigation ---- */}
      <div className="flex items-center gap-1 border-b border-gray-800 px-6">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "relative px-4 py-3 text-sm font-medium transition-colors",
              activeTab === tab.key
                ? "text-cyan-400"
                : "text-gray-500 hover:text-gray-300"
            )}
          >
            {tab.label}
            {activeTab === tab.key && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-cyan-400 rounded-t" />
            )}
          </button>
        ))}
      </div>

      {/* ---- Tab Content ---- */}
      {activeTab === "events" && (
        <>
          {/* ---- Filter Bar ---- */}
          <div className="flex flex-wrap items-center gap-3 border-b border-gray-800 px-6 py-3">
            <Filter className="h-4 w-4 text-gray-600" />

            {/* Status filter */}
            <div className="relative">
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
              >
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
            </div>

            {/* Camera filter */}
            <div className="relative">
              <select
                value={filterCamera}
                onChange={(e) => setFilterCamera(e.target.value)}
                className="appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
              >
                <option value="">All Cameras</option>
                {cameraIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
            </div>

            {/* Remediation status filter */}
            <div className="relative">
              <select
                value={filterRemediation}
                onChange={(e) => setFilterRemediation(e.target.value)}
                className="appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
              >
                {REMEDIATION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
            </div>

            {/* Active filter indicator */}
            {(filterStatus !== "all" || filterCamera !== "" || filterRemediation !== "all") && (
              <button
                onClick={() => {
                  setFilterStatus("all");
                  setFilterCamera("");
                  setFilterRemediation("all");
                }}
                className="rounded-lg border border-cyan-800/40 bg-cyan-900/20 px-3 py-1.5 text-xs text-cyan-400 transition-colors hover:bg-cyan-900/40"
              >
                Clear filters
              </button>
            )}

            {/* Results info */}
            <div className="ml-auto text-xs text-gray-500">
              {!loading && (
                <span>
                  Showing {filteredEvents.length} event
                  {filteredEvents.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          </div>

          {/* ---- Events Table ---- */}
          <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
            {/* Loading state */}
            {loading && (
              <div className="flex flex-col items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
                <p className="mt-3 text-sm text-gray-500">
                  Loading compliance events...
                </p>
              </div>
            )}

            {/* Error state */}
            {!loading && error && (
              <div className="flex flex-col items-center justify-center py-20">
                <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
                <p className="text-sm text-red-400">{error}</p>
                <button
                  onClick={handleRefresh}
                  className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
                >
                  Retry
                </button>
              </div>
            )}

            {/* Empty state */}
            {!loading && !error && filteredEvents.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20">
                <CheckCircle2 className="mb-2 h-10 w-10 text-emerald-700" />
                <p className="text-sm font-medium text-gray-400">
                  No compliance events found
                </p>
                <p className="mt-1 text-xs text-gray-600">
                  {filterStatus !== "all" || filterCamera !== "" || filterRemediation !== "all"
                    ? "Try adjusting your filters"
                    : "All PPE checks are up to date"}
                </p>
              </div>
            )}

            {/* Table */}
            {!loading && !error && filteredEvents.length > 0 && (
              <div className="px-6 py-4">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-800">
                      <th className="pb-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                        Time
                      </th>
                      <th className="pb-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                        Camera
                      </th>
                      <th className="pb-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                        Zone
                      </th>
                      <th className="pb-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                        Status
                      </th>
                      <th className="pb-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                        Required PPE
                      </th>
                      <th className="pb-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                        Missing PPE
                      </th>
                      <th className="pb-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                        Remediation
                      </th>
                      <th className="pb-3 text-right text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                        Confidence
                      </th>
                      <th className="pb-3 text-right text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEvents.map((event) => {
                      const StatusIcon = complianceStatusIcon(event.status);
                      const isActioning = actionLoading === event.id;

                      return (
                        <tr
                          key={event.id}
                          className={cn(
                            "border-b border-gray-800/50 transition-colors hover:bg-gray-800/50",
                            !event.acknowledged &&
                              event.status === "non_compliant" &&
                              "bg-red-950/10"
                          )}
                        >
                          {/* Time */}
                          <td className="py-3 pr-4">
                            <div className="flex items-center gap-1.5">
                              <Clock className="h-3 w-3 text-gray-600" />
                              <span className="text-xs text-gray-400">
                                {formatTimestamp(event.timestamp)}
                              </span>
                            </div>
                            <span className="text-[10px] text-gray-600">
                              {timeAgo(event.timestamp)}
                            </span>
                          </td>

                          {/* Camera */}
                          <td className="py-3 pr-4">
                            <div className="flex items-center gap-1.5">
                              <Camera className="h-3 w-3 text-gray-600" />
                              <span className="text-xs font-medium text-gray-300">
                                {event.camera_id}
                              </span>
                            </div>
                          </td>

                          {/* Zone */}
                          <td className="py-3 pr-4">
                            <div className="flex items-center gap-1.5">
                              <MapPin className="h-3 w-3 text-gray-600" />
                              <span className="text-xs text-gray-400">
                                {event.zone || "---"}
                              </span>
                            </div>
                          </td>

                          {/* Status */}
                          <td className="py-3 pr-4">
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider border",
                                complianceStatusBadge(event.status)
                              )}
                            >
                              <StatusIcon className="h-3 w-3" />
                              {complianceStatusLabel(event.status)}
                            </span>
                          </td>

                          {/* Required PPE */}
                          <td className="py-3 pr-4">
                            <div className="flex flex-wrap gap-1">
                              {event.required_ppe.length > 0 ? (
                                event.required_ppe.map((ppe) => (
                                  <span
                                    key={ppe}
                                    className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium text-gray-400 border border-gray-700"
                                  >
                                    {ppe}
                                  </span>
                                ))
                              ) : (
                                <span className="text-[10px] text-gray-600">
                                  None specified
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Missing PPE */}
                          <td className="py-3 pr-4">
                            <div className="flex flex-wrap gap-1">
                              {event.missing_ppe.length > 0 ? (
                                event.missing_ppe.map((ppe) => (
                                  <span
                                    key={ppe}
                                    className="rounded bg-red-900/30 px-1.5 py-0.5 text-[10px] font-semibold text-red-400 border border-red-800/50"
                                  >
                                    {ppe}
                                  </span>
                                ))
                              ) : (
                                <span className="text-[10px] text-green-600">
                                  --
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Remediation */}
                          <td className="py-3 pr-4">
                            {event.status !== "compliant" ? (
                              <button
                                onClick={() => handleRemediationCycle(event.id)}
                                title="Click to advance remediation status"
                                className={cn(
                                  "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-opacity hover:opacity-80 cursor-pointer",
                                  remediationBadge(event.remediation_status)
                                )}
                              >
                                <Circle className="h-2 w-2 fill-current" />
                                {remediationLabel(event.remediation_status)}
                              </button>
                            ) : (
                              <span className="text-[10px] text-gray-600">--</span>
                            )}
                          </td>

                          {/* Confidence */}
                          <td className="py-3 pr-4 text-right">
                            <span className="font-mono text-xs font-semibold text-cyan-400">
                              {Math.round(event.confidence * 100)}%
                            </span>
                          </td>

                          {/* Actions */}
                          <td className="py-3 text-right">
                            {!event.acknowledged &&
                            event.status !== "compliant" ? (
                              <button
                                onClick={() => handleAcknowledge(event.id)}
                                disabled={isActioning}
                                className={cn(
                                  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                                  "bg-yellow-900/40 text-yellow-400 border border-yellow-800/60",
                                  "hover:bg-yellow-800/50 hover:text-yellow-300",
                                  "disabled:opacity-50 disabled:cursor-not-allowed"
                                )}
                              >
                                {isActioning ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <CheckCheck className="h-3.5 w-3.5" />
                                )}
                                Acknowledge
                              </button>
                            ) : event.acknowledged ? (
                              <span className="inline-flex items-center gap-1 text-[10px] text-green-600">
                                <CheckCircle2 className="h-3 w-3" />
                                Acknowledged
                              </span>
                            ) : (
                              <span className="text-[10px] text-gray-600">
                                --
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {activeTab === "zones" && (
        <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
          {/* Loading state */}
          {loading && (
            <div className="flex flex-col items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
              <p className="mt-3 text-sm text-gray-500">
                Loading zone compliance data...
              </p>
            </div>
          )}

          {/* Error state */}
          {!loading && error && (
            <div className="flex flex-col items-center justify-center py-20">
              <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
              <p className="text-sm text-red-400">{error}</p>
              <button
                onClick={handleRefresh}
                className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && zoneCompliance.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20">
              <MapPin className="mb-2 h-10 w-10 text-gray-700" />
              <p className="text-sm font-medium text-gray-400">
                No zone data available
              </p>
              <p className="mt-1 text-xs text-gray-600">
                Zone compliance data will appear once PPE checks are recorded
              </p>
            </div>
          )}

          {/* Zone compliance cards grid */}
          {!loading && !error && zoneCompliance.length > 0 && (
            <div className="px-6 py-4">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Compliance by Zone
                </h2>
                <span className="text-xs text-gray-600">
                  {zoneCompliance.length} zone
                  {zoneCompliance.length !== 1 ? "s" : ""} monitored
                </span>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {zoneCompliance.map((zone) => (
                  <div
                    key={zone.zone}
                    className={cn(
                      "rounded-lg border p-4 transition-shadow hover:shadow-lg hover:shadow-cyan-900/10",
                      rateBorderColor(zone.rate),
                      rateBgColor(zone.rate)
                    )}
                  >
                    {/* Zone header */}
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <MapPin className="h-4 w-4 text-gray-500" />
                        <h3 className="text-sm font-semibold text-gray-200">
                          {zone.zone}
                        </h3>
                      </div>
                      <span
                        className={cn(
                          "text-lg font-bold tabular-nums",
                          rateColor(zone.rate)
                        )}
                      >
                        {zone.rate.toFixed(1)}%
                      </span>
                    </div>

                    {/* Progress bar */}
                    <div className="mb-3 h-2.5 w-full overflow-hidden rounded-full bg-gray-800">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all duration-500",
                          rateBarColor(zone.rate)
                        )}
                        style={{ width: `${Math.min(zone.rate, 100)}%` }}
                      />
                    </div>

                    {/* Zone stats breakdown */}
                    <div className="grid grid-cols-3 gap-2">
                      <div className="text-center">
                        <p className="text-lg font-bold tabular-nums text-green-400">
                          {zone.compliant}
                        </p>
                        <p className="text-[10px] uppercase tracking-wider text-gray-600">
                          Compliant
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-lg font-bold tabular-nums text-red-400">
                          {zone.non_compliant}
                        </p>
                        <p className="text-[10px] uppercase tracking-wider text-gray-600">
                          Non-Compl.
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-lg font-bold tabular-nums text-yellow-400">
                          {zone.partially_compliant}
                        </p>
                        <p className="text-[10px] uppercase tracking-wider text-gray-600">
                          Partial
                        </p>
                      </div>
                    </div>

                    {/* Total checks info */}
                    <div className="mt-3 flex items-center justify-between border-t border-gray-800/50 pt-2">
                      <span className="text-[10px] text-gray-600">
                        Total checks
                      </span>
                      <span className="text-xs font-semibold tabular-nums text-gray-400">
                        {zone.total}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Zone summary bar */}
              <div className="mt-6 rounded-lg border border-gray-800 bg-gray-900/60 p-4">
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Overall Zone Summary
                </h3>
                <div className="space-y-2">
                  {zoneCompliance.map((zone) => (
                    <div key={zone.zone} className="flex items-center gap-3">
                      <span className="w-32 truncate text-xs font-medium text-gray-400">
                        {zone.zone}
                      </span>
                      <div className="flex-1 h-2 overflow-hidden rounded-full bg-gray-800">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all duration-500",
                            rateBarColor(zone.rate)
                          )}
                          style={{ width: `${Math.min(zone.rate, 100)}%` }}
                        />
                      </div>
                      <span
                        className={cn(
                          "w-14 text-right font-mono text-xs font-semibold tabular-nums",
                          rateColor(zone.rate)
                        )}
                      >
                        {zone.rate.toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
