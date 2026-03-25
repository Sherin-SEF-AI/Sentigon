"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Film,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Camera,
  RefreshCw,
  Download,
  Trash2,
  Play,
  FastForward,
  Zap,
  BarChart3,
  ChevronDown,
  ChevronUp,
  FileJson,
  Star,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import { exportJSON, exportCSV } from "@/lib/export";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface VideoSummaryItem {
  id: string;
  camera_id: string;
  summary_type: string;
  start_time: string;
  end_time: string;
  file_path: string | null;
  file_size: number | null;
  duration_seconds: number | null;
  event_count: number;
  status: string;
  threshold: string | null;
  speed_factor: number | null;
  error_message: string | null;
  created_at: string;
  // Optional AI fields
  summary_text?: string | null;
  confidence_score?: number | null;
  quality_score?: number | null;
}

interface KeyMoment {
  raw: string;       // original text
  timeLabel: string; // e.g. "14:32"
  totalSeconds: number;
}

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function statusBadge(status: string): string {
  switch (status) {
    case "complete":
      return "bg-green-900/40 text-green-400 border-green-800/60";
    case "processing":
      return "bg-yellow-900/40 text-yellow-400 border-yellow-800/60";
    case "failed":
      return "bg-red-900/40 text-red-400 border-red-800/60";
    default:
      return "bg-gray-800 text-gray-400 border-gray-700";
  }
}

/**
 * Parse a summary text for time references like "14:32", "at 09:15:00",
 * "at 2:05", etc. Returns all unique matches.
 */
function extractKeyMoments(text: string | null | undefined): KeyMoment[] {
  if (!text) return [];
  // Match HH:MM, H:MM, HH:MM:SS
  const TIME_RE = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g;
  const seen = new Set<string>();
  const moments: KeyMoment[] = [];
  let m: RegExpExecArray | null;
  while ((m = TIME_RE.exec(text)) !== null) {
    const full = m[0];
    if (seen.has(full)) continue;
    seen.add(full);
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const sec = m[3] ? parseInt(m[3], 10) : 0;
    moments.push({
      raw: full,
      timeLabel: full,
      totalSeconds: h * 3600 + min * 60 + sec,
    });
  }
  return moments;
}

/**
 * Confidence / quality score badge.
 * Accepts a value between 0 and 1 (or 0–100).
 */
