"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  Sparkles,
  Search,
  Upload,
  Camera,
  AlertTriangle,
  Loader2,
  ChevronDown,
  Cpu,
  Zap,
  Eye,
  Image as ImageIcon,
  X,
  RefreshCw,
  Activity,
  Clock,
  BarChart3,
  Info,
  Download,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";
import ConfidenceSlider from "@/components/common/ConfidenceSlider";
import { exportCSV } from "@/lib/export";
import { useToast } from "@/components/common/Toaster";
import type {
  VisualSearchResult,
  VisualSearchResponse,
  CLIPStats,
  VisualAnomaly,
  CLIPCamera,
} from "@/lib/types";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8002";

const HISTORY_KEY = "sentinel_visual_searches";
const HISTORY_MAX = 10;

type SearchMode = "text" | "image" | "camera";

/* ── Search History helpers ─────────────────────────────── */

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveToHistory(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return loadHistory();
  const existing = loadHistory().filter((q) => q !== trimmed);
  const updated = [trimmed, ...existing].slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  } catch {}
  return updated;
}

/* ── Main Tab ─────────────────────────────────────────── */

export default function VisualSearchTab() {
  const { addToast } = useToast();

  // Search state
  const [mode, setMode] = useState<SearchMode>("text");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VisualSearchResult[]>([]);
  const [searchType, setSearchType] = useState("");
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Confidence threshold state
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.3);

  // Search history state
  const [searchHistory, setSearchHistory] = useState<string[]>([]);

  // Image upload state
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Camera state
  const [cameras, setCameras] = useState<CLIPCamera[]>([]);
  const [selectedCamera, setSelectedCamera] = useState("");

  // Stats & anomalies
  const [stats, setStats] = useState<CLIPStats | null>(null);
  const [anomalies, setAnomalies] = useState<VisualAnomaly[]>([]);
  const [expandedResult, setExpandedResult] = useState<string | null>(null);

  // Panel state
  const [showAnomalies, setShowAnomalies] = useState(true);

  // ── Load initial data ──────────────────────────────────

  useEffect(() => {
    apiFetch<CLIPStats>("/api/visual-search/stats")
      .then(setStats)
      .catch(() => {});
    apiFetch<CLIPCamera[]>("/api/visual-search/cameras")
      .then((cams) => {
        setCameras(cams);
        if (cams.length > 0) setSelectedCamera(cams[0].camera_id);
      })
      .catch(() => {});
    apiFetch<VisualAnomaly[]>("/api/visual-search/anomalies?limit=20")
      .then(setAnomalies)
      .catch(() => {});
    // Load search history from localStorage
    setSearchHistory(loadHistory());
  }, []);

  // ── Filtered results ───────────────────────────────────

  const filteredResults = results.filter((r) => r.score >= confidenceThreshold);

  // ── Search handlers ────────────────────────────────────

  const handleTextSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setLoading(true);
    setError("");
    try {
      const resp = await apiFetch<VisualSearchResponse>("/api/visual-search/text", {
        method: "POST",
        body: JSON.stringify({ query: trimmed, top_k: 24, min_score: 0.12 }),
      });
      setResults(resp.results);
      setTotal(resp.total);
      setSearchType(resp.search_type);
      // Save to history
      const updated = saveToHistory(trimmed);
      setSearchHistory(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query]);

  const handleImageSearch = useCallback(async () => {
    if (!uploadFile) return;
    setLoading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("file", uploadFile);
      const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const resp = await fetch(`${API}/api/visual-search/image?top_k=24&min_score=0.4`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data: VisualSearchResponse = await resp.json();
      setResults(data.results);
      setTotal(data.total);
      setSearchType(data.search_type);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Image search failed");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [uploadFile]);

  const handleCameraSearch = useCallback(async () => {
    if (!selectedCamera) return;
    setLoading(true);
    setError("");
    try {
      const resp = await apiFetch<VisualSearchResponse>(
        `/api/visual-search/frame/${selectedCamera}`,
        {
          method: "POST",
          body: JSON.stringify({ top_k: 24, min_score: 0.4 }),
        }
      );
      setResults(resp.results);
      setTotal(resp.total);
      setSearchType(resp.search_type);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Camera search failed");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [selectedCamera]);

  const handleSearch = useCallback(() => {
    if (mode === "text") handleTextSearch();
    else if (mode === "image") handleImageSearch();
    else handleCameraSearch();
  }, [mode, handleTextSearch, handleImageSearch, handleCameraSearch]);

  // ── History chip click ─────────────────────────────────

  const handleHistoryClick = useCallback((histQuery: string) => {
    setMode("text");
    setQuery(histQuery);
  }, []);

  // ── Export handler ─────────────────────────────────────

  const handleExport = useCallback(() => {
    if (filteredResults.length === 0) {
      addToast("error", "No results to export.");
      return;
    }
    try {
      exportCSV(
        filteredResults.map((r) => ({
          score: r.score,
          description: String(r.metadata?.description ?? ""),
          camera_id: r.camera_id,
          timestamp: r.timestamp,
        })),
        `visual-search-results-${Date.now()}.csv`,
        [
          { key: "score", label: "Score" },
          { key: "description", label: "Description" },
          { key: "camera_id", label: "Camera ID" },
          { key: "timestamp", label: "Timestamp" },
        ]
      );
      addToast("success", `Exported ${filteredResults.length} results as CSV.`);
    } catch {
      addToast("error", "Export failed. Please try again.");
    }
  }, [filteredResults, addToast]);

  // ── File upload handling ────────────────────────────────

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) {
      setUploadFile(file);
      setUploadPreview(URL.createObjectURL(file));
    }
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadFile(file);
      setUploadPreview(URL.createObjectURL(file));
    }
  }, []);

  const clearUpload = useCallback(() => {
    setUploadFile(null);
    setUploadPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  // ── Refresh stats ──────────────────────────────────────

  const refreshStats = useCallback(() => {
    apiFetch<CLIPStats>("/api/visual-search/stats")
      .then(setStats)
      .catch(() => {});
    apiFetch<VisualAnomaly[]>("/api/visual-search/anomalies?limit=20")
      .then(setAnomalies)
      .catch(() => {});
  }, []);

  // ── Render ─────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ── Header ──────────────────────────────────────── */}
      <header className="flex items-center justify-between border-b border-gray-800 px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-900/40 border border-violet-700/50">
            <Sparkles className="h-5 w-5 text-violet-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-100">Visual Search</h1>
            <p className="text-xs text-gray-500">CLIP ViT-B/32 cross-modal video embedding</p>
          </div>
        </div>

        {/* Model status badge */}
        <div className="flex items-center gap-3">
          {stats && (
            <>
              <div className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wider border",
                stats.model_loaded
                  ? "border-emerald-700/50 bg-emerald-900/30 text-emerald-400"
                  : "border-yellow-700/50 bg-yellow-900/30 text-yellow-400"
              )}>
                <Cpu className="h-3 w-3" />
                {stats.model_loaded ? stats.device.toUpperCase() : "LOADING"}
              </div>
              <div className="flex items-center gap-1.5 rounded-full border border-gray-700/50 bg-gray-900/50 px-3 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                <Zap className="h-3 w-3 text-cyan-400" />
                {stats.frames_embedded.toLocaleString()} frames
              </div>
            </>
          )}
          <button
            onClick={refreshStats}
            className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-800/50 hover:text-gray-300 transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Main Content ────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {/* ── Search Controls ───────────────────────── */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-5 space-y-4">
            {/* Mode Tabs */}
            <div className="flex gap-1 rounded-lg bg-gray-800/60 p-1">
              {([
                { key: "text" as SearchMode, label: "Text Search", icon: Search },
                { key: "image" as SearchMode, label: "Image Upload", icon: Upload },
                { key: "camera" as SearchMode, label: "Camera Frame", icon: Camera },
              ]).map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setMode(key)}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-semibold transition-all",
                    mode === key
                      ? "bg-violet-600 text-white shadow-sm"
                      : "text-gray-400 hover:text-gray-200 hover:bg-gray-700/50"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>

            {/* Text Search Input */}
            {mode === "text" && (
              <div className="space-y-3">
                <div className="flex gap-3">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                    <input
                      type="text"
                      placeholder="Describe what you're looking for... (e.g. &quot;person in red jacket near entrance&quot;)"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                      className="w-full rounded-lg border border-gray-700 bg-gray-800/60 pl-10 pr-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                    />
                  </div>
                  <button
                    onClick={handleSearch}
                    disabled={loading || !query.trim()}
                    className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
                  </button>
                </div>

                {/* Search history chips */}
                {searchHistory.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {searchHistory.map((h, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleHistoryClick(h)}
                        title={h}
                        className="inline-flex items-center gap-1 rounded-full border border-gray-700 bg-gray-800/50 px-2.5 py-1 text-[11px] text-gray-400 hover:border-violet-600/60 hover:text-gray-200 hover:bg-gray-800 transition-colors max-w-[160px]"
                      >
                        <Clock className="h-2.5 w-2.5 shrink-0 text-gray-600" />
                        <span className="truncate">{h}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Image Upload */}
            {mode === "image" && (
              <div className="space-y-3">
                {!uploadPreview ? (
                  <div
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleFileDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-700 bg-gray-800/30 py-10 hover:border-violet-600/50 hover:bg-gray-800/50 transition-all"
                  >
                    <Upload className="h-8 w-8 text-gray-600 mb-2" />
                    <p className="text-sm font-medium text-gray-400">
                      Drop an image here or click to browse
                    </p>
                    <p className="mt-1 text-xs text-gray-600">JPEG, PNG up to 10MB</p>
                  </div>
                ) : (
                  <div className="relative">
                    <img
                      src={uploadPreview}
                      alt="Upload preview"
                      className="max-h-48 rounded-lg border border-gray-700 object-contain"
                    />
                    <button
                      onClick={clearUpload}
                      className="absolute -top-2 -right-2 rounded-full bg-red-600 p-1 text-white hover:bg-red-500"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <button
                  onClick={handleSearch}
                  disabled={loading || !uploadFile}
                  className="w-full rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" /> Searching...
                    </span>
                  ) : (
                    "Find Similar Frames"
                  )}
                </button>
              </div>
            )}

            {/* Camera Frame */}
            {mode === "camera" && (
              <div className="flex gap-3">
                <select
                  value={selectedCamera}
                  onChange={(e) => setSelectedCamera(e.target.value)}
                  className="flex-1 rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2.5 text-sm text-gray-100 focus:border-violet-500 focus:outline-none"
                >
                  {cameras.map((cam) => (
                    <option key={cam.camera_id} value={cam.camera_id}>
                      {cam.name} {cam.location ? `(${cam.location})` : ""} — {cam.status}
                    </option>
                  ))}
                </select>
                <button
                  onClick={handleSearch}
                  disabled={loading || !selectedCamera}
                  className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Use Current Frame"}
                </button>
              </div>
            )}
          </div>

          {/* ── Error ─────────────────────────────────── */}
          {error && (
            <div className="rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* ── Results Header + Confidence Slider ────── */}
          {results.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-gray-300">
                  <span className="text-violet-400">{filteredResults.length}</span>
                  {filteredResults.length !== total && (
                    <span className="text-gray-600"> / {total}</span>
                  )}{" "}
                  matching frames
                  <span className="ml-2 text-xs text-gray-500">
                    ({searchType} search)
                  </span>
                </p>
                {/* Export button */}
                <button
                  onClick={handleExport}
                  disabled={filteredResults.length === 0}
                  className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-1.5 text-xs font-semibold text-gray-300 hover:border-violet-600/60 hover:text-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <Download className="h-3.5 w-3.5" />
                  Export Results
                </button>
              </div>

              {/* Confidence threshold slider */}
              <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-3">
                <ConfidenceSlider
                  value={confidenceThreshold}
                  onChange={setConfidenceThreshold}
                  label="Min Confidence Threshold"
                  showPercent
                />
              </div>
            </div>
          )}

          {/* ── Results Grid ──────────────────────────── */}
          {filteredResults.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filteredResults.map((r, i) => (
                <ResultCard
                  key={r.point_id || i}
                  result={r}
                  rank={i + 1}
                  expanded={expandedResult === r.point_id}
                  onToggle={() =>
                    setExpandedResult(
                      expandedResult === r.point_id ? null : r.point_id
                    )
                  }
                  cameras={cameras}
                />
              ))}
            </div>
          ) : (
            !loading &&
            !error && (
              <div className="flex flex-col items-center justify-center py-20">
                <Sparkles className="h-10 w-10 text-gray-700 mb-2" />
                <p className="text-sm font-medium text-gray-400">
                  {total === 0 && searchType
                    ? results.length > 0
                      ? "All results filtered by confidence threshold"
                      : "No matching frames found"
                    : "Search across all cameras using natural language"}
                </p>
                <p className="mt-1 text-xs text-gray-600">
                  Powered by CLIP ViT-B/32 cross-modal embeddings (512d)
                </p>
              </div>
            )
          )}

          {/* ── Loading ───────────────────────────────── */}
          {loading && (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="relative h-12 w-12">
                <div className="absolute inset-0 rounded-full border-2 border-violet-500/20" />
                <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-violet-500" />
              </div>
              <p className="mt-4 text-sm text-gray-400">
                Encoding {mode === "text" ? "text" : "image"} via CLIP...
              </p>
            </div>
          )}
        </div>

        {/* ── Right Sidebar ────────────────────────────── */}
        <aside className="hidden lg:flex w-80 flex-col border-l border-gray-800 bg-gray-950">
          {/* Stats Panel */}
          <div className="border-b border-gray-800 p-4 space-y-3">
            <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-400">
              <BarChart3 className="h-3.5 w-3.5" />
              Pipeline Stats
            </h3>
            {stats ? (
              <div className="grid grid-cols-2 gap-2">
                <StatCard
                  label="Model"
                  value={stats.model_loaded ? "Loaded" : "Offline"}
                  color={stats.model_loaded ? "emerald" : "red"}
                />
                <StatCard label="Device" value={stats.device.toUpperCase()} color="cyan" />
                <StatCard
                  label="Avg Latency"
                  value={`${stats.avg_inference_ms.toFixed(0)}ms`}
                  color="violet"
                />
                <StatCard
                  label="Collection"
                  value={stats.collection_size.toLocaleString()}
                  color="blue"
                />
                <StatCard
                  label="Cameras"
                  value={String(stats.cameras_tracking)}
                  color="cyan"
                />
                <StatCard
                  label="Interval"
                  value={`${stats.embed_interval_s}s`}
                  color="gray"
                />
                <StatCard
                  label="Inferences"
                  value={stats.total_inferences.toLocaleString()}
                  color="violet"
                />
                <StatCard
                  label="Retention"
                  value={`${stats.retention_hours}h`}
                  color="gray"
                />
              </div>
            ) : (
              <div className="space-y-2">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-8 animate-pulse rounded bg-gray-800/60" />
                ))}
              </div>
            )}
          </div>

          {/* Anomalies Panel */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <button
              onClick={() => setShowAnomalies(!showAnomalies)}
              className="flex w-full items-center justify-between text-xs font-bold uppercase tracking-wider text-gray-400"
            >
              <span className="flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 text-orange-400" />
                Visual Anomalies
                {anomalies.length > 0 && (
                  <span className="rounded-full bg-orange-900/40 px-1.5 py-0.5 text-[10px] font-bold text-orange-400">
                    {anomalies.length}
                  </span>
                )}
              </span>
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 transition-transform duration-200",
                  showAnomalies && "rotate-180"
                )}
              />
            </button>

            {showAnomalies && (
              <div className="space-y-2">
                {anomalies.length > 0 ? (
                  anomalies.map((a, i) => (
                    <AnomalyCard key={i} anomaly={a} cameras={cameras} />
                  ))
                ) : (
                  <p className="text-xs text-gray-600 py-4 text-center">
                    No anomalies detected yet
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Model Info Footer */}
          {stats && (
            <div className="border-t border-gray-800 p-3">
              <div className="flex items-center gap-2 text-[10px] text-gray-600">
                <Info className="h-3 w-3" />
                <span>{stats.model_name} | {stats.embedding_dim}d | Threshold: {stats.anomaly_threshold}</span>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ── Result Card Component ──────────────────────────────── */

function ResultCard({
  result,
  rank,
  expanded,
  onToggle,
  cameras,
}: {
  result: VisualSearchResult;
  rank: number;
  expanded: boolean;
  onToggle: () => void;
  cameras: CLIPCamera[];
}) {
  const cam = cameras.find((c) => c.camera_id === result.camera_id);
  const scorePercent = Math.round(result.score * 100);
  const snapshotUrl = `${API}/api/visual-search/snapshot/${result.camera_id}`;

  return (
    <div
      className={cn(
        "group rounded-lg border bg-gray-900/50 overflow-hidden transition-all duration-200",
        result.is_anomaly ? "border-orange-800/60" : "border-gray-800",
        expanded && "ring-1 ring-violet-500/40"
      )}
    >
      {/* Thumbnail */}
      <div className="relative aspect-video bg-gray-800/60 overflow-hidden">
        <img
          src={snapshotUrl}
          alt={`Camera ${result.camera_id}`}
          className="h-full w-full object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
        {/* Rank badge */}
        <div className="absolute top-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
          #{rank}
        </div>
        {/* Score badge */}
        <div className={cn(
          "absolute top-2 right-2 rounded-md px-1.5 py-0.5 text-[10px] font-bold backdrop-blur-sm",
          scorePercent >= 70 ? "bg-emerald-600/80 text-white" :
          scorePercent >= 40 ? "bg-cyan-600/80 text-white" :
          "bg-gray-600/80 text-gray-200"
        )}>
          {scorePercent}%
        </div>
        {/* Anomaly indicator */}
        {result.is_anomaly && (
          <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-orange-600/80 px-1.5 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
            <AlertTriangle className="h-2.5 w-2.5" />
            Anomaly
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-200 truncate">
            {cam?.name || `Camera ${result.camera_id.slice(0, 8)}`}
          </span>
          <button
            onClick={onToggle}
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-200",
                expanded && "rotate-180"
              )}
            />
          </button>
        </div>

        {/* Score bar */}
        <div className="h-1.5 w-full rounded-full bg-gray-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-violet-600 to-cyan-500 transition-all"
            style={{ width: `${Math.min(scorePercent, 100)}%` }}
          />
        </div>

        <div className="flex items-center justify-between text-[10px] text-gray-500">
          <span className="flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" />
            {result.timestamp ? formatTimestamp(result.timestamp) : "—"}
          </span>
          {cam?.location && (
            <span className="truncate max-w-[120px]">{cam.location}</span>
          )}
        </div>

        {/* Expanded details */}
        {expanded && (
          <div className="mt-2 space-y-1.5 border-t border-gray-800 pt-2">
            <DetailRow label="Camera ID" value={result.camera_id.slice(0, 12) + "..."} />
            <DetailRow label="Similarity" value={`${(result.score * 100).toFixed(1)}%`} />
            <DetailRow label="Anomaly Score" value={result.anomaly_score.toFixed(3)} />
            <DetailRow label="Point ID" value={result.point_id.slice(0, 12) + "..."} />
            {Object.entries(result.metadata).map(([k, v]) => (
              <DetailRow key={k} label={k} value={String(v)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Stat Card Component ────────────────────────────────── */

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    emerald: "text-emerald-400 bg-emerald-900/20 border-emerald-800/40",
    cyan: "text-cyan-400 bg-cyan-900/20 border-cyan-800/40",
    violet: "text-violet-400 bg-violet-900/20 border-violet-800/40",
    blue: "text-blue-400 bg-blue-900/20 border-blue-800/40",
    red: "text-red-400 bg-red-900/20 border-red-800/40",
    orange: "text-orange-400 bg-orange-900/20 border-orange-800/40",
    gray: "text-gray-400 bg-gray-800/40 border-gray-700/40",
  };

  return (
    <div className={cn("rounded-lg border p-2", colorMap[color] || colorMap.gray)}>
      <p className="text-[10px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className={cn("text-sm font-bold", colorMap[color]?.split(" ")[0] || "text-gray-300")}>
        {value}
      </p>
    </div>
  );
}

/* ── Anomaly Card Component ─────────────────────────────── */

function AnomalyCard({
  anomaly,
  cameras,
}: {
  anomaly: VisualAnomaly;
  cameras: CLIPCamera[];
}) {
  const cam = cameras.find((c) => c.camera_id === anomaly.camera_id);
  const scorePct = Math.round(anomaly.anomaly_score * 100);

  return (
    <div className="rounded-lg border border-orange-800/40 bg-orange-900/10 p-2.5 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-orange-300">
          {cam?.name || anomaly.camera_id.slice(0, 8)}
        </span>
        <span className="rounded bg-orange-800/40 px-1.5 py-0.5 text-[10px] font-bold text-orange-400">
          {scorePct}% drift
        </span>
      </div>
      <div className="flex items-center gap-1 text-[10px] text-gray-500">
        <Clock className="h-2.5 w-2.5" />
        {anomaly.timestamp ? formatTimestamp(anomaly.timestamp) : "—"}
      </div>
    </div>
  );
}

/* ── Detail Row Component ───────────────────────────────── */

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-[10px]">
      <span className="text-gray-500">{label}</span>
      <span className="font-mono text-gray-300">{value}</span>
    </div>
  );
}
