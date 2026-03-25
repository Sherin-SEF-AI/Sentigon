"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import {
  MapPin,
  Plus,
  Pencil,
  Trash2,
  X,
  Loader2,
  ShieldAlert,
  CheckCircle2,
  Camera,
  AlertTriangle,
  Clock,
  ShieldX,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import TimelineView, { type TimelineEvent } from "@/components/common/TimelineView";
import type { Zone } from "@/lib/types";

/* ---------- constants ---------- */

const ZONE_TYPES = ["restricted", "entry", "exit", "parking", "general"] as const;
type ZoneType = (typeof ZONE_TYPES)[number];

const ZONE_TYPE_COLORS: Record<ZoneType, { bg: string; text: string; border: string }> = {
  restricted: {
    bg: "bg-red-500/10",
    text: "text-red-400",
    border: "border-red-500/30",
  },
  entry: {
    bg: "bg-green-500/10",
    text: "text-green-400",
    border: "border-green-500/30",
  },
  exit: {
    bg: "bg-blue-500/10",
    text: "text-blue-400",
    border: "border-blue-500/30",
  },
  parking: {
    bg: "bg-purple-500/10",
    text: "text-purple-400",
    border: "border-purple-500/30",
  },
  general: {
    bg: "bg-gray-500/10",
    text: "text-gray-400",
    border: "border-gray-500/30",
  },
};

const CARD =
  "rounded-lg border border-gray-800 bg-gray-900/60 p-4 flex flex-col gap-3 transition-shadow hover:shadow-lg hover:shadow-cyan-900/10";

/* ---------- form state type ---------- */

interface ZoneFormData {
  name: string;
  description: string;
  zone_type: ZoneType;
  max_occupancy: number | null;
  alert_on_breach: boolean;
}

const EMPTY_FORM: ZoneFormData = {
  name: "",
  description: "",
  zone_type: "general",
  max_occupancy: null,
  alert_on_breach: false,
};

/* ---------- occupancy event placeholder ---------- */

interface OccupancyEvent {
  id: string;
  event_type: string;
  description: string | null;
  timestamp: string;
}

/* ---------- zone analytics ---------- */

interface ZoneAnalytics {
  avg_dwell_seconds?: number | null;
  avg_dwell_minutes?: number | null;
  [key: string]: unknown;
}

/* ---------- helpers ---------- */

function ZoneTypeBadge({ type }: { type: string }) {
  const t = (ZONE_TYPES.includes(type as ZoneType) ? type : "general") as ZoneType;
  const colors = ZONE_TYPE_COLORS[t];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize",
        colors.bg,
        colors.text,
        colors.border
      )}
    >
      {type}
    </span>
  );
}

/** Returns Tailwind bar color based on utilization percentage (heatmap). */
function occupancyBarColor(pct: number, isOver: boolean): string {
  if (isOver || pct > 90) return "bg-red-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-green-500";
}

function OccupancyBar({
  current,
  max,
  type,
}: {
  current: number;
  max: number | null;
  type: string;
}) {
  const pct = max && max > 0 ? Math.min((current / max) * 100, 100) : 0;
  const isOver = max != null && current > max;
  const barColor = occupancyBarColor(pct, isOver);
  // Pulse animation for >90% utilization
  const isCritical = isOver || pct > 90;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-400">Occupancy</span>
        <span className={cn("font-mono", isOver ? "text-red-400" : pct >= 70 ? "text-amber-400" : "text-gray-300")}>
          {current}
          {max != null ? `/${max}` : ""}
        </span>
      </div>
      {max != null && max > 0 && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-800">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              barColor,
              isCritical && "animate-pulse"
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex flex-1 items-center justify-center py-24">
      <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
    </div>
  );
}

/* ---------- main page ---------- */

