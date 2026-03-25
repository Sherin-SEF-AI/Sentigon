"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Car,
  Search,
  Loader2,
  AlertTriangle,
  Clock,
  Camera,
  Shield,
  Trash2,
  Plus,
  X,
  Eye,
  ListFilter,
  Timer,
  MapPin,
  BarChart3,
  Truck,
  TrendingUp,
  Gauge,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { cn, apiFetch, severityColor } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import TimelineView, { TimelineEvent } from "@/components/common/TimelineView";
import ViolationTable from "@/components/lpr/ViolationTable";
import LoadingDockDashboard from "@/components/lpr/LoadingDockDashboard";
import VehicleFlowChart from "@/components/lpr/VehicleFlowChart";
import VehicleProfileCard from "@/components/lpr/VehicleProfileCard";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface LprStats {
  total_plates: number;
  plates_last_24h: number;
  watchlist_entries: number;
  watchlist_hits: number;
  unique_vehicles: number;
  avg_confidence: number;
}

interface PlateDetection {
  id: string;
  plate_number: string;
  camera: string;
  vehicle_type: string;
  color: string;
  confidence: number;
  timestamp: string;
  watchlisted: boolean;
}

interface WatchlistEntry {
  id: string;
  plate_number: string;
  reason: string;
  severity: string;
  vehicle_description: string;
  created_at: string;
}

interface DwellRecord {
  id: string;
  plate_number: string;
  zone: string;
  first_seen: string;
  last_seen: string;
  dwell_seconds: number;
}

interface WatchlistFormData {
  plate_number: string;
  reason: string;
  severity: string;
  vehicle_description: string;
}

/** All plate detections for a specific plate (used by cross-camera timeline) */
interface PlateSighting {
  id: string;
  plate_number: string;
  camera: string;
  timestamp: string;
  confidence: number;
  vehicle_type?: string;
  color?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

type TabKey = "log" | "watchlist" | "dwell" | "violations" | "loading-docks" | "flow";

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: "log", label: "Plate Log", icon: <ListFilter className="h-4 w-4" /> },
  { key: "watchlist", label: "Watchlist", icon: <Shield className="h-4 w-4" /> },
  { key: "dwell", label: "Vehicle Dwell", icon: <Timer className="h-4 w-4" /> },
  { key: "violations", label: "Violations", icon: <AlertTriangle className="h-4 w-4" /> },
  { key: "loading-docks", label: "Loading Docks", icon: <Truck className="h-4 w-4" /> },
  { key: "flow", label: "Flow Analytics", icon: <TrendingUp className="h-4 w-4" /> },
];

const SEVERITY_OPTIONS = ["low", "medium", "high", "critical"] as const;

