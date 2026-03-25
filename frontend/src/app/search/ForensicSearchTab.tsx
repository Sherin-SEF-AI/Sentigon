"use client";

import { useState, useCallback, useRef, useMemo } from "react";
import {
  Search,
  Loader2,
  AlertTriangle,
  Camera,
  Clock,
  Car,
  User,
  ScanSearch,
  Upload,
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  Image as ImageIcon,
  Route,
  Filter,
  Tag,
  ArrowRight,
  Crosshair,
  Eye,
  Save,
  FolderOpen,
  Plus,
  CalendarRange,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type SearchTab = "attributes" | "vehicle" | "similarity" | "cross-camera";

interface AttributeSearchParams {
  clothing_color: string;
  gender: string;
  age_range: string;
  has_bag: boolean | null;
  has_hat: boolean | null;
  time_start: string;
  time_end: string;
  zone: string;
}

interface VehicleSearchParams {
  plate_number: string;
  make: string;
  model: string;
  color: string;
  time_start: string;
  time_end: string;
}

interface CrossCameraParams {
  entity_id: string;
  entity_type: "person" | "vehicle";
  time_start: string;
  time_end: string;
}

interface ForensicResult {
  id: string;
  camera_id: string;
  camera_name: string;
  timestamp: string;
  confidence: number;
  thumbnail_url: string | null;
  matched_attributes: Record<string, string>;
  zone: string;
  description?: string;
  bbox: { x: number; y: number; w: number; h: number } | null;
}

interface SavedSearch {
  name: string;
  tab: SearchTab;
  attrParams: AttributeSearchParams;
  vehicleParams: VehicleSearchParams;
  crossParams: CrossCameraParams;
  savedAt: string;
}

const SAVED_SEARCHES_KEY = "sentinel_forensic_searches";

interface ForensicSearchResponse {
  results: ForensicResult[];
  total: number;
  page: number;
  page_size: number;
  query_time_ms: number;
}

interface CameraWaypoint {
  camera_id: string;
  camera_name: string;
  timestamp: string;
  confidence: number;
  duration_seconds: number;
  direction: string | null;
}

interface CrossCameraResponse {
  entity_id: string;
  entity_type: string;
  journey: CameraWaypoint[];
  total_cameras: number;
  first_seen: string;
  last_seen: string;
  elapsed_minutes: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TABS: { key: SearchTab; label: string; icon: React.ReactNode }[] = [
  { key: "attributes", label: "Attribute Search", icon: <User className="h-4 w-4" /> },
  { key: "vehicle", label: "Vehicle Search", icon: <Car className="h-4 w-4" /> },
  { key: "similarity", label: "Similarity Search", icon: <ScanSearch className="h-4 w-4" /> },
  { key: "cross-camera", label: "Cross-Camera Tracking", icon: <Route className="h-4 w-4" /> },
];

const GENDER_OPTIONS = ["", "male", "female", "unknown"] as const;
const AGE_RANGE_OPTIONS = ["", "child", "teen", "young_adult", "adult", "senior"] as const;
const VEHICLE_COLOR_OPTIONS = [
  "", "white", "black", "silver", "gray", "red", "blue",
  "green", "brown", "gold", "yellow", "orange",
] as const;
const PAGE_SIZE = 20;

const DEFAULT_ATTR: AttributeSearchParams = {
  clothing_color: "",
  gender: "",
  age_range: "",
  has_bag: null,
  has_hat: null,
  time_start: "",
  time_end: "",
  zone: "",
};

const DEFAULT_VEHICLE: VehicleSearchParams = {
  plate_number: "",
  make: "",
  model: "",
  color: "",
  time_start: "",
  time_end: "",
};

const DEFAULT_CROSS: CrossCameraParams = {
  entity_id: "",
  entity_type: "person",
  time_start: "",
  time_end: "",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function confidenceColor(score: number): string {
  if (score >= 0.9) return "text-green-400";
  if (score >= 0.75) return "text-cyan-400";
  if (score >= 0.5) return "text-yellow-400";
  return "text-red-400";
}

function confidenceBg(score: number): string {
  if (score >= 0.9) return "bg-green-500/15 border-green-500/30";
  if (score >= 0.75) return "bg-cyan-500/15 border-cyan-500/30";
  if (score >= 0.5) return "bg-yellow-500/15 border-yellow-500/30";
  return "bg-red-500/15 border-red-500/30";
}

function stripEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== "" && v !== null && v !== undefined) cleaned[k] = v;
  }
  return cleaned;
}

/* ------------------------------------------------------------------ */
/*  Shared form components                                             */
/* ------------------------------------------------------------------ */

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium text-gray-400 mb-1.5">
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        "w-full rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2 text-sm text-gray-200",
        "placeholder:text-gray-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/40",
        "transition-colors",
        className
      )}
    />
  );
}

function SelectInput({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  placeholder?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "w-full rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2 text-sm text-gray-200",
        "focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/40",
        "transition-colors appearance-none cursor-pointer"
      )}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.filter(Boolean).map((opt) => (
        <option key={opt} value={opt}>
          {opt.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
        </option>
      ))}
    </select>
  );
}

function DateTimeInput({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
}) {
  return (
    <div>
      {label && <FieldLabel>{label}</FieldLabel>}
      <input
        type="datetime-local"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "w-full rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2 text-sm text-gray-200",
          "focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/40",
          "transition-colors [color-scheme:dark]"
        )}
      />
    </div>
  );
}

function TriStateToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const opts: { label: string; val: boolean | null }[] = [
    { label: "Any", val: null },
    { label: "Yes", val: true },
    { label: "No", val: false },
  ];
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex gap-1">
        {opts.map((o) => (
          <button
            key={o.label}
            onClick={() => onChange(o.val)}
            className={cn(
              "flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
              value === o.val
                ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/40"
                : "bg-gray-800/60 text-gray-400 border border-gray-700 hover:border-gray-600"
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Result Card                                                        */
/* ------------------------------------------------------------------ */

function ResultCard({
  result,
  onCreateIncident,
}: {
  result: ForensicResult;
  onCreateIncident: (result: ForensicResult) => void;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="group rounded-xl border border-gray-800 bg-zinc-900/70 hover:border-gray-700 transition-all overflow-hidden">
      {/* Thumbnail area */}
      <div className="relative h-40 bg-gray-800/50 flex items-center justify-center overflow-hidden">
        {result.thumbnail_url ? (
          <img
            src={result.thumbnail_url}
            alt="Detection thumbnail"
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-gray-600">
            <ImageIcon className="h-8 w-8" />
            <span className="text-[10px]">No thumbnail</span>
          </div>
        )}
        {/* Confidence badge */}
        <div
          className={cn(
            "absolute top-2 right-2 rounded-md border px-2 py-0.5 text-xs font-bold tabular-nums",
            confidenceBg(result.confidence),
            confidenceColor(result.confidence)
          )}
        >
          {(result.confidence * 100).toFixed(1)}%
        </div>
      </div>

      {/* Info section */}
      <div className="p-3 space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-200">
          <Camera className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
          <span className="truncate">{result.camera_name}</span>
        </div>

        <div className="flex items-center gap-2 text-xs text-gray-400">
          <Clock className="h-3 w-3 shrink-0" />
          <span>{fmtTimestamp(result.timestamp)}</span>
        </div>

        {result.zone && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <Crosshair className="h-3 w-3 shrink-0" />
            <span>{result.zone}</span>
          </div>
        )}

        {/* Matched attributes */}
        {Object.keys(result.matched_attributes).length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {Object.entries(result.matched_attributes).map(([key, val]) => (
              <span
                key={key}
                className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 border border-cyan-500/20 px-2 py-0.5 text-[10px] text-cyan-400"
              >
                <Tag className="h-2.5 w-2.5" />
                {key}: {val}
              </span>
            ))}
          </div>
        )}

        {/* Create Incident button */}
        <button
          onClick={() => {
            setCreating(true);
            onCreateIncident(result);
            setTimeout(() => setCreating(false), 2000);
          }}
          disabled={creating}
          className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg border border-orange-800/40 bg-orange-900/20 px-2 py-1.5 text-[10px] font-medium text-orange-400 hover:bg-orange-900/30 hover:border-orange-700/50 transition-colors disabled:opacity-50"
        >
          {creating ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Plus className="h-3 w-3" />
          )}
          {creating ? "Creating..." : "Create Incident"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Journey Timeline                                                   */
/* ------------------------------------------------------------------ */

function JourneyTimeline({ journey }: { journey: CameraWaypoint[] }) {
  if (journey.length === 0) return null;

  return (
    <div className="space-y-1">
      {journey.map((wp, idx) => (
        <div key={`${wp.camera_id}-${idx}`} className="flex items-stretch gap-3">
          {/* Timeline connector */}
          <div className="flex flex-col items-center w-6">
            <div
              className={cn(
                "h-3 w-3 rounded-full border-2 mt-1.5 shrink-0",
                idx === 0
                  ? "bg-cyan-400 border-cyan-400"
                  : idx === journey.length - 1
                  ? "bg-red-400 border-red-400"
                  : "bg-gray-700 border-gray-500"
              )}
            />
            {idx < journey.length - 1 && (
              <div className="flex-1 w-px bg-gray-700 min-h-[24px]" />
            )}
          </div>

          {/* Waypoint card */}
          <div className="flex-1 rounded-lg border border-gray-800 bg-zinc-900/70 px-4 py-3 mb-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Camera className="h-3.5 w-3.5 text-cyan-400" />
                <span className="text-sm font-medium text-gray-200">
                  {wp.camera_name}
                </span>
              </div>
              <span
                className={cn(
                  "text-xs font-bold tabular-nums",
                  confidenceColor(wp.confidence)
                )}
              >
                {(wp.confidence * 100).toFixed(1)}%
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-4 text-xs text-gray-400">
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {fmtTimestamp(wp.timestamp)}
              </span>
              {wp.duration_seconds > 0 && (
                <span>Dwelled {wp.duration_seconds}s</span>
              )}
              {wp.direction && (
                <span className="flex items-center gap-1">
                  <ArrowRight className="h-3 w-3" />
                  {wp.direction}
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ForensicSearchTab                                                  */
/* ------------------------------------------------------------------ */

export default function ForensicSearchTab() {
  const { addToast } = useToast();

  /* --- Tab state --- */
  const [activeTab, setActiveTab] = useState<SearchTab>("attributes");

  /* --- Attribute search state --- */
  const [attrParams, setAttrParams] = useState<AttributeSearchParams>({
    ...DEFAULT_ATTR,
  });

  /* --- Vehicle search state --- */
  const [vehicleParams, setVehicleParams] = useState<VehicleSearchParams>({
    ...DEFAULT_VEHICLE,
  });

  /* --- Similarity search state --- */
  const [similarityFile, setSimilarityFile] = useState<File | null>(null);
  const [similarityPreview, setSimilarityPreview] = useState<string | null>(
    null
  );
  const [similarityThreshold, setSimilarityThreshold] = useState("0.7");
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* --- Cross-camera state --- */
  const [crossParams, setCrossParams] = useState<CrossCameraParams>({
    ...DEFAULT_CROSS,
  });
  const [crossResult, setCrossResult] = useState<CrossCameraResponse | null>(
    null
  );

  /* --- Shared results state --- */
  const [results, setResults] = useState<ForensicResult[]>([]);
  const [totalResults, setTotalResults] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [queryTimeMs, setQueryTimeMs] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* --- Saved search templates --- */
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem(SAVED_SEARCHES_KEY);
      return raw ? (JSON.parse(raw) as SavedSearch[]) : [];
    } catch {
      return [];
    }
  });
  const [saveSearchName, setSaveSearchName] = useState("");
  const [showSaveInput, setShowSaveInput] = useState(false);

  /* --- Temporal filter (client-side post-filter) --- */
  const [temporalStart, setTemporalStart] = useState("");
  const [temporalEnd, setTemporalEnd] = useState("");

  /* ── Attribute search ──────────────────────────────────────── */

  const searchAttributes = useCallback(
    async (page = 1) => {
      setLoading(true);
      setError(null);
      setCrossResult(null);
      try {
        const body = stripEmpty({
          clothing_color: attrParams.clothing_color,
          gender: attrParams.gender,
          age_range: attrParams.age_range,
          has_bag: attrParams.has_bag,
          has_hat: attrParams.has_hat,
          time_start: attrParams.time_start
            ? new Date(attrParams.time_start).toISOString()
            : undefined,
          time_end: attrParams.time_end
            ? new Date(attrParams.time_end).toISOString()
            : undefined,
          zone: attrParams.zone,
          page,
          page_size: PAGE_SIZE,
        });

        const data = await apiFetch<ForensicSearchResponse>(
          "/api/forensic-search/attributes",
          { method: "POST", body: JSON.stringify(body) }
        );

        setResults(data.results);
        setTotalResults(data.total);
        setCurrentPage(data.page);
        setQueryTimeMs(data.query_time_ms);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Attribute search failed"
        );
        setResults([]);
        setTotalResults(0);
      } finally {
        setLoading(false);
      }
    },
    [attrParams]
  );

  /* ── Vehicle search ────────────────────────────────────────── */

  const searchVehicle = useCallback(
    async (page = 1) => {
      setLoading(true);
      setError(null);
      setCrossResult(null);
      try {
        const body = stripEmpty({
          plate_number: vehicleParams.plate_number,
          make: vehicleParams.make,
          model: vehicleParams.model,
          color: vehicleParams.color,
          time_start: vehicleParams.time_start
            ? new Date(vehicleParams.time_start).toISOString()
            : undefined,
          time_end: vehicleParams.time_end
            ? new Date(vehicleParams.time_end).toISOString()
            : undefined,
          page,
          page_size: PAGE_SIZE,
        });

        const data = await apiFetch<ForensicSearchResponse>(
          "/api/forensic-search/vehicle",
          { method: "POST", body: JSON.stringify(body) }
        );

        setResults(data.results);
        setTotalResults(data.total);
        setCurrentPage(data.page);
        setQueryTimeMs(data.query_time_ms);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Vehicle search failed"
        );
        setResults([]);
        setTotalResults(0);
      } finally {
        setLoading(false);
      }
    },
    [vehicleParams]
  );

  /* ── Similarity search ─────────────────────────────────────── */

  const searchSimilarity = useCallback(
    async (page = 1) => {
      if (!similarityFile) {
        setError("Please upload a reference image first");
        return;
      }
      setLoading(true);
      setError(null);
      setCrossResult(null);
      try {
        const formData = new FormData();
        formData.append("image", similarityFile);
        formData.append("threshold", similarityThreshold);
        formData.append("page", String(page));
        formData.append("page_size", String(PAGE_SIZE));

        const data = await apiFetch<ForensicSearchResponse>(
          "/api/forensic-search/similarity",
          {
            method: "POST",
            body: formData,
            headers: {}, // Let browser set Content-Type with multipart boundary
          }
        );

        setResults(data.results);
        setTotalResults(data.total);
        setCurrentPage(data.page);
        setQueryTimeMs(data.query_time_ms);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Similarity search failed"
        );
        setResults([]);
        setTotalResults(0);
      } finally {
        setLoading(false);
      }
    },
    [similarityFile, similarityThreshold]
  );

  /* ── Cross-camera tracking ─────────────────────────────────── */

  const searchCrossCamera = useCallback(async () => {
    if (!crossParams.entity_id.trim()) {
      setError("Please enter a person or vehicle ID");
      return;
    }
    setLoading(true);
    setError(null);
    setResults([]);
    setTotalResults(0);
    try {
      const body = stripEmpty({
        entity_id: crossParams.entity_id.trim(),
        entity_type: crossParams.entity_type,
        time_start: crossParams.time_start
          ? new Date(crossParams.time_start).toISOString()
          : undefined,
        time_end: crossParams.time_end
          ? new Date(crossParams.time_end).toISOString()
          : undefined,
      });

      const data = await apiFetch<CrossCameraResponse>(
        "/api/forensic-search/cross-camera",
        { method: "POST", body: JSON.stringify(body) }
      );

      setCrossResult(data);
      setQueryTimeMs(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Cross-camera tracking failed"
      );
      setCrossResult(null);
    } finally {
      setLoading(false);
    }
  }, [crossParams]);

  /* ── Unified search dispatcher ─────────────────────────────── */

  const handleSearch = useCallback(
    (page = 1) => {
      switch (activeTab) {
        case "attributes":
          return searchAttributes(page);
        case "vehicle":
          return searchVehicle(page);
        case "similarity":
          return searchSimilarity(page);
        case "cross-camera":
          return searchCrossCamera();
      }
    },
    [activeTab, searchAttributes, searchVehicle, searchSimilarity, searchCrossCamera]
  );

  /* ── File upload handler ───────────────────────────────────── */

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        setError("Please select a valid image file (JPEG, PNG, WebP)");
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError("Image must be smaller than 10 MB");
        return;
      }
      setSimilarityFile(file);
      const reader = new FileReader();
      reader.onload = (ev) =>
        setSimilarityPreview(ev.target?.result as string);
      reader.readAsDataURL(file);
      setError(null);
    },
    []
  );

  const clearFile = useCallback(() => {
    setSimilarityFile(null);
    setSimilarityPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  /* ── Tab change handler ────────────────────────────────────── */

  const handleTabChange = useCallback((tab: SearchTab) => {
    setActiveTab(tab);
    setError(null);
    setResults([]);
    setTotalResults(0);
    setCurrentPage(1);
    setQueryTimeMs(null);
    setCrossResult(null);
  }, []);

  /* ── Pagination ────────────────────────────────────────────── */

  const totalPages = Math.ceil(totalResults / PAGE_SIZE);

  const goToPage = useCallback(
    (page: number) => {
      if (page < 1 || page > totalPages) return;
      handleSearch(page);
    },
    [handleSearch, totalPages]
  );

  /* ── Export results ────────────────────────────────────────── */

  const handleExport = useCallback(() => {
    const exportData =
      activeTab === "cross-camera" && crossResult
        ? crossResult
        : results.map((r) => ({
            id: r.id,
            camera: r.camera_name,
            timestamp: r.timestamp,
            confidence: r.confidence,
            zone: r.zone,
            attributes: r.matched_attributes,
          }));
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `forensic-search-${activeTab}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [results, activeTab, crossResult]);

  /* ── Saved search templates ────────────────────────────────── */

  const handleSaveSearch = useCallback(() => {
    const name = saveSearchName.trim();
    if (!name) return;
    const entry: SavedSearch = {
      name,
      tab: activeTab,
      attrParams: { ...attrParams },
      vehicleParams: { ...vehicleParams },
      crossParams: { ...crossParams },
      savedAt: new Date().toISOString(),
    };
    setSavedSearches((prev) => {
      const updated = [...prev.filter((s) => s.name !== name), entry];
      try { localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(updated)); } catch {}
      return updated;
    });
    setSaveSearchName("");
    setShowSaveInput(false);
    addToast("success", `Search "${name}" saved`);
  }, [saveSearchName, activeTab, attrParams, vehicleParams, crossParams, addToast]);

  const handleLoadSearch = useCallback((saved: SavedSearch) => {
    setActiveTab(saved.tab);
    setAttrParams({ ...saved.attrParams });
    setVehicleParams({ ...saved.vehicleParams });
    setCrossParams({ ...saved.crossParams });
    setResults([]);
    setTotalResults(0);
    setCurrentPage(1);
    setError(null);
    setCrossResult(null);
    addToast("info", `Loaded search "${saved.name}"`);
  }, [addToast]);

  const handleDeleteSavedSearch = useCallback((name: string) => {
    setSavedSearches((prev) => {
      const updated = prev.filter((s) => s.name !== name);
      try { localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(updated)); } catch {}
      return updated;
    });
  }, []);

  /* ── Create incident from result ───────────────────────────── */

  const handleCreateIncident = useCallback(async (result: ForensicResult) => {
    try {
      const attrs = Object.entries(result.matched_attributes)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      const title = `Forensic match: ${result.camera_name} @ ${fmtTimestamp(result.timestamp)}`;
      const description =
        result.description ||
        `Forensic detection on camera ${result.camera_name} in zone "${result.zone}". Matched attributes: ${attrs || "none"}. Confidence: ${(result.confidence * 100).toFixed(1)}%.`;
      await apiFetch("/api/incidents", {
        method: "POST",
        body: JSON.stringify({
          title,
          description,
          severity: "medium",
        }),
      });
      addToast("success", "Incident created successfully");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create incident";
      addToast("error", msg);
    }
  }, [addToast]);

  /* ── Temporal filtering (client-side) ──────────────────────── */

  const temporallyFilteredResults = useMemo(() => {
    if (!temporalStart && !temporalEnd) return results;
    const start = temporalStart ? new Date(temporalStart).getTime() : -Infinity;
    const end = temporalEnd ? new Date(temporalEnd).getTime() : Infinity;
    return results.filter((r) => {
      const t = new Date(r.timestamp).getTime();
      return t >= start && t <= end;
    });
  }, [results, temporalStart, temporalEnd]);

  /* ── Derived ───────────────────────────────────────────────── */

  const hasExportable =
    results.length > 0 || (activeTab === "cross-camera" && crossResult);

  /* ── Render ────────────────────────────────────────────────── */

  return (
    <div className="min-h-full bg-[#030712] text-gray-200">
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="border-b border-gray-800 bg-zinc-900/50 backdrop-blur-sm">
        <div className="mx-auto max-w-7xl px-6 py-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-500/10 border border-cyan-500/20">
                <ScanSearch className="h-5 w-5 text-cyan-400" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-white">
                  Forensic Video Search
                </h1>
                <p className="text-xs text-gray-500">
                  Search across all cameras using attributes, vehicles, visual
                  similarity, or cross-camera tracking
                </p>
              </div>
            </div>
            {hasExportable && (
              <button
                onClick={handleExport}
                className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2 text-xs text-gray-300 hover:border-gray-600 hover:text-white transition-colors"
              >
                <Download className="h-3.5 w-3.5" />
                Export Results
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-6 py-6 space-y-6">
        {/* ── Tab Navigation ──────────────────────────────────── */}
        <div className="flex gap-1 rounded-xl border border-gray-800 bg-zinc-900/50 p-1">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => handleTabChange(tab.key)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all flex-1 justify-center",
                activeTab === tab.key
                  ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 shadow-lg shadow-cyan-500/5"
                  : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/40 border border-transparent"
              )}
            >
              {tab.icon}
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* ── Saved Search Templates ──────────────────────────── */}
        <div className="rounded-xl border border-gray-800 bg-zinc-900/50 p-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-xs font-medium text-gray-400">
              <Save className="h-3.5 w-3.5 text-cyan-400" />
              Saved Searches
            </div>

            {/* Load dropdown */}
            {savedSearches.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                {savedSearches.map((s) => (
                  <div key={s.name} className="flex items-center gap-0.5">
                    <button
                      onClick={() => handleLoadSearch(s)}
                      className="flex items-center gap-1 rounded-l-md border border-gray-700 bg-gray-800/60 px-2 py-1 text-[10px] text-gray-300 hover:text-white hover:border-gray-600 transition-colors"
                    >
                      <FolderOpen className="h-2.5 w-2.5" />
                      {s.name}
                    </button>
                    <button
                      onClick={() => handleDeleteSavedSearch(s.name)}
                      className="flex items-center rounded-r-md border border-l-0 border-gray-700 bg-gray-800/60 px-1.5 py-1 text-[10px] text-gray-500 hover:text-red-400 hover:border-gray-600 transition-colors"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Save current search */}
            {showSaveInput ? (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={saveSearchName}
                  onChange={(e) => setSaveSearchName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSaveSearch(); if (e.key === "Escape") setShowSaveInput(false); }}
                  placeholder="Search name..."
                  autoFocus
                  className="rounded-md border border-gray-700 bg-gray-800/60 px-2 py-1 text-xs text-gray-200 placeholder:text-gray-600 focus:border-cyan-500 focus:outline-none w-36"
                />
                <button
                  onClick={handleSaveSearch}
                  disabled={!saveSearchName.trim()}
                  className="rounded-md border border-cyan-700/50 bg-cyan-900/30 px-2 py-1 text-[10px] font-medium text-cyan-400 hover:bg-cyan-900/50 disabled:opacity-40 transition-colors"
                >
                  Save
                </button>
                <button
                  onClick={() => { setShowSaveInput(false); setSaveSearchName(""); }}
                  className="rounded-md border border-gray-700 bg-gray-800/60 px-2 py-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowSaveInput(true)}
                className="flex items-center gap-1 rounded-md border border-gray-700 bg-gray-800/60 px-2.5 py-1 text-[10px] font-medium text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
              >
                <Save className="h-3 w-3" />
                Save Search
              </button>
            )}
          </div>
        </div>

        {/* ── Temporal Filter ──────────────────────────────────── */}
        <div className="rounded-xl border border-gray-800 bg-zinc-900/50 px-5 py-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-xs font-medium text-gray-400 shrink-0">
              <CalendarRange className="h-3.5 w-3.5 text-cyan-400" />
              Temporal Filter
              <span className="text-gray-600 font-normal">(filters displayed results)</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap flex-1">
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-gray-500 shrink-0">From</label>
                <input
                  type="datetime-local"
                  value={temporalStart}
                  onChange={(e) => setTemporalStart(e.target.value)}
                  className="rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-1.5 text-xs text-gray-200 focus:border-cyan-500 focus:outline-none [color-scheme:dark]"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-gray-500 shrink-0">To</label>
                <input
                  type="datetime-local"
                  value={temporalEnd}
                  onChange={(e) => setTemporalEnd(e.target.value)}
                  className="rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-1.5 text-xs text-gray-200 focus:border-cyan-500 focus:outline-none [color-scheme:dark]"
                />
              </div>
              {(temporalStart || temporalEnd) && (
                <button
                  onClick={() => { setTemporalStart(""); setTemporalEnd(""); }}
                  className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                >
                  <X className="h-3 w-3" /> Clear
                </button>
              )}
              {(temporalStart || temporalEnd) && results.length > 0 && (
                <span className="text-[10px] text-cyan-400 tabular-nums">
                  {temporallyFilteredResults.length} / {results.length} shown
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ── Search Form ─────────────────────────────────────── */}
        <div className="rounded-xl border border-gray-800 bg-zinc-900/50 p-6">
          {/* ---- Attribute Search Form ---- */}
          {activeTab === "attributes" && (
            <div className="space-y-5">
              <div className="flex items-center gap-2 mb-1">
                <Filter className="h-4 w-4 text-cyan-400" />
                <h2 className="text-sm font-semibold text-gray-200">
                  Person Attribute Search
                </h2>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <FieldLabel>Clothing Color</FieldLabel>
                  <TextInput
                    value={attrParams.clothing_color}
                    onChange={(v) =>
                      setAttrParams((p) => ({ ...p, clothing_color: v }))
                    }
                    placeholder="e.g. red, blue jacket"
                  />
                </div>
                <div>
                  <FieldLabel>Gender</FieldLabel>
                  <SelectInput
                    value={attrParams.gender}
                    onChange={(v) =>
                      setAttrParams((p) => ({ ...p, gender: v }))
                    }
                    options={GENDER_OPTIONS}
                    placeholder="Any gender"
                  />
                </div>
                <div>
                  <FieldLabel>Age Range</FieldLabel>
                  <SelectInput
                    value={attrParams.age_range}
                    onChange={(v) =>
                      setAttrParams((p) => ({ ...p, age_range: v }))
                    }
                    options={AGE_RANGE_OPTIONS}
                    placeholder="Any age"
                  />
                </div>
                <TriStateToggle
                  label="Carrying Bag"
                  value={attrParams.has_bag}
                  onChange={(v) =>
                    setAttrParams((p) => ({ ...p, has_bag: v }))
                  }
                />
                <TriStateToggle
                  label="Wearing Hat"
                  value={attrParams.has_hat}
                  onChange={(v) =>
                    setAttrParams((p) => ({ ...p, has_hat: v }))
                  }
                />
                <div>
                  <FieldLabel>Zone Filter</FieldLabel>
                  <TextInput
                    value={attrParams.zone}
                    onChange={(v) =>
                      setAttrParams((p) => ({ ...p, zone: v }))
                    }
                    placeholder="e.g. lobby, parking-a"
                  />
                </div>
              </div>

              {/* Time range */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <DateTimeInput
                  label="From"
                  value={attrParams.time_start}
                  onChange={(v) =>
                    setAttrParams((p) => ({ ...p, time_start: v }))
                  }
                />
                <DateTimeInput
                  label="To"
                  value={attrParams.time_end}
                  onChange={(v) =>
                    setAttrParams((p) => ({ ...p, time_end: v }))
                  }
                />
              </div>

              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={() => handleSearch(1)}
                  disabled={loading}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-all",
                    "bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed",
                    "shadow-lg shadow-cyan-600/20"
                  )}
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                  Search Attributes
                </button>
                <button
                  onClick={() => setAttrParams({ ...DEFAULT_ATTR })}
                  className="rounded-lg border border-gray-700 px-4 py-2.5 text-sm text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {/* ---- Vehicle Search Form ---- */}
          {activeTab === "vehicle" && (
            <div className="space-y-5">
              <div className="flex items-center gap-2 mb-1">
                <Car className="h-4 w-4 text-cyan-400" />
                <h2 className="text-sm font-semibold text-gray-200">
                  Vehicle Search
                </h2>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <FieldLabel>Plate Number</FieldLabel>
                  <TextInput
                    value={vehicleParams.plate_number}
                    onChange={(v) =>
                      setVehicleParams((p) => ({
                        ...p,
                        plate_number: v.toUpperCase(),
                      }))
                    }
                    placeholder="e.g. ABC1234"
                    className="uppercase tracking-wider font-mono"
                  />
                </div>
                <div>
                  <FieldLabel>Make</FieldLabel>
                  <TextInput
                    value={vehicleParams.make}
                    onChange={(v) =>
                      setVehicleParams((p) => ({ ...p, make: v }))
                    }
                    placeholder="e.g. Toyota, Ford"
                  />
                </div>
                <div>
                  <FieldLabel>Model</FieldLabel>
                  <TextInput
                    value={vehicleParams.model}
                    onChange={(v) =>
                      setVehicleParams((p) => ({ ...p, model: v }))
                    }
                    placeholder="e.g. Camry, F-150"
                  />
                </div>
                <div>
                  <FieldLabel>Color</FieldLabel>
                  <SelectInput
                    value={vehicleParams.color}
                    onChange={(v) =>
                      setVehicleParams((p) => ({ ...p, color: v }))
                    }
                    options={VEHICLE_COLOR_OPTIONS}
                    placeholder="Any color"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <DateTimeInput
                  label="From"
                  value={vehicleParams.time_start}
                  onChange={(v) =>
                    setVehicleParams((p) => ({ ...p, time_start: v }))
                  }
                />
                <DateTimeInput
                  label="To"
                  value={vehicleParams.time_end}
                  onChange={(v) =>
                    setVehicleParams((p) => ({ ...p, time_end: v }))
                  }
                />
              </div>

              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={() => handleSearch(1)}
                  disabled={loading}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-all",
                    "bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed",
                    "shadow-lg shadow-cyan-600/20"
                  )}
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                  Search Vehicles
                </button>
                <button
                  onClick={() => setVehicleParams({ ...DEFAULT_VEHICLE })}
                  className="rounded-lg border border-gray-700 px-4 py-2.5 text-sm text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {/* ---- Similarity Search Form ---- */}
          {activeTab === "similarity" && (
            <div className="space-y-5">
              <div className="flex items-center gap-2 mb-1">
                <Eye className="h-4 w-4 text-cyan-400" />
                <h2 className="text-sm font-semibold text-gray-200">
                  Visual Similarity Search (CLIP Embeddings)
                </h2>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Upload zone */}
                <div>
                  <FieldLabel>Reference Image</FieldLabel>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                  {similarityPreview ? (
                    <div className="relative rounded-xl border border-gray-700 bg-gray-800/40 overflow-hidden">
                      <img
                        src={similarityPreview}
                        alt="Reference preview"
                        className="w-full h-48 object-contain"
                      />
                      <button
                        onClick={clearFile}
                        className="absolute top-2 right-2 rounded-full bg-gray-900/80 p-1.5 text-gray-400 hover:text-white transition-colors"
                      >
                        <X className="h-4 w-4" />
                      </button>
                      <div className="absolute bottom-2 left-2 rounded-md bg-gray-900/80 px-2 py-1 text-[10px] text-gray-400">
                        {similarityFile?.name} (
                        {((similarityFile?.size || 0) / 1024).toFixed(0)} KB)
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className={cn(
                        "w-full h-48 rounded-xl border-2 border-dashed border-gray-700 bg-gray-800/30",
                        "flex flex-col items-center justify-center gap-3",
                        "text-gray-500 hover:text-gray-300 hover:border-gray-500 transition-all cursor-pointer"
                      )}
                    >
                      <Upload className="h-8 w-8" />
                      <div className="text-center">
                        <p className="text-sm font-medium">
                          Click to upload reference image
                        </p>
                        <p className="text-xs mt-1">
                          JPEG, PNG, or WebP up to 10 MB
                        </p>
                      </div>
                    </button>
                  )}
                </div>

                {/* Settings */}
                <div className="space-y-4">
                  <div>
                    <FieldLabel>Similarity Threshold</FieldLabel>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min="0.3"
                        max="0.99"
                        step="0.01"
                        value={similarityThreshold}
                        onChange={(e) =>
                          setSimilarityThreshold(e.target.value)
                        }
                        className="flex-1 accent-cyan-500 h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                      />
                      <span className="text-sm font-mono text-cyan-400 w-12 text-right tabular-nums">
                        {Number(similarityThreshold).toFixed(2)}
                      </span>
                    </div>
                    <p className="text-[10px] text-gray-600 mt-1">
                      Higher threshold = fewer but more accurate matches
                    </p>
                  </div>

                  <div className="rounded-lg border border-gray-800 bg-gray-800/30 p-3">
                    <p className="text-xs text-gray-400 leading-relaxed">
                      Upload a reference image of a person, vehicle, or
                      object. The system will use CLIP neural embeddings to
                      find visually similar detections across all indexed
                      cameras and time ranges.
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={() => handleSearch(1)}
                  disabled={loading || !similarityFile}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-all",
                    "bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed",
                    "shadow-lg shadow-cyan-600/20"
                  )}
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ScanSearch className="h-4 w-4" />
                  )}
                  Find Similar
                </button>
                <button
                  onClick={() => {
                    clearFile();
                    setSimilarityThreshold("0.7");
                  }}
                  className="rounded-lg border border-gray-700 px-4 py-2.5 text-sm text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {/* ---- Cross-Camera Form ---- */}
          {activeTab === "cross-camera" && (
            <div className="space-y-5">
              <div className="flex items-center gap-2 mb-1">
                <Route className="h-4 w-4 text-cyan-400" />
                <h2 className="text-sm font-semibold text-gray-200">
                  Cross-Camera Journey Tracking
                </h2>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <FieldLabel>Person / Vehicle ID</FieldLabel>
                  <TextInput
                    value={crossParams.entity_id}
                    onChange={(v) =>
                      setCrossParams((p) => ({ ...p, entity_id: v }))
                    }
                    placeholder="e.g. PERSON-0042, VEH-1189"
                  />
                </div>
                <div>
                  <FieldLabel>Entity Type</FieldLabel>
                  <div className="flex gap-2">
                    {(["person", "vehicle"] as const).map((type) => (
                      <button
                        key={type}
                        onClick={() =>
                          setCrossParams((p) => ({
                            ...p,
                            entity_type: type,
                          }))
                        }
                        className={cn(
                          "flex-1 flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                          crossParams.entity_type === type
                            ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/40"
                            : "bg-gray-800/60 text-gray-400 border border-gray-700 hover:border-gray-600"
                        )}
                      >
                        {type === "person" ? (
                          <User className="h-3.5 w-3.5" />
                        ) : (
                          <Car className="h-3.5 w-3.5" />
                        )}
                        {type.charAt(0).toUpperCase() + type.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <DateTimeInput
                  label="From"
                  value={crossParams.time_start}
                  onChange={(v) =>
                    setCrossParams((p) => ({ ...p, time_start: v }))
                  }
                />
                <DateTimeInput
                  label="To"
                  value={crossParams.time_end}
                  onChange={(v) =>
                    setCrossParams((p) => ({ ...p, time_end: v }))
                  }
                />
              </div>

              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={() => handleSearch()}
                  disabled={loading || !crossParams.entity_id.trim()}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-all",
                    "bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed",
                    "shadow-lg shadow-cyan-600/20"
                  )}
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Route className="h-4 w-4" />
                  )}
                  Track Journey
                </button>
                <button
                  onClick={() => setCrossParams({ ...DEFAULT_CROSS })}
                  className="rounded-lg border border-gray-700 px-4 py-2.5 text-sm text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Error Banner ────────────────────────────────────── */}
        {error && (
          <div className="flex items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
            <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
            <p className="text-sm text-red-300 flex-1">{error}</p>
            <button
              onClick={() => setError(null)}
              className="text-red-400 hover:text-red-300 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* ── Loading State ───────────────────────────────────── */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="h-8 w-8 text-cyan-400 animate-spin mb-3" />
            <p className="text-sm text-gray-400">
              Searching across indexed video...
            </p>
          </div>
        )}

        {/* ── Cross-Camera Journey Results ────────────────────── */}
        {!loading && activeTab === "cross-camera" && crossResult && (
          <div className="space-y-4">
            {/* Journey summary cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-xl border border-gray-800 bg-zinc-900/50 px-4 py-3 text-center">
                <div className="text-lg font-bold text-cyan-400 tabular-nums">
                  {crossResult.total_cameras}
                </div>
                <div className="text-[11px] text-gray-500">
                  Cameras Visited
                </div>
              </div>
              <div className="rounded-xl border border-gray-800 bg-zinc-900/50 px-4 py-3 text-center">
                <div className="text-lg font-bold text-cyan-400 tabular-nums">
                  {crossResult.journey.length}
                </div>
                <div className="text-[11px] text-gray-500">Waypoints</div>
              </div>
              <div className="rounded-xl border border-gray-800 bg-zinc-900/50 px-4 py-3 text-center">
                <div className="text-lg font-bold text-yellow-400 tabular-nums">
                  {crossResult.elapsed_minutes.toFixed(1)}m
                </div>
                <div className="text-[11px] text-gray-500">
                  Total Duration
                </div>
              </div>
              <div className="rounded-xl border border-gray-800 bg-zinc-900/50 px-4 py-3 text-center">
                <div className="text-sm font-medium text-gray-300 truncate">
                  {crossResult.entity_id}
                </div>
                <div className="text-[11px] text-gray-500 capitalize">
                  {crossResult.entity_type}
                </div>
              </div>
            </div>

            {/* Time range bar */}
            {crossResult.first_seen && crossResult.last_seen && (
              <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/30 px-4 py-2.5 text-xs text-gray-400">
                <Clock className="h-3.5 w-3.5 text-cyan-400" />
                <span>
                  First seen: {fmtTimestamp(crossResult.first_seen)}
                </span>
                <ArrowRight className="h-3 w-3 text-gray-600" />
                <span>
                  Last seen: {fmtTimestamp(crossResult.last_seen)}
                </span>
              </div>
            )}

            {/* Timeline */}
            <div className="rounded-xl border border-gray-800 bg-zinc-900/50 p-5">
              <h3 className="text-sm font-semibold text-gray-200 mb-4 flex items-center gap-2">
                <Route className="h-4 w-4 text-cyan-400" />
                Journey Timeline
              </h3>
              <JourneyTimeline journey={crossResult.journey} />
            </div>
          </div>
        )}

        {/* ── Grid Results (Attributes, Vehicle, Similarity) ── */}
        {!loading && activeTab !== "cross-camera" && results.length > 0 && (
          <div className="space-y-4">
            {/* Results header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-semibold text-gray-200">
                  {temporallyFilteredResults.length !== results.length
                    ? `${temporallyFilteredResults.length} of ${totalResults.toLocaleString()} result${totalResults !== 1 ? "s" : ""} (filtered)`
                    : `${totalResults.toLocaleString()} result${totalResults !== 1 ? "s" : ""} found`
                  }
                </h3>
                {queryTimeMs !== null && (
                  <span className="text-[10px] text-gray-600 tabular-nums">
                    ({queryTimeMs.toFixed(0)} ms)
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-500 tabular-nums">
                Page {currentPage} of {totalPages}
              </div>
            </div>

            {/* Results grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {temporallyFilteredResults.map((result) => (
                <ResultCard
                  key={result.id}
                  result={result}
                  onCreateIncident={handleCreateIncident}
                />
              ))}
            </div>
            {temporallyFilteredResults.length === 0 && (temporalStart || temporalEnd) && (
              <div className="flex flex-col items-center justify-center py-10 text-gray-600">
                <CalendarRange className="h-8 w-8 mb-2 opacity-40" />
                <p className="text-sm">No results match the selected time window</p>
                <p className="text-xs mt-1">Adjust or clear the temporal filter above</p>
              </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-2">
                <button
                  onClick={() => goToPage(currentPage - 1)}
                  disabled={currentPage <= 1}
                  className={cn(
                    "flex items-center gap-1 rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-400 transition-colors",
                    currentPage <= 1
                      ? "opacity-40 cursor-not-allowed"
                      : "hover:border-gray-600 hover:text-gray-200"
                  )}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  Previous
                </button>

                {/* Page number buttons */}
                <div className="flex gap-1">
                  {Array.from(
                    { length: Math.min(totalPages, 7) },
                    (_, i) => {
                      let pageNum: number;
                      if (totalPages <= 7) {
                        pageNum = i + 1;
                      } else if (currentPage <= 4) {
                        pageNum = i + 1;
                      } else if (currentPage >= totalPages - 3) {
                        pageNum = totalPages - 6 + i;
                      } else {
                        pageNum = currentPage - 3 + i;
                      }
                      return (
                        <button
                          key={pageNum}
                          onClick={() => goToPage(pageNum)}
                          className={cn(
                            "h-8 w-8 rounded-lg text-xs font-medium transition-colors tabular-nums",
                            pageNum === currentPage
                              ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                              : "text-gray-500 hover:text-gray-300 border border-transparent hover:border-gray-700"
                          )}
                        >
                          {pageNum}
                        </button>
                      );
                    }
                  )}
                </div>

                <button
                  onClick={() => goToPage(currentPage + 1)}
                  disabled={currentPage >= totalPages}
                  className={cn(
                    "flex items-center gap-1 rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-400 transition-colors",
                    currentPage >= totalPages
                      ? "opacity-40 cursor-not-allowed"
                      : "hover:border-gray-600 hover:text-gray-200"
                  )}
                >
                  Next
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Empty State ─────────────────────────────────────── */}
        {!loading && !error && results.length === 0 && !crossResult && (
          <div className="flex flex-col items-center justify-center py-20 text-gray-600">
            <Search className="h-12 w-12 mb-4 opacity-30" />
            <p className="text-sm">
              Enter search criteria above and run a query
            </p>
            <p className="text-xs mt-1 text-gray-700">
              Results will appear here from indexed video across all cameras
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
