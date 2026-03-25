"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  Search,
  Loader2,
  Sparkles,
  User,
  Car,
  Box,
  ChevronDown,
  Clock,
  Camera,
  Tag,
  FileSearch,
  Inbox,
  Bookmark,
  BookmarkCheck,
  X,
  Image as ImageIcon,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp, API_BASE } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import type { SearchResult, Camera as CameraType, Zone } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

type SearchMode = "semantic" | "entity" | "similar";

const SEARCH_MODES: { value: SearchMode; label: string; icon: typeof Search }[] = [
  { value: "semantic", label: "Semantic", icon: Sparkles },
  { value: "entity", label: "Entity", icon: User },
  { value: "similar", label: "Similar Event", icon: FileSearch },
];

const ENTITY_TYPES = [
  { value: "person", label: "Person", icon: User },
  { value: "vehicle", label: "Vehicle", icon: Car },
  { value: "object", label: "Object", icon: Box },
];

const SAVED_KEY = "sentinel_saved_searches";

/* ------------------------------------------------------------------ */
/*  Saved search types                                                 */
/* ------------------------------------------------------------------ */

interface SavedSearch {
  name: string;
  query: string;
  mode: SearchMode;
  entityType: string;
  zoneId: string;
  cameraId: string;
  savedAt: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function eventTypeColor(eventType: string | null): string {
  if (!eventType) return "text-gray-400 bg-gray-400/10 border-gray-700";
  const map: Record<string, string> = {
    intrusion: "text-red-400 bg-red-400/10 border-red-800/60",
    loitering: "text-orange-400 bg-orange-400/10 border-orange-800/60",
    tailgating: "text-yellow-400 bg-yellow-400/10 border-yellow-800/60",
    crowd: "text-purple-400 bg-purple-400/10 border-purple-800/60",
    vehicle: "text-blue-400 bg-blue-400/10 border-blue-800/60",
    object: "text-cyan-400 bg-cyan-400/10 border-cyan-800/60",
    person: "text-emerald-400 bg-emerald-400/10 border-emerald-800/60",
    anomaly: "text-pink-400 bg-pink-400/10 border-pink-800/60",
  };
  const key = Object.keys(map).find((k) =>
    eventType.toLowerCase().includes(k)
  );
  return key ? map[key] : "text-gray-400 bg-gray-400/10 border-gray-700";
}

function scoreToPercent(score: number): number {
  return Math.min(100, Math.max(0, Math.round(score * 100)));
}

function loadSavedSearches(): SavedSearch[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    return raw ? (JSON.parse(raw) as SavedSearch[]) : [];
  } catch {
    return [];
  }
}

function persistSavedSearches(searches: SavedSearch[]): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(searches));
  } catch {}
}

/* ------------------------------------------------------------------ */
/*  ResultCard                                                         */
/* ------------------------------------------------------------------ */

interface ResultCardProps {
  result: SearchResult;
  expanded: boolean;
  onToggle: () => void;
}

