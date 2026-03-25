"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Activity,
  Users,
  UserX,
  AlertTriangle,
  Eye,
  Clock,
  MapPin,
  DoorOpen,
  Loader2,
  CheckCircle2,
  TrendingUp,
  Shield,
  Footprints,
  PersonStanding,
  BarChart3,
  ChevronDown,
  HelpCircle,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface BehavioralStats {
  loitering_today: number;
  tailgating_alerts: number;
  occupancy_violations: number;
  unresolved_events: number;
}

interface BehavioralEvent {
  id: string;
  type: "loitering" | "tailgating" | "occupancy_violation" | "unusual_access" | "crowd_anomaly";
  severity: "critical" | "high" | "medium" | "low";
  zone: string;
  description: string;
  timestamp: string;
  resolved: boolean;
  resolved_by: string | null;
  camera_name: string | null;
  // Optional explainability fields
  reason?: string;
  explanation?: string;
  confidence?: number;
}

interface OccupancyZone {
  zone_id: string;
  zone_name: string;
  current_count: number;
  max_capacity: number;
  utilization: number;
}

interface TailgatingEntry {
  id: string;
  door: string;
  timestamp: string;
  person_count: number;
  authorized_user: string;
  camera_name: string;
}

interface UnusualAccessEntry {
  id: string;
  user: string;
  door: string;
  timestamp: string;
  flag_reason: string;
  risk_score: number;
}

