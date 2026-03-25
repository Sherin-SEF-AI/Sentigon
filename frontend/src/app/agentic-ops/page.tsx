"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Sparkles,
  Search,
  Send,
  Loader2,
  AlertTriangle,
  X,
  RefreshCw,
  Clock,
  Camera,
  Users,
  FileText,
  Eye,
  Activity,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Zap,
  MessageSquare,
  UserSearch,
  Package,
  Grid3X3,
  MapPin,
  BarChart3,
  Flame,
  Play,
  History,
  Pause,
  Bot,
  CirclePlay,
} from "lucide-react";
import { cn, apiFetch, API_BASE } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface InvestigationResult {
  id: string;
  query: string;
  status: "running" | "completed" | "failed";
  timeline: { timestamp: string; event: string; camera?: string; confidence?: number }[];
  subjects: { track_id: string; description: string; cameras: string[]; risk_score: number }[];
  narrative: string;
  created_at: string;
}

interface InvestigationSummary {
  id: string;
  query: string;
  status: string;
  created_at: string;
  subject_count: number;
  event_count: number;
}

interface VideoWallCamera {
  camera_id: string;
  camera_name: string;
  activity_score: number;
  rank: number;
  zone: string;
  last_event?: string;
}

interface AttentionGap {
  camera_id: string;
  camera_name: string;
  priority: "critical" | "high" | "medium";
  last_viewed: string;
  activity_score: number;
  reason: string;
}

interface HeatScore {
  camera_id: string;
  camera_name: string;
  score: number;
  zone: string;
}

interface NLAlertRule {
  id: string;
  description: string;
  parsed_conditions: string;
  is_active: boolean;
  trigger_count: number;
  last_triggered: string | null;
  created_at: string;
}

interface AgentStatus {
  id: string;
  name: string;
  type: string;
  status: "running" | "paused" | "idle" | "error" | string;
  last_action?: string | null;
  confidence?: number | null;
  current_task?: string | null;
  created_at?: string;
  actions?: { description: string; confidence?: number; timestamp?: string }[];
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TABS = ["Investigations", "Video Wall AI", "Alert Rules", "Agents"] as const;
type Tab = (typeof TABS)[number];

const EXAMPLE_QUERIES = [
  "Show me all unauthorized access in the last 4 hours",
  "Find the person in a red jacket near parking lot B",
  "What happened at the main entrance between 2 AM and 4 AM?",
  "Track vehicle movements around the loading dock today",
];

const PRIORITY_BADGE: Record<string, string> = {
  critical: "text-red-400 bg-red-500/10 border-red-500/30",
  high: "text-orange-400 bg-orange-500/10 border-orange-500/30",
  medium: "text-yellow-400 bg-yellow-500/10 border-yellow-500/30",
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

function activityColor(score: number): string {
  if (score >= 0.7) return "text-red-400";
  if (score >= 0.4) return "text-yellow-400";
  return "text-green-400";
}

function confidenceBarColor(pct: number): string {
  if (pct >= 80) return "bg-green-500";
  if (pct >= 50) return "bg-amber-500";
  return "bg-red-500";
}

function ConfidenceBar({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) {
    return <span className="text-[10px] text-gray-600">N/A</span>;
  }
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 rounded-full bg-gray-800 overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", confidenceBarColor(pct))}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={cn(
        "text-[10px] font-mono font-bold",
        pct >= 80 ? "text-green-400" : pct >= 50 ? "text-amber-400" : "text-red-400"
      )}>
        {pct}%
      </span>
    </div>
  );
}

