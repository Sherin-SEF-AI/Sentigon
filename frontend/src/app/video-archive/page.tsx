"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Clapperboard,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Maximize,
  Bookmark,
  Microscope,
  Download,
  Clock,
  HardDrive,
  Camera,
  Film,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Flag,
  FileText,
  AlertTriangle,
  Eye,
  X,
  Search,
  Grid3X3,
  List,
  Gauge,
  Plus,
  BookmarkCheck,
  Calendar,
  CheckSquare,
  Square,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp, API_BASE } from "@/lib/utils";
import { exportCSV } from "@/lib/export";
import type {
  ArchiveRecording,
  RecordingListResponse,
  VideoBookmark,
  ForensicAnalysisResult,
  ArchiveStats,
  Severity,
} from "@/lib/types";

/* ── Helpers ──────────────────────────────────────────────── */

function formatDuration(s: number | null): string {
  if (!s) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

const TYPE_COLORS: Record<string, string> = {
  continuous: "text-blue-400 bg-blue-900/30 border-blue-700/50",
  event_triggered: "text-red-400 bg-red-900/30 border-red-700/50",
  manual: "text-amber-400 bg-amber-900/30 border-amber-700/50",
};

const TYPE_LABELS: Record<string, string> = {
  continuous: "Continuous",
  event_triggered: "Event",
  manual: "Manual",
};

const BM_COLORS: Record<string, string> = {
  marker: "bg-amber-400",
  annotation: "bg-cyan-400",
  evidence_flag: "bg-red-500",
};

const BM_FILTER_TABS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "marker", label: "Marker" },
  { key: "annotation", label: "Annotation" },
  { key: "evidence_flag", label: "Evidence" },
];

/* ── Sub-components ──────────────────────────────────────── */

function StatCard({ label, value, icon: Icon }: { label: string; value: string | number; icon: React.ElementType }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2">
      <Icon className="h-3.5 w-3.5 text-amber-400 shrink-0" />
      <div className="min-w-0">
        <p className="text-xs text-gray-500 truncate">{label}</p>
        <p className="text-sm font-bold text-gray-100 truncate">{value}</p>
      </div>
    </div>
  );
}

function RecordingCard({
  rec,
  isSelected,
  onSelect,
}: {
  rec: ArchiveRecording;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "w-full text-left rounded-lg border p-3 transition-all hover:border-amber-700/60",
        isSelected
          ? "border-amber-600/70 bg-amber-900/20"
          : "border-gray-800 bg-gray-900/40 hover:bg-gray-900/70"
      )}
    >
      {/* Thumbnail */}
      <div className="relative mb-2 aspect-video w-full overflow-hidden rounded-md bg-gray-800">
        <img
          src={`${API_BASE}/api/video-archive/thumbnail/${rec.id}?offset=1`}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
        {/* Duration badge */}
        <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-mono text-gray-200">
          {formatDuration(rec.duration_seconds)}
        </span>
        {/* Type badge */}
        <span className={cn(
          "absolute top-1 left-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold",
          TYPE_COLORS[rec.recording_type] || "text-gray-400 bg-gray-800 border-gray-700"
        )}>
          {TYPE_LABELS[rec.recording_type] || rec.recording_type}
        </span>
      </div>
      {/* Info */}
      <p className="text-xs font-semibold text-gray-200 truncate">
        {rec.camera_name || "Unknown Camera"}
      </p>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-500">
        <Clock className="h-3 w-3" />
        <span>{formatTimestamp(rec.start_time)}</span>
        {rec.bookmark_count > 0 && (
          <>
            <Bookmark className="h-3 w-3 ml-1 text-amber-500" />
            <span className="text-amber-400">{rec.bookmark_count}</span>
          </>
        )}
      </div>
      <p className="mt-0.5 text-[10px] text-gray-600">{formatBytes(rec.file_size)}</p>
    </button>
  );
}

/* ── Main Page ───────────────────────────────────────────── */

