"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Brain,
  Activity,
  Shield,
  Target,
  Clock,
  Camera,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  AlertTriangle,
  X,
  ChevronDown,
  RefreshCw,
  TrendingUp,
  Zap,
  BarChart3,
  Users,
  HelpCircle,
  CloudRain,
  Globe,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ContextRule {
  id: string;
  zone_type: string;
  object_class: string;
  base_threat_score: number;
  time_multipliers: Record<string, number>;
  description?: string;
  is_active: boolean;
  created_at: string;
}

interface BaselineSlot {
  time_slot: string;
  avg_count: number;
  std_dev: number;
  adaptive_threshold: number;
}

interface AnomalyScore {
  camera_id: string;
  camera_name: string;
  score: number;
  timestamp: string;
  contributing_factors: string[];
}

interface IntentClassification {
  id: string;
  camera_id: string;
  camera_name: string;
  track_id: string;
  intent_category: string;
  risk_score: number;
  precursors: string[];
  timestamp: string;
  confidence: number;
}

interface IntentStats {
  total_classifications: number;
  high_risk_count: number;
  categories: Record<string, number>;
}

interface ContextStats {
  active_rules: number;
  anomalies_today: number;
  baseline_coverage: number;
  avg_anomaly_score: number;
}

interface ExternalThreat {
  id?: string;
  type: string;
  title: string;
  description?: string;
  severity?: string;
  location?: string;
  source?: string;
  timestamp?: string;
  [key: string]: unknown;
}

interface CameraOption {
  id: string;
  name: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TABS = ["Rules", "Baselines", "Anomaly Monitor", "Intent History"] as const;
type Tab = (typeof TABS)[number];

const INTENT_COLORS: Record<string, string> = {
  benign: "text-green-400 bg-green-500/10 border-green-500/30",
  suspicious: "text-yellow-400 bg-yellow-500/10 border-yellow-500/30",
  reconnaissance: "text-orange-400 bg-orange-500/10 border-orange-500/30",
  hostile: "text-red-400 bg-red-500/10 border-red-500/30",
  unknown: "text-gray-400 bg-gray-500/10 border-gray-500/30",
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
  return `${Math.floor(hours / 24)}d ago`;
}

function anomalyColor(score: number): string {
  if (score > 2.0) return "text-red-400";
  if (score >= 1.0) return "text-yellow-400";
  return "text-green-400";
}

function anomalyBg(score: number): string {
  if (score > 2.0) return "border-red-800/60 bg-red-950/20";
  if (score >= 1.0) return "border-yellow-800/50 bg-yellow-950/10";
  return "border-gray-800 bg-zinc-900/50";
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function ContextIntelligencePage() {
  const { addToast } = useToast();

  const [activeTab, setActiveTab] = useState<Tab>("Rules");
  const [stats, setStats] = useState<ContextStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Rules state
  const [rules, setRules] = useState<ContextRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [editingRule, setEditingRule] = useState<ContextRule | null>(null);
  const [ruleForm, setRuleForm] = useState({
    zone_type: "",
    object_class: "",
    base_threat_score: 1.0,
    time_multipliers: "{}",
    description: "",
  });
  const [ruleSubmitting, setRuleSubmitting] = useState(false);
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);
  const [togglingRuleId, setTogglingRuleId] = useState<string | null>(null);

  // Baselines state
  const [cameras, setCameras] = useState<CameraOption[]>([]);
  const [selectedCamera, setSelectedCamera] = useState("");
  const [baselineSlots, setBaselineSlots] = useState<BaselineSlot[]>([]);
  const [baselineAnomalies, setBaselineAnomalies] = useState<AnomalyScore[]>([]);
  const [baselineLoading, setBaselineLoading] = useState(false);

  // Anomaly monitor state
  const [anomalyScores, setAnomalyScores] = useState<AnomalyScore[]>([]);
  const [anomalyLoading, setAnomalyLoading] = useState(false);

  // Intent state
  const [intents, setIntents] = useState<IntentClassification[]>([]);
  const [intentStats, setIntentStats] = useState<IntentStats | null>(null);
  const [intentLoading, setIntentLoading] = useState(false);

  // Explainability state — which rule row is expanded
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);