function ScoreBadge({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) {
    return (
      <span className="flex items-center gap-1 rounded border border-gray-700 bg-gray-800/40 px-2 py-0.5 text-[10px] font-medium text-gray-500">
        <Star className="h-2.5 w-2.5" />
        AI Confidence: N/A
      </span>
    );
  }

  // Normalize to 0–100
  const pct = score > 1 ? Math.min(score, 100) : Math.round(score * 100);

  let colorClass = "border-gray-700 bg-gray-800/40 text-gray-400";
  if (pct >= 80) colorClass = "border-emerald-800 bg-emerald-900/30 text-emerald-400";
  else if (pct >= 60) colorClass = "border-yellow-800 bg-yellow-900/30 text-yellow-400";
  else colorClass = "border-red-800 bg-red-900/30 text-red-400";

  return (
    <span className={`flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-medium ${colorClass}`}>
      <Star className="h-2.5 w-2.5" />
      AI Confidence: {pct}%
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  VideoSummaryPage                                                   */
/* ------------------------------------------------------------------ */

export default function VideoSummaryPage() {
  const { addToast } = useToast();

  const [summaries, setSummaries] = useState<VideoSummaryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Generate form
  const [formCamera, setFormCamera] = useState("");
  const [formStart, setFormStart] = useState("");
  const [formEnd, setFormEnd] = useState("");
  const [formThreshold, setFormThreshold] = useState("medium");
  const [formSpeedFactor, setFormSpeedFactor] = useState(60);
  const [generating, setGenerating] = useState<string | null>(null);

  // Action state
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Inline video preview
  const [expandedPreviews, setExpandedPreviews] = useState<Set<string>>(new Set());

  // Polling ref
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Available cameras
  const [cameras, setCameras] = useState<{ id: string; name: string }[]>([]);

  // Per-summary exporting
  const [exportingId, setExportingId] = useState<string | null>(null);

  /* --- Fetch summaries --- */
  const fetchSummaries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ summaries: VideoSummaryItem[] }>(
        "/api/video-summary/list"
      );
      setSummaries(data.summaries);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch summaries"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  /* --- Fetch cameras --- */
  const fetchCameras = useCallback(async () => {
    try {
      const data = await apiFetch<{ cameras: { id: string; name: string }[] } | { id: string; name: string }[]>(
        "/api/cameras"
      );
      const cameraList = Array.isArray(data) ? data : (data as { cameras: { id: string; name: string }[] })?.cameras || [];
      setCameras(cameraList);
      if (cameraList.length > 0 && !formCamera) {
        setFormCamera(cameraList[0].id);
      }
    } catch {
      // Non-critical
    }
  }, [formCamera]);

  useEffect(() => {
    fetchSummaries();
    fetchCameras();
  }, [fetchSummaries, fetchCameras]);

  /* --- Auto-poll while any summary is processing --- */
  useEffect(() => {
    const hasProcessing = summaries.some((s) => s.status === "processing");

    if (hasProcessing && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        try {
          const data = await apiFetch<{ summaries: VideoSummaryItem[] }>(
            "/api/video-summary/list"
          );
          setSummaries(data.summaries);
        } catch {
          // Silently ignore poll errors
        }
      }, 5000);
    } else if (!hasProcessing && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [summaries]);

  /* --- Generate highlight --- */
  const handleGenerateHighlight = useCallback(async () => {
    if (!formCamera || !formStart || !formEnd) return;
    setGenerating("highlight");
    try {
      await apiFetch("/api/video-summary/highlight", {
        method: "POST",
        body: JSON.stringify({
          camera_id: formCamera,
          start_time: new Date(formStart).toISOString(),
          end_time: new Date(formEnd).toISOString(),
          threshold: formThreshold,
        }),
      });
      await fetchSummaries();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to generate highlight"
      );
    } finally {
      setGenerating(null);
    }
  }, [formCamera, formStart, formEnd, formThreshold, fetchSummaries]);

  /* --- Generate timelapse --- */
  const handleGenerateTimelapse = useCallback(async () => {
    if (!formCamera || !formStart || !formEnd) return;
    setGenerating("timelapse");
    try {
      await apiFetch("/api/video-summary/timelapse", {
        method: "POST",
        body: JSON.stringify({
          camera_id: formCamera,
          start_time: new Date(formStart).toISOString(),
          end_time: new Date(formEnd).toISOString(),
          speed_factor: formSpeedFactor,
        }),
      });
      await fetchSummaries();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to generate timelapse"
      );
    } finally {
      setGenerating(null);
    }
  }, [formCamera, formStart, formEnd, formSpeedFactor, fetchSummaries]);

  /* --- Delete summary --- */
  const handleDelete = useCallback(
    async (id: string) => {
      setActionLoading(`delete-${id}`);
      try {
        await apiFetch(`/api/video-summary/${id}`, { method: "DELETE" });
        await fetchSummaries();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to delete summary"
        );
      } finally {
        setActionLoading(null);
      }
    },
    [fetchSummaries]
  );

  /* --- Download --- */
  const handleDownload = useCallback((id: string) => {
    const token = localStorage.getItem("sentinel_token");
    window.open(
      `/api/video-summary/${id}/download?token=${token}`,
      "_blank"
    );
  }, []);

  /* --- Toggle inline preview --- */
  const togglePreview = useCallback((id: string) => {
    setExpandedPreviews((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  /* --- Export summary to JSON --- */
  const handleExportSummary = useCallback(
    (s: VideoSummaryItem) => {
      setExportingId(s.id);
      try {
        const payload = {
          id: s.id,
          camera_id: s.camera_id,
          summary_type: s.summary_type,
          status: s.status,
          start_time: s.start_time,
          end_time: s.end_time,
          created_at: s.created_at,
          event_count: s.event_count,
          duration_seconds: s.duration_seconds,
          file_size: s.file_size,
          threshold: s.threshold,
          speed_factor: s.speed_factor,
          summary_text: s.summary_text ?? null,
          confidence_score: s.confidence_score ?? null,
          quality_score: s.quality_score ?? null,
          exported_at: new Date().toISOString(),
        };
        exportJSON(
          payload,
          `video-summary-${s.camera_id.slice(0, 8)}-${new Date(s.created_at).toISOString().slice(0, 10)}.json`
        );
        addToast("success", "Summary exported as JSON.");
      } catch {
        addToast("error", "Failed to export summary.");
      } finally {
        setExportingId(null);
      }
    },
    [addToast]
  );

  /* --- Export all summaries as CSV --- */
  const handleExportAllCSV = useCallback(() => {
    if (summaries.length === 0) return;
    exportCSV(
      summaries.map((s) => ({
        id: s.id,
        camera_id: s.camera_id,
        summary_type: s.summary_type,
        status: s.status,
        start_time: s.start_time,
        end_time: s.end_time,
        created_at: s.created_at,
        event_count: String(s.event_count),
        duration_seconds: String(s.duration_seconds ?? ""),
        file_size: String(s.file_size ?? ""),
        threshold: s.threshold ?? "",
        speed_factor: String(s.speed_factor ?? ""),
        confidence_score: String(s.confidence_score ?? ""),
        quality_score: String(s.quality_score ?? ""),
      })),
      `video-summaries-export-${new Date().toISOString().slice(0, 10)}.csv`
    );
    addToast("success", `Exported ${summaries.length} summaries as CSV.`);
  }, [summaries, addToast]);

  /* --- Set default time range (last 8 hours) --- */
  useEffect(() => {
    if (!formEnd) {
      const now = new Date();
      setFormEnd(now.toISOString().slice(0, 16));
      const start = new Date(now.getTime() - 8 * 60 * 60 * 1000);
      setFormStart(start.toISOString().slice(0, 16));
    }
  }, [formEnd]);

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="flex h-full flex-col overflow-auto bg-gray-950 text-gray-100">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-900/30 border border-violet-800/50">
            <Film className="h-5 w-5 text-violet-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Video Summary
            </h1>
            <p className="text-xs text-gray-500">
              Generate highlight reels and timelapse videos from camera feeds
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {summaries.length > 0 && (
            <button
              onClick={handleExportAllCSV}
              className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
            >
              <Download className="h-3.5 w-3.5" />
              Export All CSV
            </button>
          )}
          <button
            onClick={fetchSummaries}
            className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* ---- Generator Form ---- */}
      <div className="border-b border-gray-800 bg-gray-900/40 px-6 py-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
          Generate New Summary
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {/* Camera */}
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              Camera
            </label>
            <select
              value={formCamera}
              onChange={(e) => setFormCamera(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-300 focus:border-violet-600 focus:outline-none"
            >
              {cameras.length === 0 && (
                <option value="">No cameras</option>
              )}
              {cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.id.substring(0, 8)}
                </option>
              ))}
            </select>
          </div>

          {/* Start time */}
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              Start Time
            </label>
            <input
              type="datetime-local"
              value={formStart}
              onChange={(e) => setFormStart(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-300 focus:border-violet-600 focus:outline-none"
            />
          </div>

          {/* End time */}
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              End Time
            </label>
            <input
              type="datetime-local"
              value={formEnd}
              onChange={(e) => setFormEnd(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-300 focus:border-violet-600 focus:outline-none"
            />
          </div>

          {/* Threshold / Speed */}
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              Threshold / Speed
            </label>
            <div className="flex gap-2">
              <select
                value={formThreshold}
                onChange={(e) => setFormThreshold(e.target.value)}
                className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-2 py-2 text-xs text-gray-300 focus:border-violet-600 focus:outline-none"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
              <select
                value={formSpeedFactor}
                onChange={(e) => setFormSpeedFactor(Number(e.target.value))}
                className="w-20 rounded-lg border border-gray-700 bg-gray-900 px-2 py-2 text-xs text-gray-300 focus:border-violet-600 focus:outline-none"
              >
                <option value={30}>30x</option>
                <option value={60}>60x</option>
                <option value={120}>120x</option>
                <option value={300}>300x</option>
              </select>
            </div>
          </div>

          {/* Buttons */}
          <div className="flex items-end gap-2">
            <button
              onClick={handleGenerateHighlight}
              disabled={!formCamera || !formStart || !formEnd || generating !== null}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {generating === "highlight" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="h-3.5 w-3.5" />
              )}
              Highlight
            </button>
            <button
              onClick={handleGenerateTimelapse}
              disabled={!formCamera || !formStart || !formEnd || generating !== null}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {generating === "timelapse" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FastForward className="h-3.5 w-3.5" />
              )}
              Timelapse
            </button>
          </div>
        </div>
      </div>

      {/* ---- Summaries List ---- */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800 px-6 py-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            Generated Summaries
          </h2>
          <span className="text-xs text-gray-600">
            {summaries.length} summary{summaries.length !== 1 ? "ies" : "y"}
          </span>
        </div>

        {loading && (
          <div className="flex flex-col items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-violet-400" />
            <p className="mt-3 text-sm text-gray-500">Loading summaries...</p>
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center justify-center py-16">
            <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {!loading && !error && summaries.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16">
            <Film className="mb-2 h-10 w-10 text-gray-700" />
            <p className="text-sm font-medium text-gray-400">
              No summaries generated yet
            </p>
            <p className="mt-1 text-xs text-gray-600">
              Use the form above to create your first highlight or timelapse
            </p>
          </div>
        )}

        {!loading && !error && summaries.length > 0 && (
          <div className="space-y-3">
            {summaries.map((s) => {
              const keyMoments = extractKeyMoments(s.summary_text);
              const score = s.confidence_score ?? s.quality_score ?? null;

              return (
                <div
                  key={s.id}
                  className="rounded-lg border border-gray-800 bg-gray-900/60 p-4 transition-shadow hover:shadow-lg hover:shadow-violet-900/10"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className={cn(
                          "relative flex h-8 w-8 items-center justify-center rounded-lg border",
                          s.summary_type === "highlight"
                            ? "bg-violet-900/30 border-violet-800/50"
                            : "bg-cyan-900/30 border-cyan-800/50"
                        )}
                      >
                        {s.status === "processing" ? (
                          <Loader2 className={cn(
                            "h-4 w-4 animate-spin",
                            s.summary_type === "highlight"
                              ? "text-violet-400"
                              : "text-cyan-400"
                          )} />
                        ) : s.summary_type === "highlight" ? (
                          <Zap className="h-4 w-4 text-violet-400" />
                        ) : (
                          <FastForward className="h-4 w-4 text-cyan-400" />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-gray-200 capitalize">
                            {s.summary_type}
                          </span>
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase border",
                              statusBadge(s.status)
                            )}
                          >
                            {s.status}
                          </span>
                          {/* AI Confidence badge */}
                          <ScoreBadge score={score} />
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-3 text-[11px] text-gray-500">
                          <span className="flex items-center gap-1">
                            <Camera className="h-3 w-3" />
                            {s.camera_id.substring(0, 8)}...
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {s.created_at ? timeAgo(s.created_at) : "--"}
                          </span>
                          {s.event_count > 0 && (
                            <span className="flex items-center gap-1">
                              <BarChart3 className="h-3 w-3" />
                              {s.event_count} events
                            </span>
                          )}
                          {s.duration_seconds && (
                            <span>{formatDuration(s.duration_seconds)}</span>
                          )}
                          {s.file_size && (
                            <span>{formatBytes(s.file_size)}</span>
                          )}
                          {s.threshold && (
                            <span>Threshold: {s.threshold}</span>
                          )}
                          {s.speed_factor && (
                            <span>{s.speed_factor}x speed</span>
                          )}
                        </div>
                        {s.error_message && (
                          <p className="mt-1 text-[11px] text-red-400">
                            {s.error_message}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 shrink-0">
                      {/* Export Summary button */}
                      <button
                        onClick={() => handleExportSummary(s)}
                        disabled={exportingId === s.id}
                        title="Export summary as JSON"
                        className="flex items-center gap-1 rounded-lg border border-gray-700 bg-gray-900 px-2 py-1.5 text-[11px] text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors disabled:opacity-50"
                      >
                        {exportingId === s.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <FileJson className="h-3 w-3" />
                        )}
                        Export
                      </button>

                      {s.status === "complete" && s.file_path && (
                        <>
                          <button
                            onClick={() => togglePreview(s.id)}
                            className="flex items-center gap-1 rounded-lg border border-gray-700 bg-gray-900 px-2 py-1.5 text-[11px] text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
                          >
                            <Play className="h-3 w-3" />
                            Preview
                            {expandedPreviews.has(s.id) ? (
                              <ChevronUp className="h-3 w-3" />
                            ) : (
                              <ChevronDown className="h-3 w-3" />
                            )}
                          </button>
                          <button
                            onClick={() => handleDownload(s.id)}
                            className="flex items-center gap-1 rounded-lg border border-gray-700 bg-gray-900 px-2 py-1.5 text-[11px] text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
                          >
                            <Download className="h-3 w-3" />
                            Download
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => handleDelete(s.id)}
                        disabled={actionLoading === `delete-${s.id}`}
                        className="flex items-center gap-1 rounded-lg border border-red-800/40 px-2 py-1.5 text-[11px] text-red-400 hover:bg-red-900/20 transition-colors disabled:opacity-50"
                      >
                        {actionLoading === `delete-${s.id}` ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* ---- Summary text with key moment badges ---- */}
                  {s.summary_text && (
                    <div className="mt-3 rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">
                        AI Summary
                      </p>
                      <p className="text-xs text-gray-400 leading-relaxed">
                        {s.summary_text}
                      </p>
                      {keyMoments.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <span className="text-[9px] uppercase tracking-wider text-gray-600 self-center">
                            Key moments:
                          </span>
                          {keyMoments.map((km) => (
                            <button
                              key={km.raw}
                              title={`Seek to ${km.timeLabel} (${km.totalSeconds}s)`}
                              onClick={() => {
                                // If there's a preview open, attempt to seek the video
                                const videoEl = document.querySelector<HTMLVideoElement>(
                                  `video[data-summary-id="${s.id}"]`
                                );
                                if (videoEl) {
                                  videoEl.currentTime = km.totalSeconds;
                                  videoEl.play().catch(() => {});
                                }
                                addToast(
                                  "info",
                                  `Seeking to ${km.timeLabel}${s.file_path ? "" : " (open preview first)"}`
                                );
                              }}
                              className="flex items-center gap-1 rounded-full border border-violet-800/60 bg-violet-900/20 px-2 py-0.5 text-[10px] font-medium text-violet-400 hover:bg-violet-900/40 transition-colors"
                            >
                              <Clock className="h-2.5 w-2.5" />
                              {km.timeLabel}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Inline video preview */}
                  {s.status === "complete" && s.file_path && expandedPreviews.has(s.id) && (
                    <div className="mt-3 rounded-lg border border-gray-800 bg-gray-950/80 p-3">
                      <video
                        data-summary-id={s.id}
                        src={`/api/video-summary/${s.id}/download?token=${typeof window !== "undefined" ? localStorage.getItem("sentinel_token") || "" : ""}`}
                        controls
                        className="w-full max-h-[400px] rounded-lg bg-black"
                        preload="metadata"
                      >
                        Your browser does not support the video tag.
                      </video>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