export default function VideoArchivePage() {
  // Archive state
  const [recordings, setRecordings] = useState<ArchiveRecording[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<ArchiveStats | null>(null);

  // Filters
  const [filterCamera, setFilterCamera] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterStartDate, setFilterStartDate] = useState("");
  const [filterEndDate, setFilterEndDate] = useState("");
  const [cameras, setCameras] = useState<{ id: string; name: string }[]>([]);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  // Player state
  const [selected, setSelected] = useState<ArchiveRecording | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);

  // Bookmarks
  const [bookmarks, setBookmarks] = useState<VideoBookmark[]>([]);
  const [bmFilterType, setBmFilterType] = useState("all");
  const [showBookmarkForm, setShowBookmarkForm] = useState(false);
  const [bmLabel, setBmLabel] = useState("");
  const [bmNotes, setBmNotes] = useState("");
  const [bmType, setBmType] = useState<"marker" | "annotation" | "evidence_flag">("marker");
  const [savingBookmark, setSavingBookmark] = useState(false);

  // Forensics
  const [forensicResult, setForensicResult] = useState<ForensicAnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [forensicQuery, setForensicQuery] = useState("Perform comprehensive forensic analysis of this frame");

  // Export
  const [exporting, setExporting] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [exportResult, setExportResult] = useState<Record<string, any> | null>(null);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  /* ── Data fetching ─────────────────────────────────────── */

  const fetchRecordings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterCamera) params.append("camera_id", filterCamera);
      if (filterType) params.append("recording_type", filterType);
      if (filterStartDate) params.append("start_date", filterStartDate);
      if (filterEndDate) params.append("end_date", filterEndDate);
      params.append("page", String(page));
      params.append("page_size", "24");
      const data = await apiFetch<RecordingListResponse>(
        `/api/video-archive/recordings?${params}`
      );
      setRecordings(data.recordings);
      setTotal(data.total);
      setTotalPages(data.total_pages);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load recordings");
    } finally {
      setLoading(false);
    }
  }, [filterCamera, filterType, filterStartDate, filterEndDate, page]);

  useEffect(() => { fetchRecordings(); }, [fetchRecordings]);

  useEffect(() => {
    apiFetch<ArchiveStats>("/api/video-archive/stats").then(setStats).catch(() => {});
    apiFetch<{ id: string; name: string }[]>("/api/cameras")
      .then((cams) => setCameras(cams.map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => {});
  }, []);

  const fetchBookmarks = useCallback(async (recId: string) => {
    try {
      const bms = await apiFetch<VideoBookmark[]>(
        `/api/video-archive/recordings/${recId}/bookmarks`
      );
      setBookmarks(bms);
    } catch {
      setBookmarks([]);
    }
  }, []);

  /* ── Player actions ────────────────────────────────────── */

  const selectRecording = (rec: ArchiveRecording) => {
    setSelected(rec);
    setForensicResult(null);
    setExportResult(null);
    setBookmarks([]);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setPlaybackRate(1);
    fetchBookmarks(rec.id);
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) videoRef.current.pause();
    else videoRef.current.play();
  };

  const seek = (t: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = t;
    setCurrentTime(t);
  };

  const skip = (delta: number) => {
    if (!videoRef.current) return;
    const t = Math.max(0, Math.min(duration, videoRef.current.currentTime + delta));
    videoRef.current.currentTime = t;
  };

  const cycleSpeed = () => {
    const speeds = [0.25, 0.5, 1, 2, 4];
    const idx = speeds.indexOf(playbackRate);
    const next = speeds[(idx + 1) % speeds.length];
    setPlaybackRate(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
  };

  const toggleMute = () => {
    setMuted(!muted);
    if (videoRef.current) videoRef.current.muted = !muted;
  };

  const toggleFullscreen = () => {
    if (!videoRef.current) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else videoRef.current.requestFullscreen();
  };

  /* ── Bookmark actions ──────────────────────────────────── */

  const addBookmark = async () => {
    if (!selected || !bmLabel.trim()) return;
    setSavingBookmark(true);
    try {
      await apiFetch("/api/video-archive/bookmarks", {
        method: "POST",
        body: JSON.stringify({
          recording_id: selected.id,
          timestamp_offset: currentTime,
          label: bmLabel.trim(),
          notes: bmNotes.trim() || null,
          bookmark_type: bmType,
        }),
      });
      setBmLabel("");
      setBmNotes("");
      setShowBookmarkForm(false);
      fetchBookmarks(selected.id);
    } catch { /* ignore */ }
    finally { setSavingBookmark(false); }
  };

  const deleteBookmark = async (bmId: string) => {
    try {
      await apiFetch(`/api/video-archive/bookmarks/${bmId}`, { method: "DELETE" });
      if (selected) fetchBookmarks(selected.id);
    } catch { /* ignore */ }
  };

  /* ── Forensic analysis ─────────────────────────────────── */

  const analyzeFrame = async () => {
    if (!selected) return;
    setAnalyzing(true);
    setForensicResult(null);
    try {
      const result = await apiFetch<ForensicAnalysisResult>(
        "/api/video-archive/forensics/analyze",
        {
          method: "POST",
          body: JSON.stringify({
            recording_id: selected.id,
            timestamp_offset: currentTime,
            query: forensicQuery,
          }),
        }
      );
      setForensicResult(result);
    } catch (err: unknown) {
      setForensicResult({
        recording_id: selected.id,
        timestamp_offset: currentTime,
        camera_id: selected.camera_id,
        timestamp: "",
        forensic_analysis: { error: err instanceof Error ? err.message : "Analysis failed" },
        similar_frames: [],
        ai_provider: "error",
      });
    } finally {
      setAnalyzing(false);
    }
  };

  /* ── Export ─────────────────────────────────────────────── */

  const exportEvidence = async () => {
    if (!selected) return;
    setExporting(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await apiFetch<Record<string, any>>("/api/video-archive/export", {
        method: "POST",
        body: JSON.stringify({
          recording_id: selected.id,
          include_bookmarks: true,
          include_ai_analysis: true,
        }),
      });
      setExportResult(result);
    } catch { /* ignore */ }
    finally { setExporting(false); }
  };

  /* ── Bulk export selected recordings as CSV ────────────── */

  const exportSelected = () => {
    const selectedRecs = recordings.filter((r) => selectedIds.has(r.id));
    if (selectedRecs.length === 0) return;
    exportCSV(
      selectedRecs.map((r) => ({
        id: r.id,
        camera_name: r.camera_name || "",
        recording_type: r.recording_type,
        start_time: r.start_time,
        duration_seconds: String(r.duration_seconds ?? ""),
        file_size: String(r.file_size ?? ""),
        bookmark_count: String(r.bookmark_count),
      })),
      `recordings_export_${new Date().toISOString().slice(0, 10)}.csv`,
      [
        { key: "id", label: "Recording ID" },
        { key: "camera_name", label: "Camera" },
        { key: "recording_type", label: "Type" },
        { key: "start_time", label: "Start Time" },
        { key: "duration_seconds", label: "Duration (s)" },
        { key: "file_size", label: "File Size (bytes)" },
        { key: "bookmark_count", label: "Bookmarks" },
      ]
    );
    setSelectedIds(new Set());
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === recordings.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(recordings.map((r) => r.id)));
    }
  };

  /* ── Close player ──────────────────────────────────────── */

  const closePlayer = () => {
    if (videoRef.current) videoRef.current.pause();
    setSelected(null);
    setForensicResult(null);
    setExportResult(null);
    setBookmarks([]);
  };

  /* ── Keyboard shortcuts ───────────────────────────────── */

  useEffect(() => {
    if (!selected) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when user is typing in an input/textarea/select
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          skip(-5);
          break;
        case "ArrowRight":
          e.preventDefault();
          skip(5);
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selected, isPlaying, duration]);

  /* ── Filtered bookmarks ──────────────────────────────── */

  const filteredBookmarks = bmFilterType === "all"
    ? bookmarks
    : bookmarks.filter((bm) => bm.bookmark_type === bmFilterType);

  /* ── Render ─────────────────────────────────────────────── */

  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="flex items-center justify-between border-b border-gray-800 px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-900/40 border border-amber-700/50">
            <Clapperboard className="h-5 w-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-100">Video Archive</h1>
            <p className="text-xs text-gray-500">
              Browse, replay &amp; analyze recorded footage
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {stats && (
            <div className="hidden md:flex items-center gap-4 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <Film className="h-3 w-3" />
                {stats.total_recordings} recordings
              </span>
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatDuration(stats.total_duration_seconds)}
              </span>
              <span className="flex items-center gap-1">
                <HardDrive className="h-3 w-3" />
                {formatBytes(stats.total_size_bytes)}
              </span>
            </div>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Left: Archive Browser ──────────────────────── */}
        <div
          className={cn(
            "flex flex-col overflow-hidden border-r border-gray-800 transition-all duration-200",
            selected ? "w-72 shrink-0" : "flex-1"
          )}
        >
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 border-b border-gray-800 px-4 py-2.5">
            <select
              value={filterCamera}
              onChange={(e) => { setFilterCamera(e.target.value); setPage(1); }}
              className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-gray-300 focus:border-amber-600 focus:outline-none"
            >
              <option value="">All Cameras</option>
              {cameras.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <select
              value={filterType}
              onChange={(e) => { setFilterType(e.target.value); setPage(1); }}
              className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-gray-300 focus:border-amber-600 focus:outline-none"
            >
              <option value="">All Types</option>
              <option value="continuous">Continuous</option>
              <option value="event_triggered">Event Triggered</option>
              <option value="manual">Manual</option>
            </select>
            <div className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5 text-gray-500 shrink-0" />
              <input
                type="date"
                value={filterStartDate}
                onChange={(e) => { setFilterStartDate(e.target.value); setPage(1); }}
                className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-gray-300 focus:border-amber-600 focus:outline-none [color-scheme:dark]"
                title="Start date"
              />
              <span className="text-[10px] text-gray-600">to</span>
              <input
                type="date"
                value={filterEndDate}
                onChange={(e) => { setFilterEndDate(e.target.value); setPage(1); }}
                className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-gray-300 focus:border-amber-600 focus:outline-none [color-scheme:dark]"
                title="End date"
              />
            </div>
            {!selected && (
              <div className="ml-auto flex items-center gap-2">
                {/* Select all checkbox */}
                {recordings.length > 0 && (
                  <button
                    onClick={toggleSelectAll}
                    className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                    title="Select / deselect all"
                  >
                    {selectedIds.size === recordings.length && recordings.length > 0
                      ? <CheckSquare className="h-4 w-4 text-amber-400" />
                      : <Square className="h-4 w-4" />}
                  </button>
                )}
                {/* Export Selected */}
                {selectedIds.size > 0 && (
                  <button
                    onClick={exportSelected}
                    className="flex items-center gap-1.5 rounded-md bg-amber-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-amber-500 transition-colors"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export {selectedIds.size} Selected
                  </button>
                )}
                <div className="flex gap-1">
                  <button
                    onClick={() => setViewMode("grid")}
                    className={cn("rounded p-1.5", viewMode === "grid" ? "bg-amber-600 text-white" : "text-gray-500 hover:text-gray-300")}
                  >
                    <Grid3X3 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => setViewMode("list")}
                    className={cn("rounded p-1.5", viewMode === "list" ? "bg-amber-600 text-white" : "text-gray-500 hover:text-gray-300")}
                  >
                    <List className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Recordings */}
          <div className="flex-1 overflow-y-auto px-3 py-3">
            {loading && (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            {!loading && !error && recordings.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-gray-500">
                <Film className="h-10 w-10 mb-3 text-gray-700" />
                <p className="text-sm font-medium">No recordings found</p>
                <p className="text-xs mt-1">Adjust filters or start recording cameras</p>
              </div>
            )}

            {!loading && !error && recordings.length > 0 && (
              <div
                className={cn(
                  selected
                    ? "space-y-2"
                    : viewMode === "grid"
                    ? "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
                    : "space-y-2"
                )}
              >
                {recordings.map((rec) => (
                  <div key={rec.id} className="relative">
                    {/* Checkbox overlay (only when no player open) */}
                    {!selected && (
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleSelect(rec.id); }}
                        className="absolute top-2 left-2 z-10 rounded bg-gray-900/80 p-0.5 transition-opacity hover:opacity-100"
                        title={selectedIds.has(rec.id) ? "Deselect" : "Select for export"}
                      >
                        {selectedIds.has(rec.id)
                          ? <CheckSquare className="h-4 w-4 text-amber-400" />
                          : <Square className="h-4 w-4 text-gray-500" />}
                      </button>
                    )}
                    <RecordingCard
                      rec={rec}
                      isSelected={selected?.id === rec.id}
                      onSelect={() => selectRecording(rec)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-gray-800 px-4 py-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-30"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </button>
              <span className="text-xs text-gray-500">
                {page} / {totalPages}
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-30"
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* ── Center: Media Player ───────────────────────── */}
        {selected && (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Player header */}
            <div className="flex items-center justify-between border-b border-gray-800 px-4 py-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-200 truncate">
                  {selected.camera_name || "Unknown Camera"}
                </p>
                <p className="text-[10px] text-gray-500">
                  {formatTimestamp(selected.start_time)} &middot; {formatDuration(selected.duration_seconds)} &middot; {formatBytes(selected.file_size)}
                </p>
              </div>
              <button
                onClick={closePlayer}
                className="rounded-md p-1.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Video element */}
            <div className="relative flex-1 bg-black flex items-center justify-center min-h-0">
              <video
                ref={videoRef}
                src={`${API_BASE}/api/video-archive/stream/${selected.id}`}
                className="max-h-full max-w-full"
                onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
                onDurationChange={() => setDuration(videoRef.current?.duration ?? 0)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onClick={togglePlay}
              />
              {!isPlaying && duration === 0 && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <button
                    onClick={togglePlay}
                    className="rounded-full bg-amber-600/80 p-4 text-white shadow-lg hover:bg-amber-500 transition-colors"
                  >
                    <Play className="h-8 w-8" />
                  </button>
                </div>
              )}
            </div>

            {/* Seek bar with bookmark markers */}
            <div className="px-4 pt-2">
              <div className="relative h-2 w-full group">
                {/* Background */}
                <div className="absolute inset-0 rounded-full bg-gray-800" />
                {/* Progress */}
                <div
                  className="absolute h-full rounded-full bg-amber-500 transition-all"
                  style={{ width: duration > 0 ? `${(currentTime / duration) * 100}%` : "0%" }}
                />
                {/* Bookmark markers */}
                {bookmarks.map((bm) => (
                  <button
                    key={bm.id}
                    className={cn(
                      "absolute top-0 h-full w-1 rounded-full cursor-pointer z-10 hover:scale-y-150 transition-transform",
                      BM_COLORS[bm.bookmark_type] || "bg-amber-400"
                    )}
                    style={{ left: duration > 0 ? `${(bm.timestamp_offset / duration) * 100}%` : "0%" }}
                    onClick={() => seek(bm.timestamp_offset)}
                    title={`${bm.label} (${formatDuration(bm.timestamp_offset)})`}
                  />
                ))}
                {/* Seek input */}
                <input
                  type="range"
                  min={0}
                  max={duration || 100}
                  step={0.1}
                  value={currentTime}
                  onChange={(e) => seek(parseFloat(e.target.value))}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </div>
            </div>

            {/* Custom controls */}
            <div className="flex items-center gap-3 border-t border-gray-800/50 px-4 py-2">
              <button onClick={() => skip(-10)} className="text-gray-400 hover:text-gray-200" title="Back 10s">
                <SkipBack className="h-4 w-4" />
              </button>
              <button
                onClick={togglePlay}
                className="rounded-full bg-amber-600 p-2 text-white hover:bg-amber-500 transition-colors"
              >
                {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </button>
              <button onClick={() => skip(10)} className="text-gray-400 hover:text-gray-200" title="Forward 10s">
                <SkipForward className="h-4 w-4" />
              </button>

              {/* Time */}
              <span className="text-xs font-mono text-gray-400 min-w-[80px]">
                {formatDuration(currentTime)} / {formatDuration(duration)}
              </span>

              {/* Speed */}
              <button
                onClick={cycleSpeed}
                className="rounded border border-gray-700 px-2 py-0.5 text-[10px] font-bold text-gray-300 hover:border-amber-600 hover:text-amber-400"
                title="Playback speed"
              >
                {playbackRate}x
              </button>

              <div className="flex-1" />

              {/* Volume */}
              <button onClick={toggleMute} className="text-gray-400 hover:text-gray-200">
                {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              </button>

              {/* Bookmark at current time */}
              <button
                onClick={() => setShowBookmarkForm(!showBookmarkForm)}
                className={cn(
                  "rounded-md px-2 py-1 text-xs font-semibold transition-colors flex items-center gap-1",
                  showBookmarkForm
                    ? "bg-amber-600 text-white"
                    : "text-gray-400 hover:text-amber-400 hover:bg-gray-800"
                )}
                title="Add bookmark"
              >
                <Plus className="h-3 w-3" />
                <Bookmark className="h-3 w-3" />
              </button>

              {/* Fullscreen */}
              <button onClick={toggleFullscreen} className="text-gray-400 hover:text-gray-200" title="Fullscreen">
                <Maximize className="h-4 w-4" />
              </button>
            </div>

            {/* Bookmark form */}
            {showBookmarkForm && (
              <div className="border-t border-gray-800 px-4 py-3 bg-gray-900/60">
                <div className="flex items-center gap-2 mb-2">
                  <BookmarkCheck className="h-4 w-4 text-amber-400" />
                  <span className="text-xs font-semibold text-gray-300">
                    Bookmark at {formatDuration(currentTime)}
                  </span>
                </div>
                <div className="flex gap-2">
                  <input
                    value={bmLabel}
                    onChange={(e) => setBmLabel(e.target.value)}
                    placeholder="Label..."
                    className="flex-1 rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:border-amber-600 focus:outline-none"
                  />
                  <select
                    value={bmType}
                    onChange={(e) => setBmType(e.target.value as "marker" | "annotation" | "evidence_flag")}
                    className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-gray-300 focus:border-amber-600 focus:outline-none"
                  >
                    <option value="marker">Marker</option>
                    <option value="annotation">Annotation</option>
                    <option value="evidence_flag">Evidence Flag</option>
                  </select>
                  <button
                    onClick={addBookmark}
                    disabled={!bmLabel.trim() || savingBookmark}
                    className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-40"
                  >
                    {savingBookmark ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                  </button>
                </div>
                <textarea
                  value={bmNotes}
                  onChange={(e) => setBmNotes(e.target.value)}
                  placeholder="Notes (optional)..."
                  rows={2}
                  className="mt-2 w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:border-amber-600 focus:outline-none resize-none"
                />
              </div>
            )}
          </div>
        )}

        {/* ── Right: Forensics Sidebar ───────────────────── */}
        {selected && (
          <aside className="hidden lg:flex w-80 shrink-0 flex-col border-l border-gray-800 bg-gray-950 overflow-hidden">
            {/* Forensics tools */}
            <div className="border-b border-gray-800 p-4 space-y-3">
              <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-400">
                <Microscope className="h-3.5 w-3.5" />
                Forensic Analysis
              </h3>
              <textarea
                value={forensicQuery}
                onChange={(e) => setForensicQuery(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:border-amber-600 focus:outline-none resize-none"
                placeholder="Forensic query..."
              />
              <button
                onClick={analyzeFrame}
                disabled={analyzing}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-amber-600 px-3 py-2 text-xs font-bold text-white hover:bg-amber-500 disabled:opacity-50 transition-colors"
              >
                {analyzing ? (
                  <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Analyzing...</>
                ) : (
                  <><Eye className="h-3.5 w-3.5" /> Analyze Frame at {formatDuration(currentTime)}</>
                )}
              </button>
            </div>

            {/* Analysis results */}
            <div className="flex-1 overflow-y-auto">
              {forensicResult && (() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const fa = forensicResult.forensic_analysis as Record<string, any>;
                return (
                <div className="border-b border-gray-800 p-4 space-y-3">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-amber-400">
                    Analysis Results
                  </h3>
                  <p className="text-[10px] text-gray-500">
                    Provider: {forensicResult.ai_provider} &middot; at {formatDuration(forensicResult.timestamp_offset)}
                  </p>

                  {/* Summary */}
                  {fa.forensic_summary && (
                    <div className="rounded-md border border-gray-800 bg-gray-900/60 p-3">
                      <p className="text-xs font-semibold text-gray-300 mb-1">Summary</p>
                      <p className="text-[11px] text-gray-400 leading-relaxed">
                        {String(fa.forensic_summary)}
                      </p>
                    </div>
                  )}

                  {/* Risk */}
                  {fa.risk_assessment && typeof fa.risk_assessment === "object" && (
                    <div className="rounded-md border border-gray-800 bg-gray-900/60 p-3">
                      <p className="text-xs font-semibold text-gray-300 mb-1">Risk Assessment</p>
                      <div className="space-y-1">
                        {Object.entries(fa.risk_assessment as Record<string, unknown>).map(([k, v]) => (
                          <div key={k} className="flex justify-between text-[10px]">
                            <span className="text-gray-500">{k.replace(/_/g, " ")}</span>
                            <span className="text-gray-300">{Array.isArray(v) ? (v as string[]).join(", ") : String(v)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Persons */}
                  {Array.isArray(fa.persons_detailed) && fa.persons_detailed.length > 0 && (
                    <div className="rounded-md border border-gray-800 bg-gray-900/60 p-3">
                      <p className="text-xs font-semibold text-gray-300 mb-1">
                        Persons ({fa.persons_detailed.length})
                      </p>
                      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                      {(fa.persons_detailed as Record<string, any>[]).map((p, i) => (
                        <div key={i} className="mt-2 text-[10px] text-gray-400 border-t border-gray-800 pt-1.5">
                          <p className="text-gray-300 font-medium">{String(p.physical_description || p.id || `Person ${i + 1}`)}</p>
                          {p.behavior_analysis && <p className="mt-0.5">{String(p.behavior_analysis)}</p>}
                          {Array.isArray(p.suspicious_indicators) && (p.suspicious_indicators as string[]).length > 0 && (
                            <p className="mt-0.5 text-red-400">
                              Suspicious: {(p.suspicious_indicators as string[]).join(", ")}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Evidence markers */}
                  {Array.isArray(fa.evidence_markers) && fa.evidence_markers.length > 0 && (
                    <div className="rounded-md border border-gray-800 bg-gray-900/60 p-3">
                      <p className="text-xs font-semibold text-gray-300 mb-1">Evidence Markers</p>
                      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                      {(fa.evidence_markers as Record<string, any>[]).map((em, i) => (
                        <div key={i} className="text-[10px] text-gray-400 mt-1">
                          <span className="text-amber-400 font-medium">{String(em.type)}</span>
                          {em.significance && <span> &mdash; {String(em.significance)}</span>}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Similar frames */}
                  {forensicResult.similar_frames.length > 0 && (
                    <div className="rounded-md border border-gray-800 bg-gray-900/60 p-3">
                      <p className="text-xs font-semibold text-gray-300 mb-1">
                        Similar Frames ({forensicResult.similar_frames.length})
                      </p>
                      {forensicResult.similar_frames.map((sf, i) => (
                        <div key={i} className="flex items-center justify-between text-[10px] text-gray-400 mt-1">
                          <span>{sf.camera_id.slice(0, 8)}... @ {formatTimestamp(sf.timestamp)}</span>
                          <span className="text-amber-400 font-mono">{(sf.score * 100).toFixed(0)}%</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Error */}
                  {fa.error && (
                    <div className="rounded-md border border-red-800/50 bg-red-900/20 p-3 text-xs text-red-400">
                      {String(fa.error)}
                    </div>
                  )}
                </div>
                );
              })()}

              {/* Bookmarks list */}
              <div className="border-b border-gray-800 p-4 space-y-2">
                <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-400">
                  <Bookmark className="h-3.5 w-3.5" />
                  Bookmarks ({bookmarks.length})
                </h3>
                {/* Bookmark type filter tabs */}
                <div className="flex gap-1">
                  {BM_FILTER_TABS.map((tab) => (
                    <button
                      key={tab.key}
                      onClick={() => setBmFilterType(tab.key)}
                      className={cn(
                        "rounded-md px-2 py-1 text-[10px] font-semibold transition-colors",
                        bmFilterType === tab.key
                          ? "bg-amber-600 text-white"
                          : "text-gray-500 hover:text-gray-300 hover:bg-gray-800"
                      )}
                    >
                      {tab.label}
                      {tab.key !== "all" && (
                        <span className="ml-1 text-[9px] opacity-70">
                          {bookmarks.filter((bm) => bm.bookmark_type === tab.key).length}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                {filteredBookmarks.length === 0 && (
                  <p className="text-[10px] text-gray-600">
                    {bookmarks.length === 0 ? "No bookmarks yet" : "No bookmarks match this filter"}
                  </p>
                )}
                {filteredBookmarks.map((bm) => (
                  <div
                    key={bm.id}
                    className="group flex items-start gap-2 rounded-md border border-gray-800 bg-gray-900/40 p-2 cursor-pointer hover:border-amber-700/50 transition-colors"
                    onClick={() => seek(bm.timestamp_offset)}
                  >
                    <div className={cn("mt-0.5 h-2 w-2 rounded-full shrink-0", BM_COLORS[bm.bookmark_type] || "bg-gray-500")} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium text-gray-300 truncate">{bm.label}</p>
                        <span className="text-[10px] font-mono text-amber-400 shrink-0 ml-1">
                          {formatDuration(bm.timestamp_offset)}
                        </span>
                      </div>
                      {bm.notes && <p className="text-[10px] text-gray-500 mt-0.5 truncate">{bm.notes}</p>}
                      {bm.severity && (
                        <span className="text-[9px] text-red-400 font-semibold uppercase">{bm.severity}</span>
                      )}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteBookmark(bm.id); }}
                      className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-opacity"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>

              {/* Export */}
              <div className="p-4 space-y-3">
                <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-400">
                  <Download className="h-3.5 w-3.5" />
                  Evidence Export
                </h3>
                <button
                  onClick={exportEvidence}
                  disabled={exporting}
                  className="w-full flex items-center justify-center gap-2 rounded-lg border border-amber-700/50 bg-amber-900/20 px-3 py-2 text-xs font-semibold text-amber-400 hover:bg-amber-900/40 disabled:opacity-50 transition-colors"
                >
                  {exporting ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Exporting...</>
                  ) : (
                    <><FileText className="h-3.5 w-3.5" /> Export with SHA-256 Hash</>
                  )}
                </button>
                {exportResult && (
                  <div className="rounded-md border border-green-800/50 bg-green-900/20 p-3 space-y-1">
                    <p className="text-xs font-semibold text-green-400">Evidence Exported</p>
                    <p className="text-[10px] text-gray-400">
                      Hash: <span className="font-mono text-gray-300">{String(exportResult.evidence_hash).slice(0, 24)}...</span>
                    </p>
                    {exportResult.case_evidence_id && (
                      <p className="text-[10px] text-gray-400">
                        Case evidence ID: <span className="font-mono text-gray-300">{String(exportResult.case_evidence_id).slice(0, 8)}</span>
                      </p>
                    )}
                  </div>
                )}

                {/* Recording info */}
                <div className="mt-4 space-y-1 text-[10px] text-gray-600">
                  <p>Recording ID: {selected.id.slice(0, 8)}...</p>
                  <p>Camera: {selected.camera_name}</p>
                  <p>Type: {TYPE_LABELS[selected.recording_type] || selected.recording_type}</p>
                  <p>Duration: {formatDuration(selected.duration_seconds)}</p>
                  <p>Size: {formatBytes(selected.file_size)}</p>
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
