"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Flame,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Camera,
  ChevronDown,
  Droplets,
  Zap,
  Wind,
  Building2,
  FlaskConical,
  Lightbulb,
  CloudFog,
  ShieldAlert,
  Activity,
  BarChart3,
  RefreshCw,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";
import MetricSparkline from "@/components/common/MetricSparkline";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface EnvironmentalStats {
  total_events: number;
  active_hazards: number;
  resolved: number;
  avg_severity: number;
  cameras_monitored: number;
}

interface EnvironmentalEvent {
  id: string;
  hazard_type: string;
  severity: number;
  camera_name: string;
  description: string;
  recommended_action: string;
  status: "new" | "acknowledged" | "resolved";
  created_at: string;
  acknowledged_at?: string | null;
  resolved_at?: string | null;
  // Optional sensor health fields
  last_reading?: string | null;
  recent_readings?: number[];
}

interface HazardTypeInfo {
  type: string;
  label: string;
  count: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const HAZARD_CATEGORIES: {
  type: string;
  label: string;
  icon: typeof Flame;
  color: string;
  bgColor: string;
  borderColor: string;
  textColor: string;
  ringColor: string;
}[] = [
  {
    type: "smoke",
    label: "Smoke",
    icon: CloudFog,
    color: "text-gray-400",
    bgColor: "bg-gray-500/10",
    borderColor: "border-gray-500/30",
    textColor: "text-gray-300",
    ringColor: "ring-gray-500/30",
  },
  {
    type: "fire",
    label: "Fire / Flame",
    icon: Flame,
    color: "text-red-400",
    bgColor: "bg-red-500/10",
    borderColor: "border-red-500/30",
    textColor: "text-red-300",
    ringColor: "ring-red-500/30",
  },
  {
    type: "electrical",
    label: "Electrical Sparking",
    icon: Zap,
    color: "text-yellow-400",
    bgColor: "bg-yellow-500/10",
    borderColor: "border-yellow-500/30",
    textColor: "text-yellow-300",
    ringColor: "ring-yellow-500/30",
  },
  {
    type: "water",
    label: "Water / Flooding",
    icon: Droplets,
    color: "text-blue-400",
    bgColor: "bg-blue-500/10",
    borderColor: "border-blue-500/30",
    textColor: "text-blue-300",
    ringColor: "ring-blue-500/30",
  },
  {
    type: "gas",
    label: "Gas / Fog",
    icon: Wind,
    color: "text-purple-400",
    bgColor: "bg-purple-500/10",
    borderColor: "border-purple-500/30",
    textColor: "text-purple-300",
    ringColor: "ring-purple-500/30",
  },
  {
    type: "structural",
    label: "Structural Damage",
    icon: Building2,
    color: "text-orange-400",
    bgColor: "bg-orange-500/10",
    borderColor: "border-orange-500/30",
    textColor: "text-orange-300",
    ringColor: "ring-orange-500/30",
  },
  {
    type: "chemical",
    label: "Chemical Spill",
    icon: FlaskConical,
    color: "text-green-400",
    bgColor: "bg-green-500/10",
    borderColor: "border-green-500/30",
    textColor: "text-green-300",
    ringColor: "ring-green-500/30",
  },
  {
    type: "lighting",
    label: "Unusual Lighting",
    icon: Lightbulb,
    color: "text-amber-400",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/30",
    textColor: "text-amber-300",
    ringColor: "ring-amber-500/30",
  },
];

const HAZARD_TYPE_MAP = Object.fromEntries(
  HAZARD_CATEGORIES.map((h) => [h.type, h])
);

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All Statuses" },
  { value: "new", label: "New" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "resolved", label: "Resolved" },
];

const HAZARD_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All Hazard Types" },
  ...HAZARD_CATEGORIES.map((h) => ({ value: h.type, label: h.label })),
];

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

function severityBarColor(severity: number): string {
  if (severity <= 3) return "bg-green-500";
  if (severity <= 5) return "bg-yellow-500";
  if (severity <= 7) return "bg-orange-500";
  return "bg-red-500";
}

function severityTextColor(severity: number): string {
  if (severity <= 3) return "text-green-400";
  if (severity <= 5) return "text-yellow-400";
  if (severity <= 7) return "text-orange-400";
  return "text-red-400";
}

/* ------------------------------------------------------------------ */
/*  Sensor Health Helpers                                             */
/* ------------------------------------------------------------------ */

type SensorHealth = "Online" | "Stale" | "Offline";

