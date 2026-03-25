"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Users,
  MapPin,
  TriangleAlert,
  XCircle,
  Loader2,
  ShieldAlert,
  RefreshCw,
  X,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface Zone {
  id: string;
  name: string;
  zone_type: string;
  current_occupancy?: number;
  max_occupancy?: number | null;
}

type ZoneEvacStatus = "not_started" | "in_progress" | "cleared";

interface AssemblyPoint {
  id: string;
  name: string;
  location: string;
  expected: number;
  actual: number;
}

/* ------------------------------------------------------------------ */
/*  Static assembly points (configurable in production)                */
/* ------------------------------------------------------------------ */

const ASSEMBLY_POINTS: AssemblyPoint[] = [
  { id: "ap1", name: "Assembly Point A", location: "North Car Park", expected: 0, actual: 0 },
  { id: "ap2", name: "Assembly Point B", location: "East Plaza", expected: 0, actual: 0 },
  { id: "ap3", name: "Assembly Point C", location: "South Gate", expected: 0, actual: 0 },
  { id: "ap4", name: "Assembly Point D", location: "West Emergency Exit", expected: 0, actual: 0 },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function zoneTypeLabel(type: string): string {
  const map: Record<string, string> = {
    restricted: "Restricted",
    entry: "Entry",
    exit: "Exit",
    parking: "Parking",
    general: "General",
  };
  return map[type] || type;
}

/* ------------------------------------------------------------------ */
/*  Zone Status Card                                                    */
/* ------------------------------------------------------------------ */

interface ZoneCardProps {
  zone: Zone;
  status: ZoneEvacStatus;
  evacuationActive: boolean;
  onMarkCleared: (zoneId: string) => void;
}

function ZoneCard({ zone, status, evacuationActive, onMarkCleared }: ZoneCardProps) {
  const statusConfig = {
    not_started: {
      label: "Not Started",
      color: "text-gray-400",
      bg: "bg-gray-800/60",
      border: "border-gray-700",
      dot: "bg-gray-500",
      pulse: false,
    },
    in_progress: {
      label: "In Progress",
      color: "text-amber-400",
      bg: "bg-amber-900/20",
      border: "border-amber-700/60",
      dot: "bg-amber-400",
      pulse: true,
    },
    cleared: {
      label: "Cleared",
      color: "text-emerald-400",
      bg: "bg-emerald-900/20",
      border: "border-emerald-700/60",
      dot: "bg-emerald-400",
      pulse: false,
    },
  }[status];

  return (
    <div
      className={cn(
        "rounded-xl border p-4 flex flex-col gap-3 transition-all duration-300",
        statusConfig.bg,
        statusConfig.border
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-bold text-gray-100 text-sm truncate">{zone.name}</h3>
          <span className="text-[10px] uppercase tracking-wider text-gray-500">
            {zoneTypeLabel(zone.zone_type)}
          </span>
        </div>
        {status === "cleared" && (
          <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
        )}
      </div>

      {/* Occupancy */}
      <div className="flex items-center gap-1.5 text-sm">
        <Users className="h-4 w-4 text-gray-500" />
        <span className="text-gray-300 font-mono font-bold">
          {zone.current_occupancy ?? "—"}
        </span>
        {zone.max_occupancy && (
          <span className="text-gray-600 text-xs">/ {zone.max_occupancy}</span>
        )}
        <span className="text-gray-600 text-xs ml-1">occupants</span>
      </div>

      {/* Status indicator */}
      <div className="flex items-center gap-2">
        <span className={cn("h-2 w-2 rounded-full shrink-0", statusConfig.dot, statusConfig.pulse && "animate-pulse")} />
        <span className={cn("text-xs font-semibold", statusConfig.color)}>{statusConfig.label}</span>
      </div>

      {/* Mark cleared button */}
      {evacuationActive && status !== "cleared" && (
        <button
          onClick={() => onMarkCleared(zone.id)}
          className={cn(
            "w-full rounded-lg py-2 text-xs font-bold uppercase tracking-wider transition-all",
            status === "in_progress"
              ? "bg-emerald-700/40 border border-emerald-600/60 text-emerald-300 hover:bg-emerald-700/60"
              : "bg-gray-700/40 border border-gray-600/60 text-gray-400 hover:bg-gray-600/40 hover:text-gray-200"
          )}
        >
          Mark Cleared
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Confirmation Dialog                                                 */
/* ------------------------------------------------------------------ */

interface ConfirmDialogProps {
  zones: Zone[];
  onConfirm: (zoneIds: string[] | "all") => void;
  onCancel: () => void;
  loading: boolean;
}

function ConfirmDialog({ zones, onConfirm, onCancel, loading }: ConfirmDialogProps) {
  const [target, setTarget] = useState<"all" | "specific">("all");
  const [selectedZones, setSelectedZones] = useState<Set<string>>(new Set());

  const toggleZone = (id: string) => {
    setSelectedZones((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = () => {
    if (target === "all") {
      onConfirm("all");
    } else {
      onConfirm(Array.from(selectedZones));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-red-800/60 bg-gray-950 shadow-2xl shadow-red-900/20 p-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-red-900/40 border border-red-700/60">
            <TriangleAlert className="h-6 w-6 text-red-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-red-300">Confirm Evacuation</h2>
            <p className="text-xs text-gray-500">This action will alert all personnel</p>
          </div>
          <button onClick={onCancel} className="ml-auto text-gray-600 hover:text-gray-400">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Zone target */}
        <div className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">Evacuate</p>
          <div className="flex gap-3">
            <button
              onClick={() => setTarget("all")}
              className={cn(
                "flex-1 rounded-lg border py-2.5 text-sm font-bold transition-all",
                target === "all"
                  ? "border-red-700/80 bg-red-900/30 text-red-300"
                  : "border-gray-700 bg-gray-900 text-gray-500 hover:border-gray-600 hover:text-gray-300"
              )}
            >
              All Zones
            </button>
            <button
              onClick={() => setTarget("specific")}
              className={cn(
                "flex-1 rounded-lg border py-2.5 text-sm font-bold transition-all",
                target === "specific"
                  ? "border-amber-700/80 bg-amber-900/30 text-amber-300"
                  : "border-gray-700 bg-gray-900 text-gray-500 hover:border-gray-600 hover:text-gray-300"
              )}
            >
              Specific Zones
            </button>
          </div>
        </div>

        {/* Zone selector */}
        {target === "specific" && (
          <div className="mb-4 space-y-2 max-h-48 overflow-y-auto">
            {zones.map((zone) => (
              <label
                key={zone.id}
                className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900/60 p-3 cursor-pointer hover:border-gray-700 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selectedZones.has(zone.id)}
                  onChange={() => toggleZone(zone.id)}
                  className="h-4 w-4 accent-amber-500 rounded"
                />
                <div>
                  <p className="text-sm font-medium text-gray-200">{zone.name}</p>
                  <p className="text-[10px] text-gray-500">{zoneTypeLabel(zone.zone_type)}</p>
                </div>
                <span className="ml-auto text-xs text-gray-500 font-mono">
                  {zone.current_occupancy ?? 0} people
                </span>
              </label>
            ))}
          </div>
        )}

        {/* Warning text */}
        <div className="mb-5 rounded-lg border border-amber-800/50 bg-amber-900/10 px-4 py-3">
          <p className="text-xs text-amber-300 leading-relaxed">
            All assigned operators and security personnel will be notified immediately.
            Emergency systems will be activated.
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={loading}
            className="flex-1 rounded-xl border border-gray-700 bg-gray-900 py-3 text-sm font-bold text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading || (target === "specific" && selectedZones.size === 0)}
            className="flex-1 rounded-xl bg-red-600 py-3 text-sm font-bold text-white hover:bg-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <TriangleAlert className="h-4 w-4" />
            )}
            INITIATE NOW
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  EvacuationPage                                                      */
/* ------------------------------------------------------------------ */

export default function EvacuationPage() {
  const { addToast } = useToast();

  /* --- State --- */
  const [zones, setZones] = useState<Zone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [evacuationActive, setEvacuationActive] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [initiating, setInitiating] = useState(false);

  const [zoneStatuses, setZoneStatuses] = useState<Record<string, ZoneEvacStatus>>({});

  // Timer
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number | null>(null);

  // Assembly point headcounts (local state for demo)
  const [assemblyPoints, setAssemblyPoints] = useState<AssemblyPoint[]>(ASSEMBLY_POINTS);

  /* --- Fetch zones --- */
  const fetchZones = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<Zone[]>("/api/zones");
      setZones(data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load zones");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchZones();
  }, [fetchZones]);

  /* --- Fetch assembly points (API-first, fallback to static defaults) --- */
  useEffect(() => {
    apiFetch<{ assembly_points?: AssemblyPoint[] }>("/api/gis/floor-plans")
      .then((data) => {
        if (data?.assembly_points && data.assembly_points.length > 0) {
          setAssemblyPoints(data.assembly_points.map((ap) => ({ ...ap, actual: 0, expected: 0 })));
        }
        // If the API returns nothing useful, keep the ASSEMBLY_POINTS defaults already in state
      })
      .catch((err) => {
        console.warn("[evacuation] Failed to fetch assembly points, using defaults:", err);
      });
  }, []);

  /* --- Timer management --- */
  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current!) / 1000));
    }, 1000);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setElapsedSeconds(0);
    startTimeRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  /* --- Initiate evacuation --- */
  const handleInitiate = useCallback(
    async (target: string[] | "all") => {
      setInitiating(true);
      try {
        await apiFetch("/api/emergency/activate", {
          method: "POST",
          body: JSON.stringify({ code: "Evacuate", zones: target }),
        });

        // Set all zones to in_progress
        const initialStatuses: Record<string, ZoneEvacStatus> = {};
        const targetZones =
          target === "all" ? zones : zones.filter((z) => (target as string[]).includes(z.id));
        targetZones.forEach((z) => {
          initialStatuses[z.id] = "in_progress";
        });

        // Zones not in evacuation stay not_started
        zones.forEach((z) => {
          if (!initialStatuses[z.id]) initialStatuses[z.id] = "not_started";
        });

        setZoneStatuses(initialStatuses);
        setEvacuationActive(true);
        setShowConfirm(false);
        startTimer();

        // Set expected assembly headcounts based on total occupancy
        const totalOccupancy = targetZones.reduce((sum, z) => sum + (z.current_occupancy ?? 0), 0);
        setAssemblyPoints((prev) =>
          prev.map((ap, i) => ({
            ...ap,
            expected: Math.floor(totalOccupancy / prev.length) + (i < totalOccupancy % prev.length ? 1 : 0),
            actual: 0,
          }))
        );

        addToast("success", "Evacuation initiated. All zones now in emergency mode.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to initiate evacuation";
        addToast("error", `Evacuation failed: ${msg}`);
      } finally {
        setInitiating(false);
      }
    },
    [zones, startTimer, addToast]
  );

  /* --- Cancel evacuation --- */
  const handleCancel = useCallback(async () => {
    await apiFetch("/api/emergency/deactivate", { method: "POST" }).catch((err) => { console.warn("[evacuation] API call failed:", err); });
    setEvacuationActive(false);
    setZoneStatuses({});
    stopTimer();
    setAssemblyPoints(ASSEMBLY_POINTS.map((ap) => ({ ...ap, actual: 0, expected: 0 })));
    addToast("success", "Evacuation cancelled. Returning to normal operations.");
  }, [stopTimer, addToast]);

  /* --- Mark zone cleared --- */
  const handleMarkCleared = useCallback((zoneId: string) => {
    setZoneStatuses((prev) => ({ ...prev, [zoneId]: "cleared" }));
    addToast("success", `Zone marked as cleared.`);
  }, [addToast]);

  /* --- Assembly point headcount update --- */
  const updateActualCount = useCallback((apId: string, delta: number) => {
    setAssemblyPoints((prev) =>
      prev.map((ap) =>
        ap.id === apId
          ? { ...ap, actual: Math.max(0, ap.actual + delta) }
          : ap
      )
    );
  }, []);

  /* --- Derived stats --- */
  const activeZones = zones.filter((z) => zoneStatuses[z.id] === "in_progress");
  const clearedZones = zones.filter((z) => zoneStatuses[z.id] === "cleared");
  const remainingZones = activeZones.length;
  const totalEvacuated = assemblyPoints.reduce((s, ap) => s + ap.actual, 0);
  const totalOccupancy = zones.reduce((s, z) => s + (z.current_occupancy ?? 0), 0);
  const estimatedMinutes =
    remainingZones > 0 && elapsedSeconds > 0 && clearedZones.length > 0
      ? Math.ceil((elapsedSeconds / clearedZones.length) * remainingZones / 60)
      : null;

  /* --- Render --- */
  return (
    <div className="flex h-full flex-col bg-gray-950 overflow-hidden">
      {/* ---- Header ---- */}
      <div
        className={cn(
          "flex items-center justify-between border-b px-6 py-4 transition-all duration-500",
          evacuationActive
            ? "border-red-800/60 bg-red-950/20"
            : "border-gray-800 bg-gray-950"
        )}
      >
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-xl border transition-all",
              evacuationActive
                ? "bg-red-900/40 border-red-700/60"
                : "bg-amber-900/20 border-amber-800/40"
            )}
          >
            <ShieldAlert
              className={cn(
                "h-5 w-5 transition-all",
                evacuationActive ? "text-red-400 animate-pulse" : "text-amber-400"
              )}
            />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-wide text-gray-100">
              Evacuation Management
            </h1>
            <p className="text-xs text-gray-500">
              Emergency coordination for malls, hospitals, and public spaces
            </p>
          </div>
        </div>

        {/* Status indicator */}
        <div
          className={cn(
            "flex items-center gap-2 rounded-full border px-4 py-2",
            evacuationActive
              ? "border-red-700/60 bg-red-900/30"
              : "border-emerald-700/50 bg-emerald-900/20"
          )}
        >
          <span
            className={cn(
              "h-2.5 w-2.5 rounded-full",
              evacuationActive ? "bg-red-400 animate-pulse" : "bg-emerald-400"
            )}
          />
          <span
            className={cn(
              "text-sm font-bold tracking-wide",
              evacuationActive ? "text-red-300" : "text-emerald-300"
            )}
          >
            {evacuationActive ? "EVACUATION ACTIVE" : "Normal"}
          </span>
        </div>
      </div>

      {/* ---- Main content ---- */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        <div className="p-6 space-y-6">

          {/* ---- Evacuation Controls ---- */}
          <section className="flex flex-wrap items-center gap-4">
            {!evacuationActive ? (
              <button
                onClick={() => setShowConfirm(true)}
                className="flex items-center gap-3 rounded-2xl bg-red-600 px-8 py-5 text-lg font-black uppercase tracking-wider text-white shadow-lg shadow-red-900/40 hover:bg-red-500 hover:shadow-red-800/50 active:scale-95 transition-all duration-150 touch-manipulation"
              >
                <TriangleAlert className="h-7 w-7" />
                INITIATE EVACUATION
              </button>
            ) : (
              <button
                onClick={handleCancel}
                className="flex items-center gap-3 rounded-2xl border border-gray-600 bg-gray-800 px-8 py-5 text-lg font-black uppercase tracking-wider text-gray-200 shadow-lg hover:bg-gray-700 hover:text-white active:scale-95 transition-all duration-150 touch-manipulation"
              >
                <XCircle className="h-7 w-7" />
                CANCEL EVACUATION
              </button>
            )}

            <button
              onClick={fetchZones}
              disabled={loading}
              className="flex items-center gap-2 rounded-xl border border-gray-700 bg-gray-800 px-4 py-3 text-sm font-semibold text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              Refresh
            </button>

            {/* Timer */}
            {evacuationActive && (
              <div className="flex items-center gap-3 ml-auto rounded-2xl border border-red-800/60 bg-red-950/20 px-6 py-4">
                <Clock className="h-6 w-6 text-red-400" />
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-red-500">
                    Elapsed Time
                  </p>
                  <p className="text-3xl font-black font-mono text-red-300 tabular-nums leading-none">
                    {formatElapsed(elapsedSeconds)}
                  </p>
                </div>
              </div>
            )}
          </section>

          {/* ---- Stats Row (only when active) ---- */}
          {evacuationActive && (
            <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                {
                  label: "Total Evacuated",
                  value: totalEvacuated,
                  color: "text-emerald-400",
                  bg: "bg-emerald-900/10 border-emerald-800/30",
                },
                {
                  label: "Zones Cleared",
                  value: clearedZones.length,
                  color: "text-emerald-400",
                  bg: "bg-emerald-900/10 border-emerald-800/30",
                },
                {
                  label: "Zones Remaining",
                  value: remainingZones,
                  color: "text-amber-400",
                  bg: "bg-amber-900/10 border-amber-800/30",
                },
                {
                  label: "Est. Completion",
                  value: estimatedMinutes != null ? `~${estimatedMinutes}m` : "Calculating...",
                  color: "text-cyan-400",
                  bg: "bg-cyan-900/10 border-cyan-800/30",
                },
              ].map(({ label, value, color, bg }) => (
                <div key={label} className={cn("rounded-xl border p-4 text-center", bg)}>
                  <p className="text-xs text-gray-500 mb-1">{label}</p>
                  <p className={cn("text-2xl font-black tabular-nums", color)}>{value}</p>
                </div>
              ))}
            </section>
          )}

          {/* ---- Zone Status Grid ---- */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">
                Zone Status
              </h2>
              <span className="text-xs text-gray-600">{zones.length} zones total</span>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-8 w-8 animate-spin text-amber-400" />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-12">
                <AlertTriangle className="h-8 w-8 text-red-500 mb-2" />
                <p className="text-sm text-red-400">{error}</p>
                <button
                  onClick={fetchZones}
                  className="mt-3 text-xs text-gray-500 underline hover:text-gray-300"
                >
                  Retry
                </button>
              </div>
            ) : zones.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12">
                <MapPin className="h-8 w-8 text-gray-700 mb-2" />
                <p className="text-sm text-gray-500">No zones configured</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {zones.map((zone) => (
                  <ZoneCard
                    key={zone.id}
                    zone={zone}
                    status={evacuationActive ? (zoneStatuses[zone.id] ?? "not_started") : "not_started"}
                    evacuationActive={evacuationActive}
                    onMarkCleared={handleMarkCleared}
                  />
                ))}
              </div>
            )}
          </section>

          {/* ---- Assembly Points ---- */}
          {evacuationActive && (
            <section>
              <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-3">
                Assembly Points — Headcount
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {assemblyPoints.map((ap) => {
                  const pct = ap.expected > 0 ? Math.min(100, Math.round((ap.actual / ap.expected) * 100)) : 0;
                  return (
                    <div
                      key={ap.id}
                      className="rounded-xl border border-gray-700 bg-gray-900/60 p-4 flex flex-col gap-3"
                    >
                      <div>
                        <p className="font-bold text-gray-100 text-sm">{ap.name}</p>
                        <div className="flex items-center gap-1 text-[11px] text-gray-500">
                          <MapPin className="h-3 w-3" />
                          {ap.location}
                        </div>
                      </div>

                      {/* Progress bar */}
                      <div className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-500">Actual</span>
                          <span className="font-mono font-bold text-gray-200">
                            {ap.actual} / {ap.expected}
                          </span>
                        </div>
                        <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-full transition-all duration-300",
                              pct >= 100 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-500" : "bg-red-500"
                            )}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <p className="text-right text-[10px] text-gray-500">{pct}% accounted</p>
                      </div>

                      {/* +/- controls */}
                      <div className="flex items-center gap-2 justify-center">
                        <button
                          onClick={() => updateActualCount(ap.id, -1)}
                          className="h-9 w-9 rounded-lg border border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700 font-bold text-lg flex items-center justify-center transition-colors"
                        >
                          −
                        </button>
                        <span className="text-xl font-black text-gray-100 tabular-nums min-w-[2ch] text-center">
                          {ap.actual}
                        </span>
                        <button
                          onClick={() => updateActualCount(ap.id, 1)}
                          className="h-9 w-9 rounded-lg border border-amber-700/60 bg-amber-900/30 text-amber-300 hover:bg-amber-800/40 font-bold text-lg flex items-center justify-center transition-colors"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* ---- Not-active placeholder ---- */}
          {!evacuationActive && (
            <div className="rounded-2xl border border-gray-800 bg-gray-900/30 p-10 text-center">
              <CheckCircle2 className="h-12 w-12 text-emerald-700 mx-auto mb-3" />
              <p className="text-lg font-bold text-gray-400">No Active Evacuation</p>
              <p className="text-sm text-gray-600 mt-1">
                All zones are operating normally. Press INITIATE EVACUATION to begin an emergency procedure.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ---- Confirmation Dialog ---- */}
      {showConfirm && (
        <ConfirmDialog
          zones={zones}
          onConfirm={handleInitiate}
          onCancel={() => setShowConfirm(false)}
          loading={initiating}
        />
      )}
    </div>
  );
}
