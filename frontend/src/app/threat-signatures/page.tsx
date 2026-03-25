"use client";

import { useState, useEffect } from "react";
import {
  Fingerprint,
  Search,
  Filter,
  Plus,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Loader2,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Sparkles,
  BarChart3,
  TrendingUp,
  Shield,
  AlertTriangle,
  X,
  FlaskConical,
  Flag,
  Camera,
} from "lucide-react";
import { apiFetch, cn, severityColor } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Signature {
  id: string | null;
  name: string;
  category: string;
  severity: string;
  detection_method: string;
  description: string;
  yolo_classes: string[];
  gemini_keywords: string[];
  conditions: Record<string, unknown>;
  is_active: boolean;
  source: string;
  detection_count: number;
  false_positive_count?: number;
  last_detected_at: string | null;
  learned_from_event_id: string | null;
  created_at: string | null;
}

interface CategoryInfo {
  category: string;
  count: number;
  severities: Record<string, number>;
}

interface SignatureStats {
  total_signatures: number;
  active_signatures: number;
  built_in_count: number;
  auto_learned_count: number;
  custom_count: number;
  categories: number;
  top_triggered: { name: string; category: string; detection_count: number; last_detected_at: string | null }[];
  recently_learned: { name: string; category: string; severity: string; created_at: string | null }[];
}

interface DetectionExample {
  id: string;
  timestamp: string;
  camera_source: string;
  camera_name?: string;
  description?: string;
}

/* ------------------------------------------------------------------ */
/*  Category display config                                            */
/* ------------------------------------------------------------------ */

const CATEGORY_COLORS: Record<string, string> = {
  intrusion: "bg-red-500/15 text-red-400 border-red-500/30",
  suspicious: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  violence: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  theft: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  vehicle: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  safety: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  occupancy: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
  operational: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  behavioral: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  compliance: "bg-teal-500/15 text-teal-400 border-teal-500/30",
  cyber_physical: "bg-indigo-500/15 text-indigo-400 border-indigo-500/30",
  insider_threat: "bg-fuchsia-500/15 text-fuchsia-400 border-fuchsia-500/30",
  terrorism: "bg-red-600/15 text-red-300 border-red-600/30",
  child_safety: "bg-pink-500/15 text-pink-400 border-pink-500/30",
  animal_threat: "bg-lime-500/15 text-lime-400 border-lime-500/30",
  infrastructure: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  medical_biohazard: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  retail_commercial: "bg-violet-500/15 text-violet-400 border-violet-500/30",
  parking: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  active_shooter: "bg-red-700/20 text-red-300 border-red-700/40",
  escape_evasion: "bg-gray-500/15 text-gray-400 border-gray-500/30",
  social_unrest: "bg-amber-600/15 text-amber-300 border-amber-600/30",
};

const SEVERITY_BADGES: Record<string, string> = {
  critical: "bg-red-500/20 text-red-400 border border-red-500/40",
  high: "bg-orange-500/20 text-orange-400 border border-orange-500/40",
  medium: "bg-yellow-500/20 text-yellow-400 border border-yellow-500/40",
  low: "bg-blue-400/20 text-blue-400 border border-blue-400/40",
  info: "bg-gray-500/20 text-gray-400 border border-gray-500/40",
};

const SOURCE_BADGES: Record<string, string> = {
  built_in: "bg-cyan-500/15 text-cyan-400",
  auto_learned: "bg-emerald-500/15 text-emerald-400",
  custom: "bg-purple-500/15 text-purple-400",
};

