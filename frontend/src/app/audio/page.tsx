"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Volume2,
  AlertTriangle,
  Camera,
  Clock,
  Loader2,
  ShieldAlert,
  Activity,
  BarChart3,
  Target,
  Siren,
  Waves,
  Eye,
  Timer,
  CheckCircle2,
  XCircle,
  Tag,
  Plus,
  X,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";
import MetricSparkline from "@/components/common/MetricSparkline";
import { useToast } from "@/components/common/Toaster";

const KEYWORDS_STORAGE_KEY = "sentinel_audio_keywords";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AudioStats {
  total_events: number;
  events_last_hour: number;
  active_alerts: number;
  classification_accuracy: number;
  false_positive_rate: number;
}

interface AudioCategory {
  category: string;
  count: number;
  percentage: number;
}

interface AudioEvent {
  id: string;
  classification: string;
  camera_id: string;
  camera_name: string;
  severity: string;
  description: string;
  correlated_visual_evidence: string | null;
  timestamp: string;
  duration_seconds: number;
  status: string;
  confidence: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const SEVERITY_FILTERS = [
  { value: "all", label: "All" },
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

const SEVERITY_COLORS: Record<string, string> = {
  critical: "text-red-500 bg-red-500/10 border-red-500/40",
  high: "text-orange-500 bg-orange-500/10 border-orange-500/40",
  medium: "text-yellow-500 bg-yellow-500/10 border-yellow-500/40",
  low: "text-blue-400 bg-blue-400/10 border-blue-400/40",
  info: "text-gray-400 bg-gray-400/10 border-gray-400/40",
};

const CATEGORY_COLORS: Record<string, string> = {
  glass_breaking: "text-red-400 bg-red-500/10 border-red-500/30",
  shouting_aggression: "text-orange-400 bg-orange-500/10 border-orange-500/30",
  gunshot: "text-red-500 bg-red-600/10 border-red-600/30",
  alarm_siren: "text-yellow-400 bg-yellow-500/10 border-yellow-500/30",
  vehicle_horn: "text-blue-400 bg-blue-500/10 border-blue-500/30",
  metal_impact: "text-gray-400 bg-gray-500/10 border-gray-500/30",
  explosion: "text-red-600 bg-red-700/10 border-red-700/30",
  dog_barking: "text-amber-400 bg-amber-500/10 border-amber-500/30",
  scream: "text-rose-400 bg-rose-500/10 border-rose-500/30",
  footsteps_running: "text-teal-400 bg-teal-500/10 border-teal-500/30",
};

const CATEGORY_ICONS: Record<string, string> = {
  glass_breaking: "Glass Break",
  shouting_aggression: "Shouting",
  gunshot: "Gunshot",
  alarm_siren: "Alarm/Siren",
  vehicle_horn: "Vehicle Horn",
  metal_impact: "Metal Impact",
  explosion: "Explosion",
  dog_barking: "Dog Barking",
  scream: "Scream",
  footsteps_running: "Running",
};

const STATUS_COLORS: Record<string, string> = {
  new: "text-red-400",
  acknowledged: "text-yellow-400",
  investigating: "text-blue-400",
  resolved: "text-green-400",
  dismissed: "text-gray-500",
};

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

function formatDuration(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] || "text-gray-400 bg-gray-500/10 border-gray-500/30";
}

function getCategoryLabel(category: string): string {
  return CATEGORY_ICONS[category] || category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function getSeverityColor(severity: string): string {
  return SEVERITY_COLORS[severity] || SEVERITY_COLORS.info;
}

/* ------------------------------------------------------------------ */
/*  Skeleton loaders                                                   */
/* ------------------------------------------------------------------ */

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded bg-gray-800/60",
        className
      )}
    />
  );
}

function StatCardSkeleton() {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 space-y-3">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-7 w-16" />
    </div>
  );
}