function getSensorHealth(lastReadingIso?: string | null): SensorHealth {
  if (!lastReadingIso) return "Offline";
  const ageMs = Date.now() - new Date(lastReadingIso).getTime();
  const ageMin = ageMs / 60000;
  if (ageMin > 15) return "Offline";
  if (ageMin > 5) return "Stale";
  return "Online";
}

function sensorHealthBadge(health: SensorHealth): string {
  switch (health) {
    case "Online":
      return "bg-green-900/40 text-green-400 border-green-800/60";
    case "Stale":
      return "bg-amber-900/40 text-amber-400 border-amber-800/60";
    case "Offline":
      return "bg-red-900/40 text-red-400 border-red-800/60";
  }
}

function statusBadgeClasses(status: string): string {
  switch (status) {
    case "new":
      return "bg-red-900/40 text-red-400 border-red-800/60";
    case "acknowledged":
      return "bg-yellow-900/40 text-yellow-400 border-yellow-800/60";
    case "resolved":
      return "bg-green-900/40 text-green-400 border-green-800/60";
    default:
      return "bg-gray-800 text-gray-400 border-gray-700";
  }
}

/* ------------------------------------------------------------------ */
/*  SeverityBar component                                              */
/* ------------------------------------------------------------------ */

function SeverityBar({ severity }: { severity: number }) {
  const clamped = Math.max(1, Math.min(10, severity));
  const pct = (clamped / 10) * 100;

  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "font-mono text-xs font-bold tabular-nums",
          severityTextColor(clamped)
        )}
      >
        {clamped.toFixed(1)}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-800">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-300",
            severityBarColor(clamped)
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-gray-600">/10</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  HazardEventCard                                                    */
/* ------------------------------------------------------------------ */

interface HazardEventCardProps {
  event: EnvironmentalEvent;
  expanded: boolean;
  onToggle: () => void;
  onAcknowledge: (id: string) => void;
  onResolve: (id: string) => void;
  actionLoading: string | null;
}

