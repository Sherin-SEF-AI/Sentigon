"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import {
  DoorOpen,
  ShieldAlert,
  Loader2,
  AlertTriangle,
  Clock,
  Camera,
  Hash,
  User,
  Lock,
  Unlock,
  Search,
  Plus,
  CheckCircle2,
  XCircle,
  RefreshCw,
  ChevronDown,
  ShieldOff,
  Ban,
  UserCheck,
  UserX,
  Edit3,
  Trash2,
  X,
  BarChart2,
  Users,
  Moon,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";
import type { PACSEvent } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface DoorSummary {
  door_id: string;
  event_count: number;
}

interface PACSAnomaly extends PACSEvent {
  severity?: string;
}

interface DoorDetail {
  id: string;
  name: string;
  door_id: string;
  state: "locked" | "unlocked" | "held_open" | "forced" | "unknown";
  last_event_time: string | null;
  zone: string | null;
}

interface BadgeHolder {
  id: string;
  badge_number: string;
  first_name: string;
  last_name: string;
  department: string | null;
  access_level: string;
  is_active: boolean;
  photo_url: string | null;
  created_at: string;
}

interface CheckedInVisitor {
  id: string;
  zones: string[];
  status: string;
}

type TabKey = "events" | "anomalies" | "doors" | "badges" | "analytics";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const EVENT_TYPE_COLORS: Record<string, string> = {
  granted: "bg-green-900/40 text-green-400 border-green-800",
  denied: "bg-yellow-900/40 text-yellow-400 border-yellow-800",
  forced: "bg-red-900/40 text-red-400 border-red-800",
  held_open: "bg-orange-900/40 text-orange-400 border-orange-800",
  tailgating: "bg-red-900/40 text-red-400 border-red-800",
};

const SEVERITY_BADGE: Record<string, string> = {
  critical: "bg-red-900/40 text-red-400 border-red-800",
  high: "bg-orange-900/40 text-orange-400 border-orange-800",
  medium: "bg-yellow-900/40 text-yellow-400 border-yellow-800",
  low: "bg-blue-900/40 text-blue-400 border-blue-800",
};

const DOOR_STATE_STYLES: Record<string, { bg: string; text: string; border: string; icon: typeof Lock }> = {
  locked: { bg: "bg-emerald-900/30", text: "text-emerald-400", border: "border-emerald-800/50", icon: Lock },
  unlocked: { bg: "bg-yellow-900/30", text: "text-yellow-400", border: "border-yellow-800/50", icon: Unlock },
  held_open: { bg: "bg-orange-900/30", text: "text-orange-400", border: "border-orange-800/50", icon: DoorOpen },
  forced: { bg: "bg-red-900/30", text: "text-red-400", border: "border-red-800/50", icon: ShieldAlert },
  unknown: { bg: "bg-gray-800", text: "text-gray-500", border: "border-gray-700", icon: DoorOpen },
};