const EMPTY_FORM: WatchlistFormData = {
  plate_number: "",
  reason: "",
  severity: "medium",
  vehicle_description: "",
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

function formatDwell(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/* ------------------------------------------------------------------ */
/*  Stat Card                                                          */
/* ------------------------------------------------------------------ */

function StatCard({
  label,
  value,
  accent = "text-cyan-400",
}: {
  label: string;
  value: string | number;
  accent?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3 min-w-[120px]">
      <span className={cn("text-lg font-bold tabular-nums", accent)}>
        {value}
      </span>
      <span className="text-[11px] text-gray-500 whitespace-nowrap">{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  LPR Page                                                           */
/* ------------------------------------------------------------------ */

export default function LprPage() {
  const { addToast } = useToast();

  /* --- State --- */
  const [activeTab, setActiveTab] = useState<TabKey>("log");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");

  // Data
  const [stats, setStats] = useState<LprStats | null>(null);
  const [plates, setPlates] = useState<PlateDetection[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [dwellRecords, setDwellRecords] = useState<DwellRecord[]>([]);

  // Loading & error states
  const [loadingStats, setLoadingStats] = useState(true);
  const [loadingPlates, setLoadingPlates] = useState(true);
  const [loadingWatchlist, setLoadingWatchlist] = useState(true);
  const [loadingDwell, setLoadingDwell] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Vehicle profile modal
  const [profilePlate, setProfilePlate] = useState<string | null>(null);

  // Watchlist form
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<WatchlistFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Feature: Cross-camera tracking timeline
  const [selectedTimelinePlate, setSelectedTimelinePlate] = useState<string | null>(null);
  const [plateSightings, setPlateSightings] = useState<PlateSighting[]>([]);
  const [loadingSightings, setLoadingSightings] = useState(false);
  const [expandedPlateRow, setExpandedPlateRow] = useState<string | null>(null);

  // Feature: Parking duration alert threshold (minutes, default 120)
  const [dwellThresholdMinutes, setDwellThresholdMinutes] = useState(120);

  /* --- Fetch helpers --- */

  const fetchStats = useCallback(async () => {
    setLoadingStats(true);
    try {
      const data = await apiFetch<LprStats>("/api/lpr/stats");
      setStats(data);
    } catch {
      // Stats are non-critical; silently fail
    } finally {
      setLoadingStats(false);
    }
  }, []);

  const fetchPlates = useCallback(async () => {
    setLoadingPlates(true);
    setError(null);
    try {
      const path = searchQuery
        ? `/api/lpr/search?query=${encodeURIComponent(searchQuery)}`
        : "/api/lpr/plates?limit=50&watchlisted_only=false";
      const data = await apiFetch<PlateDetection[]>(path);
      setPlates(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch plates");
      setPlates([]);
    } finally {
      setLoadingPlates(false);
    }
  }, [searchQuery]);

  const fetchWatchlist = useCallback(async () => {
    setLoadingWatchlist(true);
    try {
      const data = await apiFetch<WatchlistEntry[]>("/api/lpr/watchlist");
      setWatchlist(data);
    } catch {
      setWatchlist([]);
    } finally {
      setLoadingWatchlist(false);
    }
  }, []);

  const fetchDwell = useCallback(async () => {
    setLoadingDwell(true);
    try {
      const data = await apiFetch<DwellRecord[]>("/api/lpr/dwell");
      setDwellRecords(data);
    } catch {
      setDwellRecords([]);
    } finally {
      setLoadingDwell(false);
    }
  }, []);

  /**
   * Feature: Cross-camera tracking — fetch all sightings for a given plate.
   * Uses /api/lpr/search?query=<plate> which returns PlateDetection[].
   * We cast these to PlateSighting for the timeline view.
   */
  const fetchPlateSightings = useCallback(async (plateNumber: string) => {
    setLoadingSightings(true);
    setPlateSightings([]);
    try {
      const data = await apiFetch<PlateSighting[]>(
        `/api/lpr/search?query=${encodeURIComponent(plateNumber)}&limit=200`
      );
      // Only keep entries matching this exact plate
      const filtered = data.filter(
        (d) => d.plate_number.toUpperCase() === plateNumber.toUpperCase()
      );
      setPlateSightings(filtered);
    } catch {
      addToast("error", `Could not fetch sightings for ${plateNumber}`);
      setPlateSightings([]);
    } finally {
      setLoadingSightings(false);
    }
  }, [addToast]);

  /* --- Initial data load --- */

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    fetchPlates();
  }, [fetchPlates]);

  useEffect(() => {
    if (activeTab === "watchlist") fetchWatchlist();
  }, [activeTab, fetchWatchlist]);

  useEffect(() => {
    if (activeTab === "dwell") fetchDwell();
  }, [activeTab, fetchDwell]);

  /* --- Derived: cross-camera timeline events for selected plate --- */

  const plateTimelineEvents = useMemo<TimelineEvent[]>(() => {
    return plateSightings.map((s) => ({
      id: s.id,
      timestamp: s.timestamp,
      title: s.camera,
      description: s.vehicle_type
        ? `${s.vehicle_type}${s.color ? " · " + s.color : ""}`
        : undefined,
      type: "camera",
      severity: "info" as const,
      metadata: {
        Confidence: `${Math.round((s.confidence ?? 0) * 100)}%`,
        ...(s.vehicle_type ? { Type: s.vehicle_type } : {}),
        ...(s.color ? { Color: s.color } : {}),
      },
    }));
  }, [plateSightings]);

  /**
   * Feature: Speed estimation — for the selected plate, compute transition
   * rates between consecutive camera sightings and return the fastest one.
   * Result is in "camera transitions per minute" since no GPS distance is known.
   */
  const speedEstimation = useMemo<string | null>(() => {
    if (plateSightings.length < 2) return null;
    const sorted = [...plateSightings].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    // Find the fastest transition (shortest gap between two different cameras)
    let fastestGapMs = Infinity;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].camera !== sorted[i - 1].camera) {
        const gap =
          new Date(sorted[i].timestamp).getTime() -
          new Date(sorted[i - 1].timestamp).getTime();
        if (gap > 0 && gap < fastestGapMs) fastestGapMs = gap;
      }
    }
    if (!isFinite(fastestGapMs)) return null;
    const transitionsPerMin = 60000 / fastestGapMs;
    return `~${transitionsPerMin.toFixed(2)} transition/min`;
  }, [plateSightings]);

  /* --- Callbacks for child components --- */

  const handlePlateClick = useCallback((plate: string) => {
    setProfilePlate(plate);
  }, []);

  const handleCloseProfile = useCallback(() => {
    setProfilePlate(null);
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchInput("");
    setSearchQuery("");
  }, []);

  /* --- Search handler --- */

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    setSearchQuery(searchInput.trim());
    if (activeTab !== "log") setActiveTab("log");
  }, [searchInput, activeTab]);

  /* --- Watchlist CRUD --- */

  const handleAddWatchlist = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiFetch<WatchlistEntry>("/api/lpr/watchlist", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      fetchWatchlist();
      fetchStats();
    } catch {
      // Error handled by apiFetch
    } finally {
      setSaving(false);
    }
  }, [form, fetchWatchlist, fetchStats]);

  const handleDeleteWatchlist = useCallback(async (id: string) => {
    if (!window.confirm("Remove this plate from the watchlist?")) return;
    setDeletingId(id);
    try {
      await apiFetch(`/api/lpr/watchlist/${id}`, { method: "DELETE" });
      setWatchlist((prev) => prev.filter((w) => w.id !== id));
      fetchStats();
    } catch {
      // silent
    } finally {
      setDeletingId(null);
    }
  }, [fetchStats]);

  /* --- Render --- */

  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
            <Car className="h-5 w-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              License Plate Recognition
            </h1>
            <p className="text-xs text-gray-500">
              Automated plate detection, watchlist matching &amp; vehicle tracking
            </p>
          </div>
        </div>

        {/* Search */}
        <form onSubmit={handleSearch} className="relative w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search plates..."
            className="w-full rounded-lg border border-gray-700 bg-gray-900 pl-10 pr-4 py-2 text-sm text-gray-300 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          />
          {searchInput && (
            <button
              type="button"
              onClick={handleClearSearch}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </form>
      </div>

      {/* ---- Stats Bar ---- */}
      <div className="flex items-center gap-3 overflow-x-auto border-b border-gray-800 px-6 py-3 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {loadingStats ? (
          <div className="flex items-center gap-2 py-3">
            <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
            <span className="text-xs text-gray-500">Loading stats...</span>
          </div>
        ) : stats ? (
          <>
            <StatCard
              label="Total Plates Logged"
              value={stats.total_plates.toLocaleString()}
            />
            <StatCard
              label="Plates (24h)"
              value={stats.plates_last_24h.toLocaleString()}
              accent="text-emerald-400"
            />
            <StatCard
              label="Watchlist Entries"
              value={stats.watchlist_entries}
              accent="text-amber-400"
            />
            <StatCard
              label="Watchlist Hits"
              value={stats.watchlist_hits}
              accent="text-red-400"
            />
            <StatCard
              label="Unique Vehicles"
              value={stats.unique_vehicles.toLocaleString()}
            />
            <StatCard
              label="Avg Confidence"
              value={`${Math.round(stats.avg_confidence * 100)}%`}
              accent="text-emerald-400"
            />
          </>
        ) : (
          <span className="py-3 text-xs text-gray-600">Stats unavailable</span>
        )}
      </div>

      {/* ---- Tabs ---- */}
      <div className="flex items-center gap-1 border-b border-gray-800 px-6">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors",
              activeTab === tab.key
                ? "border-cyan-500 text-cyan-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* ---- Tab Content ---- */}
      <div className="flex-1 overflow-y-auto px-6 py-4 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {/* ===== Plate Log Tab ===== */}
        {activeTab === "log" && (
          <>
            {loadingPlates && (
              <div className="flex flex-col items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
                <p className="mt-3 text-sm text-gray-500">Loading plates...</p>
              </div>
            )}

            {!loadingPlates && error && (
              <div className="flex flex-col items-center justify-center py-20">
                <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
                <p className="text-sm text-red-400">{error}</p>
                <button
                  onClick={fetchPlates}
                  className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
                >
                  Retry
                </button>
              </div>
            )}

            {!loadingPlates && !error && plates.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20">
                <Car className="mb-2 h-10 w-10 text-gray-700" />
                <p className="text-sm font-medium text-gray-400">
                  {searchQuery
                    ? `No plates matching "${searchQuery}"`
                    : "No plate detections yet"}
                </p>
                <p className="mt-1 text-xs text-gray-600">
                  {searchQuery
                    ? "Try a different search term"
                    : "Plates will appear as cameras detect them"}
                </p>
              </div>
            )}

            {!loadingPlates && !error && plates.length > 0 && (
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                      <th className="px-4 py-3">Plate Number</th>
                      <th className="px-4 py-3">Camera</th>
                      <th className="px-4 py-3">Vehicle Type</th>
                      <th className="px-4 py-3">Color</th>
                      <th className="px-4 py-3 text-center">Confidence</th>
                      <th className="px-4 py-3">Time</th>
                      <th className="px-4 py-3 text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plates.map((plate) => {
                      const isRowExpanded = expandedPlateRow === plate.id;

                      return (
                        <>
                          <tr
                            key={plate.id}
                            className={cn(
                              "border-b border-gray-800/50 transition-colors hover:bg-gray-800/30 cursor-pointer",
                              plate.watchlisted && "bg-red-950/10",
                              isRowExpanded && "bg-gray-800/20"
                            )}
                            onClick={() => {
                              if (isRowExpanded) {
                                setExpandedPlateRow(null);
                                setSelectedTimelinePlate(null);
                                setPlateSightings([]);
                              } else {
                                setExpandedPlateRow(plate.id);
                                setSelectedTimelinePlate(plate.plate_number);
                                fetchPlateSightings(plate.plate_number);
                              }
                            }}
                          >
                            {/* Plate Number */}
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                {isRowExpanded ? (
                                  <ChevronDown className="h-3 w-3 text-cyan-400 shrink-0" />
                                ) : (
                                  <ChevronRight className="h-3 w-3 text-gray-600 shrink-0" />
                                )}
                                <span className="inline-flex items-center gap-2 rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1 font-mono text-sm font-bold tracking-wider text-gray-100">
                                  {plate.plate_number}
                                </span>
                              </div>
                            </td>

                            {/* Camera */}
                            <td className="px-4 py-3">
                              <span className="flex items-center gap-1.5 text-gray-400">
                                <Camera className="h-3.5 w-3.5 text-gray-600" />
                                {plate.camera}
                              </span>
                            </td>

                            {/* Vehicle Type */}
                            <td className="px-4 py-3 capitalize text-gray-400">
                              {plate.vehicle_type}
                            </td>

                            {/* Color */}
                            <td className="px-4 py-3 capitalize text-gray-400">
                              {plate.color}
                            </td>

                            {/* Confidence */}
                            <td className="px-4 py-3 text-center">
                              <span
                                className={cn(
                                  "font-mono text-sm tabular-nums font-medium",
                                  plate.confidence >= 0.9
                                    ? "text-emerald-400"
                                    : plate.confidence >= 0.7
                                      ? "text-yellow-400"
                                      : "text-red-400"
                                )}
                              >
                                {Math.round(plate.confidence * 100)}%
                              </span>
                            </td>

                            {/* Time */}
                            <td className="px-4 py-3">
                              <span className="flex items-center gap-1.5 text-xs text-gray-500">
                                <Clock className="h-3 w-3" />
                                {timeAgo(plate.timestamp)}
                              </span>
                              <span className="mt-0.5 block text-[11px] text-gray-600">
                                {formatTimestamp(plate.timestamp)}
                              </span>
                            </td>

                            {/* Watchlisted badge */}
                            <td className="px-4 py-3 text-center">
                              {plate.watchlisted ? (
                                <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-400">
                                  <Shield className="h-3 w-3" />
                                  Watchlisted
                                </span>
                              ) : (
                                <span className="text-xs text-gray-600">---</span>
                              )}
                            </td>
                          </tr>

                          {/* Feature 1: Cross-camera timeline — inline expanded row */}
                          {isRowExpanded && (
                            <tr key={`${plate.id}-timeline`} className="border-b border-gray-800/50 bg-gray-900/80">
                              <td colSpan={7} className="px-6 py-4">
                                <div className="space-y-3">
                                  <div className="flex items-center justify-between">
                                    <h3 className="text-xs font-semibold text-cyan-400 flex items-center gap-2">
                                      <Camera className="h-3.5 w-3.5" />
                                      Cross-Camera Sightings for{" "}
                                      <span className="font-mono text-gray-100">{plate.plate_number}</span>
                                    </h3>
                                    {/* Feature 3: Speed estimation */}
                                    {!loadingSightings && speedEstimation && selectedTimelinePlate === plate.plate_number && (
                                      <span className="flex items-center gap-1.5 rounded-lg border border-cyan-700/40 bg-cyan-900/20 px-3 py-1 text-xs text-cyan-300">
                                        <Gauge className="h-3.5 w-3.5 text-cyan-400" />
                                        Est. speed: {speedEstimation}
                                      </span>
                                    )}
                                  </div>

                                  {loadingSightings ? (
                                    <div className="flex items-center gap-2 py-4">
                                      <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
                                      <span className="text-xs text-gray-500">Loading sightings...</span>
                                    </div>
                                  ) : (
                                    <TimelineView
                                      events={plateTimelineEvents}
                                      compact={false}
                                      maxVisible={10}
                                    />
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ===== Watchlist Tab ===== */}
        {activeTab === "watchlist" && (
          <>
            {/* Add button */}
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-300">
                Watchlisted Plates
              </h2>
              <button
                onClick={() => setShowForm(true)}
                className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cyan-500"
              >
                <Plus className="h-4 w-4" />
                Add to Watchlist
              </button>
            </div>

            {/* Add form modal */}
            {showForm && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                <form
                  onSubmit={handleAddWatchlist}
                  className="relative w-full max-w-lg rounded-xl border border-gray-800 bg-gray-900 p-6 shadow-2xl"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setShowForm(false);
                      setForm(EMPTY_FORM);
                    }}
                    className="absolute right-4 top-4 text-gray-500 hover:text-gray-300"
                  >
                    <X className="h-5 w-5" />
                  </button>

                  <h2 className="mb-5 text-lg font-semibold text-gray-100">
                    Add to Watchlist
                  </h2>

                  <div className="space-y-4">
                    {/* Plate number */}
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-400">
                        Plate Number
                      </label>
                      <input
                        required
                        value={form.plate_number}
                        onChange={(e) =>
                          setForm({ ...form, plate_number: e.target.value.toUpperCase() })
                        }
                        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm font-mono tracking-wider text-gray-100 placeholder-gray-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                        placeholder="e.g. ABC 1234"
                      />
                    </div>

                    {/* Reason */}
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-400">
                        Reason
                      </label>
                      <input
                        required
                        value={form.reason}
                        onChange={(e) => setForm({ ...form, reason: e.target.value })}
                        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                        placeholder="e.g. Stolen vehicle, Person of interest"
                      />
                    </div>

                    {/* Severity */}
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-400">
                        Severity
                      </label>
                      <select
                        value={form.severity}
                        onChange={(e) => setForm({ ...form, severity: e.target.value })}
                        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                      >
                        {SEVERITY_OPTIONS.map((sev) => (
                          <option key={sev} value={sev}>
                            {sev.charAt(0).toUpperCase() + sev.slice(1)}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Vehicle description */}
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-400">
                        Vehicle Description
                      </label>
                      <textarea
                        rows={2}
                        value={form.vehicle_description}
                        onChange={(e) =>
                          setForm({ ...form, vehicle_description: e.target.value })
                        }
                        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                        placeholder="e.g. White Toyota Camry, 2020 model"
                      />
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="mt-6 flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setShowForm(false);
                        setForm(EMPTY_FORM);
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
                      Add Plate
                    </button>
                  </div>
                </form>
              </div>
            )}

            {/* Watchlist content */}
            {loadingWatchlist && (
              <div className="flex flex-col items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
                <p className="mt-3 text-sm text-gray-500">Loading watchlist...</p>
              </div>
            )}

            {!loadingWatchlist && watchlist.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20">
                <Shield className="mb-2 h-10 w-10 text-gray-700" />
                <p className="text-sm font-medium text-gray-400">
                  No watchlisted plates
                </p>
                <p className="mt-1 text-xs text-gray-600">
                  Add plates to your watchlist to receive alerts on detection
                </p>
              </div>
            )}

            {!loadingWatchlist && watchlist.length > 0 && (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {watchlist.map((entry) => (
                  <div
                    key={entry.id}
                    className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 transition-shadow hover:shadow-lg hover:shadow-cyan-900/10"
                  >
                    {/* Top row: plate + severity */}
                    <div className="flex items-start justify-between mb-3">
                      <span className="inline-flex items-center rounded-md border border-gray-700 bg-gray-800 px-3 py-1.5 font-mono text-base font-bold tracking-wider text-gray-100">
                        {entry.plate_number}
                      </span>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                          severityColor(entry.severity)
                        )}
                      >
                        {entry.severity}
                      </span>
                    </div>

                    {/* Reason */}
                    <div className="mb-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                        Reason
                      </span>
                      <p className="mt-0.5 text-sm text-gray-300">{entry.reason}</p>
                    </div>

                    {/* Vehicle description */}
                    {entry.vehicle_description && (
                      <div className="mb-3">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                          Vehicle
                        </span>
                        <p className="mt-0.5 text-sm text-gray-400">
                          {entry.vehicle_description}
                        </p>
                      </div>
                    )}

                    {/* Footer: date + delete */}
                    <div className="flex items-center justify-between border-t border-gray-800 pt-3">
                      <span className="flex items-center gap-1 text-[11px] text-gray-600">
                        <Clock className="h-3 w-3" />
                        Added {timeAgo(entry.created_at)}
                      </span>
                      <button
                        onClick={() => handleDeleteWatchlist(entry.id)}
                        disabled={deletingId === entry.id}
                        className="flex items-center gap-1.5 rounded-md border border-gray-700 px-3 py-1.5 text-xs text-red-400 transition-colors hover:border-red-500/40 hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {deletingId === entry.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ===== Vehicle Dwell Tab ===== */}
        {activeTab === "dwell" && (
          <>
            {/* Feature 2: Threshold control */}
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
                <Timer className="h-4 w-4 text-amber-400" />
                Vehicle Dwell Tracking
              </h2>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500 whitespace-nowrap">
                  Extended Stay Threshold
                </label>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    value={dwellThresholdMinutes}
                    onChange={(e) =>
                      setDwellThresholdMinutes(Math.max(1, Number(e.target.value)))
                    }
                    className="w-20 rounded-lg border border-gray-700 bg-gray-900 px-2 py-1 text-sm text-gray-200 text-center font-mono focus:border-cyan-600 focus:outline-none"
                  />
                  <span className="text-xs text-gray-500">min</span>
                </div>
              </div>
            </div>

            {loadingDwell && (
              <div className="flex flex-col items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
                <p className="mt-3 text-sm text-gray-500">
                  Loading dwell records...
                </p>
              </div>
            )}

            {!loadingDwell && dwellRecords.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20">
                <Timer className="mb-2 h-10 w-10 text-gray-700" />
                <p className="text-sm font-medium text-gray-400">
                  No vehicles currently being tracked
                </p>
                <p className="mt-1 text-xs text-gray-600">
                  Vehicle dwell records will appear when cameras detect prolonged
                  presence
                </p>
              </div>
            )}

            {!loadingDwell && dwellRecords.length > 0 && (
              <div className="space-y-2">
                {dwellRecords.map((record) => {
                  const dwellMinutes = Math.floor(record.dwell_seconds / 60);
                  const isLong = dwellMinutes >= 30;
                  // Feature 2: use configurable threshold for Extended Stay
                  const isExtendedStay = dwellMinutes >= dwellThresholdMinutes;
                  const isVeryLong = dwellMinutes >= 60;

                  return (
                    <div
                      key={record.id}
                      className={cn(
                        "flex items-center gap-4 rounded-xl border bg-gray-900/50 px-5 py-4 transition-colors",
                        isExtendedStay
                          ? "border-red-800/50 bg-red-950/10"
                          : isLong
                            ? "border-amber-800/30"
                            : "border-gray-800"
                      )}
                    >
                      {/* Plate */}
                      <span className="inline-flex items-center rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1 font-mono text-sm font-bold tracking-wider text-gray-100">
                        {record.plate_number}
                      </span>

                      {/* Zone */}
                      <span className="flex items-center gap-1.5 text-sm text-gray-400">
                        <MapPin className="h-3.5 w-3.5 text-gray-600" />
                        {record.zone}
                      </span>

                      {/* First seen */}
                      <div className="flex flex-col text-xs">
                        <span className="text-gray-600">First Seen</span>
                        <span className="text-gray-400 tabular-nums">
                          {formatTimestamp(record.first_seen)}
                        </span>
                      </div>

                      {/* Last seen */}
                      <div className="flex flex-col text-xs">
                        <span className="text-gray-600">Last Seen</span>
                        <span className="text-gray-400 tabular-nums">
                          {formatTimestamp(record.last_seen)}
                        </span>
                      </div>

                      {/* Dwell duration + Extended Stay badge */}
                      <div className="ml-auto flex items-center gap-3">
                        {/* Feature 2: Extended Stay badge */}
                        {isExtendedStay && (
                          <span className="flex items-center gap-1 rounded-full border border-red-500/40 bg-red-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-400">
                            <AlertTriangle className="h-3 w-3" />
                            Extended Stay
                          </span>
                        )}
                        <Eye
                          className={cn(
                            "h-4 w-4",
                            isExtendedStay
                              ? "text-red-400"
                              : isLong
                                ? "text-amber-400"
                                : "text-gray-600"
                          )}
                        />
                        <span
                          className={cn(
                            "font-mono text-sm font-semibold tabular-nums",
                            isExtendedStay
                              ? "text-red-400"
                              : isLong
                                ? "text-amber-400"
                                : "text-emerald-400"
                          )}
                        >
                          {formatDwell(record.dwell_seconds)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ===== Violations Tab ===== */}
        {activeTab === "violations" && (
          <ViolationTable onPlateClick={handlePlateClick} />
        )}

        {/* ===== Loading Docks Tab ===== */}
        {activeTab === "loading-docks" && <LoadingDockDashboard />}

        {/* ===== Flow Analytics Tab ===== */}
        {activeTab === "flow" && <VehicleFlowChart />}
      </div>

      {/* ---- Vehicle Profile Modal ---- */}
      {profilePlate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={handleCloseProfile}
          />
          <div className="relative z-10 w-full max-w-2xl max-h-[85vh] overflow-y-auto">
            <VehicleProfileCard
              plateNumber={profilePlate}
              onClose={handleCloseProfile}
            />
          </div>
        </div>
      )}
    </div>
  );
}