export default function ZonesPage() {
  const { addToast } = useToast();
  const [zones, setZones] = useState<Zone[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  /* form state */
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ZoneFormData>(EMPTY_FORM);

  /* camera counts & type filter */
  const [cameras, setCameras] = useState<{ id: string; zone_id: string | null }[]>([]);
  const [filterType, setFilterType] = useState<ZoneType | "all">("all");

  /* selected zone detail */
  const [selectedZone, setSelectedZone] = useState<Zone | null>(null);
  const [zoneEvents, setZoneEvents] = useState<OccupancyEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);

  /* dwell analytics keyed by zone id */
  const [dwellMap, setDwellMap] = useState<Record<string, ZoneAnalytics>>({});

  /* breach history for selected zone */
  const [breachEvents, setBreachEvents] = useState<TimelineEvent[]>([]);
  const [loadingBreaches, setLoadingBreaches] = useState(false);

  /* ---------- fetch zones ---------------------------------------------------- */

  const fetchZones = useCallback(() => {
    setLoading(true);
    apiFetch<Zone[]>("/api/zones")
      .then(setZones)
      .catch(() => setZones([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchZones();
    apiFetch<{ id: string; zone_id: string | null }[]>("/api/cameras")
      .then(setCameras)
      .catch(() => setCameras([]));
  }, [fetchZones]);

  /* ---------- fetch dwell analytics for all zones --------------------------- */

  useEffect(() => {
    if (zones.length === 0) return;
    // Fire off analytics requests in parallel; silently ignore individual failures
    zones.forEach((zone) => {
      apiFetch<ZoneAnalytics>(`/api/zones/${zone.id}/analytics`)
        .then((data) => {
          setDwellMap((prev) => ({ ...prev, [zone.id]: data }));
        })
        .catch(() => {
          // Analytics endpoint may not exist for every zone — ignore silently
        });
    });
  }, [zones]);

  /* camera count per zone */
  const cameraCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const cam of cameras) {
      if (cam.zone_id) counts[cam.zone_id] = (counts[cam.zone_id] || 0) + 1;
    }
    return counts;
  }, [cameras]);

  /* filtered zones */
  const filteredZones = useMemo(() => {
    if (filterType === "all") return zones;
    return zones.filter((z) => z.zone_type === filterType);
  }, [zones, filterType]);

  /* ---------- zone events when selected -------------------------------------- */

  useEffect(() => {
    if (!selectedZone) {
      setZoneEvents([]);
      setBreachEvents([]);
      return;
    }
    setLoadingEvents(true);
    setLoadingBreaches(true);

    apiFetch<OccupancyEvent[]>(`/api/zones/${selectedZone.id}/events`)
      .then((evs) => {
        setZoneEvents(evs);

        // Filter to breach-related events and shape them as TimelineEvents
        const BREACH_KEYWORDS = ["breach", "capacity", "over_capacity", "overcapacity"];
        const breachEvs: TimelineEvent[] = evs
          .filter((ev) =>
            BREACH_KEYWORDS.some((kw) => ev.event_type.toLowerCase().includes(kw))
          )
          .map((ev) => ({
            id: ev.id,
            timestamp: ev.timestamp,
            title: ev.event_type.replace(/_/g, " "),
            description: ev.description ?? undefined,
            type: ev.event_type,
            severity: "high" as const,
          }));
        setBreachEvents(breachEvs);
      })
      .catch(() => {
        setZoneEvents([]);
        setBreachEvents([]);
      })
      .finally(() => {
        setLoadingEvents(false);
        setLoadingBreaches(false);
      });
  }, [selectedZone]);

  /* ---------- CRUD handlers -------------------------------------------------- */

  function openCreateForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  }

  function openEditForm(zone: Zone) {
    setEditingId(zone.id);
    setForm({
      name: zone.name,
      description: zone.description || "",
      zone_type: (ZONE_TYPES.includes(zone.zone_type as ZoneType)
        ? zone.zone_type
        : "general") as ZoneType,
      max_occupancy: zone.max_occupancy,
      alert_on_breach: zone.alert_on_breach,
    });
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        description: form.description || null,
        zone_type: form.zone_type,
        max_occupancy: form.max_occupancy,
        alert_on_breach: form.alert_on_breach,
      };
      if (editingId) {
        await apiFetch<Zone>(`/api/zones/${editingId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      } else {
        await apiFetch<Zone>("/api/zones", {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      setShowForm(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
      fetchZones();
    } catch {
      /* error already surfaced by apiFetch */
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this zone? This action cannot be undone.")) return;
    try {
      await apiFetch(`/api/zones/${id}`, { method: "DELETE" });
      if (selectedZone?.id === id) setSelectedZone(null);
      fetchZones();
      addToast("success", "Zone deleted successfully");
    } catch {
      addToast("error", "Failed to delete zone");
    }
  }

  /* ---------- render --------------------------------------------------------- */

  return (
    <div className="flex h-full flex-col overflow-auto bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <MapPin className="h-6 w-6 text-cyan-400" />
          <h1 className="text-xl font-bold tracking-tight">Zone Management</h1>
          <span className="text-xs text-gray-500 ml-2">
            {zones.length} zones · {zones.filter((z) => z.max_occupancy != null && z.current_occupancy >= z.max_occupancy).length > 0 && (
              <span className="text-red-400 font-semibold">
                {zones.filter((z) => z.max_occupancy != null && z.current_occupancy >= z.max_occupancy).length} over capacity
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as ZoneType | "all")}
            className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-300 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
          >
            <option value="all">All Types</option>
            {ZONE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
          <button
            onClick={openCreateForm}
            className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cyan-500"
          >
            <Plus className="h-4 w-4" />
            New Zone
          </button>
        </div>
      </header>

      {/* Form modal overlay */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <form
            onSubmit={handleSubmit}
            className="relative w-full max-w-lg rounded-xl border border-gray-800 bg-gray-900 p-6 shadow-2xl"
          >
            {/* close */}
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setEditingId(null);
              }}
              className="absolute right-4 top-4 text-gray-500 hover:text-gray-300"
            >
              <X className="h-5 w-5" />
            </button>

            <h2 className="mb-5 text-lg font-semibold">
              {editingId ? "Edit Zone" : "Create Zone"}
            </h2>

            <div className="space-y-4">
              {/* name */}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-400">
                  Name
                </label>
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  placeholder="e.g. Main Entrance"
                />
              </div>

              {/* description */}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-400">
                  Description
                </label>
                <textarea
                  rows={2}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  placeholder="Optional description"
                />
              </div>

              {/* zone_type */}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-400">
                  Zone Type
                </label>
                <select
                  value={form.zone_type}
                  onChange={(e) =>
                    setForm({ ...form, zone_type: e.target.value as ZoneType })
                  }
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                >
                  {ZONE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </option>
                  ))}
                </select>
              </div>

              {/* max_occupancy */}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-400">
                  Max Occupancy
                </label>
                <input
                  type="number"
                  min={0}
                  value={form.max_occupancy ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      max_occupancy: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  placeholder="Leave blank for unlimited"
                />
              </div>

              {/* alert_on_breach */}
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.alert_on_breach}
                  onChange={(e) =>
                    setForm({ ...form, alert_on_breach: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-gray-600 bg-gray-800 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-0"
                />
                <span className="text-sm text-gray-300">
                  Alert on occupancy breach
                </span>
              </label>
            </div>

            {/* actions */}
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setEditingId(null);
                }}
                className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 transition-colors hover:text-gray-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cyan-500 disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editingId ? "Update" : "Create"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Zone grid */}
        <div className="flex-1 overflow-auto p-6">
          {loading ? (
            <Spinner />
          ) : zones.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-gray-500">
              <MapPin className="mb-3 h-10 w-10" />
              <p className="text-sm">No zones configured yet.</p>
              <button
                onClick={openCreateForm}
                className="mt-3 text-sm text-cyan-400 hover:underline"
              >
                Create your first zone
              </button>
            </div>
          ) : filteredZones.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-gray-500">
              <MapPin className="mb-3 h-8 w-8" />
              <p className="text-sm">No zones match the selected filter.</p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredZones.map((zone) => {
                const isSelected = selectedZone?.id === zone.id;
                return (
                  <div
                    key={zone.id}
                    onClick={() => setSelectedZone(isSelected ? null : zone)}
                    className={cn(
                      CARD,
                      "cursor-pointer",
                      isSelected && "ring-1 ring-cyan-500/50 border-cyan-800"
                    )}
                  >
                    {/* over-capacity alert */}
                    {zone.max_occupancy != null && zone.current_occupancy >= zone.max_occupancy && zone.max_occupancy > 0 && (
                      <div className="flex items-center gap-1.5 rounded-md bg-red-500/15 border border-red-500/30 px-2 py-1 text-[10px] font-semibold text-red-400">
                        <AlertTriangle className="h-3 w-3" />
                        OVER CAPACITY
                      </div>
                    )}

                    {/* top row */}
                    <div className="flex items-start justify-between">
                      <ZoneTypeBadge type={zone.zone_type} />
                      <div className="flex items-center gap-2">
                        <span className="flex items-center gap-1 text-[10px] text-gray-500">
                          <Camera className="h-3 w-3" />
                          {cameraCounts[zone.id] || 0}
                        </span>
                        {zone.alert_on_breach && (
                          <ShieldAlert className="h-4 w-4 text-amber-400" />
                        )}
                      </div>
                    </div>

                    {/* name + description */}
                    <div>
                      <h3 className="text-sm font-semibold text-gray-100">
                        {zone.name}
                      </h3>
                      {zone.description && (
                        <p className="mt-0.5 text-xs text-gray-500 line-clamp-2">
                          {zone.description}
                        </p>
                      )}
                    </div>

                    {/* occupancy bar */}
                    <OccupancyBar
                      current={zone.current_occupancy}
                      max={zone.max_occupancy}
                      type={zone.zone_type}
                    />

                    {/* dwell time badge — only shown when analytics data is available */}
                    {(() => {
                      const analytics = dwellMap[zone.id];
                      if (!analytics) return null;
                      const dwell =
                        analytics.avg_dwell_minutes != null
                          ? analytics.avg_dwell_minutes
                          : analytics.avg_dwell_seconds != null
                          ? analytics.avg_dwell_seconds / 60
                          : null;
                      if (dwell == null) return null;
                      return (
                        <span className="inline-flex items-center gap-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium text-cyan-400">
                          <Clock className="h-2.5 w-2.5" />
                          Avg dwell: {Math.round(dwell)}m
                        </span>
                      );
                    })()}

                    {/* alert_on_breach indicator */}
                    <div className="flex items-center gap-1.5 text-xs text-gray-500">
                      {zone.alert_on_breach ? (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5 text-amber-400" />
                          <span>Breach alerts enabled</span>
                        </>
                      ) : (
                        <span>Breach alerts disabled</span>
                      )}
                    </div>

                    {/* actions */}
                    <div className="flex justify-end gap-2 border-t border-gray-800 pt-3">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditForm(zone);
                        }}
                        className="flex items-center gap-1.5 rounded-md border border-gray-700 px-3 py-1.5 text-xs text-gray-400 transition-colors hover:border-gray-600 hover:text-gray-200"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Edit
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(zone.id);
                        }}
                        className="flex items-center gap-1.5 rounded-md border border-gray-700 px-3 py-1.5 text-xs text-red-400 transition-colors hover:border-red-500/40 hover:bg-red-500/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Selected zone detail sidebar */}
        {selectedZone && (
          <aside className="w-80 shrink-0 overflow-auto border-l border-gray-800 bg-gray-900/40 xl:w-96">
            <div className="p-5">
              {/* header */}
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-200">
                  Zone Details
                </h2>
                <button
                  onClick={() => setSelectedZone(null)}
                  className="text-gray-500 hover:text-gray-300"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* zone info */}
              <div className="space-y-3 rounded-lg border border-gray-800 bg-gray-900/60 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-100">
                    {selectedZone.name}
                  </span>
                  <ZoneTypeBadge type={selectedZone.zone_type} />
                </div>
                {selectedZone.description && (
                  <p className="text-xs text-gray-400">
                    {selectedZone.description}
                  </p>
                )}
                <OccupancyBar
                  current={selectedZone.current_occupancy}
                  max={selectedZone.max_occupancy}
                  type={selectedZone.zone_type}
                />
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5">
                    {selectedZone.alert_on_breach ? (
                      <>
                        <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />
                        <span className="text-amber-400">Breach alerts on</span>
                      </>
                    ) : (
                      <span className="text-gray-500">Breach alerts off</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-gray-400">
                    <Camera className="h-3.5 w-3.5" />
                    <span>{cameraCounts[selectedZone.id] || 0} cameras</span>
                  </div>
                </div>
              </div>

              {/* occupancy history */}
              <h3 className="mb-3 mt-6 text-xs font-semibold uppercase tracking-wider text-gray-500">
                Recent Events in Zone
              </h3>
              {loadingEvents ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-cyan-400" />
                </div>
              ) : zoneEvents.length === 0 ? (
                <p className="py-6 text-center text-xs text-gray-600">
                  No recent events recorded.
                </p>
              ) : (
                <ul className="space-y-2">
                  {zoneEvents.map((ev) => (
                    <li
                      key={ev.id}
                      className="rounded-md border border-gray-800 bg-gray-900/60 px-3 py-2"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-gray-300 capitalize">
                          {ev.event_type.replace(/_/g, " ")}
                        </span>
                        <span className="text-[11px] text-gray-500">
                          {formatTimestamp(ev.timestamp)}
                        </span>
                      </div>
                      {ev.description && (
                        <p className="mt-1 text-[11px] text-gray-500 line-clamp-2">
                          {ev.description}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {/* breach history */}
              <h3 className="mb-3 mt-6 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500">
                <ShieldX className="h-3.5 w-3.5 text-red-400" />
                Breach History
              </h3>
              {loadingBreaches ? (
                <div className="flex justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-cyan-400" />
                </div>
              ) : (
                <TimelineView
                  events={breachEvents}
                  compact
                  maxVisible={10}
                />
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