function HazardEventCard({
  event,
  expanded,
  onToggle,
  onAcknowledge,
  onResolve,
  actionLoading,
}: HazardEventCardProps) {
  const hazard = HAZARD_TYPE_MAP[event.hazard_type];
  const HazardIcon = hazard?.icon || AlertTriangle;
  const isActioning = actionLoading === event.id;

  return (
    <div
      className={cn(
        "border rounded-lg transition-all duration-200",
        expanded
          ? "bg-gray-900/90 border-gray-700"
          : "bg-gray-900/50 border-gray-800 hover:bg-gray-900/80",
        event.status === "new" && "border-l-2 border-l-red-500"
      )}
    >
      {/* Collapsed row */}
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {/* Hazard type icon */}
        <div
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border",
            hazard?.bgColor || "bg-gray-800",
            hazard?.borderColor || "border-gray-700"
          )}
        >
          <HazardIcon
            className={cn("h-4 w-4", hazard?.color || "text-gray-400")}
          />
        </div>

        {/* Hazard label */}
        <span
          className={cn(
            "shrink-0 text-xs font-semibold uppercase tracking-wider",
            hazard?.textColor || "text-gray-300"
          )}
        >
          {hazard?.label || event.hazard_type}
        </span>

        {/* Description truncated */}
        <span className="flex-1 truncate text-sm text-gray-400">
          {event.description}
        </span>

        {/* Camera */}
        <span className="hidden items-center gap-1 text-xs text-gray-500 md:flex">
          <Camera className="h-3 w-3" />
          {event.camera_name}
        </span>

        {/* Severity mini indicator */}
        <span
          className={cn(
            "shrink-0 font-mono text-xs font-bold",
            severityTextColor(event.severity ?? 0)
          )}
        >
          {(event.severity ?? 0).toFixed(1)}
        </span>

        {/* Status badge */}
        <span
          className={cn(
            "shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider border",
            statusBadgeClasses(event.status)
          )}
        >
          {event.status}
        </span>

        {/* Sensor health badge */}
        {(() => {
          const health = getSensorHealth(event.last_reading ?? event.created_at);
          return (
            <span
              className={cn(
                "shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold border",
                sensorHealthBadge(health)
              )}
              title={event.last_reading ? `Last reading: ${event.last_reading}` : "No reading timestamp"}
            >
              {health}
            </span>
          );
        })()}

        {/* Time ago */}
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-gray-500">
          <Clock className="h-3 w-3" />
          {timeAgo(event.created_at)}
        </span>

        {/* Expand chevron */}
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-gray-600 transition-transform duration-200",
            expanded && "rotate-180"
          )}
        />
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-gray-800 px-4 py-4 space-y-4">
          {/* Severity bar */}
          <div>
            <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
              <Activity className="h-3.5 w-3.5" />
              Severity Level
            </h4>
            <SeverityBar severity={event.severity} />
          </div>

          {/* Historical trend sparkline */}
          {event.recent_readings && event.recent_readings.length >= 2 && (
            <div>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
                <BarChart3 className="h-3.5 w-3.5" />
                Recent Readings Trend
              </h4>
              <div className="flex items-center gap-3">
                <MetricSparkline
                  data={event.recent_readings.slice(-20)}
                  width={200}
                  height={36}
                  color={
                    event.severity > 7 ? "#ef4444" :
                    event.severity > 5 ? "#f97316" :
                    event.severity > 3 ? "#eab308" : "#22c55e"
                  }
                  fill={true}
                  showValue={true}
                />
                <span className="text-[10px] text-gray-500">
                  Last {Math.min(event.recent_readings.length, 20)} readings
                </span>
              </div>
            </div>
          )}

          {/* Description */}
          <div>
            <h4 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
              <ShieldAlert className="h-3.5 w-3.5 text-orange-400" />
              Description
            </h4>
            <p className="rounded-lg border border-orange-900/40 bg-orange-950/20 px-3 py-2 text-sm leading-relaxed text-orange-200">
              {event.description}
            </p>
          </div>

          {/* Recommended action */}
          {event.recommended_action && (
            <div>
              <h4 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
                <CheckCircle2 className="h-3.5 w-3.5 text-amber-400" />
                Recommended Action
              </h4>
              <p className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-sm leading-relaxed text-amber-200">
                {event.recommended_action}
              </p>
            </div>
          )}

          {/* Metadata row */}
          <div className="flex flex-wrap gap-4 text-xs text-gray-500">
            <span>
              ID:{" "}
              <span className="font-mono text-gray-400">
                {event.id.slice(0, 8)}
              </span>
            </span>
            <span>
              Camera:{" "}
              <span className="text-gray-400">{event.camera_name}</span>
            </span>
            <span>
              Created:{" "}
              <span className="text-gray-400">
                {formatTimestamp(event.created_at)}
              </span>
            </span>
            {event.acknowledged_at && (
              <span>
                Acknowledged:{" "}
                <span className="text-gray-400">
                  {formatTimestamp(event.acknowledged_at)}
                </span>
              </span>
            )}
            {event.resolved_at && (
              <span>
                Resolved:{" "}
                <span className="text-gray-400">
                  {formatTimestamp(event.resolved_at)}
                </span>
              </span>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 pt-1">
            {event.status === "new" && (
              <button
                onClick={() => onAcknowledge(event.id)}
                disabled={isActioning}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                  "bg-yellow-900/40 text-yellow-400 border border-yellow-800/60",
                  "hover:bg-yellow-800/50 hover:text-yellow-300",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
              >
                {isActioning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                Acknowledge
              </button>
            )}

            {(event.status === "new" || event.status === "acknowledged") && (
              <button
                onClick={() => onResolve(event.id)}
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
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                Resolve
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  EnvironmentalSafetyPage                                            */
/* ------------------------------------------------------------------ */

export default function EnvironmentalSafetyPage() {
  /* --- State --- */
  const [stats, setStats] = useState<EnvironmentalStats | null>(null);
  const [events, setEvents] = useState<EnvironmentalEvent[]>([]);
  const [hazardTypes, setHazardTypes] = useState<HazardTypeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filterHazardType, setFilterHazardType] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");

  // UI state
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  /* --- Fetch stats --- */
  const fetchStats = useCallback(async () => {
    try {
      const data = await apiFetch<EnvironmentalStats>(
        "/api/environmental/stats"
      );
      setStats(data);
    } catch {
      // Stats fetch failure is non-critical
    }
  }, []);

  /* --- Fetch hazard type counts --- */
  const fetchHazardTypes = useCallback(async () => {
    try {
      const data = await apiFetch<HazardTypeInfo[]>(
        "/api/environmental/types"
      );
      setHazardTypes(Array.isArray(data) ? data : []);
    } catch {
      setHazardTypes([]);
    }
  }, []);

  /* --- Fetch events --- */
  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    setExpandedId(null);

    try {
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (filterHazardType !== "all") params.set("hazard_type", filterHazardType);
      if (filterStatus !== "all") params.set("status", filterStatus);
      params.set("min_severity", "0");

      const data = await apiFetch<EnvironmentalEvent[]>(
        `/api/environmental/events?${params.toString()}`
      );
      setEvents(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch environmental events"
      );
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [filterHazardType, filterStatus]);

  /* --- Initial load and refresh --- */
  useEffect(() => {
    fetchStats();
    fetchHazardTypes();
    fetchEvents();
  }, [fetchStats, fetchHazardTypes, fetchEvents]);

  /* --- Auto-refresh stats every 10s --- */
  useEffect(() => {
    const interval = setInterval(() => {
      fetchStats();
      fetchHazardTypes();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchStats, fetchHazardTypes]);

  /* --- Actions --- */
  const handleAcknowledge = useCallback(
    async (eventId: string) => {
      setActionLoading(eventId);
      try {
        await apiFetch(`/api/environmental/events/${eventId}/acknowledge`, {
          method: "POST",
        });
        setEvents((prev) =>
          prev.map((e) =>
            e.id === eventId
              ? { ...e, status: "acknowledged" as const, acknowledged_at: new Date().toISOString() }
              : e
          )
        );
        fetchStats();
      } catch {
        // Silently handle
      } finally {
        setActionLoading(null);
      }
    },
    [fetchStats]
  );

  const handleResolve = useCallback(
    async (eventId: string) => {
      setActionLoading(eventId);
      try {
        await apiFetch(`/api/environmental/events/${eventId}/resolve`, {
          method: "POST",
        });
        setEvents((prev) =>
          prev.map((e) =>
            e.id === eventId
              ? { ...e, status: "resolved" as const, resolved_at: new Date().toISOString() }
              : e
          )
        );
        fetchStats();
      } catch {
        // Silently handle
      } finally {
        setActionLoading(null);
      }
    },
    [fetchStats]
  );

  const handleRefresh = useCallback(() => {
    fetchStats();
    fetchHazardTypes();
    fetchEvents();
  }, [fetchStats, fetchHazardTypes, fetchEvents]);

  /* --- Derive hazard type counts for grid --- */
  const hazardCountMap = Object.fromEntries(
    hazardTypes.map((ht) => [ht.type, ht.count])
  );

  const hasActiveHazards = stats != null && stats.active_hazards > 0;

  /* --- Render --- */
  return (
    <div className="flex h-full flex-col overflow-auto bg-gray-950 text-gray-100">
      {/* ---- Active Hazard Alert Banner ---- */}
      {hasActiveHazards && (
        <div className="border-b border-red-900/50 bg-gradient-to-r from-red-950/80 via-orange-950/60 to-red-950/80 px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
            </span>
            <AlertTriangle className="h-5 w-5 text-red-400" />
            <span className="text-sm font-semibold text-red-300">
              {stats?.active_hazards ?? 0} active hazard
              {(stats?.active_hazards ?? 0) !== 1 ? "s" : ""} detected
            </span>
            <span className="text-xs text-red-400/70">
              -- Immediate attention required
            </span>
          </div>
        </div>
      )}

      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-900/30 border border-orange-800/50">
            <Flame className="h-5 w-5 text-orange-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Environmental Safety Monitor
            </h1>
            <p className="text-xs text-gray-500">
              Real-time hazard detection and environmental threat monitoring
            </p>
          </div>
        </div>

        <button
          onClick={handleRefresh}
          className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {/* ---- Stats Row ---- */}
      {stats && (
        <div className="grid grid-cols-2 gap-3 border-b border-gray-800 px-6 py-4 md:grid-cols-5">
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <BarChart3 className="h-3.5 w-3.5" />
              Total Events
            </div>
            <p className="mt-1 text-2xl font-bold tabular-nums text-gray-100">
              {stats.total_events}
            </p>
          </div>

          <div className="rounded-lg border border-red-900/40 bg-red-950/20 px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-red-400/80">
              <AlertTriangle className="h-3.5 w-3.5" />
              Active Hazards
            </div>
            <p className="mt-1 text-2xl font-bold tabular-nums text-red-400">
              {stats.active_hazards}
            </p>
          </div>

          <div className="rounded-lg border border-green-900/40 bg-green-950/20 px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-green-400/80">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Resolved
            </div>
            <p className="mt-1 text-2xl font-bold tabular-nums text-green-400">
              {stats.resolved}
            </p>
          </div>

          <div className="rounded-lg border border-orange-900/40 bg-orange-950/20 px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-orange-400/80">
              <Activity className="h-3.5 w-3.5" />
              Avg Severity
            </div>
            <p
              className={cn(
                "mt-1 text-2xl font-bold tabular-nums",
                severityTextColor(stats.avg_severity ?? 0)
              )}
            >
              {(stats.avg_severity ?? 0).toFixed(1)}
            </p>
          </div>

          <div className="rounded-lg border border-gray-800 bg-gray-900/60 px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Camera className="h-3.5 w-3.5" />
              Cameras Monitored
            </div>
            <p className="mt-1 text-2xl font-bold tabular-nums text-gray-100">
              {stats.cameras_monitored}
            </p>
          </div>
        </div>
      )}

      {/* ---- Hazard Type Grid ---- */}
      <div className="border-b border-gray-800 px-6 py-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
          Hazard Categories
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {HAZARD_CATEGORIES.map((hazard) => {
            const HIcon = hazard.icon;
            const count = hazardCountMap[hazard.type] ?? 0;
            const isActive = count > 0;

            return (
              <button
                key={hazard.type}
                onClick={() =>
                  setFilterHazardType(
                    filterHazardType === hazard.type ? "all" : hazard.type
                  )
                }
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-lg border px-3 py-3 text-center transition-all duration-200",
                  filterHazardType === hazard.type
                    ? cn(hazard.bgColor, hazard.borderColor, "ring-1", hazard.ringColor)
                    : "border-gray-800 bg-gray-900/40 hover:bg-gray-900/70",
                  isActive && filterHazardType !== hazard.type && "border-gray-700"
                )}
              >
                <HIcon
                  className={cn(
                    "h-5 w-5",
                    isActive || filterHazardType === hazard.type
                      ? hazard.color
                      : "text-gray-600"
                  )}
                />
                <span
                  className={cn(
                    "text-[10px] font-medium leading-tight",
                    isActive || filterHazardType === hazard.type
                      ? hazard.textColor
                      : "text-gray-500"
                  )}
                >
                  {hazard.label}
                </span>
                <span
                  className={cn(
                    "text-lg font-bold tabular-nums",
                    isActive ? hazard.color : "text-gray-700"
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ---- Filter Bar ---- */}
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-800 px-6 py-3">
        {/* Hazard type filter */}
        <div className="relative">
          <select
            value={filterHazardType}
            onChange={(e) => setFilterHazardType(e.target.value)}
            className="appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-300 focus:border-orange-700 focus:outline-none focus:ring-1 focus:ring-orange-700"
          >
            {HAZARD_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
        </div>

        {/* Status filter */}
        <div className="relative">
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-300 focus:border-orange-700 focus:outline-none focus:ring-1 focus:ring-orange-700"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
        </div>

        {/* Active filter indicator */}
        {(filterHazardType !== "all" || filterStatus !== "all") && (
          <button
            onClick={() => {
              setFilterHazardType("all");
              setFilterStatus("all");
            }}
            className="rounded-lg border border-orange-800/40 bg-orange-900/20 px-3 py-1.5 text-xs text-orange-400 transition-colors hover:bg-orange-900/40"
          >
            Clear filters
          </button>
        )}

        {/* Results info */}
        <div className="ml-auto text-xs text-gray-500">
          {!loading && (
            <span>
              Showing {events.length} event{events.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      {/* ---- Events List ---- */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {/* Loading state */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-orange-400" />
            <p className="mt-3 text-sm text-gray-500">
              Loading environmental events...
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
        {!loading && !error && events.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20">
            <CheckCircle2 className="mb-2 h-10 w-10 text-emerald-700" />
            <p className="text-sm font-medium text-gray-400">
              No environmental hazards detected
            </p>
            <p className="mt-1 text-xs text-gray-600">
              {filterHazardType !== "all" || filterStatus !== "all"
                ? "Try adjusting your filters"
                : "All clear -- the environment is safe"}
            </p>
          </div>
        )}

        {/* Event rows */}
        {!loading &&
          !error &&
          events.map((event) => (
            <HazardEventCard
              key={event.id}
              event={event}
              expanded={expandedId === event.id}
              onToggle={() =>
                setExpandedId(expandedId === event.id ? null : event.id)
              }
              onAcknowledge={handleAcknowledge}
              onResolve={handleResolve}
              actionLoading={actionLoading}
            />
          ))}
      </div>
    </div>
  );
}