const METHOD_LABELS: Record<string, string> = {
  yolo: "YOLO",
  gemini: "Gemini",
  hybrid: "Hybrid",
};

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function ThreatSignaturesPage() {
  const { addToast } = useToast();

  const [signatures, setSignatures] = useState<Signature[]>([]);
  const [categories, setCategories] = useState<CategoryInfo[]>([]);
  const [stats, setStats] = useState<SignatureStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [filterCategory, setFilterCategory] = useState<string>("");
  const [filterSeverity, setFilterSeverity] = useState<string>("");
  const [filterSource, setFilterSource] = useState<string>("");
  const [filterMethod, setFilterMethod] = useState<string>("");
  const [showInactive, setShowInactive] = useState(false);

  // UI state
  const [activeTab, setActiveTab] = useState<"all" | "learned" | "stats">("all");
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Per-signature feature state
  // testResults: sigKey -> { loading, result }
  const [testResults, setTestResults] = useState<Record<string, { loading: boolean; matches?: number }>>({});
  // detectionExamples: sigKey -> { loading, items, notAvailable }
  const [detectionExamples, setDetectionExamples] = useState<
    Record<string, { loading: boolean; items: DetectionExample[]; notAvailable?: boolean }>
  >({});
  // expanded detail panels (show detection examples)
  const [expandedDetail, setExpandedDetail] = useState<Set<string>>(new Set());

  // Create form
  const [newSig, setNewSig] = useState({
    name: "", category: "", severity: "medium", detection_method: "gemini",
    description: "", gemini_keywords: "",
  });
  const [creating, setCreating] = useState(false);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [sigs, cats, st] = await Promise.all([
        apiFetch<Signature[]>(`/api/threat-signatures?active_only=${!showInactive}`),
        apiFetch<CategoryInfo[]>("/api/threat-signatures/categories"),
        apiFetch<SignatureStats>("/api/threat-signatures/stats"),
      ]);
      setSignatures(sigs);
      setCategories(cats);
      setStats(st);
      setError(null);

      // Auto-expand categories with few items
      const autoExpand = new Set<string>();
      cats.forEach(c => { if (c.count <= 8) autoExpand.add(c.category); });
      setExpandedCategories(autoExpand);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load signatures");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, [showInactive]);

  const toggleCategory = (cat: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };

  const expandAll = () => {
    setExpandedCategories(new Set(categories.map(c => c.category)));
  };

  const collapseAll = () => {
    setExpandedCategories(new Set());
  };

  // Filter signatures
  const filtered = signatures.filter(s => {
    if (filterCategory && s.category !== filterCategory) return false;
    if (filterSeverity && s.severity !== filterSeverity) return false;
    if (filterSource && s.source !== filterSource) return false;
    if (filterMethod && s.detection_method !== filterMethod) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.gemini_keywords.some(k => k.toLowerCase().includes(q))
      );
    }
    return true;
  });

  // Group by category
  const grouped = filtered.reduce<Record<string, Signature[]>>((acc, s) => {
    if (!acc[s.category]) acc[s.category] = [];
    acc[s.category].push(s);
    return acc;
  }, {});

  const sortedCategories = Object.keys(grouped).sort();

  const handleToggle = async (sig: Signature) => {
    const key = sig.id || sig.name;
    try {
      await apiFetch(`/api/threat-signatures/${encodeURIComponent(key)}/toggle`, { method: "POST" });
      await fetchAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Toggle failed");
    }
  };

  const handleDelete = async (sig: Signature) => {
    if (sig.source === "built_in") return;
    if (!confirm(`Delete signature "${sig.name}"?`)) return;
    const key = sig.id || sig.name;
    try {
      await apiFetch(`/api/threat-signatures/${encodeURIComponent(key)}`, { method: "DELETE" });
      await fetchAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const handleCreate = async () => {
    if (!newSig.name || !newSig.category) return;
    setCreating(true);
    try {
      await apiFetch("/api/threat-signatures", {
        method: "POST",
        body: JSON.stringify({
          ...newSig,
          gemini_keywords: newSig.gemini_keywords.split(",").map(k => k.trim()).filter(Boolean),
        }),
      });
      setNewSig({ name: "", category: "", severity: "medium", detection_method: "gemini", description: "", gemini_keywords: "" });
      setShowCreateForm(false);
      await fetchAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  };

  /* ---- Feature: Test signature ---- */
  const handleTest = async (sig: Signature) => {
    const key = sig.id || sig.name;
    setTestResults(prev => ({ ...prev, [key]: { loading: true } }));
    try {
      const result = await apiFetch<{ matched_events: number; hours: number }>(
        `/api/threat-signatures/${encodeURIComponent(key)}/test`,
        { method: "POST", body: JSON.stringify({ hours: 24 }) }
      );
      const matches = result?.matched_events ?? 0;
      setTestResults(prev => ({ ...prev, [key]: { loading: false, matches } }));
      addToast("info", `"${sig.name}" would have matched ${matches} event${matches !== 1 ? "s" : ""} in the last 24h`);
    } catch (e: unknown) {
      setTestResults(prev => ({ ...prev, [key]: { loading: false } }));
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("404") || msg.includes("Not Found")) {
        addToast("info", `Test endpoint not available for "${sig.name}"`);
      } else {
        addToast("error", `Test failed: ${msg || "Unknown error"}`);
      }
    }
  };

  /* ---- Feature: Mark false positive on a detection ---- */
  const handleMarkFP = async (sig: Signature, detectionId: string) => {
    const key = sig.id || sig.name;
    try {
      await apiFetch(`/api/threat-signatures/${encodeURIComponent(key)}/false-positive`, {
        method: "POST",
        body: JSON.stringify({ detection_id: detectionId }),
      });
      addToast("success", "Marked as false positive. Signature model will adapt.");
      // Refresh detection examples for this sig
      fetchDetectionExamples(sig);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("404") || msg.includes("Not Found")) {
        addToast("info", "False positive recorded (endpoint not yet available).");
      } else {
        addToast("error", `Could not mark false positive: ${msg || "Unknown error"}`);
      }
    }
  };

  /* ---- Feature: Fetch detection examples ---- */
  const fetchDetectionExamples = async (sig: Signature) => {
    const key = sig.id || sig.name;
    setDetectionExamples(prev => ({ ...prev, [key]: { loading: true, items: [] } }));
    try {
      const data = await apiFetch<DetectionExample[]>(
        `/api/threat-signatures/${encodeURIComponent(key)}/detections?limit=3`
      );
      setDetectionExamples(prev => ({
        ...prev,
        [key]: { loading: false, items: Array.isArray(data) ? data : [] },
      }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("404") || msg.includes("Not Found")) {
        setDetectionExamples(prev => ({
          ...prev,
          [key]: { loading: false, items: [], notAvailable: true },
        }));
      } else {
        setDetectionExamples(prev => ({ ...prev, [key]: { loading: false, items: [] } }));
      }
    }
  };

  /* ---- Toggle detail panel (fetch examples on first open) ---- */
  const toggleDetail = (sig: Signature) => {
    const key = sig.id || sig.name;
    setExpandedDetail(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        if (!detectionExamples[key]) {
          fetchDetectionExamples(sig);
        }
      }
      return next;
    });
  };

  /* ---- False positive rate calculation ---- */
  const fpRate = (sig: Signature): string | null => {
    if (sig.detection_count === 0) return null;
    const fpCount = sig.false_positive_count ?? 0;
    const rate = (fpCount / sig.detection_count) * 100;
    return `${rate.toFixed(1)}%`;
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800/60 bg-gray-950/50 px-6 py-4">
        <div className="flex items-center gap-3">
          <Fingerprint className="h-6 w-6 text-cyan-400" />
          <div>
            <h1 className="text-lg font-bold text-gray-100">Threat Signature Library</h1>
            <p className="text-xs text-gray-500">
              {stats?.total_signatures || 0} signatures across {stats?.categories || 0} categories
              {stats && stats.auto_learned_count > 0 && (
                <span className="ml-2 text-emerald-400">
                  {stats.auto_learned_count} auto-learned
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCreateForm(true)}
            className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-500 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" /> Add Custom
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-6 mt-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto"><X className="h-3 w-3" /></button>
        </div>
      )}

      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 px-6 py-4">
          <StatCard label="Total" value={stats.total_signatures} icon={<Fingerprint className="h-4 w-4 text-cyan-400" />} />
          <StatCard label="Active" value={stats.active_signatures} icon={<Shield className="h-4 w-4 text-emerald-400" />} />
          <StatCard label="Built-in" value={stats.built_in_count} icon={<Eye className="h-4 w-4 text-blue-400" />} />
          <StatCard label="Auto-Learned" value={stats.auto_learned_count} icon={<Sparkles className="h-4 w-4 text-emerald-400" />} />
          <StatCard label="Custom" value={stats.custom_count} icon={<Plus className="h-4 w-4 text-purple-400" />} />
          <StatCard label="Categories" value={stats.categories} icon={<BarChart3 className="h-4 w-4 text-amber-400" />} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 px-6 border-b border-gray-800/60">
        {(["all", "learned", "stats"] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-4 py-2 text-xs font-medium border-b-2 transition-colors capitalize",
              activeTab === tab
                ? "border-cyan-400 text-cyan-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            )}
          >
            {tab === "all" ? "All Signatures" : tab === "learned" ? "Auto-Learned" : "Statistics"}
          </button>
        ))}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {activeTab === "all" && (
          <>
            {/* Filters */}
            <div className="flex flex-wrap items-center gap-3 mb-4">
              <div className="relative flex-1 min-w-[200px] max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-500" />
                <input
                  type="text"
                  placeholder="Search signatures..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900/50 pl-9 pr-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:border-cyan-600 focus:outline-none"
                />
              </div>
              <select
                value={filterCategory}
                onChange={e => setFilterCategory(e.target.value)}
                className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-300 focus:border-cyan-600 focus:outline-none"
              >
                <option value="">All Categories</option>
                {categories.map(c => (
                  <option key={c.category} value={c.category}>
                    {c.category.replace(/_/g, " ")} ({c.count})
                  </option>
                ))}
              </select>
              <select
                value={filterSeverity}
                onChange={e => setFilterSeverity(e.target.value)}
                className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-300 focus:border-cyan-600 focus:outline-none"
              >
                <option value="">All Severities</option>
                {["critical", "high", "medium", "low", "info"].map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <select
                value={filterSource}
                onChange={e => setFilterSource(e.target.value)}
                className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-300 focus:border-cyan-600 focus:outline-none"
              >
                <option value="">All Sources</option>
                <option value="built_in">Built-in</option>
                <option value="auto_learned">Auto-Learned</option>
                <option value="custom">Custom</option>
              </select>
              <select
                value={filterMethod}
                onChange={e => setFilterMethod(e.target.value)}
                className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-300 focus:border-cyan-600 focus:outline-none"
              >
                <option value="">All Methods</option>
                <option value="yolo">YOLO</option>
                <option value="gemini">Gemini</option>
                <option value="hybrid">Hybrid</option>
              </select>
              <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showInactive}
                  onChange={e => setShowInactive(e.target.checked)}
                  className="rounded border-gray-700"
                />
                Show disabled
              </label>
              <div className="flex items-center gap-1 ml-auto">
                <button onClick={expandAll} className="text-[10px] text-gray-500 hover:text-gray-300 px-2 py-1">Expand All</button>
                <button onClick={collapseAll} className="text-[10px] text-gray-500 hover:text-gray-300 px-2 py-1">Collapse All</button>
              </div>
            </div>

            <p className="text-[10px] text-gray-600 mb-3">
              Showing {filtered.length} of {signatures.length} signatures
            </p>

            {/* Category groups */}
            <div className="space-y-3">
              {sortedCategories.map(cat => {
                const sigs = grouped[cat];
                const isExpanded = expandedCategories.has(cat);
                const catColor = CATEGORY_COLORS[cat] || "bg-gray-500/15 text-gray-400 border-gray-500/30";

                return (
                  <div key={cat} className="rounded-xl border border-gray-800/60 bg-gray-900/30 overflow-hidden">
                    <button
                      onClick={() => toggleCategory(cat)}
                      className="flex items-center justify-between w-full px-4 py-3 hover:bg-gray-800/30 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        {isExpanded
                          ? <ChevronDown className="h-3.5 w-3.5 text-gray-500" />
                          : <ChevronRight className="h-3.5 w-3.5 text-gray-500" />
                        }
                        <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider", catColor)}>
                          {cat.replace(/_/g, " ")}
                        </span>
                        <span className="text-xs text-gray-500">{sigs.length} signature{sigs.length !== 1 ? "s" : ""}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {["critical", "high", "medium", "low", "info"].map(sev => {
                          const count = sigs.filter(s => s.severity === sev).length;
                          if (!count) return null;
                          return (
                            <span key={sev} className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium", SEVERITY_BADGES[sev])}>
                              {count} {sev}
                            </span>
                          );
                        })}
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-gray-800/40">
                        {/* Signature rows */}
                        {sigs.map(sig => {
                          const key = sig.id || sig.name;
                          const isDetailOpen = expandedDetail.has(key);
                          const testState = testResults[key];
                          const detState = detectionExamples[key];
                          const rate = fpRate(sig);

                          return (
                            <div key={sig.name} className={cn("border-t border-gray-800/30", !sig.is_active && "opacity-40")}>
                              {/* Main row */}
                              <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] items-center gap-2 px-4 py-2.5 text-xs hover:bg-gray-800/20 transition-colors">
                                {/* Signature info */}
                                <div>
                                  <div className="font-medium text-gray-200">{sig.name}</div>
                                  <div className="text-[10px] text-gray-600 mt-0.5 line-clamp-1">{sig.description}</div>
                                  <div className="flex flex-wrap items-center gap-1 mt-1">
                                    {sig.gemini_keywords.slice(0, 5).map(kw => (
                                      <span key={kw} className="inline-block rounded bg-gray-800/60 px-1.5 py-0.5 text-[9px] text-gray-500">
                                        {kw}
                                      </span>
                                    ))}
                                    {sig.gemini_keywords.length > 5 && (
                                      <span className="text-[9px] text-gray-600">+{sig.gemini_keywords.length - 5}</span>
                                    )}
                                    {/* False positive rate badge */}
                                    {rate !== null && (
                                      <span className={cn(
                                        "inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium border",
                                        parseFloat(rate) > 20
                                          ? "bg-red-500/10 text-red-400 border-red-500/30"
                                          : parseFloat(rate) > 10
                                          ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/30"
                                          : "bg-gray-500/10 text-gray-500 border-gray-700/40"
                                      )}>
                                        <Flag className="h-2.5 w-2.5" />
                                        FP: {rate}
                                      </span>
                                    )}
                                    {/* Test result badge */}
                                    {testState && !testState.loading && testState.matches !== undefined && (
                                      <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium border bg-cyan-500/10 text-cyan-400 border-cyan-500/30">
                                        <FlaskConical className="h-2.5 w-2.5" />
                                        {testState.matches} match{testState.matches !== 1 ? "es" : ""} / 24h
                                      </span>
                                    )}
                                  </div>
                                </div>

                                {/* Severity */}
                                <span className={cn("inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap", SEVERITY_BADGES[sig.severity])}>
                                  {sig.severity}
                                </span>

                                {/* Method */}
                                <span className="text-[10px] text-gray-500 whitespace-nowrap">
                                  {METHOD_LABELS[sig.detection_method] || sig.detection_method}
                                </span>

                                {/* Source */}
                                <span className={cn("inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap", SOURCE_BADGES[sig.source] || "")}>
                                  {sig.source.replace(/_/g, " ")}
                                </span>

                                {/* Detections */}
                                <span className="text-gray-400 text-right min-w-[40px]">{sig.detection_count}</span>

                                {/* Actions */}
                                <div className="flex items-center gap-1">
                                  {/* Test button */}
                                  <button
                                    onClick={() => handleTest(sig)}
                                    disabled={testState?.loading}
                                    title="Test signature (last 24h)"
                                    className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-cyan-400 transition-colors disabled:opacity-50"
                                  >
                                    {testState?.loading
                                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                      : <FlaskConical className="h-3.5 w-3.5" />
                                    }
                                  </button>
                                  {/* Detection examples toggle */}
                                  {sig.detection_count > 0 && (
                                    <button
                                      onClick={() => toggleDetail(sig)}
                                      title="Show detection examples"
                                      className={cn(
                                        "rounded p-1 transition-colors",
                                        isDetailOpen
                                          ? "bg-gray-800 text-cyan-400"
                                          : "text-gray-500 hover:bg-gray-800 hover:text-gray-300"
                                      )}
                                    >
                                      <Camera className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  {/* Toggle active */}
                                  <button
                                    onClick={() => handleToggle(sig)}
                                    title={sig.is_active ? "Disable" : "Enable"}
                                    className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
                                  >
                                    {sig.is_active
                                      ? <ToggleRight className="h-3.5 w-3.5 text-emerald-400" />
                                      : <ToggleLeft className="h-3.5 w-3.5 text-gray-600" />
                                    }
                                  </button>
                                  {/* Delete */}
                                  {sig.source !== "built_in" && (
                                    <button
                                      onClick={() => handleDelete(sig)}
                                      title="Delete"
                                      className="rounded p-1 text-gray-500 hover:bg-red-900/30 hover:text-red-400 transition-colors"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                </div>
                              </div>

                              {/* Detection examples panel */}
                              {isDetailOpen && (
                                <div className="px-4 pb-3 bg-gray-900/40 border-t border-gray-800/30">
                                  <p className="text-[10px] uppercase tracking-wider text-gray-600 pt-2 pb-1.5">
                                    Recent Detections
                                  </p>
                                  {detState?.loading ? (
                                    <div className="flex items-center gap-1.5 text-[10px] text-gray-600 py-2">
                                      <Loader2 className="h-3 w-3 animate-spin" /> Loading examples...
                                    </div>
                                  ) : detState?.notAvailable ? (
                                    <p className="text-[10px] text-gray-600 py-1">No detection examples available</p>
                                  ) : detState && detState.items.length === 0 ? (
                                    <p className="text-[10px] text-gray-600 py-1">No detection examples available</p>
                                  ) : detState ? (
                                    <div className="flex flex-wrap gap-2">
                                      {detState.items.map((det, i) => (
                                        <div
                                          key={det.id || i}
                                          className="flex-1 min-w-[180px] rounded-lg border border-gray-800/60 bg-gray-900/50 px-3 py-2"
                                        >
                                          <div className="flex items-center gap-1.5 mb-0.5">
                                            <Camera className="h-3 w-3 text-gray-500 shrink-0" />
                                            <span className="text-[10px] text-gray-400 truncate">
                                              {det.camera_name || det.camera_source || "Unknown camera"}
                                            </span>
                                          </div>
                                          <p className="text-[9px] text-gray-600">
                                            {new Date(det.timestamp).toLocaleString()}
                                          </p>
                                          {det.description && (
                                            <p className="text-[9px] text-gray-500 mt-0.5 line-clamp-1">{det.description}</p>
                                          )}
                                          <button
                                            onClick={() => handleMarkFP(sig, det.id)}
                                            className="mt-1.5 flex items-center gap-1 rounded bg-red-500/10 border border-red-500/20 px-1.5 py-0.5 text-[9px] text-red-400 hover:bg-red-500/20 transition-colors"
                                          >
                                            <Flag className="h-2.5 w-2.5" /> Mark False Positive
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {activeTab === "learned" && (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-emerald-400" />
              Auto-Learned Signatures
            </h2>
            <p className="text-xs text-gray-500">
              Signatures automatically created when Gemini identifies novel threats not matching existing patterns.
            </p>
            {stats && stats.recently_learned.length > 0 ? (
              <div className="grid gap-3">
                {stats.recently_learned.map((sig, i) => (
                  <div key={i} className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-gray-200">{sig.name}</span>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={cn("inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium", CATEGORY_COLORS[sig.category] || "bg-gray-500/15 text-gray-400")}>
                            {sig.category.replace(/_/g, " ")}
                          </span>
                          <span className={cn("inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium", SEVERITY_BADGES[sig.severity])}>
                            {sig.severity}
                          </span>
                        </div>
                      </div>
                      {sig.created_at && (
                        <span className="text-[10px] text-gray-600">
                          {new Date(sig.created_at).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <Sparkles className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">No auto-learned signatures yet</p>
                <p className="text-xs mt-1">Novel threats will be automatically captured here</p>
              </div>
            )}
          </div>
        )}

        {activeTab === "stats" && stats && (
          <div className="space-y-6">
            <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-amber-400" />
              Detection Statistics
            </h2>

            {/* Top triggered */}
            <div>
              <h3 className="text-xs font-medium text-gray-400 mb-3">Top Triggered Signatures</h3>
              {stats.top_triggered.length > 0 ? (
                <div className="space-y-2">
                  {stats.top_triggered.map((sig, i) => (
                    <div key={i} className="flex items-center gap-3 rounded-lg border border-gray-800/60 bg-gray-900/30 px-4 py-3">
                      <span className="text-lg font-bold text-gray-600 w-6 text-right">#{i + 1}</span>
                      <div className="flex-1">
                        <span className="text-xs font-medium text-gray-200">{sig.name}</span>
                        <span className="ml-2 text-[10px] text-gray-600">{sig.category}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-sm font-bold text-cyan-400">{sig.detection_count}</span>
                        <span className="text-[10px] text-gray-600 ml-1">detections</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-gray-600 py-8 text-center">No detections recorded yet</p>
              )}
            </div>

            {/* Category breakdown */}
            <div>
              <h3 className="text-xs font-medium text-gray-400 mb-3">Signatures by Category</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                {categories.map(cat => (
                  <div key={cat.category} className="rounded-lg border border-gray-800/60 bg-gray-900/30 p-3">
                    <div className={cn("inline-flex rounded-md border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider mb-2", CATEGORY_COLORS[cat.category] || "bg-gray-500/15 text-gray-400 border-gray-500/30")}>
                      {cat.category.replace(/_/g, " ")}
                    </div>
                    <div className="text-xl font-bold text-gray-200">{cat.count}</div>
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {Object.entries(cat.severities).map(([sev, cnt]) => (
                        <span key={sev} className={cn("text-[8px] rounded px-1 py-0.5", SEVERITY_BADGES[sev])}>
                          {cnt} {sev}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Create signature modal */}
      {showCreateForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-lg rounded-2xl border border-gray-800 bg-gray-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-gray-200">Create Custom Signature</h2>
              <button onClick={() => setShowCreateForm(false)} className="text-gray-500 hover:text-gray-300">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3">
              <input
                placeholder="Signature name"
                value={newSig.name}
                onChange={e => setNewSig({ ...newSig, name: e.target.value })}
                className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:border-cyan-600 focus:outline-none"
              />
              <input
                placeholder="Category (e.g. intrusion, custom)"
                value={newSig.category}
                onChange={e => setNewSig({ ...newSig, category: e.target.value })}
                className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:border-cyan-600 focus:outline-none"
              />
              <textarea
                placeholder="Description"
                value={newSig.description}
                onChange={e => setNewSig({ ...newSig, description: e.target.value })}
                rows={2}
                className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:border-cyan-600 focus:outline-none resize-none"
              />
              <div className="grid grid-cols-2 gap-3">
                <select
                  value={newSig.severity}
                  onChange={e => setNewSig({ ...newSig, severity: e.target.value })}
                  className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-300 focus:border-cyan-600 focus:outline-none"
                >
                  {["critical", "high", "medium", "low", "info"].map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <select
                  value={newSig.detection_method}
                  onChange={e => setNewSig({ ...newSig, detection_method: e.target.value })}
                  className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-300 focus:border-cyan-600 focus:outline-none"
                >
                  <option value="gemini">Gemini</option>
                  <option value="yolo">YOLO</option>
                  <option value="hybrid">Hybrid</option>
                </select>
              </div>
              <input
                placeholder="Gemini keywords (comma separated)"
                value={newSig.gemini_keywords}
                onChange={e => setNewSig({ ...newSig, gemini_keywords: e.target.value })}
                className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:border-cyan-600 focus:outline-none"
              />
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setShowCreateForm(false)}
                  className="rounded-lg border border-gray-700 px-4 py-2 text-xs text-gray-400 hover:bg-gray-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={creating || !newSig.name || !newSig.category}
                  className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-4 py-2 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-50 transition-colors"
                >
                  {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                  Create
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stat Card Component                                                */
/* ------------------------------------------------------------------ */

function StatCard({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-800/60 bg-gray-900/30 p-3">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-[10px] uppercase tracking-wider text-gray-500">{label}</span>
      </div>
      <span className="text-xl font-bold text-gray-100">{value}</span>
    </div>
  );
}