  // External threat feeds
  const [externalThreats, setExternalThreats] = useState<ExternalThreat[]>([]);
  const [externalFeedsLoading, setExternalFeedsLoading] = useState(false);
  const [externalFeedsError, setExternalFeedsError] = useState<string | null>(null);

  /* ---- External threat feeds ---- */
  const fetchExternalFeeds = useCallback(async () => {
    setExternalFeedsLoading(true);
    setExternalFeedsError(null);
    try {
      const data = await apiFetch<ExternalThreat[]>("/api/threat-intel/feeds");
      setExternalThreats(Array.isArray(data) ? data : []);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to load external feeds";
      setExternalFeedsError(msg);
      setExternalThreats([]);
    } finally {
      setExternalFeedsLoading(false);
    }
  }, []);

  /* ---- Initial load ---- */
  const fetchStats = useCallback(async () => {
    try {
      const [rulesData, statsData, camerasData] = await Promise.all([
        apiFetch<ContextRule[]>("/api/context/rules"),
        apiFetch<ContextStats>("/api/context/stats"),
        apiFetch<CameraOption[]>("/api/cameras"),
      ]);
      setRules(rulesData);
      setStats({
        anomalies_today: 0,
        baseline_coverage: 0,
        avg_anomaly_score: 0,
        ...statsData,
      });
      setCameras(Array.isArray(camerasData) ? camerasData : []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  /* ---- Rules handlers ---- */
  const fetchRules = async () => {
    setRulesLoading(true);
    try {
      const [data, statsData] = await Promise.all([
        apiFetch<ContextRule[]>("/api/context/rules"),
        apiFetch<ContextStats>("/api/context/stats"),
      ]);
      setRules(data);
      setStats((prev) => prev ? { ...prev, ...statsData } : { anomalies_today: 0, baseline_coverage: 0, avg_anomaly_score: 0, ...statsData });
    } catch {
    } finally {
      setRulesLoading(false);
    }
  };

  const handleRuleSubmit = async () => {
    setRuleSubmitting(true);
    try {
      let parsedMultipliers = {};
      try {
        parsedMultipliers = JSON.parse(ruleForm.time_multipliers);
      } catch {
        parsedMultipliers = {};
      }
      const body = {
        zone_type: ruleForm.zone_type,
        object_class: ruleForm.object_class,
        base_threat_score: ruleForm.base_threat_score,
        time_multipliers: parsedMultipliers,
        description: ruleForm.description,
      };

      if (editingRule) {
        await apiFetch(`/api/context/rules/${editingRule.id}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        addToast("success", "Context rule updated");
      } else {
        await apiFetch("/api/context/rules", {
          method: "POST",
          body: JSON.stringify(body),
        });
        addToast("success", "Context rule created");
      }
      setShowRuleForm(false);
      setEditingRule(null);
      setRuleForm({ zone_type: "", object_class: "", base_threat_score: 1.0, time_multipliers: "{}", description: "" });
      await fetchRules();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to save rule";
      addToast("error", msg);
      setError(msg);
    } finally {
      setRuleSubmitting(false);
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    if (!confirm("Delete this context rule?")) return;
    setDeletingRuleId(ruleId);
    try {
      await apiFetch(`/api/context/rules/${ruleId}`, { method: "DELETE" });
      addToast("success", "Context rule deleted");
      await fetchRules();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Delete failed";
      addToast("error", msg);
      setError(msg);
    } finally {
      setDeletingRuleId(null);
    }
  };

  const handleToggleRule = async (rule: ContextRule) => {
    setTogglingRuleId(rule.id);
    try {
      await apiFetch(`/api/context/rules/${rule.id}`, {
        method: "PUT",
        body: JSON.stringify({ is_active: !rule.is_active }),
      });
      addToast("success", rule.is_active ? "Rule deactivated" : "Rule activated");
      await fetchRules();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Toggle failed";
      addToast("error", msg);
      setError(msg);
    } finally {
      setTogglingRuleId(null);
    }
  };

  const openEditRule = (rule: ContextRule) => {
    setEditingRule(rule);
    setRuleForm({
      zone_type: rule.zone_type,
      object_class: rule.object_class,
      base_threat_score: rule.base_threat_score,
      time_multipliers: JSON.stringify(rule.time_multipliers, null, 2),
      description: rule.description || "",
    });
    setShowRuleForm(true);
  };

  /* ---- Baselines handlers ---- */
  const fetchBaselines = async (camId: string) => {
    if (!camId) return;
    setBaselineLoading(true);
    try {
      const [slots, anomalies] = await Promise.all([
        apiFetch<BaselineSlot[]>(`/api/baselines/camera/${camId}`),
        apiFetch<AnomalyScore[]>(`/api/baselines/camera/${camId}/anomaly`),
      ]);
      setBaselineSlots(slots);
      setBaselineAnomalies(anomalies);
    } catch {
      setBaselineSlots([]);
      setBaselineAnomalies([]);
    } finally {
      setBaselineLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "Baselines" && selectedCamera) {
      fetchBaselines(selectedCamera);
    }
  }, [activeTab, selectedCamera]);

  /* ---- Anomaly monitor ---- */
  const fetchAnomalies = async () => {
    setAnomalyLoading(true);
    try {
      const data = await apiFetch<AnomalyScore[]>("/api/baselines/anomaly-scores");
      setAnomalyScores(data);
    } catch {
      setAnomalyScores([]);
    } finally {
      setAnomalyLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "Anomaly Monitor") {
      fetchAnomalies();
      const interval = setInterval(fetchAnomalies, 15000);
      return () => clearInterval(interval);
    }
  }, [activeTab]);

  /* ---- Intent history ---- */
  const fetchIntents = async () => {
    setIntentLoading(true);
    try {
      const [recent, st] = await Promise.all([
        apiFetch<IntentClassification[]>("/api/intent/recent"),
        apiFetch<IntentStats>("/api/intent/stats"),
      ]);
      setIntents(recent);
      setIntentStats(st);
    } catch {
      setIntents([]);
    } finally {
      setIntentLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "Intent History") fetchIntents();
  }, [activeTab]);

  useEffect(() => {
    fetchExternalFeeds();
  }, [fetchExternalFeeds]);

  /* ---- Loading ---- */
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[#030712]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-10 w-10 animate-spin text-cyan-400" />
          <p className="text-sm text-gray-500">Loading context intelligence...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#030712]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-900/30 border border-purple-800/50">
            <Brain className="h-5 w-5 text-purple-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Context Intelligence Engine
            </h1>
            <p className="text-xs text-gray-500">
              Adaptive baselines, anomaly scoring, and intent classification
            </p>
          </div>
        </div>
        <button
          onClick={() => { setLoading(true); fetchStats(); }}
          className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-6 mt-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto"><X className="h-3 w-3" /></button>
        </div>
      )}

      {/* Stat Cards */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 border-b border-gray-800 px-6 py-3">
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 p-3">
            <Target className="h-5 w-5 text-cyan-400" />
            <div>
              <p className="text-lg font-bold text-gray-100">{stats.active_rules}</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">Active Context Rules</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-red-900/50 bg-red-950/20 p-3">
            <AlertTriangle className="h-5 w-5 text-red-400" />
            <div>
              <p className="text-lg font-bold text-red-400">{stats.anomalies_today}</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">Anomalies Today</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 p-3">
            <BarChart3 className="h-5 w-5 text-green-400" />
            <div>
              <p className="text-lg font-bold text-gray-100">{Math.round(stats.baseline_coverage * 100)}%</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">Baseline Coverage</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 p-3">
            <TrendingUp className="h-5 w-5 text-yellow-400" />
            <div>
              <p className={cn("text-lg font-bold", anomalyColor(stats.avg_anomaly_score))}>
                {stats.avg_anomaly_score.toFixed(2)}
              </p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">Avg Anomaly Score</p>
            </div>
          </div>
        </div>
      )}

      {/* Tab navigation */}
      <div className="flex items-center gap-1 border-b border-gray-800 px-6">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-4 py-2.5 text-xs font-medium border-b-2 transition-colors",
              activeTab === tab
                ? "border-cyan-400 text-cyan-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {/* ============ RULES TAB ============ */}
        {activeTab === "Rules" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                <Shield className="h-4 w-4 text-cyan-400" />
                Context Rules ({rules.length})
              </h2>
              <button
                onClick={() => { setEditingRule(null); setRuleForm({ zone_type: "", object_class: "", base_threat_score: 1.0, time_multipliers: "{}", description: "" }); setShowRuleForm(true); }}
                className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-500 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" /> Add Rule
              </button>
            </div>

            {rulesLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
              </div>
            ) : rules.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <Target className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">No context rules configured</p>
                <p className="text-xs mt-1">Create rules to define threat scoring by zone and object</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-gray-800 bg-zinc-900/30">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-gray-800 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                      <th className="px-4 py-3">Zone Type</th>
                      <th className="px-4 py-3">Object Class</th>
                      <th className="px-4 py-3">Base Score</th>
                      <th className="px-4 py-3">Time Multipliers</th>
                      <th className="px-4 py-3">Description</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((rule) => (
                      <React.Fragment key={rule.id}>
                      <tr className="border-b border-gray-800/30 hover:bg-gray-800/20 transition-colors">
                        <td className="px-4 py-2.5">
                          <span className="inline-flex rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-400">
                            {rule.zone_type}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-300">{rule.object_class}</td>
                        <td className="px-4 py-2.5">
                          <span className={cn(
                            "text-xs font-bold font-mono",
                            rule.base_threat_score >= 8 ? "text-red-400" :
                            rule.base_threat_score >= 5 ? "text-yellow-400" : "text-green-400"
                          )}>
                            {rule.base_threat_score.toFixed(1)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {Object.entries(rule.time_multipliers).slice(0, 3).map(([key, val]) => (
                              <span key={key} className="rounded bg-gray-800/60 px-1.5 py-0.5 text-[9px] text-gray-500">
                                {key}: {val}x
                              </span>
                            ))}
                            {Object.keys(rule.time_multipliers).length > 3 && (
                              <span className="text-[9px] text-gray-600">+{Object.keys(rule.time_multipliers).length - 3}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-[11px] text-gray-500 max-w-[200px] truncate">
                          {rule.description || "-"}
                        </td>
                        <td className="px-4 py-2.5">
                          <button
                            onClick={() => handleToggleRule(rule)}
                            disabled={togglingRuleId === rule.id}
                            className={cn(
                              "rounded px-1.5 py-0.5 text-[9px] font-bold uppercase border transition-opacity",
                              rule.is_active
                                ? "text-green-400 bg-green-500/10 border-green-500/30 hover:bg-green-500/20"
                                : "text-gray-500 bg-gray-500/10 border-gray-500/30 hover:bg-gray-500/20",
                              togglingRuleId === rule.id && "opacity-50 cursor-not-allowed"
                            )}
                          >
                            {togglingRuleId === rule.id ? (
                              <Loader2 className="h-2.5 w-2.5 animate-spin inline" />
                            ) : rule.is_active ? "Active" : "Inactive"}
                          </button>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* Why? explainability button */}
                            <button
                              onClick={() => setExpandedRuleId(expandedRuleId === rule.id ? null : rule.id)}
                              className={cn(
                                "flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold border transition-colors",
                                expandedRuleId === rule.id
                                  ? "bg-purple-500/20 border-purple-500/40 text-purple-300"
                                  : "bg-gray-800/60 border-gray-700 text-gray-500 hover:text-purple-300 hover:border-purple-500/40"
                              )}
                              title="Explain this rule"
                            >
                              <HelpCircle className="h-2.5 w-2.5" />
                              Why?
                            </button>
                            <button
                              onClick={() => openEditRule(rule)}
                              disabled={deletingRuleId === rule.id || togglingRuleId === rule.id}
                              className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors disabled:opacity-40"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => handleDeleteRule(rule.id)}
                              disabled={deletingRuleId === rule.id || togglingRuleId === rule.id}
                              className="rounded p-1 text-gray-500 hover:bg-red-900/30 hover:text-red-400 transition-colors disabled:opacity-40"
                            >
                              {deletingRuleId === rule.id
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <Trash2 className="h-3.5 w-3.5" />}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {/* Explainability expanded row */}
                      {expandedRuleId === rule.id && (
                        <tr key={`${rule.id}-explain`} className="border-b border-purple-900/30 bg-purple-950/10">
                          <td colSpan={7} className="px-4 py-3">
                            <div className="space-y-2">
                              <p className="text-[10px] font-bold uppercase tracking-wider text-purple-400 flex items-center gap-1.5">
                                <HelpCircle className="h-3 w-3" /> Rule Explanation
                              </p>
                              <div className="grid grid-cols-2 gap-3 text-[11px]">
                                <div className="rounded-md border border-purple-900/40 bg-purple-950/20 p-2.5 space-y-1">
                                  <p className="font-semibold text-gray-300">Conditions</p>
                                  <p className="text-gray-400">Zone type: <span className="text-cyan-400 font-mono">{rule.zone_type}</span></p>
                                  <p className="text-gray-400">Object class: <span className="text-cyan-400 font-mono">{rule.object_class}</span></p>
                                  <p className="text-gray-400">Base threat score: <span className={cn("font-mono font-bold", rule.base_threat_score >= 8 ? "text-red-400" : rule.base_threat_score >= 5 ? "text-yellow-400" : "text-green-400")}>{rule.base_threat_score.toFixed(1)}</span></p>
                                  <p className="text-gray-400">Status: <span className={rule.is_active ? "text-green-400" : "text-gray-500"}>{rule.is_active ? "Active — currently evaluating detections" : "Inactive — not applied to events"}</span></p>
                                </div>
                                <div className="rounded-md border border-purple-900/40 bg-purple-950/20 p-2.5 space-y-1">
                                  <p className="font-semibold text-gray-300">Time Multipliers</p>
                                  {Object.keys(rule.time_multipliers).length === 0 ? (
                                    <p className="text-gray-500">No time multipliers — base score applied at all times</p>
                                  ) : (
                                    Object.entries(rule.time_multipliers).map(([period, mult]) => (
                                      <p key={period} className="text-gray-400">
                                        During <span className="text-amber-400 font-mono">{period}</span>: score &times; <span className="text-amber-400 font-mono font-bold">{mult}</span> = <span className="text-white font-mono">{(rule.base_threat_score * Number(mult)).toFixed(1)}</span>
                                      </p>
                                    ))
                                  )}
                                </div>
                              </div>
                              {rule.description && (
                                <p className="text-[11px] text-gray-400 italic border-l-2 border-purple-700 pl-2">{rule.description}</p>
                              )}
                              <p className="text-[10px] text-gray-600">
                                Rule ID: <span className="font-mono">{rule.id}</span> &middot; Created: {timeAgo(rule.created_at)}
                              </p>
                            </div>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ============ EXTERNAL THREAT FEEDS (shown in all tabs at bottom of Rules) ============ */}
        {activeTab === "Rules" && (
          <div className="mt-6 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                <Globe className="h-4 w-4 text-blue-400" />
                External Threat Feeds
              </h2>
              <button
                onClick={fetchExternalFeeds}
                disabled={externalFeedsLoading}
                className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 transition-colors disabled:opacity-50"
              >
                {externalFeedsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Refresh
              </button>
            </div>

            {externalFeedsLoading && (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-blue-400" />
              </div>
            )}

            {!externalFeedsLoading && externalFeedsError && (
              <div className="rounded-xl border border-red-900/40 bg-red-950/20 p-4 text-xs text-red-400">
                <AlertTriangle className="h-3.5 w-3.5 inline mr-1" />
                {externalFeedsError}
              </div>
            )}

            {!externalFeedsLoading && !externalFeedsError && externalThreats.length === 0 && (
              <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-6 text-center">
                <Globe className="h-8 w-8 text-gray-700 mx-auto mb-2" />
                <p className="text-sm text-gray-500">No feeds configured</p>
              </div>
            )}

            {!externalFeedsLoading && !externalFeedsError && externalThreats.length > 0 && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {externalThreats.map((threat, i) => (
                  <div key={threat.id ?? i} className="rounded-xl border border-blue-900/40 bg-blue-950/10 p-3 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <CloudRain className="h-4 w-4 text-blue-400 shrink-0" />
                      <span className="text-xs font-semibold text-gray-200 truncate">{threat.title}</span>
                      {threat.severity && (
                        <span className={cn(
                          "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase border",
                          threat.severity === "high" || threat.severity === "critical"
                            ? "text-red-400 bg-red-900/30 border-red-800/50"
                            : threat.severity === "medium"
                            ? "text-yellow-400 bg-yellow-900/30 border-yellow-800/50"
                            : "text-blue-400 bg-blue-900/30 border-blue-800/50"
                        )}>
                          {threat.severity}
                        </span>
                      )}
                    </div>
                    {threat.description && (
                      <p className="text-[11px] text-gray-400 leading-relaxed">{threat.description}</p>
                    )}
                    <div className="flex flex-wrap gap-3 text-[10px] text-gray-500">
                      {threat.type && <span>Type: <span className="text-gray-400">{threat.type}</span></span>}
                      {threat.location && <span>Location: <span className="text-gray-400">{threat.location}</span></span>}
                      {threat.source && <span>Source: <span className="text-gray-400">{threat.source}</span></span>}
                      {threat.timestamp && <span>{timeAgo(threat.timestamp)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ============ BASELINES TAB ============ */}
        {activeTab === "Baselines" && (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-green-400" />
                Camera Baselines
              </h2>
              <select
                value={selectedCamera}
                onChange={(e) => setSelectedCamera(e.target.value)}
                className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-300 focus:border-cyan-600 focus:outline-none min-w-[200px]"
              >
                <option value="">Select a camera...</option>
                {cameras.map((cam) => (
                  <option key={cam.id} value={cam.id}>{cam.name}</option>
                ))}
              </select>
            </div>

            {!selectedCamera ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <Camera className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">Select a camera to view baselines</p>
              </div>
            ) : baselineLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                {/* Baseline chart */}
                <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-4">
                  <h3 className="mb-3 text-xs font-bold text-gray-300 uppercase tracking-wider">
                    Baseline per Time Slot
                  </h3>
                  {baselineSlots.length === 0 ? (
                    <p className="text-xs text-gray-600 py-8 text-center">No baseline data</p>
                  ) : (
                    <div className="space-y-1.5 max-h-[400px] overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
                      {baselineSlots.map((slot) => {
                        const pct = Math.min((slot.avg_count / (slot.adaptive_threshold || 1)) * 100, 100);
                        return (
                          <div key={slot.time_slot} className="flex items-center gap-3">
                            <span className="text-[10px] text-gray-500 font-mono w-14 shrink-0">{slot.time_slot}</span>
                            <div className="flex-1 h-3 rounded-full bg-gray-800 overflow-hidden">
                              <div
                                className={cn(
                                  "h-full rounded-full transition-all",
                                  pct > 80 ? "bg-red-500" : pct > 50 ? "bg-yellow-500" : "bg-cyan-500"
                                )}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-[10px] text-gray-400 font-mono w-12 text-right">
                              {slot.avg_count.toFixed(1)}
                            </span>
                            <span className="text-[9px] text-gray-600 w-10 text-right">
                              +/-{slot.std_dev.toFixed(1)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Anomaly scores */}
                <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-4">
                  <h3 className="mb-3 text-xs font-bold text-gray-300 uppercase tracking-wider">
                    Anomaly Scores
                  </h3>
                  {baselineAnomalies.length === 0 ? (
                    <p className="text-xs text-gray-600 py-8 text-center">No anomalies for this camera</p>
                  ) : (
                    <div className="space-y-2 max-h-[400px] overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
                      {baselineAnomalies.map((a, i) => (
                        <div key={i} className={cn("rounded-lg border p-3", anomalyBg(a.score))}>
                          <div className="flex items-center justify-between">
                            <span className={cn("text-sm font-bold font-mono", anomalyColor(a.score))}>
                              {a.score.toFixed(2)}
                            </span>
                            <span className="text-[10px] text-gray-500">{timeAgo(a.timestamp)}</span>
                          </div>
                          {a.contributing_factors.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {a.contributing_factors.map((f, j) => (
                                <span key={j} className="rounded bg-gray-800/60 px-1.5 py-0.5 text-[9px] text-gray-500">{f}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ============ ANOMALY MONITOR TAB ============ */}
        {activeTab === "Anomaly Monitor" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                <Activity className="h-4 w-4 text-red-400" />
                Live Anomaly Monitor
                <span className="ml-2 flex h-2 w-2 rounded-full bg-green-500 animate-pulse" />
              </h2>
              <button
                onClick={fetchAnomalies}
                disabled={anomalyLoading}
                className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 transition-colors disabled:opacity-50"
              >
                {anomalyLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Refresh
              </button>
            </div>

            {anomalyLoading && anomalyScores.length === 0 ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
              </div>
            ) : anomalyScores.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <Activity className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">No anomaly data available</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {anomalyScores.map((a) => (
                  <div key={a.camera_id} className={cn("rounded-lg border p-3 transition-colors", anomalyBg(a.score))}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Camera className="h-3.5 w-3.5 text-gray-500" />
                        <span className="text-xs font-semibold text-gray-200 truncate max-w-[120px]">
                          {a.camera_name}
                        </span>
                      </div>
                      <span className={cn("text-lg font-bold font-mono", anomalyColor(a.score))}>
                        {a.score.toFixed(2)}
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-gray-800 overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all duration-500",
                          a.score > 2.0 ? "bg-red-500" : a.score >= 1.0 ? "bg-yellow-500" : "bg-green-500"
                        )}
                        style={{ width: `${Math.min(a.score * 33, 100)}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-[9px] text-gray-600">{timeAgo(a.timestamp)}</span>
                      {a.contributing_factors.length > 0 && (
                        <span className="text-[9px] text-gray-500">{a.contributing_factors.length} factors</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Legend */}
            <div className="flex items-center gap-6 pt-2">
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded-full bg-green-500" />
                <span className="text-[10px] text-gray-500">Normal (&lt; 1.0)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded-full bg-yellow-500" />
                <span className="text-[10px] text-gray-500">Elevated (1.0 - 2.0)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded-full bg-red-500" />
                <span className="text-[10px] text-gray-500">Critical (&gt; 2.0)</span>
              </div>
            </div>
          </div>
        )}

        {/* ============ INTENT HISTORY TAB ============ */}
        {activeTab === "Intent History" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                <Zap className="h-4 w-4 text-yellow-400" />
                Intent Classifications
              </h2>
              <button
                onClick={fetchIntents}
                disabled={intentLoading}
                className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 transition-colors disabled:opacity-50"
              >
                {intentLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Refresh
              </button>
            </div>

            {/* Intent stats summary */}
            {intentStats && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-lg border border-gray-800 bg-zinc-900/50 p-3">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider">Total</p>
                  <p className="text-lg font-bold text-gray-100">{intentStats.total_classifications}</p>
                </div>
                <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-3">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider">High Risk</p>
                  <p className="text-lg font-bold text-red-400">{intentStats.high_risk_count}</p>
                </div>
                {Object.entries(intentStats.categories).slice(0, 2).map(([cat, count]) => (
                  <div key={cat} className="rounded-lg border border-gray-800 bg-zinc-900/50 p-3">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">{cat}</p>
                    <p className="text-lg font-bold text-gray-100">{count}</p>
                  </div>
                ))}
              </div>
            )}

            {intentLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
              </div>
            ) : intents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <Users className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">No intent classifications yet</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-gray-800 bg-zinc-900/30">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-gray-800 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                      <th className="px-4 py-3">Camera</th>
                      <th className="px-4 py-3">Track ID</th>
                      <th className="px-4 py-3">Intent</th>
                      <th className="px-4 py-3">Risk Score</th>
                      <th className="px-4 py-3">Confidence</th>
                      <th className="px-4 py-3">Precursors</th>
                      <th className="px-4 py-3">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {intents.map((intent) => (
                      <tr key={intent.id} className="border-b border-gray-800/30 hover:bg-gray-800/20 transition-colors">
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-1.5 text-xs text-gray-300">
                            <Camera className="h-3 w-3 text-gray-500" />
                            {intent.camera_name}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-400 font-mono">{intent.track_id}</td>
                        <td className="px-4 py-2.5">
                          <span className={cn(
                            "rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                            INTENT_COLORS[intent.intent_category] || INTENT_COLORS.unknown
                          )}>
                            {intent.intent_category}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={cn(
                            "text-xs font-bold font-mono",
                            intent.risk_score >= 0.8 ? "text-red-400" :
                            intent.risk_score >= 0.5 ? "text-yellow-400" : "text-green-400"
                          )}>
                            {(intent.risk_score * 100).toFixed(0)}%
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-400">{(intent.confidence * 100).toFixed(0)}%</td>
                        <td className="px-4 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {intent.precursors.slice(0, 3).map((p, i) => (
                              <span key={i} className="rounded bg-gray-800/60 px-1.5 py-0.5 text-[9px] text-gray-500">{p}</span>
                            ))}
                            {intent.precursors.length > 3 && (
                              <span className="text-[9px] text-gray-600">+{intent.precursors.length - 3}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-[11px] text-gray-500">{timeAgo(intent.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Rule create/edit modal */}
      {showRuleForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-lg rounded-2xl border border-gray-800 bg-gray-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-gray-200">
                {editingRule ? "Edit Context Rule" : "Create Context Rule"}
              </h2>
              <button onClick={() => { setShowRuleForm(false); setEditingRule(null); }} className="text-gray-500 hover:text-gray-300">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <input
                  placeholder="Zone type (e.g., parking, lobby)"
                  value={ruleForm.zone_type}
                  onChange={(e) => setRuleForm({ ...ruleForm, zone_type: e.target.value })}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:border-cyan-600 focus:outline-none"
                />
                <input
                  placeholder="Object class (e.g., person, vehicle)"
                  value={ruleForm.object_class}
                  onChange={(e) => setRuleForm({ ...ruleForm, object_class: e.target.value })}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:border-cyan-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wider">Base Threat Score</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="10"
                  value={ruleForm.base_threat_score}
                  onChange={(e) => setRuleForm({ ...ruleForm, base_threat_score: parseFloat(e.target.value) || 0 })}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-200 focus:border-cyan-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wider">Time Multipliers (JSON)</label>
                <textarea
                  value={ruleForm.time_multipliers}
                  onChange={(e) => setRuleForm({ ...ruleForm, time_multipliers: e.target.value })}
                  rows={3}
                  placeholder='{"night": 2.0, "weekend": 1.5}'
                  className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:border-cyan-600 focus:outline-none font-mono resize-none"
                />
              </div>
              <textarea
                placeholder="Description (optional)"
                value={ruleForm.description}
                onChange={(e) => setRuleForm({ ...ruleForm, description: e.target.value })}
                rows={2}
                className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:border-cyan-600 focus:outline-none resize-none"
              />
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => { setShowRuleForm(false); setEditingRule(null); }}
                  className="rounded-lg border border-gray-700 px-4 py-2 text-xs text-gray-400 hover:bg-gray-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRuleSubmit}
                  disabled={ruleSubmitting || !ruleForm.zone_type || !ruleForm.object_class}
                  className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-4 py-2 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-50 transition-colors"
                >
                  {ruleSubmitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                  {editingRule ? "Update" : "Create"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