function EventCardSkeleton() {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 space-y-3">
      <div className="flex items-center gap-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-16" />
        <Skeleton className="ml-auto h-4 w-20" />
      </div>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stat Card component                                                */
/* ------------------------------------------------------------------ */

function StatCard({
  label,
  value,
  icon: Icon,
  accent = "text-orange-400",
  suffix,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  accent?: string;
  suffix?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className={cn("h-4 w-4", accent)} />
        <span className="text-xs font-medium uppercase tracking-wider text-gray-500">
          {label}
        </span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold text-gray-100">{value}</span>
        {suffix && (
          <span className="text-xs text-gray-500">{suffix}</span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Audio Event Card component                                         */
/* ------------------------------------------------------------------ */

function AudioEventCard({ event }: { event: AudioEvent }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 transition-all duration-200 hover:bg-gray-900/80 hover:border-gray-700">
      {/* Top row: classification, camera, severity, time */}
      <div className="flex items-center gap-3 mb-3">
        {/* Classification badge */}
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold",
            getCategoryColor(event.classification)
          )}
        >
          <Volume2 className="h-3 w-3" />
          {getCategoryLabel(event.classification)}
        </span>

        {/* Severity badge */}
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
            getSeverityColor(event.severity)
          )}
        >
          <ShieldAlert className="h-3 w-3" />
          {event.severity}
        </span>

        {/* Status */}
        <span
          className={cn(
            "rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-gray-800 border border-gray-700",
            STATUS_COLORS[event.status] || "text-gray-400"
          )}
        >
          {event.status}
        </span>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Camera */}
        <span className="hidden items-center gap-1 text-xs text-gray-500 md:flex">
          <Camera className="h-3 w-3" />
          {event.camera_name || event.camera_id}
        </span>

        {/* Duration */}
        <span className="flex items-center gap-1 text-xs text-gray-500">
          <Timer className="h-3 w-3" />
          {formatDuration(event.duration_seconds)}
        </span>

        {/* Time ago */}
        <span className="flex items-center gap-1 text-[11px] text-gray-500">
          <Clock className="h-3 w-3" />
          {timeAgo(event.timestamp)}
        </span>
      </div>

      {/* Description */}
      {event.description && (
        <p className="text-sm text-gray-400 leading-relaxed mb-2">
          {event.description}
        </p>
      )}

      {/* Correlated visual evidence */}
      {event.correlated_visual_evidence && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-900/30 bg-amber-950/20 px-3 py-2 mt-2">
          <Eye className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-400" />
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-500">
              Correlated Visual Evidence
            </span>
            <p className="text-xs text-amber-300/80 mt-0.5 leading-relaxed">
              {event.correlated_visual_evidence}
            </p>
          </div>
        </div>
      )}

      {/* Footer metadata */}
      <div className="flex items-center gap-4 mt-3 text-[10px] text-gray-600">
        <span>
          ID: <span className="font-mono text-gray-500">{event.id.slice(0, 8)}</span>
        </span>
        <span>
          Confidence:{" "}
          <span className="font-mono text-amber-400">
            {Math.round(event.confidence * 100)}%
          </span>
        </span>
        <span>
          Timestamp: <span className="text-gray-500">{formatTimestamp(event.timestamp)}</span>
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function AudioIntelligencePage() {
  const { addToast } = useToast();

  /* --- State --- */
  const [stats, setStats] = useState<AudioStats | null>(null);
  const [categories, setCategories] = useState<AudioCategory[]>([]);
  const [events, setEvents] = useState<AudioEvent[]>([]);

  const [statsLoading, setStatsLoading] = useState(true);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(true);

  const [statsError, setStatsError] = useState<string | null>(null);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const [severityFilter, setSeverityFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");

  // Keywords state
  const [keywords, setKeywords] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const stored = localStorage.getItem(KEYWORDS_STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [newKeyword, setNewKeyword] = useState("");

  /* --- Fetch stats --- */
  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const data = await apiFetch<AudioStats>("/api/audio/stats");
      setStats(data);
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : "Failed to fetch stats");
    } finally {
      setStatsLoading(false);
    }
  }, []);

  /* --- Fetch categories --- */
  const fetchCategories = useCallback(async () => {
    setCategoriesLoading(true);
    setCategoriesError(null);
    try {
      const data = await apiFetch<AudioCategory[]>("/api/audio/categories");
      setCategories(Array.isArray(data) ? data : []);
    } catch (err) {
      setCategoriesError(err instanceof Error ? err.message : "Failed to fetch categories");
    } finally {
      setCategoriesLoading(false);
    }
  }, []);

  /* --- Fetch events --- */
  const fetchEvents = useCallback(async () => {
    setEventsLoading(true);
    setEventsError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (severityFilter !== "all") params.set("severity", severityFilter);
      if (categoryFilter !== "all") params.set("category", categoryFilter);

      const data = await apiFetch<AudioEvent[]>(
        `/api/audio/events?${params.toString()}`
      );
      setEvents(Array.isArray(data) ? data : []);
    } catch (err) {
      setEventsError(err instanceof Error ? err.message : "Failed to fetch events");
    } finally {
      setEventsLoading(false);
    }
  }, [severityFilter, categoryFilter]);

  /* --- Initial load --- */
  useEffect(() => {
    fetchStats();
    fetchCategories();
  }, [fetchStats, fetchCategories]);

  /* --- Reload events when filters change --- */
  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  /* --- Auto-refresh stats every 30 seconds --- */
  useEffect(() => {
    const interval = setInterval(() => {
      fetchStats();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  /* --- Keyword handlers --- */
  const addKeyword = () => {
    const kw = newKeyword.trim().toLowerCase();
    if (!kw) return;
    if (keywords.includes(kw)) {
      addToast("error", `Keyword "${kw}" already exists`);
      return;
    }
    const updated = [...keywords, kw];
    setKeywords(updated);
    localStorage.setItem(KEYWORDS_STORAGE_KEY, JSON.stringify(updated));
    setNewKeyword("");
    addToast("success", `Keyword "${kw}" added`);
  };

  const removeKeyword = (kw: string) => {
    const updated = keywords.filter((k) => k !== kw);
    setKeywords(updated);
    localStorage.setItem(KEYWORDS_STORAGE_KEY, JSON.stringify(updated));
    addToast("success", `Keyword "${kw}" removed`);
  };

  /* --- Sparkline: group events by hour (last 24 hours) --- */
  const sparklineData: number[] = (() => {
    const now = Date.now();
    const buckets = new Array(24).fill(0);
    events.forEach((ev) => {
      const ageMs = now - new Date(ev.timestamp).getTime();
      const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
      if (ageHours >= 0 && ageHours < 24) {
        // slot 0 = most recent hour, slot 23 = 24h ago
        buckets[ageHours]++;
      }
    });
    // reverse so oldest is first (left-to-right on chart)
    return buckets.slice().reverse();
  })();

  /* --- Render --- */
  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ---- Header ---- */}
      <header className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-900/30 border border-orange-800/50">
            <Volume2 className="h-5 w-5 text-orange-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Audio Intelligence
            </h1>
            <p className="text-xs text-gray-500">
              Real-time audio classification, anomaly detection &amp; visual correlation
            </p>
          </div>
        </div>

        {/* Active alerts indicator */}
        {stats && stats.active_alerts > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-red-800/60 bg-red-900/20 px-3 py-1.5">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
            </span>
            <span className="text-sm font-semibold text-red-400">
              {stats.active_alerts} active alert{stats.active_alerts !== 1 ? "s" : ""}
            </span>
          </div>
        )}
      </header>

      {/* ---- Content ---- */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {/* ---- Stats Cards ---- */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <BarChart3 className="h-4 w-4 text-orange-400" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
              Overview
            </h2>
          </div>

          {statsLoading && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <StatCardSkeleton key={i} />
              ))}
            </div>
          )}

          {statsError && (
            <div className="flex items-center gap-2 rounded-xl border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400">
              <XCircle className="h-4 w-4 shrink-0" />
              {statsError}
              <button
                onClick={fetchStats}
                className="ml-auto rounded-lg border border-gray-700 px-3 py-1 text-xs text-gray-400 hover:bg-gray-800 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {stats && !statsLoading && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
              <StatCard
                label="Total Events"
                value={(stats.total_events ?? 0).toLocaleString()}
                icon={Activity}
                accent="text-orange-400"
              />
              <StatCard
                label="Last Hour"
                value={(stats.events_last_hour ?? 0).toLocaleString()}
                icon={Clock}
                accent="text-amber-400"
              />
              <StatCard
                label="Active Alerts"
                value={stats.active_alerts}
                icon={AlertTriangle}
                accent="text-red-400"
              />
              <StatCard
                label="Accuracy"
                value={`${((stats.classification_accuracy ?? 0) * 100).toFixed(1)}`}
                icon={Target}
                accent="text-green-400"
                suffix="%"
              />
              <StatCard
                label="False Positive Rate"
                value={`${((stats.false_positive_rate ?? 0) * 100).toFixed(1)}`}
                icon={ShieldAlert}
                accent="text-yellow-400"
                suffix="%"
              />
            </div>
          )}
        </section>

        {/* ---- Event Frequency Sparkline ---- */}
        {!eventsLoading && events.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Activity className="h-4 w-4 text-orange-400" />
              <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
                Event Frequency (Last 24h)
              </h2>
            </div>
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500">Hourly audio event count — oldest to newest</span>
                <span className="text-xs font-mono text-orange-400">{events.length} total events</span>
              </div>
              <MetricSparkline
                data={sparklineData}
                width={600}
                height={48}
                color="#f97316"
                fill={true}
                showValue={true}
                unit=" events"
                className="w-full"
              />
              <div className="flex justify-between text-[9px] text-gray-600 mt-1 px-0.5">
                <span>24h ago</span>
                <span>12h ago</span>
                <span>Now</span>
              </div>
            </div>
          </section>
        )}

        {/* ---- Keyword Spotting Config ---- */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Tag className="h-4 w-4 text-orange-400" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
              Alert Keywords
            </h2>
            <span className="ml-1 rounded-full bg-gray-800 px-2 py-0.5 text-[10px] font-mono text-gray-500">
              {keywords.length} configured
            </span>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 space-y-3">
            <p className="text-xs text-gray-500">
              Words/phrases that trigger priority alerts when detected in audio transcriptions. Stored locally.
            </p>
            {/* Add keyword input */}
            <div className="flex items-center gap-2">
              <input
                value={newKeyword}
                onChange={(e) => setNewKeyword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addKeyword(); }}
                placeholder="Enter keyword or phrase..."
                className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:border-orange-600 focus:outline-none"
              />
              <button
                onClick={addKeyword}
                disabled={!newKeyword.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-2 text-xs font-medium text-white hover:bg-orange-500 disabled:opacity-40 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" /> Add
              </button>
            </div>
            {/* Keyword chips */}
            {keywords.length === 0 ? (
              <p className="text-xs text-gray-600 text-center py-2">No keywords configured yet</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {keywords.map((kw) => (
                  <span
                    key={kw}
                    className="inline-flex items-center gap-1.5 rounded-full border border-orange-700/50 bg-orange-900/20 px-2.5 py-1 text-xs font-medium text-orange-300"
                  >
                    <Tag className="h-3 w-3 text-orange-500" />
                    {kw}
                    <button
                      onClick={() => removeKeyword(kw)}
                      className="text-orange-400 hover:text-red-400 transition-colors ml-0.5"
                      title={`Remove "${kw}"`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ---- Category Distribution ---- */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Waves className="h-4 w-4 text-orange-400" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
              Category Distribution
            </h2>
          </div>

          {categoriesLoading && (
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-5">
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-28" />
                ))}
              </div>
            </div>
          )}

          {categoriesError && (
            <div className="flex items-center gap-2 rounded-xl border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400">
              <XCircle className="h-4 w-4 shrink-0" />
              {categoriesError}
              <button
                onClick={fetchCategories}
                className="ml-auto rounded-lg border border-gray-700 px-3 py-1 text-xs text-gray-400 hover:bg-gray-800 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {!categoriesLoading && !categoriesError && categories.length > 0 && (
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-5">
              <div className="flex flex-wrap gap-2">
                {/* "All" category button */}
                <button
                  onClick={() => setCategoryFilter("all")}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors",
                    categoryFilter === "all"
                      ? "text-orange-400 bg-orange-500/10 border-orange-500/40"
                      : "text-gray-400 bg-gray-800/50 border-gray-700 hover:border-gray-600 hover:text-gray-300"
                  )}
                >
                  All Categories
                </button>

                {categories.map((cat) => (
                  <button
                    key={cat.category}
                    onClick={() =>
                      setCategoryFilter(
                        categoryFilter === cat.category ? "all" : cat.category
                      )
                    }
                    className={cn(
                      "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors",
                      categoryFilter === cat.category
                        ? getCategoryColor(cat.category)
                        : "text-gray-400 bg-gray-800/50 border-gray-700 hover:border-gray-600 hover:text-gray-300"
                    )}
                  >
                    <Volume2 className="h-3 w-3" />
                    {getCategoryLabel(cat.category)}
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[10px] font-bold",
                        categoryFilter === cat.category
                          ? "bg-white/10"
                          : "bg-gray-700/50 text-gray-500"
                      )}
                    >
                      {cat.count}
                    </span>
                  </button>
                ))}
              </div>

              {/* Category bar chart */}
              <div className="mt-4 space-y-2">
                {categories.map((cat) => (
                  <div key={cat.category} className="flex items-center gap-3">
                    <span className="w-28 truncate text-xs text-gray-500">
                      {getCategoryLabel(cat.category)}
                    </span>
                    <div className="flex-1 h-2 rounded-full bg-gray-800 overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all duration-500",
                          cat.category === "glass_breaking" || cat.category === "gunshot"
                            ? "bg-red-500"
                            : cat.category === "shouting_aggression"
                            ? "bg-orange-500"
                            : cat.category === "alarm_siren"
                            ? "bg-yellow-500"
                            : cat.category === "vehicle_horn"
                            ? "bg-blue-500"
                            : cat.category === "metal_impact"
                            ? "bg-gray-500"
                            : "bg-amber-500"
                        )}
                        style={{ width: `${Math.min(cat.percentage ?? 0, 100)}%` }}
                      />
                    </div>
                    <span className="w-12 text-right font-mono text-xs text-gray-500">
                      {(cat.percentage ?? 0).toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!categoriesLoading && !categoriesError && categories.length === 0 && (
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-8 text-center">
              <Waves className="mx-auto mb-2 h-8 w-8 text-gray-700" />
              <p className="text-sm text-gray-500">No audio categories recorded yet</p>
            </div>
          )}
        </section>

        {/* ---- Severity Filter ---- */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Siren className="h-4 w-4 text-orange-400" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
              Audio Events
            </h2>
            <span className="ml-2 rounded-full bg-gray-800 px-2 py-0.5 text-[10px] font-mono text-gray-500">
              {events.length} events
            </span>
          </div>

          {/* Filter buttons */}
          <div className="flex items-center gap-2 mb-4">
            {SEVERITY_FILTERS.map((filter) => (
              <button
                key={filter.value}
                onClick={() => setSeverityFilter(filter.value)}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all duration-200",
                  severityFilter === filter.value
                    ? filter.value === "all"
                      ? "text-orange-400 bg-orange-500/10 border-orange-500/40"
                      : getSeverityColor(filter.value)
                    : "text-gray-500 bg-gray-900 border-gray-700 hover:border-gray-600 hover:text-gray-400"
                )}
              >
                {filter.label}
              </button>
            ))}
          </div>

          {/* Events loading */}
          {eventsLoading && (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <EventCardSkeleton key={i} />
              ))}
            </div>
          )}

          {/* Events error */}
          {!eventsLoading && eventsError && (
            <div className="flex flex-col items-center justify-center py-16">
              <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
              <p className="text-sm text-red-400">{eventsError}</p>
              <button
                onClick={fetchEvents}
                className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {/* Events empty state */}
          {!eventsLoading && !eventsError && events.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16">
              <CheckCircle2 className="mb-2 h-10 w-10 text-emerald-700" />
              <p className="text-sm font-medium text-gray-400">No audio events found</p>
              <p className="mt-1 text-xs text-gray-600">
                {severityFilter !== "all" || categoryFilter !== "all"
                  ? "Try adjusting your filters"
                  : "No audio events have been detected yet"}
              </p>
            </div>
          )}

          {/* Events list */}
          {!eventsLoading && !eventsError && events.length > 0 && (
            <div className="space-y-3">
              {events.map((event) => (
                <AudioEventCard key={event.id} event={event} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