interface OccupancyTimeSeries {
  timestamp: string;
  [zone: string]: string | number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const EVENT_TYPE_ICONS: Record<string, React.ReactNode> = {
  loitering: <Footprints className="h-4 w-4" />,
  tailgating: <Users className="h-4 w-4" />,
  occupancy_violation: <PersonStanding className="h-4 w-4" />,
  unusual_access: <DoorOpen className="h-4 w-4" />,
  crowd_anomaly: <Activity className="h-4 w-4" />,
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  loitering: "Loitering",
  tailgating: "Tailgating",
  occupancy_violation: "Occupancy Violation",
  unusual_access: "Unusual Access",
  crowd_anomaly: "Crowd Anomaly",
};

const SEVERITY_BADGE: Record<string, string> = {
  critical: "text-red-500 bg-red-500/10 border-red-500/50",
  high: "text-orange-500 bg-orange-500/10 border-orange-500/50",
  medium: "text-yellow-500 bg-yellow-500/10 border-yellow-500/50",
  low: "text-blue-400 bg-blue-400/10 border-blue-400/50",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function utilizationColor(util: number): string {
  if (util >= 0.9) return "text-red-500";
  if (util >= 0.7) return "text-yellow-400";
  return "text-green-400";
}

function utilizationBarColor(util: number): string {
  if (util >= 0.9) return "bg-red-500";
  if (util >= 0.7) return "bg-yellow-500";
  return "bg-green-500";
}

/* ------------------------------------------------------------------ */
/*  Occupancy Zone Card                                                */
/* ------------------------------------------------------------------ */

function OccupancyCard({ zone }: { zone: OccupancyZone }) {
  const util = zone.utilization ?? 0;
  const pct = Math.min(util * 100, 100);
  return (
    <div
      className={cn(
        "rounded-lg border p-3 transition-colors",
        util >= 0.9
          ? "border-red-800/60 bg-red-950/20"
          : util >= 0.7
          ? "border-yellow-800/50 bg-yellow-950/10"
          : "border-gray-800 bg-zinc-900/50"
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-gray-200">
          {zone.zone_name}
        </span>
        <span
          className={cn(
            "text-sm font-bold font-mono",
            utilizationColor(util)
          )}
        >
          {zone.current_count}/{zone.max_capacity}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-gray-800 overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            utilizationBarColor(util)
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1.5 text-[10px] text-gray-500">
        {Math.round(pct)}% utilized
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function BehavioralAnalyticsPage() {
  const [stats, setStats] = useState<BehavioralStats | null>(null);
  const [events, setEvents] = useState<BehavioralEvent[]>([]);
  const [occupancy, setOccupancy] = useState<OccupancyZone[]>([]);
  const [tailgating, setTailgating] = useState<TailgatingEntry[]>([]);
  const [unusualAccess, setUnusualAccess] = useState<UnusualAccessEntry[]>([]);
  const [occupancyTimeSeries, setOccupancyTimeSeries] = useState<OccupancyTimeSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolveLoading, setResolveLoading] = useState<string | null>(null);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [statsData, eventsData, occData, tailData, unusualData] =
        await Promise.all([
          apiFetch<BehavioralStats>("/api/behavioral/stats"),
          apiFetch<BehavioralEvent[]>("/api/behavioral/events"),
          apiFetch<OccupancyZone[]>("/api/behavioral/occupancy"),
          apiFetch<TailgatingEntry[]>("/api/behavioral/tailgating"),
          apiFetch<UnusualAccessEntry[]>("/api/behavioral/unusual-access"),
        ]);
      setStats(statsData);
      setEvents(eventsData);
      setOccupancy(occData);
      setTailgating(tailData);
      setUnusualAccess(unusualData);

      // Fetch time series data for occupancy chart
      if (Array.isArray(occData) && occData.length > 0) {
        apiFetch<OccupancyTimeSeries[]>("/api/behavioral/occupancy?format=timeseries")
          .then(setOccupancyTimeSeries)
          .catch(() => {});
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleResolve = async (eventId: string) => {
    setResolveLoading(eventId);
    try {
      await apiFetch(`/api/behavioral/events/${eventId}/resolve`, {
        method: "POST",
      });
      setEvents((prev) =>
        prev.map((e) =>
          e.id === eventId ? { ...e, resolved: true } : e
        )
      );
      apiFetch<BehavioralStats>("/api/behavioral/stats")
        .then(setStats)
        .catch(() => {});
    } catch {
    } finally {
      setResolveLoading(null);
    }
  };

  // Get unique zone names for chart lines
  const zoneNames = occupancy.map((z) => z.zone_name);
  const chartColors = [
    "#22d3ee",
    "#a78bfa",
    "#f97316",
    "#22c55e",
    "#ef4444",
    "#eab308",
    "#ec4899",
    "#6366f1",
  ];

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[#030712]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-10 w-10 animate-spin text-cyan-400" />
          <p className="text-sm text-gray-500">Loading behavioral analytics...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#030712]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-900/30 border border-indigo-800/50">
            <Activity className="h-5 w-5 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Behavioral Analytics
            </h1>
            <p className="text-xs text-gray-500">
              Loitering, tailgating, occupancy, and anomaly detection
            </p>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 border-b border-gray-800 px-6 py-3">
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 p-3">
            <Footprints className="h-5 w-5 text-yellow-400" />
            <div>
              <p className="text-lg font-bold text-gray-100">
                {stats.loitering_today}
              </p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                Loitering Today
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 p-3">
            <Users className="h-5 w-5 text-orange-400" />
            <div>
              <p className="text-lg font-bold text-gray-100">
                {stats.tailgating_alerts}
              </p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                Tailgating Alerts
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-red-900/50 bg-red-950/20 p-3">
            <PersonStanding className="h-5 w-5 text-red-500" />
            <div>
              <p className="text-lg font-bold text-red-400">
                {stats.occupancy_violations}
              </p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                Occupancy Violations
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 p-3">
            <AlertTriangle className="h-5 w-5 text-cyan-400" />
            <div>
              <p className="text-lg font-bold text-gray-100">
                {stats.unresolved_events}
              </p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                Unresolved Events
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {/* Row 1: Occupancy Map + Events Feed */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Occupancy Map */}
          <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-gray-200">
              <MapPin className="h-4 w-4 text-cyan-400" />
              Zone Occupancy
            </h3>
            {occupancy.length === 0 ? (
              <p className="text-xs text-gray-600 py-8 text-center">
                No occupancy data available
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {occupancy.map((zone) => (
                  <OccupancyCard key={zone.zone_id} zone={zone} />
                ))}
              </div>
            )}
          </div>

          {/* Events Feed */}
          <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-gray-200">
              <Activity className="h-4 w-4 text-orange-400" />
              Behavioral Events
            </h3>
            <div className="max-h-[380px] overflow-y-auto space-y-2 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
              {events.length === 0 ? (
                <p className="text-xs text-gray-600 py-8 text-center">
                  No events detected
                </p>
              ) : (
                events.map((event) => {
                  const hasExplain = !!(event.reason || event.explanation || event.confidence !== undefined);
                  const isExpanded = expandedEventId === event.id;
                  return (
                  <div
                    key={event.id}
                    className={cn(
                      "rounded-lg border transition-colors",
                      event.resolved
                        ? "border-gray-800/50 bg-gray-900/30 opacity-60"
                        : "border-gray-800 bg-zinc-900/50"
                    )}
                  >
                    <div className="flex items-start gap-3 p-3">
                      {/* Type icon */}
                      <div
                        className={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                          event.severity === "critical"
                            ? "bg-red-900/30 text-red-400"
                            : event.severity === "high"
                            ? "bg-orange-900/30 text-orange-400"
                            : event.severity === "medium"
                            ? "bg-yellow-900/30 text-yellow-400"
                            : "bg-blue-900/30 text-blue-400"
                        )}
                      >
                        {EVENT_TYPE_ICONS[event.type] || (
                          <Activity className="h-4 w-4" />
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-semibold text-gray-200">
                            {EVENT_TYPE_LABELS[event.type] || event.type}
                          </span>
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-[9px] font-bold uppercase border",
                              SEVERITY_BADGE[event.severity] ||
                                "text-gray-400 bg-gray-800 border-gray-700"
                            )}
                          >
                            {event.severity}
                          </span>
                          {event.confidence !== undefined && (
                            <span
                              className={cn(
                                "rounded px-1.5 py-0.5 text-[9px] font-bold font-mono border",
                                event.confidence >= 0.8
                                  ? "text-green-400 bg-green-900/30 border-green-800/50"
                                  : event.confidence >= 0.5
                                  ? "text-amber-400 bg-amber-900/30 border-amber-800/50"
                                  : "text-red-400 bg-red-900/30 border-red-800/50"
                              )}
                            >
                              {(event.confidence * 100).toFixed(0)}% conf
                            </span>
                          )}
                          {event.resolved && (
                            <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                          )}
                        </div>
                        <p className="mt-0.5 text-[11px] text-gray-400 truncate">
                          {event.description}
                        </p>
                        <div className="mt-1 flex items-center gap-3 text-[10px] text-gray-500">
                          <span className="flex items-center gap-1">
                            <MapPin className="h-2.5 w-2.5" />
                            {event.zone}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-2.5 w-2.5" />
                            {timeAgo(event.timestamp)}
                          </span>
                          {/* Explain expand button */}
                          {hasExplain && (
                            <button
                              onClick={() => setExpandedEventId(isExpanded ? null : event.id)}
                              className="flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
                            >
                              <HelpCircle className="h-2.5 w-2.5" />
                              Why?
                              <ChevronDown className={cn("h-2.5 w-2.5 transition-transform", isExpanded && "rotate-180")} />
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Resolve button */}
                      {!event.resolved && (
                        <button
                          onClick={() => handleResolve(event.id)}
                          disabled={resolveLoading === event.id}
                          className="shrink-0 flex items-center gap-1 rounded-lg bg-green-900/30 border border-green-800/50 px-2.5 py-1 text-[10px] font-semibold text-green-400 hover:bg-green-800/40 disabled:opacity-50"
                        >
                          {resolveLoading === event.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-3 w-3" />
                          )}
                          Resolve
                        </button>
                      )}
                    </div>

                    {/* Explainability expanded section */}
                    {isExpanded && hasExplain && (
                      <div className="border-t border-indigo-900/30 bg-indigo-950/10 px-3 py-2.5 space-y-1.5">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-400 flex items-center gap-1">
                          <HelpCircle className="h-3 w-3" /> Alert Explanation
                        </p>
                        {(event.reason || event.explanation) && (
                          <p className="text-[11px] text-gray-300 leading-relaxed border-l-2 border-indigo-700 pl-2">
                            {event.reason || event.explanation}
                          </p>
                        )}
                        {event.confidence !== undefined && (
                          <p className="text-[10px] text-gray-500">
                            Model confidence: <span className={cn(
                              "font-mono font-bold",
                              event.confidence >= 0.8 ? "text-green-400" :
                              event.confidence >= 0.5 ? "text-amber-400" : "text-red-400"
                            )}>{(event.confidence * 100).toFixed(1)}%</span>
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Row 2: Crowd Flow Chart */}
        <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-gray-200">
            <TrendingUp className="h-4 w-4 text-cyan-400" />
            Occupancy Over Time
          </h3>
          {occupancyTimeSeries.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <p className="text-xs text-gray-600">
                No time series data available yet
              </p>
            </div>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={occupancyTimeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis
                    dataKey="timestamp"
                    stroke="#4b5563"
                    tick={{ fontSize: 10, fill: "#6b7280" }}
                    tickFormatter={(v) =>
                      new Date(v).toLocaleTimeString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })
                    }
                  />
                  <YAxis
                    stroke="#4b5563"
                    tick={{ fontSize: 10, fill: "#6b7280" }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#0a0a0a",
                      borderColor: "#374151",
                      borderRadius: 8,
                      fontSize: 11,
                      color: "#d1d5db",
                    }}
                    labelFormatter={(v) =>
                      new Date(v).toLocaleString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })
                    }
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 10, color: "#9ca3af" }}
                  />
                  {zoneNames.map((name, i) => (
                    <Line
                      key={name}
                      type="monotone"
                      dataKey={name}
                      stroke={chartColors[i % chartColors.length]}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Row 3: Tailgating + Unusual Access */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Tailgating Table */}
          <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-gray-200">
              <Users className="h-4 w-4 text-orange-400" />
              Tailgating Events
            </h3>
            {tailgating.length === 0 ? (
              <p className="text-xs text-gray-600 py-8 text-center">
                No tailgating events detected
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-800 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                      <th className="pb-2 pr-3">Door</th>
                      <th className="pb-2 pr-3">Time</th>
                      <th className="pb-2 pr-3">Count</th>
                      <th className="pb-2">User</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tailgating.map((entry) => (
                      <tr
                        key={entry.id}
                        className="border-b border-gray-800/30"
                      >
                        <td className="py-2 pr-3">
                          <span className="flex items-center gap-1 text-xs text-gray-300">
                            <DoorOpen className="h-3 w-3 text-gray-500" />
                            {entry.door}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-[11px] text-gray-500">
                          {timeAgo(entry.timestamp)}
                        </td>
                        <td className="py-2 pr-3">
                          <span
                            className={cn(
                              "text-xs font-bold font-mono",
                              entry.person_count > 2
                                ? "text-red-400"
                                : "text-yellow-400"
                            )}
                          >
                            {entry.person_count}
                          </span>
                        </td>
                        <td className="py-2 text-xs text-gray-400">
                          {entry.authorized_user}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Unusual Access Table */}
          <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-gray-200">
              <Shield className="h-4 w-4 text-red-400" />
              Unusual Access Patterns
            </h3>
            {unusualAccess.length === 0 ? (
              <p className="text-xs text-gray-600 py-8 text-center">
                No unusual access patterns detected
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-800 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                      <th className="pb-2 pr-3">User</th>
                      <th className="pb-2 pr-3">Door</th>
                      <th className="pb-2 pr-3">Time</th>
                      <th className="pb-2">Flag Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unusualAccess.map((entry) => (
                      <tr
                        key={entry.id}
                        className="border-b border-gray-800/30"
                      >
                        <td className="py-2 pr-3 text-xs text-gray-300 font-medium">
                          {entry.user}
                        </td>
                        <td className="py-2 pr-3">
                          <span className="flex items-center gap-1 text-xs text-gray-400">
                            <DoorOpen className="h-3 w-3 text-gray-500" />
                            {entry.door}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-[11px] text-gray-500">
                          {timeAgo(entry.timestamp)}
                        </td>
                        <td className="py-2">
                          <span className="flex items-center gap-1.5">
                            <span className="text-[11px] text-orange-300 truncate max-w-[160px]">
                              {entry.flag_reason}
                            </span>
                            <span
                              className={cn(
                                "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold font-mono",
                                entry.risk_score >= 0.8
                                  ? "text-red-400 bg-red-900/30"
                                  : entry.risk_score >= 0.5
                                  ? "text-yellow-400 bg-yellow-900/30"
                                  : "text-gray-400 bg-gray-800"
                              )}
                            >
                              {Math.round(entry.risk_score * 100)}
                            </span>
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
      </div>
    </div>
  );
}