const TABS: { key: TabKey; label: string }[] = [
  { key: "events", label: "Access Log" },
  { key: "anomalies", label: "Anomalies" },
  { key: "doors", label: "Doors" },
  { key: "badges", label: "Badge Holders" },
  { key: "analytics", label: "Analytics" },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function isPassbackEvent(eventType: string): boolean {
  const lower = eventType.toLowerCase();
  return (
    lower.includes("tailgating") ||
    lower.includes("tailgate") ||
    lower.includes("passback") ||
    lower.includes("piggybacking")
  );
}

function isUnusualHour(timestamp: string): boolean {
  try {
    const h = new Date(timestamp).getHours();
    return h < 6 || h >= 20;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Badge Holder Form                                                  */
/* ------------------------------------------------------------------ */

function BadgeHolderForm({
  onCreated,
  onCancel,
  initial,
}: {
  onCreated: () => void;
  onCancel: () => void;
  initial?: BadgeHolder;
}) {
  const [badgeNumber, setBadgeNumber] = useState(initial?.badge_number || "");
  const [firstName, setFirstName] = useState(initial?.first_name || "");
  const [lastName, setLastName] = useState(initial?.last_name || "");
  const [department, setDepartment] = useState(initial?.department || "");
  const [accessLevel, setAccessLevel] = useState(initial?.access_level || "standard");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const endpoint = initial
        ? `/api/pacs/badge-holders/${initial.id}`
        : "/api/pacs/badge-holders";
      await apiFetch(endpoint, {
        method: initial ? "PUT" : "POST",
        body: JSON.stringify({
          badge_number: badgeNumber,
          first_name: firstName,
          last_name: lastName,
          department: department || null,
          access_level: accessLevel,
        }),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save badge holder");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-gray-800 bg-gray-900/60 p-4 space-y-4"
    >
      <h3 className="text-sm font-semibold text-gray-200">
        {initial ? "Edit Badge Holder" : "New Badge Holder"}
      </h3>
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-400">
            Badge Number
          </label>
          <input
            type="text"
            value={badgeNumber}
            onChange={(e) => setBadgeNumber(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            placeholder="B-001234"
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-400">
            First Name
          </label>
          <input
            type="text"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-400">
            Last Name
          </label>
          <input
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-400">
            Department
          </label>
          <input
            type="text"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            placeholder="Engineering"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-400">
            Access Level
          </label>
          <select
            value={accessLevel}
            onChange={(e) => setAccessLevel(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          >
            <option value="standard">Standard</option>
            <option value="elevated">Elevated</option>
            <option value="restricted">Restricted</option>
            <option value="executive">Executive</option>
            <option value="contractor">Contractor</option>
          </select>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={loading}
          className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:opacity-50"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {initial ? "Update" : "Add"} Badge Holder
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:bg-gray-800 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Analytics Tab                                                      */
/* ------------------------------------------------------------------ */

function AnalyticsTab({ events }: { events: PACSEvent[] }) {
  /* Events by hour (0-23) */
  const eventsByHour = useMemo(() => {
    const counts = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));
    events.forEach((e) => {
      if (e.timestamp) {
        try {
          const h = new Date(e.timestamp).getHours();
          counts[h].count++;
        } catch {
          /* skip malformed timestamps */
        }
      }
    });
    return counts;
  }, [events]);

  const maxHourCount = useMemo(
    () => Math.max(1, ...eventsByHour.map((h) => h.count)),
    [eventsByHour]
  );

  /* Top 5 most accessed doors */
  const top5Doors = useMemo(() => {
    const map: Record<string, number> = {};
    events.forEach((e) => {
      if (e.door_id) map[e.door_id] = (map[e.door_id] || 0) + 1;
    });
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [events]);

  const maxDoorCount = useMemo(
    () => Math.max(1, ...top5Doors.map(([, c]) => c)),
    [top5Doors]
  );

  /* Unusual-hour events (before 06:00 or after 20:00) */
  const unusualEvents = useMemo(
    () => events.filter((e) => e.timestamp && isUnusualHour(e.timestamp)),
    [events]
  );

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <BarChart2 className="mb-2 h-10 w-10 text-gray-700" />
        <p className="text-sm text-gray-500">No access events to analyse yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Events by Hour */}
      <section>
        <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-300">
          <Clock className="h-4 w-4 text-cyan-400" />
          Access Events by Hour
        </h3>
        <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4 space-y-1.5">
          {eventsByHour.map(({ hour, count }) => {
            const pct = (count / maxHourCount) * 100;
            const unusual = hour < 6 || hour >= 20;
            return (
              <div key={hour} className="flex items-center gap-3">
                <span className="w-12 shrink-0 text-right text-[11px] font-mono text-gray-500">
                  {String(hour).padStart(2, "0")}:00
                </span>
                <div className="relative flex-1 h-5 rounded overflow-hidden bg-gray-800/60">
                  <div
                    className={cn(
                      "h-full rounded transition-all duration-300",
                      unusual ? "bg-orange-700/70" : "bg-cyan-700/70"
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span
                  className={cn(
                    "w-8 shrink-0 text-right text-[11px] font-mono",
                    unusual ? "text-orange-400" : "text-gray-400"
                  )}
                >
                  {count}
                </span>
                {unusual && count > 0 && (
                  <span title="Outside business hours"><Moon className="h-3 w-3 shrink-0 text-orange-400" /></span>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-gray-600">
          Orange bars indicate off-hours access (before 06:00 or after 20:00).
        </p>
      </section>

      {/* Top 5 Doors */}
      <section>
        <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-300">
          <DoorOpen className="h-4 w-4 text-cyan-400" />
          Top 5 Most Accessed Doors
        </h3>
        {top5Doors.length === 0 ? (
          <p className="text-xs text-gray-600">No door data.</p>
        ) : (
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4 space-y-3">
            {top5Doors.map(([doorId, count], idx) => {
              const pct = (count / maxDoorCount) * 100;
              return (
                <div key={doorId} className="flex items-center gap-3">
                  <span className="w-5 shrink-0 text-center text-[11px] font-bold text-gray-600">
                    #{idx + 1}
                  </span>
                  <span className="w-32 shrink-0 truncate font-mono text-xs text-gray-300">
                    {doorId}
                  </span>
                  <div className="relative flex-1 h-5 rounded overflow-hidden bg-gray-800/60">
                    <div
                      className="h-full rounded bg-cyan-700/70 transition-all duration-300"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-10 shrink-0 text-right text-[11px] font-mono text-gray-400">
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Unusual Access Time Highlights */}
      <section>
        <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-300">
          <AlertTriangle className="h-4 w-4 text-orange-400" />
          Off-Hours Access Events
          <span className="ml-1 rounded-full bg-orange-900/40 border border-orange-800 px-2 py-0.5 text-[10px] font-bold text-orange-400">
            {unusualEvents.length}
          </span>
        </h3>
        {unusualEvents.length === 0 ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-6 text-center text-xs text-gray-600">
            No access events outside business hours (06:00–20:00).
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-orange-900/30 bg-orange-950/10">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/60">
                  <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">User</th>
                  <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Door</th>
                  <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Event</th>
                  <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {unusualEvents.slice(0, 50).map((ev) => (
                  <tr key={ev.id} className="hover:bg-orange-900/10 transition-colors">
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-300">{ev.user_identifier || "---"}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-300">{ev.door_id || "---"}</td>
                    <td className="px-4 py-2.5">
                      <span className={cn("inline-flex rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border", EVENT_TYPE_COLORS[ev.event_type] || "bg-gray-800 text-gray-400 border-gray-700")}>
                        {ev.event_type}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-orange-400 font-mono">
                      {ev.timestamp ? formatTimestamp(ev.timestamp) : "---"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function PACSPage() {
  const [events, setEvents] = useState<PACSEvent[]>([]);
  const [doors, setDoors] = useState<DoorSummary[]>([]);
  const [doorDetails, setDoorDetails] = useState<DoorDetail[]>([]);
  const [anomalies, setAnomalies] = useState<PACSAnomaly[]>([]);
  const [badgeHolders, setBadgeHolders] = useState<BadgeHolder[]>([]);
  const [checkedInVisitors, setCheckedInVisitors] = useState<CheckedInVisitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("events");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showBadgeForm, setShowBadgeForm] = useState(false);
  const [editingBadge, setEditingBadge] = useState<BadgeHolder | null>(null);
  const [badgeSearch, setBadgeSearch] = useState("");
  const [eventFilter, setEventFilter] = useState("all");
  const [doorFilter, setDoorFilter] = useState("");
  const [lockdownLoading, setLockdownLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const showToast = useCallback(
    (message: string, type: "success" | "error") => {
      setToast({ message, type });
      setTimeout(() => setToast(null), 4000);
    },
    []
  );

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [eventsData, doorsData, anomaliesData, doorDetailsData, badgeData, visitorsData] =
        await Promise.allSettled([
          apiFetch<PACSEvent[]>("/api/pacs/events"),
          apiFetch<DoorSummary[]>("/api/pacs/doors"),
          apiFetch<PACSAnomaly[]>("/api/pacs/anomalies"),
          apiFetch<DoorDetail[]>("/api/access-control/doors"),
          apiFetch<BadgeHolder[]>("/api/pacs/badge-holders"),
          apiFetch<CheckedInVisitor[]>("/api/visitors?status=checked_in"),
        ]);
      if (eventsData.status === "fulfilled") setEvents(eventsData.value);
      if (doorsData.status === "fulfilled") setDoors(doorsData.value);
      if (anomaliesData.status === "fulfilled") setAnomalies(anomaliesData.value);
      if (doorDetailsData.status === "fulfilled") setDoorDetails(doorDetailsData.value);
      if (badgeData.status === "fulfilled") setBadgeHolders(badgeData.value);
      // Gracefully handle 404 from visitors endpoint
      if (visitorsData.status === "fulfilled") setCheckedInVisitors(visitorsData.value);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch PACS data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleLockUnlock = async (doorId: string, action: "lock" | "unlock") => {
    setActionLoading(doorId);
    try {
      await apiFetch(`/api/access-control/doors/${doorId}/${action}`, { method: "POST" });
      showToast(
        `Door ${doorId} ${action === "lock" ? "locked" : "unlocked"} successfully.`,
        "success"
      );
      await fetchData();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : `Failed to ${action} door ${doorId}.`,
        "error"
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handleEmergencyLockdown = async () => {
    const confirmed = window.confirm(
      "WARNING: This will lock ALL doors facility-wide immediately.\n\nProceed with Emergency Lockdown?"
    );
    if (!confirmed) return;

    setLockdownLoading(true);
    try {
      const result = await apiFetch<{ doors_locked: number }>("/api/access-control/emergency-lockdown", {
        method: "POST",
      });
      showToast(
        `Emergency lockdown activated — ${result.doors_locked ?? 0} door(s) locked.`,
        "success"
      );
      await fetchData();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Emergency lockdown failed.",
        "error"
      );
    } finally {
      setLockdownLoading(false);
    }
  };

  /* ---- Stats ---- */
  const totalEvents = events.length;
  const grantedEvents = events.filter((e) => e.event_type === "granted").length;
  const deniedEvents = events.filter((e) => e.event_type === "denied").length;
  const uniqueDoors = useMemo(
    () => new Set(events.map((e) => e.door_id)).size,
    [events]
  );
  const anomalyCount = anomalies.length;
  const apbViolations = anomalies.filter(
    (a) => a.event_type === "tailgating" || a.severity === "high"
  ).length;

  /* ---- Anti-passback: count passback events per door ---- */
  const passbackByDoor = useMemo(() => {
    const map: Record<string, number> = {};
    events.forEach((e) => {
      if (isPassbackEvent(e.event_type) && e.door_id) {
        map[e.door_id] = (map[e.door_id] || 0) + 1;
      }
    });
    return map;
  }, [events]);

  /* ---- Visitor count per door zone ---- */
  const visitorsByZone = useMemo(() => {
    const map: Record<string, number> = {};
    checkedInVisitors.forEach((v) => {
      (v.zones || []).forEach((z) => {
        map[z] = (map[z] || 0) + 1;
      });
    });
    return map;
  }, [checkedInVisitors]);

  /* Filtered events */
  const filteredEvents = events.filter((e) => {
    if (eventFilter !== "all" && e.event_type !== eventFilter) return false;
    if (doorFilter && e.door_id !== doorFilter) return false;
    return true;
  });

  /* Filtered badge holders */
  const filteredBadges = badgeHolders.filter((b) => {
    if (!badgeSearch) return true;
    const search = badgeSearch.toLowerCase();
    return (
      b.first_name.toLowerCase().includes(search) ||
      b.last_name.toLowerCase().includes(search) ||
      b.badge_number.toLowerCase().includes(search) ||
      (b.department || "").toLowerCase().includes(search)
    );
  });

  /* ---- Render ---- */
  return (
    <div className="min-h-screen bg-gray-950 p-6">
      {/* Toast Notification */}
      {toast && (
        <div
          className={cn(
            "fixed bottom-6 right-6 z-50 flex items-center gap-3 rounded-lg border px-4 py-3 text-sm font-medium shadow-xl transition-all",
            toast.type === "success"
              ? "border-emerald-700 bg-emerald-900/80 text-emerald-300"
              : "border-red-700 bg-red-900/80 text-red-300"
          )}
        >
          {toast.type === "success" ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="h-4 w-4 shrink-0" />
          )}
          <span>{toast.message}</span>
          <button
            onClick={() => setToast(null)}
            className="ml-2 rounded p-0.5 opacity-70 hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
            <DoorOpen className="h-5 w-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-cyan-400 tracking-wide">
              Physical Access Control
            </h1>
            <p className="text-xs text-gray-500">
              Monitor door events, anomalies, badge holders, and access patterns
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Emergency Lockdown */}
          <button
            onClick={handleEmergencyLockdown}
            disabled={lockdownLoading}
            className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-red-500 shadow-lg shadow-red-900/50 disabled:opacity-50"
          >
            {lockdownLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Ban className="h-4 w-4" />
            )}
            EMERGENCY LOCKDOWN
          </button>
          <button
            onClick={fetchData}
            className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            <Clock className="h-3.5 w-3.5" />
            Total Events
          </div>
          <p className="mt-2 text-2xl font-bold text-gray-100">
            {loading ? "--" : totalEvents}
          </p>
        </div>
        <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-400/80">
            <UserCheck className="h-3.5 w-3.5" />
            Granted
          </div>
          <p className="mt-2 text-2xl font-bold text-emerald-400">
            {loading ? "--" : grantedEvents}
          </p>
        </div>
        <div className="rounded-lg border border-yellow-900/40 bg-yellow-950/20 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-yellow-400/80">
            <UserX className="h-3.5 w-3.5" />
            Denied
          </div>
          <p className="mt-2 text-2xl font-bold text-yellow-400">
            {loading ? "--" : deniedEvents}
          </p>
        </div>
        <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            <DoorOpen className="h-3.5 w-3.5" />
            Unique Doors
          </div>
          <p className="mt-2 text-2xl font-bold text-gray-100">
            {loading ? "--" : uniqueDoors}
          </p>
        </div>
        <div className="rounded-lg border border-red-900/40 bg-red-950/20 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-red-400/80">
            <ShieldAlert className="h-3.5 w-3.5" />
            Anomalies
          </div>
          <p className={cn("mt-2 text-2xl font-bold", anomalyCount > 0 ? "text-red-400" : "text-gray-100")}>
            {loading ? "--" : anomalyCount}
          </p>
        </div>
        <div className="rounded-lg border border-orange-900/40 bg-orange-950/20 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-orange-400/80">
            <ShieldOff className="h-3.5 w-3.5" />
            APB Violations
          </div>
          <p className={cn("mt-2 text-2xl font-bold", apbViolations > 0 ? "text-orange-400" : "text-gray-100")}>
            {loading ? "--" : apbViolations}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-1 border-b border-gray-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px",
              tab === t.key
                ? "border-cyan-400 text-cyan-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          <p className="mt-3 text-sm text-gray-500">Loading PACS data...</p>
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

      {/* ---- Events Tab ---- */}
      {!loading && !error && tab === "events" && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <select
                value={eventFilter}
                onChange={(e) => setEventFilter(e.target.value)}
                className="appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none"
              >
                <option value="all">All Types</option>
                <option value="granted">Granted</option>
                <option value="denied">Denied</option>
                <option value="forced">Forced</option>
                <option value="held_open">Held Open</option>
                <option value="tailgating">Tailgating</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
            </div>
            <input
              type="text"
              value={doorFilter}
              onChange={(e) => setDoorFilter(e.target.value)}
              placeholder="Filter by door ID..."
              className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:border-cyan-700 focus:outline-none w-48"
            />
            <span className="text-xs text-gray-500 ml-auto">
              {filteredEvents.length} event{filteredEvents.length !== 1 && "s"}
            </span>
          </div>

          <div className="overflow-x-auto rounded-lg border border-gray-800 max-h-[60vh] overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-gray-800 bg-gray-900/80">
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    <div className="flex items-center gap-1.5"><User className="h-3 w-3" />User</div>
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    <div className="flex items-center gap-1.5"><DoorOpen className="h-3 w-3" />Door</div>
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Event Type
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    <div className="flex items-center gap-1.5"><Camera className="h-3 w-3" />Camera</div>
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    <div className="flex items-center gap-1.5"><Clock className="h-3 w-3" />Timestamp</div>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {filteredEvents.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-sm text-gray-600">
                      No events recorded
                    </td>
                  </tr>
                )}
                {filteredEvents.map((ev) => {
                  const unusual = ev.timestamp && isUnusualHour(ev.timestamp);
                  return (
                    <tr
                      key={ev.id}
                      className={cn(
                        "hover:bg-gray-900/60 transition-colors",
                        unusual ? "bg-orange-950/10" : ""
                      )}
                    >
                      <td className="px-4 py-3 font-mono text-xs text-gray-300">
                        {ev.user_identifier || "---"}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-300">
                        {ev.door_id || "---"}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-flex rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                            EVENT_TYPE_COLORS[ev.event_type] || "bg-gray-800 text-gray-400 border-gray-700"
                          )}
                        >
                          {ev.event_type}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">
                        {ev.camera_id || "---"}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <span className={unusual ? "text-orange-400 font-medium" : "text-gray-500"}>
                          {ev.timestamp ? formatTimestamp(ev.timestamp) : "---"}
                        </span>
                        {unusual && (
                          <span className="ml-2 rounded bg-orange-900/40 border border-orange-800 px-1.5 py-0.5 text-[9px] font-bold uppercase text-orange-400">
                            Off-Hours
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---- Anomalies Tab ---- */}
      {!loading && !error && tab === "anomalies" && (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-900/80">
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">User</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Door</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Event Type</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Severity</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Camera</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {anomalies.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-sm text-gray-600">
                    No anomalies detected
                  </td>
                </tr>
              )}
              {anomalies.map((a) => (
                <tr key={a.id} className="hover:bg-gray-900/60 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-gray-300">{a.user_identifier || "---"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-300">{a.door_id || "---"}</td>
                  <td className="px-4 py-3">
                    <span className={cn("inline-flex rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border", EVENT_TYPE_COLORS[a.event_type] || "bg-gray-800 text-gray-400 border-gray-700")}>
                      {a.event_type}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {a.severity ? (
                      <span className={cn("inline-flex rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border", SEVERITY_BADGE[a.severity] || "bg-gray-800 text-gray-400 border-gray-700")}>
                        {a.severity}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-600">---</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{a.camera_id || "---"}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{a.timestamp ? formatTimestamp(a.timestamp) : "---"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Doors Tab ---- */}
      {!loading && !error && tab === "doors" && (
        <div>
          {doorDetails.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {doorDetails.map((d) => {
                const doorStyle = DOOR_STATE_STYLES[d.state] || DOOR_STATE_STYLES.unknown;
                const DoorIcon = doorStyle.icon;
                const isActioning = actionLoading === d.id;
                const passbackCount = passbackByDoor[d.door_id] || passbackByDoor[d.id] || 0;
                const visitorCount = d.zone ? (visitorsByZone[d.zone] || 0) : 0;
                return (
                  <div
                    key={d.id}
                    className={cn(
                      "rounded-lg border bg-gray-900/60 p-5 transition-colors hover:border-cyan-800/50",
                      doorStyle.border
                    )}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <DoorIcon className={cn("h-4 w-4", doorStyle.text)} />
                        <span className="font-mono text-sm font-semibold text-gray-200">
                          {d.name || d.door_id}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {/* Anti-passback warning badge */}
                        {passbackCount > 0 && (
                          <span
                            title={`${passbackCount} tailgating/passback event(s)`}
                            className="flex items-center gap-1 rounded-full bg-red-900/40 border border-red-800 px-2 py-0.5 text-[10px] font-bold text-red-400"
                          >
                            <ShieldOff className="h-2.5 w-2.5" />
                            APB {passbackCount}
                          </span>
                        )}
                        <span className={cn(
                          "rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                          doorStyle.bg, doorStyle.text, doorStyle.border
                        )}>
                          {d.state}
                        </span>
                      </div>
                    </div>
                    {d.zone && (
                      <p className="text-xs text-gray-500 mb-2">Zone: <span className="text-gray-300">{d.zone}</span></p>
                    )}
                    {/* Visitor integration indicator */}
                    {visitorCount > 0 && (
                      <div className="mb-2 flex items-center gap-1.5">
                        <Users className="h-3 w-3 text-blue-400 shrink-0" />
                        <span className="text-xs text-blue-400 font-medium">
                          {visitorCount} active visitor{visitorCount !== 1 ? "s" : ""} in zone
                        </span>
                      </div>
                    )}
                    {d.last_event_time && (
                      <p className="text-xs text-gray-500 mb-3">
                        Last event: <span className="text-gray-300">{formatTimestamp(d.last_event_time)}</span>
                      </p>
                    )}
                    <div className="flex gap-2 pt-3 border-t border-gray-800/60">
                      <button
                        onClick={() => handleLockUnlock(d.id, "lock")}
                        disabled={isActioning || d.state === "locked"}
                        className="flex items-center gap-1.5 rounded-lg bg-emerald-900/30 border border-emerald-800/50 px-3 py-1.5 text-xs font-semibold text-emerald-400 hover:bg-emerald-900/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isActioning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Lock className="h-3 w-3" />}
                        Lock
                      </button>
                      <button
                        onClick={() => handleLockUnlock(d.id, "unlock")}
                        disabled={isActioning || d.state === "unlocked"}
                        className="flex items-center gap-1.5 rounded-lg bg-yellow-900/30 border border-yellow-800/50 px-3 py-1.5 text-xs font-semibold text-yellow-400 hover:bg-yellow-900/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isActioning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlock className="h-3 w-3" />}
                        Unlock
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : doors.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {doors.map((d) => {
                const passbackCount = passbackByDoor[d.door_id] || 0;
                return (
                  <div
                    key={d.door_id}
                    className="rounded-lg border border-gray-800 bg-gray-900/60 p-5 transition-colors hover:border-cyan-800/50"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <DoorOpen className="h-4 w-4 text-cyan-400" />
                        <span className="font-mono text-sm font-semibold text-gray-200">{d.door_id}</span>
                      </div>
                      {passbackCount > 0 && (
                        <span
                          title={`${passbackCount} tailgating/passback event(s)`}
                          className="flex items-center gap-1 rounded-full bg-red-900/40 border border-red-800 px-2 py-0.5 text-[10px] font-bold text-red-400"
                        >
                          <ShieldOff className="h-2.5 w-2.5" />
                          APB {passbackCount}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Hash className="h-3.5 w-3.5 text-gray-600" />
                      <span className="text-xs text-gray-500">Events:</span>
                      <span className="font-mono text-lg font-bold text-gray-100">{d.event_count}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-20">
              <DoorOpen className="mb-2 h-10 w-10 text-gray-700" />
              <p className="text-sm text-gray-500">No door data available</p>
            </div>
          )}
        </div>
      )}

      {/* ---- Badges Tab ---- */}
      {!loading && !error && tab === "badges" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-500" />
                <input
                  type="text"
                  value={badgeSearch}
                  onChange={(e) => setBadgeSearch(e.target.value)}
                  placeholder="Search badge holders..."
                  className="rounded-lg border border-gray-700 bg-gray-900 pl-9 pr-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:border-cyan-700 focus:outline-none w-64"
                />
              </div>
              <span className="text-xs text-gray-500">
                {filteredBadges.length} holder{filteredBadges.length !== 1 && "s"}
              </span>
            </div>
            <button
              onClick={() => {
                setEditingBadge(null);
                setShowBadgeForm(!showBadgeForm);
              }}
              className="flex items-center gap-2 rounded-lg bg-cyan-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500"
            >
              <Plus className="h-4 w-4" />
              Add Badge Holder
            </button>
          </div>

          {showBadgeForm && (
            <BadgeHolderForm
              initial={editingBadge || undefined}
              onCreated={() => {
                setShowBadgeForm(false);
                setEditingBadge(null);
                fetchData();
              }}
              onCancel={() => {
                setShowBadgeForm(false);
                setEditingBadge(null);
              }}
            />
          )}

          <div className="overflow-x-auto rounded-lg border border-gray-800">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/80">
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Badge #</th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Name</th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Department</th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Access Level</th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Status</th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {filteredBadges.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-sm text-gray-600">
                      No badge holders found
                    </td>
                  </tr>
                )}
                {filteredBadges.map((badge) => (
                  <tr key={badge.id} className="hover:bg-gray-900/60 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-gray-300">{badge.badge_number}</td>
                    <td className="px-4 py-3 text-xs text-gray-200">
                      {badge.first_name} {badge.last_name}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">{badge.department || "---"}</td>
                    <td className="px-4 py-3">
                      <span className="rounded bg-cyan-900/30 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-400 border border-cyan-800/50">
                        {badge.access_level}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {badge.is_active ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-400">
                          <CheckCircle2 className="h-3 w-3" /> Active
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-gray-500">
                          <XCircle className="h-3 w-3" /> Inactive
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => {
                          setEditingBadge(badge);
                          setShowBadgeForm(true);
                        }}
                        className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-800 hover:text-cyan-400"
                        title="Edit"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---- Analytics Tab ---- */}
      {!loading && !error && tab === "analytics" && (
        <AnalyticsTab events={events} />
      )}
    </div>
  );
}