function heatColor(score: number): string {
  if (score >= 0.8) return "bg-red-500/40 border-red-500/50";
  if (score >= 0.6) return "bg-orange-500/30 border-orange-500/40";
  if (score >= 0.4) return "bg-yellow-500/20 border-yellow-500/30";
  if (score >= 0.2) return "bg-green-500/15 border-green-500/25";
  return "bg-gray-800/40 border-gray-700/50";
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function AgenticOpsPage() {
  const { addToast } = useToast();
  const [activeTab, setActiveTab] = useState<Tab>("Investigations");
  const [error, setError] = useState<string | null>(null);

  // ---- Investigations state ----
  const [query, setQuery] = useState("");
  const [investigating, setInvestigating] = useState(false);
  const [currentResult, setCurrentResult] = useState<InvestigationResult | null>(null);
  const [history, setHistory] = useState<InvestigationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [showFollowModal, setShowFollowModal] = useState(false);
  const [followDesc, setFollowDesc] = useState("");
  const [followSubmitting, setFollowSubmitting] = useState(false);
  const [expandedTimeline, setExpandedTimeline] = useState(true);

  // ---- Video Wall AI state ----
  const [wallCameras, setWallCameras] = useState<VideoWallCamera[]>([]);
  const [attentionGaps, setAttentionGaps] = useState<AttentionGap[]>([]);
  const [heatScores, setHeatScores] = useState<HeatScore[]>([]);
  const [wallLoading, setWallLoading] = useState(false);
  const [wallSubTab, setWallSubTab] = useState<"grid" | "gaps" | "heat">("grid");

  // ---- Alert Rules state ----
  const [nlRules, setNlRules] = useState<NLAlertRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [newRuleText, setNewRuleText] = useState("");
  const [ruleCreating, setRuleCreating] = useState(false);
  const [parsedPreview, setParsedPreview] = useState<string | null>(null);

  // ---- Agents state ----
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentActionId, setAgentActionId] = useState<string | null>(null);
  const [pauseConfirmId, setPauseConfirmId] = useState<string | null>(null);

  /* ---- Investigations ---- */
  const fetchHistory = async () => {
    setHistoryLoading(true);
    try {
      const data = await apiFetch<InvestigationSummary[]>("/api/investigations/");
      setHistory(Array.isArray(data) ? data : []);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleInvestigate = async () => {
    if (!query.trim()) return;
    setInvestigating(true);
    setCurrentResult(null);
    try {
      const result = await apiFetch<InvestigationResult>("/api/investigations/", {
        method: "POST",
        body: JSON.stringify({ query: query.trim() }),
      });
      setCurrentResult(result);
      setQuery("");
      fetchHistory();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Investigation failed");
    } finally {
      setInvestigating(false);
    }
  };

  const handleFollowSubject = async () => {
    if (!followDesc.trim() || !currentResult) return;
    setFollowSubmitting(true);
    try {
      const result = await apiFetch<InvestigationResult>("/api/investigations/follow-subject", {
        method: "POST",
        body: JSON.stringify({
          investigation_id: currentResult.id,
          subject_description: followDesc.trim(),
        }),
      });
      setCurrentResult(result);
      setShowFollowModal(false);
      setFollowDesc("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Follow subject failed");
    } finally {
      setFollowSubmitting(false);
    }
  };

  const handleDownloadEvidence = async (investigationId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/investigations/${investigationId}/evidence`, {
        headers: {
          Accept: "application/zip",
          Authorization: `Bearer ${localStorage.getItem("sentinel_token")}`,
        },
      });
      if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `evidence-${investigationId}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Evidence download failed");
    }
  };

  const loadInvestigation = async (id: string) => {
    try {
      const data = await apiFetch<InvestigationResult>(`/api/investigations/${id}`);
      setCurrentResult(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load investigation");
    }
  };

  useEffect(() => {
    if (activeTab === "Investigations") fetchHistory();
  }, [activeTab]);

  /* ---- Video Wall AI ---- */
  const fetchWallData = async () => {
    setWallLoading(true);
    try {
      const [layoutRaw, gaps, heatRaw] = await Promise.all([
        apiFetch<any>("/api/video-wall-ai/layout"),
        apiFetch<AttentionGap[]>("/api/video-wall-ai/attention-gaps"),
        apiFetch<any>("/api/video-wall-ai/heat-scores"),
      ]);
      setWallCameras(Array.isArray(layoutRaw) ? layoutRaw : (layoutRaw?.cells ?? []));
      setAttentionGaps(Array.isArray(gaps) ? gaps : []);
      const heatArr = Array.isArray(heatRaw) ? heatRaw : Object.entries(heatRaw || {}).map(([id, v]: [string, any]) => ({ camera_id: id, ...v }));
      setHeatScores(heatArr);
    } catch {
      setWallCameras([]);
      setAttentionGaps([]);
      setHeatScores([]);
    } finally {
      setWallLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "Video Wall AI") fetchWallData();
  }, [activeTab]);

  /* ---- Alert Rules ---- */
  const fetchRules = async () => {
    setRulesLoading(true);
    try {
      const data = await apiFetch<NLAlertRule[]>("/api/nl-alerts/rules");
      setNlRules(data);
    } catch {
      setNlRules([]);
    } finally {
      setRulesLoading(false);
    }
  };

  const handleCreateRule = async () => {
    if (!newRuleText.trim()) return;
    setRuleCreating(true);
    setParsedPreview(null);
    try {
      const result = await apiFetch<NLAlertRule>("/api/nl-alerts/rules", {
        method: "POST",
        body: JSON.stringify({ description: newRuleText.trim() }),
      });
      setParsedPreview(result.parsed_conditions);
      setNewRuleText("");
      fetchRules();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Rule creation failed");
    } finally {
      setRuleCreating(false);
    }
  };

  const handleToggleRule = async (ruleId: string) => {
    try {
      await apiFetch(`/api/nl-alerts/rules/${ruleId}/toggle`, { method: "POST" });
      fetchRules();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Toggle failed");
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    if (!confirm("Delete this alert rule?")) return;
    try {
      await apiFetch(`/api/nl-alerts/rules/${ruleId}`, { method: "DELETE" });
      fetchRules();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  useEffect(() => {
    if (activeTab === "Alert Rules") fetchRules();
  }, [activeTab]);

  /* ---- Agents ---- */
  const fetchAgents = async () => {
    setAgentsLoading(true);
    try {
      const data = await apiFetch<AgentStatus[]>("/api/agents");
      setAgents(Array.isArray(data) ? data : []);
    } catch {
      setAgents([]);
    } finally {
      setAgentsLoading(false);
    }
  };

  const handleAgentPause = async (agentId: string) => {
    setPauseConfirmId(null);
    setAgentActionId(`pause-${agentId}`);
    try {
      await apiFetch(`/api/agents/${agentId}/pause`, { method: "POST" });
      addToast("success", "Agent paused");
      await fetchAgents();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Pause failed";
      if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
        addToast("error", "Pause endpoint not available for this agent");
      } else {
        addToast("error", msg);
      }
    } finally {
      setAgentActionId(null);
    }
  };

  const handleAgentResume = async (agentId: string) => {
    setAgentActionId(`resume-${agentId}`);
    try {
      await apiFetch(`/api/agents/${agentId}/resume`, { method: "POST" });
      addToast("success", "Agent resumed");
      await fetchAgents();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Resume failed";
      if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
        addToast("error", "Resume endpoint not available for this agent");
      } else {
        addToast("error", msg);
      }
    } finally {
      setAgentActionId(null);
    }
  };

  useEffect(() => {
    if (activeTab === "Agents") fetchAgents();
  }, [activeTab]);

  return (
    <div className="flex h-full flex-col bg-[#030712]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-900/30 border border-violet-800/50">
            <Sparkles className="h-5 w-5 text-violet-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Agentic Operations
            </h1>
            <p className="text-xs text-gray-500">
              AI-powered investigations, intelligent video wall, and natural language alert rules
            </p>
          </div>
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
        {/* ============ INVESTIGATIONS TAB ============ */}
        {activeTab === "Investigations" && (
          <div className="space-y-6">
            {/* Query input */}
            <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-6">
              <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2 mb-3">
                <Search className="h-4 w-4 text-violet-400" />
                Ask a question about your facility
              </h2>
              <div className="flex gap-3">
                <div className="flex-1 relative">
                  <textarea
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="e.g., Show me all suspicious activity near the loading dock in the last 6 hours"
                    rows={3}
                    className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-3 text-xs text-gray-200 placeholder-gray-600 focus:border-violet-600 focus:outline-none resize-none"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleInvestigate(); }
                    }}
                  />
                </div>
                <button
                  onClick={handleInvestigate}
                  disabled={investigating || !query.trim()}
                  className="flex items-center gap-1.5 self-end rounded-lg bg-violet-600 px-5 py-2.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50 transition-colors"
                >
                  {investigating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Investigate
                </button>
              </div>
              {/* Example hints */}
              <div className="flex flex-wrap gap-2 mt-3">
                {EXAMPLE_QUERIES.map((eq, i) => (
                  <button
                    key={i}
                    onClick={() => setQuery(eq)}
                    className="rounded-lg border border-gray-800 bg-gray-900/40 px-2.5 py-1 text-[10px] text-gray-500 hover:text-gray-300 hover:border-gray-700 transition-colors"
                  >
                    {eq}
                  </button>
                ))}
              </div>
            </div>

            {/* Results panel */}
            {investigating && (
              <div className="flex flex-col items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-violet-400 mb-3" />
                <p className="text-xs text-gray-500">AI is investigating your query...</p>
              </div>
            )}

            {currentResult && (
              <div className="space-y-4">
                {/* Actions bar */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      "rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase",
                      currentResult.status === "completed" ? "text-green-400 bg-green-500/10 border-green-500/30" :
                      currentResult.status === "running" ? "text-yellow-400 bg-yellow-500/10 border-yellow-500/30" :
                      "text-red-400 bg-red-500/10 border-red-500/30"
                    )}>
                      {currentResult.status}
                    </span>
                    <span className="text-[10px] text-gray-500">{timeAgo(currentResult.created_at)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowFollowModal(true)}
                      className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 transition-colors"
                    >
                      <UserSearch className="h-3.5 w-3.5" /> Follow Subject
                    </button>
                    {currentResult.status === "completed" && (
                      <button
                        onClick={() => handleDownloadEvidence(currentResult.id)}
                        className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-500 transition-colors"
                      >
                        <Package className="h-3.5 w-3.5" /> Evidence Package
                      </button>
                    )}
                  </div>
                </div>

                {/* AI Narrative */}
                {currentResult.narrative && (
                  <div className="rounded-xl border border-violet-800/40 bg-violet-950/20 p-4">
                    <h3 className="text-xs font-bold text-violet-300 uppercase tracking-wider mb-2 flex items-center gap-2">
                      <Sparkles className="h-3.5 w-3.5" /> AI Narrative
                    </h3>
                    <p className="text-[11px] text-gray-300 leading-relaxed whitespace-pre-wrap">{currentResult.narrative}</p>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {/* Timeline */}
                  <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-4">
                    <button
                      onClick={() => setExpandedTimeline(!expandedTimeline)}
                      className="flex items-center gap-2 w-full text-left mb-3"
                    >
                      {expandedTimeline ? <ChevronDown className="h-3.5 w-3.5 text-gray-500" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-500" />}
                      <h3 className="text-xs font-bold text-gray-300 uppercase tracking-wider">
                        Timeline ({currentResult.timeline.length} events)
                      </h3>
                    </button>
                    {expandedTimeline && (
                      <div className="space-y-2 max-h-[300px] overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
                        {currentResult.timeline.length === 0 ? (
                          <p className="text-xs text-gray-600 py-4 text-center">No events found</p>
                        ) : (
                          currentResult.timeline.map((evt, i) => (
                            <div key={i} className="flex gap-3 border-l-2 border-gray-700 pl-3 py-1">
                              <span className="text-[9px] text-gray-600 font-mono shrink-0 w-16">
                                {new Date(evt.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
                              </span>
                              <div className="flex-1">
                                <p className="text-[11px] text-gray-300">{evt.event}</p>
                                <div className="flex items-center gap-2 mt-0.5">
                                  {evt.camera && (
                                    <span className="flex items-center gap-1 text-[9px] text-gray-500">
                                      <Camera className="h-2.5 w-2.5" /> {evt.camera}
                                    </span>
                                  )}
                                  {evt.confidence !== undefined && (
                                    <ConfidenceBar value={evt.confidence} />
                                  )}
                                </div>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>

                  {/* Subjects found */}
                  <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-4">
                    <h3 className="text-xs font-bold text-gray-300 uppercase tracking-wider mb-3">
                      Subjects Found ({currentResult.subjects.length})
                    </h3>
                    <div className="space-y-2 max-h-[300px] overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
                      {currentResult.subjects.length === 0 ? (
                        <p className="text-xs text-gray-600 py-4 text-center">No subjects identified</p>
                      ) : (
                        currentResult.subjects.map((sub, i) => (
                          <div key={i} className="rounded-lg border border-gray-800 bg-zinc-900/50 p-3">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-medium text-gray-200">{sub.description}</span>
                              <span className={cn(
                                "rounded px-1.5 py-0.5 text-[9px] font-bold font-mono",
                                sub.risk_score >= 0.7 ? "text-red-400 bg-red-900/30" :
                                sub.risk_score >= 0.4 ? "text-yellow-400 bg-yellow-900/30" :
                                "text-green-400 bg-green-900/30"
                              )}>
                                {(sub.risk_score * 100).toFixed(0)}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-1.5">
                              <span className="text-[9px] text-gray-500 font-mono">Track: {sub.track_id}</span>
                              <span className="text-[9px] text-gray-600">|</span>
                              <span className="text-[9px] text-gray-500">{sub.cameras.length} camera{sub.cameras.length !== 1 ? "s" : ""}</span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Investigation History */}
            <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-4">
              <h3 className="text-xs font-bold text-gray-300 uppercase tracking-wider mb-3 flex items-center gap-2">
                <History className="h-3.5 w-3.5 text-gray-500" />
                Investigation History
              </h3>
              {historyLoading ? (
                <div className="flex justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-cyan-400" />
                </div>
              ) : history.length === 0 ? (
                <p className="text-xs text-gray-600 py-6 text-center">No investigations yet</p>
              ) : (
                <div className="space-y-2 max-h-[250px] overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
                  {history.map((inv) => (
                    <button
                      key={inv.id}
                      onClick={() => loadInvestigation(inv.id)}
                      className="w-full text-left rounded-lg border border-gray-800 bg-zinc-900/50 p-3 hover:bg-gray-800/30 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-300 truncate max-w-[400px]">{inv.query}</span>
                        <span className="text-[10px] text-gray-500">{timeAgo(inv.created_at)}</span>
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-[9px] text-gray-600">{inv.subject_count} subjects</span>
                        <span className="text-[9px] text-gray-600">{inv.event_count} events</span>
                        <span className={cn(
                          "rounded px-1.5 py-0.5 text-[8px] font-bold uppercase",
                          inv.status === "completed" ? "text-green-400 bg-green-500/10" :
                          inv.status === "running" ? "text-yellow-400 bg-yellow-500/10" :
                          "text-red-400 bg-red-500/10"
                        )}>
                          {inv.status}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ============ VIDEO WALL AI TAB ============ */}
        {activeTab === "Video Wall AI" && (
          <div className="space-y-4">
            {/* Sub-tabs */}
            <div className="flex items-center gap-2">
              {([["grid", "Smart Grid", Grid3X3], ["gaps", "Attention Gaps", AlertTriangle], ["heat", "Heat Map", Flame]] as const).map(([key, label, Icon]) => (
                <button
                  key={key}
                  onClick={() => setWallSubTab(key as "grid" | "gaps" | "heat")}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                    wallSubTab === key
                      ? "border-cyan-500/50 bg-cyan-500/10 text-cyan-400"
                      : "border-gray-800 bg-gray-900/50 text-gray-500 hover:text-gray-300"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
              <button
                onClick={fetchWallData}
                disabled={wallLoading}
                className="ml-auto flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 transition-colors disabled:opacity-50"
              >
                {wallLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              </button>
            </div>

            {wallLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
              </div>
            ) : (
              <>
                {/* Smart Grid */}
                {wallSubTab === "grid" && (
                  <div>
                    {wallCameras.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                        <Grid3X3 className="h-10 w-10 mb-3 opacity-30" />
                        <p className="text-sm">No camera layout data available</p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                        {wallCameras.map((cam) => (
                          <div
                            key={cam.camera_id}
                            className={cn(
                              "rounded-lg border p-3 transition-colors",
                              cam.activity_score >= 0.7
                                ? "border-red-800/60 bg-red-950/20"
                                : cam.activity_score >= 0.4
                                ? "border-yellow-800/50 bg-yellow-950/10"
                                : "border-gray-800 bg-zinc-900/50"
                            )}
                          >
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-[10px] text-gray-400 font-mono">#{cam.rank}</span>
                              <span className={cn("text-sm font-bold font-mono", activityColor(cam.activity_score))}>
                                {(cam.activity_score * 100).toFixed(0)}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 mb-1">
                              <Camera className="h-3 w-3 text-gray-500" />
                              <span className="text-xs text-gray-300 truncate">{cam.camera_name}</span>
                            </div>
                            <span className="text-[9px] text-gray-600">{cam.zone}</span>
                            {cam.last_event && (
                              <p className="text-[9px] text-gray-500 mt-1 truncate">{cam.last_event}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Attention Gaps */}
                {wallSubTab === "gaps" && (
                  <div>
                    {attentionGaps.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                        <Eye className="h-10 w-10 mb-3 opacity-30" />
                        <p className="text-sm">No attention gaps detected</p>
                        <p className="text-xs mt-1">All high-priority cameras are being monitored</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {attentionGaps.map((gap) => (
                          <div
                            key={gap.camera_id}
                            className={cn(
                              "flex items-center gap-4 rounded-lg border p-3",
                              gap.priority === "critical" ? "border-red-800/60 bg-red-950/20" :
                              gap.priority === "high" ? "border-orange-800/50 bg-orange-950/10" :
                              "border-yellow-800/40 bg-yellow-950/10"
                            )}
                          >
                            <AlertTriangle className={cn(
                              "h-5 w-5 shrink-0",
                              gap.priority === "critical" ? "text-red-400" :
                              gap.priority === "high" ? "text-orange-400" : "text-yellow-400"
                            )} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold text-gray-200">{gap.camera_name}</span>
                                <span className={cn(
                                  "rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase",
                                  PRIORITY_BADGE[gap.priority]
                                )}>
                                  {gap.priority}
                                </span>
                              </div>
                              <p className="text-[10px] text-gray-500 mt-0.5">{gap.reason}</p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className={cn("text-xs font-bold font-mono", activityColor(gap.activity_score))}>
                                {(gap.activity_score * 100).toFixed(0)}
                              </p>
                              <p className="text-[9px] text-gray-600">Last viewed: {timeAgo(gap.last_viewed)}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Heat Map */}
                {wallSubTab === "heat" && (
                  <div>
                    {heatScores.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                        <Flame className="h-10 w-10 mb-3 opacity-30" />
                        <p className="text-sm">No heat score data available</p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-2">
                        {heatScores.map((cam) => (
                          <div
                            key={cam.camera_id}
                            className={cn(
                              "rounded-lg border p-2.5 text-center transition-colors",
                              heatColor(cam.score)
                            )}
                          >
                            <span className="text-lg font-bold font-mono text-gray-200">
                              {(cam.score * 100).toFixed(0)}
                            </span>
                            <p className="text-[9px] text-gray-400 truncate mt-0.5">{cam.camera_name}</p>
                            <p className="text-[8px] text-gray-600">{cam.zone}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* Legend */}
                    <div className="flex items-center gap-4 mt-4">
                      <span className="text-[10px] text-gray-500">Activity:</span>
                      <div className="flex items-center gap-1"><div className="h-3 w-6 rounded bg-gray-800/40" /><span className="text-[9px] text-gray-600">Low</span></div>
                      <div className="flex items-center gap-1"><div className="h-3 w-6 rounded bg-green-500/15" /><span className="text-[9px] text-gray-600">Normal</span></div>
                      <div className="flex items-center gap-1"><div className="h-3 w-6 rounded bg-yellow-500/20" /><span className="text-[9px] text-gray-600">Moderate</span></div>
                      <div className="flex items-center gap-1"><div className="h-3 w-6 rounded bg-orange-500/30" /><span className="text-[9px] text-gray-600">High</span></div>
                      <div className="flex items-center gap-1"><div className="h-3 w-6 rounded bg-red-500/40" /><span className="text-[9px] text-gray-600">Critical</span></div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ============ ALERT RULES TAB ============ */}
        {activeTab === "Alert Rules" && (
          <div className="space-y-6">
            {/* Create rule */}
            <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-5">
              <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2 mb-3">
                <MessageSquare className="h-4 w-4 text-cyan-400" />
                Create Alert Rule in Plain English
              </h2>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={newRuleText}
                  onChange={(e) => setNewRuleText(e.target.value)}
                  placeholder='e.g., "Alert me if someone enters the server room after 10 PM"'
                  className="flex-1 rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-2.5 text-xs text-gray-200 placeholder-gray-600 focus:border-cyan-600 focus:outline-none"
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreateRule(); }}
                />
                <button
                  onClick={handleCreateRule}
                  disabled={ruleCreating || !newRuleText.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-4 py-2 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-50 transition-colors"
                >
                  {ruleCreating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  Create Rule
                </button>
              </div>

              {/* Parsed preview */}
              {parsedPreview && (
                <div className="mt-3 rounded-lg border border-green-500/30 bg-green-500/10 p-3">
                  <p className="text-[10px] text-green-400 uppercase tracking-wider font-bold mb-1">Parsed Rule Conditions</p>
                  <p className="text-xs text-gray-300 font-mono">{parsedPreview}</p>
                </div>
              )}
            </div>

            {/* Existing rules */}
            <div>
              <h3 className="text-sm font-semibold text-gray-200 mb-3">
                Active Rules ({nlRules.length})
              </h3>
              {rulesLoading ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
                </div>
              ) : nlRules.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                  <Zap className="h-10 w-10 mb-3 opacity-30" />
                  <p className="text-sm">No alert rules configured</p>
                  <p className="text-xs mt-1">Create rules using natural language above</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {nlRules.map((rule) => (
                    <div
                      key={rule.id}
                      className={cn(
                        "rounded-xl border p-4 transition-colors",
                        rule.is_active ? "border-gray-800 bg-zinc-900/30" : "border-gray-800/50 bg-gray-900/20 opacity-60"
                      )}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-gray-200">{rule.description}</p>
                          {rule.parsed_conditions && (
                            <p className="text-[10px] text-gray-500 font-mono mt-1">{rule.parsed_conditions}</p>
                          )}
                          <div className="flex items-center gap-4 mt-2">
                            <span className="text-[10px] text-gray-600 flex items-center gap-1">
                              <Zap className="h-2.5 w-2.5" />
                              {rule.trigger_count} triggers
                            </span>
                            {rule.last_triggered && (
                              <span className="text-[10px] text-gray-600 flex items-center gap-1">
                                <Clock className="h-2.5 w-2.5" />
                                Last: {timeAgo(rule.last_triggered)}
                              </span>
                            )}
                            <span className="text-[10px] text-gray-600">
                              Created {timeAgo(rule.created_at)}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={() => handleToggleRule(rule.id)}
                            className="rounded p-1.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
                          >
                            {rule.is_active
                              ? <ToggleRight className="h-4 w-4 text-green-400" />
                              : <ToggleLeft className="h-4 w-4 text-gray-600" />
                            }
                          </button>
                          <button
                            onClick={() => handleDeleteRule(rule.id)}
                            className="rounded p-1.5 text-gray-500 hover:bg-red-900/30 hover:text-red-400 transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ============ AGENTS TAB ============ */}
        {activeTab === "Agents" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                <Bot className="h-4 w-4 text-violet-400" />
                Active Agents
              </h2>
              <button
                onClick={fetchAgents}
                disabled={agentsLoading}
                className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 transition-colors disabled:opacity-50"
              >
                {agentsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Refresh
              </button>
            </div>

            {agentsLoading && agents.length === 0 ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
              </div>
            ) : agents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <Bot className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">No agents found</p>
                <p className="text-xs mt-1">Agents will appear here when running</p>
              </div>
            ) : (
              <div className="space-y-3">
                {agents.map((agent) => {
                  const isRunning = agent.status === "running";
                  const isPaused = agent.status === "paused";
                  const isPausingThis = agentActionId === `pause-${agent.id}`;
                  const isResumingThis = agentActionId === `resume-${agent.id}`;
                  const statusColors: Record<string, string> = {
                    running: "text-green-400 bg-green-500/10 border-green-500/30",
                    paused: "text-amber-400 bg-amber-500/10 border-amber-500/30",
                    idle: "text-gray-400 bg-gray-500/10 border-gray-500/30",
                    error: "text-red-400 bg-red-500/10 border-red-500/30",
                  };
                  const statusCls = statusColors[agent.status] || "text-gray-400 bg-gray-500/10 border-gray-500/30";

                  return (
                    <div
                      key={agent.id}
                      className={cn(
                        "rounded-xl border p-4 transition-colors",
                        isRunning ? "border-gray-800 bg-zinc-900/30" : "border-gray-800/50 bg-gray-900/20"
                      )}
                    >
                      {/* Header */}
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={cn(
                            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border",
                            isRunning ? "bg-violet-900/30 border-violet-800/50" : "bg-gray-800 border-gray-700"
                          )}>
                            <Bot className={cn("h-4 w-4", isRunning ? "text-violet-400" : "text-gray-500")} />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="text-sm font-semibold text-gray-200">{agent.name}</h3>
                              <span className={cn("rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase", statusCls)}>
                                {agent.status}
                              </span>
                              <span className="rounded bg-gray-800 border border-gray-700 px-1.5 py-0.5 text-[9px] text-gray-500">
                                {agent.type}
                              </span>
                            </div>
                            {agent.current_task && (
                              <p className="mt-0.5 text-[10px] text-gray-500 truncate max-w-sm">{agent.current_task}</p>
                            )}
                          </div>
                        </div>

                        {/* Override buttons */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          {isRunning && (
                            <>
                              {pauseConfirmId === agent.id ? (
                                <div className="flex items-center gap-1 rounded-lg border border-amber-800/50 bg-amber-900/10 px-2 py-1 text-[10px]">
                                  <span className="text-amber-300 mr-1">Pause agent?</span>
                                  <button
                                    onClick={() => handleAgentPause(agent.id)}
                                    className="rounded px-1.5 py-0.5 bg-amber-600/40 text-amber-300 hover:bg-amber-600/60 transition-colors"
                                  >
                                    Confirm
                                  </button>
                                  <button
                                    onClick={() => setPauseConfirmId(null)}
                                    className="rounded px-1.5 py-0.5 text-gray-500 hover:text-gray-300 transition-colors"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setPauseConfirmId(agent.id)}
                                  disabled={!!agentActionId}
                                  className="flex items-center gap-1 rounded-lg border border-amber-800/40 px-2 py-1.5 text-[11px] text-amber-400 hover:bg-amber-900/20 transition-colors disabled:opacity-50"
                                >
                                  {isPausingThis ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pause className="h-3 w-3" />}
                                  Pause
                                </button>
                              )}
                            </>
                          )}
                          {isPaused && (
                            <button
                              onClick={() => handleAgentResume(agent.id)}
                              disabled={!!agentActionId}
                              className="flex items-center gap-1 rounded-lg border border-green-800/40 px-2 py-1.5 text-[11px] text-green-400 hover:bg-green-900/20 transition-colors disabled:opacity-50"
                            >
                              {isResumingThis ? <Loader2 className="h-3 w-3 animate-spin" /> : <CirclePlay className="h-3 w-3" />}
                              Resume
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Confidence + last action row */}
                      <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-gray-500">
                        <div className="flex items-center gap-2">
                          <span>Confidence:</span>
                          <ConfidenceBar value={agent.confidence} />
                        </div>
                        {agent.last_action && (
                          <div className="flex items-center gap-1">
                            <Activity className="h-3 w-3" />
                            <span className="text-gray-400 truncate max-w-[200px]">{agent.last_action}</span>
                          </div>
                        )}
                        {agent.created_at && (
                          <div className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            <span>{timeAgo(agent.created_at)}</span>
                          </div>
                        )}
                      </div>

                      {/* Action decisions with confidence bars */}
                      {agent.actions && agent.actions.length > 0 && (
                        <div className="mt-3 space-y-1.5 border-t border-gray-800/60 pt-3">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-600 mb-2">Recent Decisions</p>
                          {agent.actions.slice(0, 5).map((action, i) => (
                            <div key={i} className="flex items-center justify-between rounded-lg bg-gray-900/40 px-3 py-1.5">
                              <span className="text-[10px] text-gray-400 truncate max-w-[60%]">{action.description}</span>
                              <ConfidenceBar value={action.confidence ?? null} />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Follow Subject Modal */}
      {showFollowModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-gray-200 flex items-center gap-2">
                <UserSearch className="h-4 w-4 text-violet-400" />
                Follow Subject
              </h2>
              <button onClick={() => setShowFollowModal(false)} className="text-gray-500 hover:text-gray-300">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-gray-500 mb-3">
              Describe the person you want to track across all cameras.
            </p>
            <textarea
              value={followDesc}
              onChange={(e) => setFollowDesc(e.target.value)}
              placeholder="e.g., Male wearing a red hoodie and dark jeans, carrying a backpack"
              rows={3}
              className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2.5 text-xs text-gray-200 placeholder-gray-600 focus:border-violet-600 focus:outline-none resize-none"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowFollowModal(false)}
                className="rounded-lg border border-gray-700 px-4 py-2 text-xs text-gray-400 hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleFollowSubject}
                disabled={followSubmitting || !followDesc.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50 transition-colors"
              >
                {followSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                Track Subject
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