function ResultCard({ result, expanded, onToggle }: ResultCardProps) {
  const relevance = scoreToPercent(result.score);
  const [showPreview, setShowPreview] = useState(false);
  const [imgError, setImgError] = useState(false);

  const snapshotUrl = result.camera_id
    ? `${API_BASE}/api/cameras/${result.camera_id}/snapshot`
    : null;

  return (
    <div
      className={cn(
        "border border-gray-800 rounded-lg transition-all duration-200",
        expanded ? "bg-gray-900/90" : "bg-gray-900/50 hover:bg-gray-900/80"
      )}
    >
      {/* Main row */}
      <button
        onClick={onToggle}
        onMouseEnter={() => setShowPreview(true)}
        onMouseLeave={() => setShowPreview(false)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {/* Event type badge */}
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
            eventTypeColor(result.event_type)
          )}
        >
          <Tag className="h-3 w-3" />
          {result.event_type || "Event"}
        </span>

        {/* Description */}
        <span className="flex-1 truncate text-sm text-gray-300">
          {result.description || "No description available"}
        </span>

        {/* Camera */}
        {result.camera_id && (
          <span className="hidden items-center gap-1 text-xs text-gray-500 md:flex">
            <Camera className="h-3 w-3" />
            {result.camera_id.slice(0, 8)}
          </span>
        )}

        {/* Timestamp */}
        {result.timestamp && (
          <span className="hidden items-center gap-1 text-xs text-gray-500 lg:flex">
            <Clock className="h-3 w-3" />
            {formatTimestamp(result.timestamp)}
          </span>
        )}

        {/* Relevance score bar */}
        <div className="flex shrink-0 items-center gap-2 w-28">
          <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                relevance >= 80
                  ? "bg-cyan-400"
                  : relevance >= 60
                    ? "bg-cyan-600"
                    : relevance >= 40
                      ? "bg-blue-500"
                      : "bg-gray-600"
              )}
              style={{ width: `${relevance}%` }}
            />
          </div>
          <span className="font-mono text-[11px] text-cyan-400 w-8 text-right">
            {relevance}%
          </span>
        </div>

        {/* Expand indicator */}
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-gray-600 transition-transform duration-200",
            expanded && "rotate-180"
          )}
        />
      </button>

      {/* Hover camera thumbnail preview */}
      {showPreview && snapshotUrl && !imgError && !expanded && (
        <div className="mx-4 mb-3 rounded-lg overflow-hidden border border-gray-700 bg-gray-800/60">
          <div className="flex items-center gap-1.5 border-b border-gray-700 px-2 py-1">
            <ImageIcon className="h-3 w-3 text-gray-500" />
            <span className="text-[10px] text-gray-500">
              Camera snapshot · {result.camera_id?.slice(0, 8)}
            </span>
          </div>
          <img
            src={snapshotUrl}
            alt={`Camera ${result.camera_id} snapshot`}
            className="w-full max-h-40 object-cover"
            onError={() => setImgError(true)}
          />
        </div>
      )}

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-gray-800 px-4 py-4 space-y-3">
          {/* Camera thumbnail in expanded view */}
          {snapshotUrl && !imgError && (
            <div className="rounded-lg overflow-hidden border border-gray-700 bg-gray-800/60">
              <div className="flex items-center gap-1.5 border-b border-gray-700 px-2 py-1">
                <Camera className="h-3 w-3 text-gray-500" />
                <span className="text-[10px] text-gray-500">Camera Frame</span>
              </div>
              <img
                src={snapshotUrl}
                alt={`Camera ${result.camera_id} snapshot`}
                className="w-full max-h-48 object-cover"
                onError={() => setImgError(true)}
              />
            </div>
          )}

          {/* Full description */}
          {result.description && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
                Description
              </h4>
              <p className="text-sm leading-relaxed text-gray-300">
                {result.description}
              </p>
            </div>
          )}

          {/* Metadata grid */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Event ID
              </span>
              <p className="mt-0.5 font-mono text-xs text-gray-400">
                {result.event_id.slice(0, 12)}...
              </p>
            </div>
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Event Type
              </span>
              <p className="mt-0.5 text-xs text-gray-400">
                {result.event_type || "N/A"}
              </p>
            </div>
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Camera
              </span>
              <p className="mt-0.5 font-mono text-xs text-gray-400">
                {result.camera_id || "N/A"}
              </p>
            </div>
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Timestamp
              </span>
              <p className="mt-0.5 text-xs text-gray-400">
                {result.timestamp ? formatTimestamp(result.timestamp) : "N/A"}
              </p>
            </div>
          </div>

          {/* Relevance details */}
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Relevance Score
            </span>
            <div className="mt-1 flex items-center gap-3">
              <div className="flex-1 h-2 rounded-full bg-gray-800 overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-500",
                    relevance >= 80
                      ? "bg-gradient-to-r from-cyan-500 to-cyan-400"
                      : relevance >= 60
                        ? "bg-gradient-to-r from-cyan-700 to-cyan-600"
                        : "bg-gradient-to-r from-blue-700 to-blue-500"
                  )}
                  style={{ width: `${relevance}%` }}
                />
              </div>
              <span className="font-mono text-sm font-semibold text-cyan-400">
                {relevance}%
              </span>
            </div>
          </div>

          {/* Extra metadata */}
          {result.metadata && Object.keys(result.metadata).length > 0 && (
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Additional Metadata
              </span>
              <div className="mt-1 rounded-lg border border-gray-800 bg-gray-950 p-2">
                <pre className="text-[11px] text-gray-400 overflow-x-auto">
                  {JSON.stringify(result.metadata, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  SemanticSearchTab                                                  */
/* ------------------------------------------------------------------ */

export default function SemanticSearchTab() {
  const { addToast } = useToast();

  /* --- State --- */
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("semantic");
  const [entityType, setEntityType] = useState("person");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Saved searches
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [showSavedDropdown, setShowSavedDropdown] = useState(false);
  const [saveNameInput, setSaveNameInput] = useState("");
  const [showSaveInput, setShowSaveInput] = useState(false);

  // Zone / camera filters
  const [zones, setZones] = useState<Zone[]>([]);
  const [cameras, setCameras] = useState<CameraType[]>([]);
  const [selectedZone, setSelectedZone] = useState("");
  const [selectedCamera, setSelectedCamera] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const saveInputRef = useRef<HTMLInputElement>(null);
  const savedDropdownRef = useRef<HTMLDivElement>(null);

  /* --- Load filter options & saved searches on mount --- */
  useEffect(() => {
    apiFetch<Zone[]>("/api/zones").then(setZones).catch(() => {});
    apiFetch<CameraType[]>("/api/cameras").then(setCameras).catch(() => {});
    setSavedSearches(loadSavedSearches());
  }, []);

  /* --- Close saved-searches dropdown on outside click --- */
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        savedDropdownRef.current &&
        !savedDropdownRef.current.contains(e.target as Node)
      ) {
        setShowSavedDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  /* --- Saved search actions --- */

  const handleSaveSearch = useCallback(() => {
    const name = saveNameInput.trim();
    if (!name) {
      addToast("error", "Please enter a name for this search.");
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      addToast("error", "Enter a search query before saving.");
      return;
    }
    const entry: SavedSearch = {
      name,
      query: trimmed,
      mode,
      entityType,
      zoneId: selectedZone,
      cameraId: selectedCamera,
      savedAt: new Date().toISOString(),
    };
    const updated = [entry, ...savedSearches.filter((s) => s.name !== name)];
    setSavedSearches(updated);
    persistSavedSearches(updated);
    setSaveNameInput("");
    setShowSaveInput(false);
    addToast("success", `Saved search "${name}".`);
  }, [saveNameInput, query, mode, entityType, selectedZone, selectedCamera, savedSearches, addToast]);

  const handleLoadSaved = useCallback((saved: SavedSearch) => {
    setQuery(saved.query);
    setMode(saved.mode);
    setEntityType(saved.entityType);
    setSelectedZone(saved.zoneId);
    setSelectedCamera(saved.cameraId);
    setShowSavedDropdown(false);
    addToast("info", `Loaded saved search "${saved.name}".`);
  }, [addToast]);

  const handleDeleteSaved = useCallback((name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = savedSearches.filter((s) => s.name !== name);
    setSavedSearches(updated);
    persistSavedSearches(updated);
    addToast("info", `Deleted saved search "${name}".`);
  }, [savedSearches, addToast]);

  /* --- Search --- */
  const handleSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);
    setHasSearched(true);
    setExpandedId(null);

    // Build optional filter params
    const filterParams: Record<string, string> = {};
    if (selectedZone) filterParams.zone_id = selectedZone;
    if (selectedCamera) filterParams.camera_id = selectedCamera;

    try {
      let resp: { results?: SearchResult[] } & Record<string, unknown>;

      if (mode === "entity") {
        resp = await apiFetch<{ results: SearchResult[] }>("/api/search/entity", {
          method: "POST",
          body: JSON.stringify({
            entity_type: entityType,
            description: trimmed,
            ...filterParams,
          }),
        });
      } else if (mode === "similar") {
        resp = await apiFetch<{ results: SearchResult[] }>("/api/search/semantic", {
          method: "POST",
          body: JSON.stringify({
            query: trimmed,
            limit: 20,
            mode: "similar",
            ...filterParams,
          }),
        });
      } else {
        resp = await apiFetch<{ results: SearchResult[] }>("/api/search/semantic", {
          method: "POST",
          body: JSON.stringify({ query: trimmed, limit: 20, ...filterParams }),
        });
      }

      setResults(Array.isArray(resp) ? resp : resp.results ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query, mode, entityType, selectedZone, selectedCamera]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleSearch();
      }
    },
    [handleSearch]
  );

  /* --- Render --- */
  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ---- Header ---- */}
      <div className="border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
            <Search className="h-5 w-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Semantic Search
            </h1>
            <p className="text-xs text-gray-500">
              Search security events using natural language queries
            </p>
          </div>
        </div>
      </div>

      {/* ---- Search controls ---- */}
      <div className="border-b border-gray-800 px-6 py-5 space-y-4">
        {/* Search input row */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-500" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                mode === "entity"
                  ? `Describe the ${entityType} you are looking for...`
                  : mode === "similar"
                    ? "Enter an event ID or describe a similar event..."
                    : "Search events... e.g. 'person near restricted zone at night'"
              }
              className={cn(
                "w-full rounded-xl border bg-gray-900 py-3.5 pl-12 pr-28 text-sm text-gray-100 placeholder-gray-600 transition-colors",
                "border-gray-700 focus:border-cyan-600 focus:outline-none focus:ring-2 focus:ring-cyan-600/30"
              )}
            />
            <button
              onClick={handleSearch}
              disabled={loading || !query.trim()}
              className={cn(
                "absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
                "bg-cyan-600 text-white hover:bg-cyan-500",
                "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-cyan-600"
              )}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              Search
            </button>
          </div>

          {/* Save button */}
          <button
            onClick={() => {
              setShowSaveInput((v) => !v);
              setShowSavedDropdown(false);
              setTimeout(() => saveInputRef.current?.focus(), 50);
            }}
            title="Save this search"
            className={cn(
              "flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-semibold transition-colors",
              showSaveInput
                ? "border-cyan-700 bg-cyan-900/30 text-cyan-400"
                : "border-gray-700 bg-gray-900 text-gray-400 hover:border-cyan-700/60 hover:text-gray-200"
            )}
          >
            {showSaveInput ? (
              <BookmarkCheck className="h-4 w-4" />
            ) : (
              <Bookmark className="h-4 w-4" />
            )}
            Save
          </button>

          {/* Saved searches dropdown trigger */}
          <div className="relative" ref={savedDropdownRef}>
            <button
              onClick={() => {
                setShowSavedDropdown((v) => !v);
                setShowSaveInput(false);
              }}
              className={cn(
                "flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-semibold transition-colors",
                showSavedDropdown
                  ? "border-cyan-700 bg-cyan-900/30 text-cyan-400"
                  : "border-gray-700 bg-gray-900 text-gray-400 hover:border-cyan-700/60 hover:text-gray-200"
              )}
            >
              <BookmarkCheck className="h-4 w-4" />
              Saved
              {savedSearches.length > 0 && (
                <span className="rounded-full bg-cyan-900/50 px-1.5 py-0.5 text-[10px] font-bold text-cyan-400">
                  {savedSearches.length}
                </span>
              )}
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 transition-transform duration-200",
                  showSavedDropdown && "rotate-180"
                )}
              />
            </button>

            {/* Dropdown */}
            {showSavedDropdown && (
              <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-xl border border-gray-700 bg-gray-900 shadow-xl">
                {savedSearches.length === 0 ? (
                  <p className="py-6 text-center text-xs text-gray-600">
                    No saved searches yet
                  </p>
                ) : (
                  <ul className="max-h-64 overflow-y-auto divide-y divide-gray-800">
                    {savedSearches.map((s) => (
                      <li key={s.name}>
                        <button
                          onClick={() => handleLoadSaved(s)}
                          className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-gray-800/60 transition-colors group"
                        >
                          <Bookmark className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-600" />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold text-gray-200 truncate">
                              {s.name}
                            </p>
                            <p className="text-[11px] text-gray-500 truncate">{s.query}</p>
                            <p className="text-[10px] text-gray-700 mt-0.5">
                              {s.mode}
                              {s.zoneId && " · zone filter"}
                              {s.cameraId && " · camera filter"}
                            </p>
                          </div>
                          <button
                            onClick={(e) => handleDeleteSaved(s.name, e)}
                            className="shrink-0 opacity-0 group-hover:opacity-100 rounded p-0.5 text-gray-600 hover:text-red-400 transition-all"
                            title="Delete saved search"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Save name input (shown when Save is clicked) */}
        {showSaveInput && (
          <div className="flex gap-2 items-center">
            <input
              ref={saveInputRef}
              type="text"
              value={saveNameInput}
              onChange={(e) => setSaveNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveSearch();
                if (e.key === "Escape") setShowSaveInput(false);
              }}
              placeholder="Name this search..."
              className="flex-1 rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-600 focus:outline-none"
            />
            <button
              onClick={handleSaveSearch}
              disabled={!saveNameInput.trim()}
              className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-600 disabled:opacity-40 transition-colors"
            >
              Save
            </button>
            <button
              onClick={() => setShowSaveInput(false)}
              className="rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-500 hover:text-gray-300 hover:border-gray-600 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Mode toggle + entity type selector */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Search mode toggle */}
          <div className="flex rounded-lg border border-gray-700 bg-gray-900 p-0.5">
            {SEARCH_MODES.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                onClick={() => setMode(value)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  mode === value
                    ? "bg-cyan-900/50 text-cyan-400 border border-cyan-800/50"
                    : "text-gray-500 hover:text-gray-300"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* Entity type selector (only in entity mode) */}
          {mode === "entity" && (
            <div className="relative">
              <select
                value={entityType}
                onChange={(e) => setEntityType(e.target.value)}
                className="appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
              >
                {ENTITY_TYPES.map((et) => (
                  <option key={et.value} value={et.value}>
                    {et.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
            </div>
          )}

          {/* Mode description */}
          <span className="text-[11px] text-gray-600">
            {mode === "semantic" &&
              "Natural language search across all security events"}
            {mode === "entity" &&
              "Find specific entities (persons, vehicles, objects) by description"}
            {mode === "similar" &&
              "Find events similar to a given event or description"}
          </span>
        </div>

        {/* Zone / camera filters */}
        <div className="flex flex-wrap gap-3">
          {/* Zone filter */}
          <div className="relative">
            <select
              value={selectedZone}
              onChange={(e) => setSelectedZone(e.target.value)}
              className="appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700 min-w-[140px]"
            >
              <option value="">All Zones</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
          </div>

          {/* Camera filter */}
          <div className="relative">
            <select
              value={selectedCamera}
              onChange={(e) => setSelectedCamera(e.target.value)}
              className="appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700 min-w-[160px]"
            >
              <option value="">All Cameras</option>
              {cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
          </div>

          {/* Active filter indicators */}
          {(selectedZone || selectedCamera) && (
            <button
              onClick={() => {
                setSelectedZone("");
                setSelectedCamera("");
              }}
              className="flex items-center gap-1 rounded-lg border border-gray-700 bg-gray-800/50 px-2.5 py-1.5 text-[11px] text-gray-500 hover:border-gray-600 hover:text-gray-300 transition-colors"
            >
              <X className="h-3 w-3" />
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* ---- Results ---- */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {/* Loading state */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="relative">
              <div className="h-12 w-12 rounded-full border-2 border-gray-800" />
              <div className="absolute inset-0 h-12 w-12 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
            </div>
            <p className="mt-4 text-sm text-gray-500">Searching events...</p>
            <p className="mt-1 text-xs text-gray-600">
              Analyzing {mode === "entity" ? "entity database" : "vector embeddings"}
            </p>
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="flex flex-col items-center justify-center py-20">
            <Search className="mb-2 h-8 w-8 text-red-500" />
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={handleSearch}
              className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty initial state (no search yet) */}
        {!loading && !error && !hasSearched && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-900 border border-gray-800">
              <Search className="h-8 w-8 text-gray-700" />
            </div>
            <p className="mt-4 text-sm font-medium text-gray-400">
              Search security events
            </p>
            <p className="mt-1 max-w-md text-center text-xs text-gray-600">
              Use natural language to search through processed security events.
              Try queries like &ldquo;unauthorized person in parking lot&rdquo; or
              &ldquo;vehicle stopped near entrance&rdquo;.
            </p>
          </div>
        )}

        {/* No results state */}
        {!loading && !error && hasSearched && results.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20">
            <Inbox className="mb-2 h-10 w-10 text-gray-700" />
            <p className="text-sm font-medium text-gray-400">
              No results found
            </p>
            <p className="mt-1 text-xs text-gray-600">
              Try adjusting your search query or switching modes
            </p>
          </div>
        )}

        {/* Results header */}
        {!loading && !error && hasSearched && results.length > 0 && (
          <div className="flex items-center justify-between pb-2">
            <span className="text-xs text-gray-500">
              <span className="font-semibold text-gray-300">{results.length}</span>{" "}
              results found
              {(selectedZone || selectedCamera) && (
                <span className="ml-1 text-gray-600">(filtered)</span>
              )}
            </span>
            <span className="text-[10px] text-gray-600">
              Sorted by relevance
            </span>
          </div>
        )}

        {/* Result cards */}
        {!loading &&
          !error &&
          results.map((result) => (
            <ResultCard
              key={result.event_id}
              result={result}
              expanded={expandedId === result.event_id}
              onToggle={() =>
                setExpandedId(
                  expandedId === result.event_id ? null : result.event_id
                )
              }
            />
          ))}
      </div>

      {/* ---- Footer ---- */}
      <div className="border-t border-gray-800 px-6 py-2">
        <p className="text-center text-[10px] text-gray-600">
          {mode === "semantic" && "Powered by vector similarity search"}
          {mode === "entity" && "Powered by entity recognition and matching"}
          {mode === "similar" && "Powered by event embedding comparison"}
          {" "}&middot; Press Enter to search
        </p>
      </div>
    </div>
  );
}
