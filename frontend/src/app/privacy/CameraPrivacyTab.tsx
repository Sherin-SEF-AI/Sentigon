"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Shield,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Camera,
  Users,
  Lock,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  X,
  FileText,
  Database,
  ArrowRight,
  Server,
  Globe,
  Download,
  Settings,
  UserCheck,
  KeyRound,
  Trash2,
  ChevronDown,
  BarChart3,
  Zap,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ComplianceScorecard {
  overall_score: number;
  categories: {
    retention: number;
    consent: number;
    access: number;
    redaction: number;
    audit: number;
  };
  last_assessed: string;
}

interface ComplianceIssue {
  id: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  description: string;
  recommendation: string;
  resolved: boolean;
}

interface SilhouetteConfig {
  camera_id: string;
  camera_name: string;
  zone: string;
  privacy_mode: "silhouette_only" | "blurred_faces" | "full_video";
  tier_roles: Record<string, string>;
  auto_redaction: boolean;
}

interface VideoAccessLog {
  id: string;
  user: string;
  camera_name: string;
  access_tier: string;
  reason: string;
  timestamp: string;
  duration_seconds: number;
}

interface PIAResult {
  id: string;
  target: string;
  target_type: "camera" | "zone";
  risk_level: "high" | "medium" | "low";
  risks: { risk: string; severity: string; mitigation: string }[];
  overall_assessment: string;
  generated_at: string;
}

interface DataFlow {
  id: string;
  source: string;
  destination: string;
  data_type: string;
  purpose: string;
  retention_days: number;
  encrypted: boolean;
  flow_type: "processing" | "storage" | "external";
}

interface RedactionQueue {
  pending: number;
  in_progress: number;
  completed: number;
}

interface RetentionPolicy {
  id: string;
  name: string;
  retention_days: number;
  data_type: string;
  last_purge: string | null;
  next_purge: string | null;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TABS = ["Scorecard", "Silhouette Config", "Video Access Audit", "PIA", "Data Flows", "Redaction Queue", "Retention"] as const;
type Tab = (typeof TABS)[number];

const SEVERITY_BADGE: Record<string, string> = {
  critical: "text-red-500 bg-red-500/10 border-red-500/50",
  high: "text-orange-500 bg-orange-500/10 border-orange-500/50",
  medium: "text-yellow-500 bg-yellow-500/10 border-yellow-500/50",
  low: "text-blue-400 bg-blue-400/10 border-blue-400/50",
};

const PRIVACY_MODE_LABELS: Record<string, string> = {
  silhouette_only: "Silhouette Only",
  blurred_faces: "Blurred Faces",
  full_video: "Full Video",
};

const PRIVACY_MODE_BADGE: Record<string, string> = {
  silhouette_only: "text-green-400 bg-green-500/10 border-green-500/30",
  blurred_faces: "text-yellow-400 bg-yellow-500/10 border-yellow-500/30",
  full_video: "text-red-400 bg-red-500/10 border-red-500/30",
};

const FLOW_TYPE_BADGE: Record<string, string> = {
  processing: "text-blue-400 bg-blue-500/10 border-blue-500/30",
  storage: "text-purple-400 bg-purple-500/10 border-purple-500/30",
  external: "text-orange-400 bg-orange-500/10 border-orange-500/30",
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

function scoreColor(score: number): string {
  if (score >= 80) return "text-green-400";
  if (score >= 60) return "text-yellow-400";
  if (score >= 40) return "text-orange-400";
  return "text-red-400";
}

function scoreStrokeColor(score: number): string {
  if (score >= 80) return "#4ade80";
  if (score >= 60) return "#facc15";
  if (score >= 40) return "#fb923c";
  return "#f87171";
}

/* ------------------------------------------------------------------ */
/*  Circular Progress Component                                        */
/* ------------------------------------------------------------------ */

function CircularProgress({ score, size = 160 }: { score: number; size?: number }) {
  const radius = (size - 16) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = (score / 100) * circumference;
  const strokeColor = scoreStrokeColor(score);

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#1f2937"
          strokeWidth="8"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - progress}
          className="transition-all duration-1000"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn("text-3xl font-bold", scoreColor(score))}>{score}</span>
        <span className="text-[10px] text-gray-500 uppercase tracking-wider">Score</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

export default function CameraPrivacyTab() {
  const [activeTab, setActiveTab] = useState<Tab>("Scorecard");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Scorecard state
  const [scorecard, setScorecard] = useState<ComplianceScorecard | null>(null);
  const [issues, setIssues] = useState<ComplianceIssue[]>([]);
  const [scorecardLoading, setScorecardLoading] = useState(false);
  const [assessing, setAssessing] = useState(false);

  // Silhouette config state
  const [silhouetteConfigs, setSilhouetteConfigs] = useState<SilhouetteConfig[]>([]);
  const [silhouetteLoading, setSilhouetteLoading] = useState(false);
  const [editingConfig, setEditingConfig] = useState<SilhouetteConfig | null>(null);
  const [configSaving, setConfigSaving] = useState(false);

  // Video access state
  const [accessLogs, setAccessLogs] = useState<VideoAccessLog[]>([]);
  const [accessLoading, setAccessLoading] = useState(false);

  // PIA state
  const [piaTarget, setPiaTarget] = useState("");
  const [piaTargetType, setPiaTargetType] = useState<"camera" | "zone">("camera");
  const [piaResult, setPiaResult] = useState<PIAResult | null>(null);
  const [piaGenerating, setPiaGenerating] = useState(false);

  // Data flows state
  const [dataFlows, setDataFlows] = useState<DataFlow[]>([]);
  const [flowsLoading, setFlowsLoading] = useState(false);

  // Redaction queue state
  const [redactionQueue, setRedactionQueue] = useState<RedactionQueue | null>(null);
  const [redactionLoading, setRedactionLoading] = useState(false);
  const [redactionUnavailable, setRedactionUnavailable] = useState(false);

  // Retention policies state
  const [retentionPolicies, setRetentionPolicies] = useState<RetentionPolicy[]>([]);
  const [retentionLoading, setRetentionLoading] = useState(false);

  /* ---- Initial load ---- */
  const fetchInitial = useCallback(async () => {
    try {
      const data = await apiFetch<any>("/api/compliance-dashboard/scorecard");
      setScorecard({
        overall_score: data.overall_score ?? 0,
        categories: data.categories ?? {},
        framework: data.framework ?? "GDPR",
        status: data.status ?? "unknown",
        ...data,
      });
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load compliance data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInitial();
  }, [fetchInitial]);

  /* ---- Tab data fetchers ---- */
  const runAssessment = async () => {
    setAssessing(true);
    try {
      const data = await apiFetch<{ scorecard: ComplianceScorecard; issues: ComplianceIssue[] }>(
        "/api/compliance-dashboard/assess",
        { method: "POST" }
      );
      setScorecard(data.scorecard);
      setIssues(data.issues || []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Assessment failed");
    } finally {
      setAssessing(false);
    }
  };

  const fetchSilhouetteConfig = async () => {
    setSilhouetteLoading(true);
    try {
      const data = await apiFetch<any>("/api/silhouette/config");
      setSilhouetteConfigs(Array.isArray(data) ? data : [data]);
    } catch {
      setSilhouetteConfigs([]);
    } finally {
      setSilhouetteLoading(false);
    }
  };

  const saveSilhouetteConfig = async (config: SilhouetteConfig) => {
    setConfigSaving(true);
    try {
      await apiFetch("/api/silhouette/config", {
        method: "POST",
        body: JSON.stringify(config),
      });
      setEditingConfig(null);
      fetchSilhouetteConfig();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Config save failed");
    } finally {
      setConfigSaving(false);
    }
  };

  const fetchAccessLogs = async () => {
    setAccessLoading(true);
    try {
      const data = await apiFetch<VideoAccessLog[]>("/api/silhouette/access-audit");
      setAccessLogs(data);
    } catch {
      setAccessLogs([]);
    } finally {
      setAccessLoading(false);
    }
  };

  const generatePIA = async () => {
    if (!piaTarget) return;
    setPiaGenerating(true);
    setPiaResult(null);
    try {
      const result = await apiFetch<PIAResult>("/api/compliance-dashboard/pia", {
        method: "POST",
        body: JSON.stringify({ target: piaTarget, target_type: piaTargetType }),
      });
      setPiaResult(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "PIA generation failed");
    } finally {
      setPiaGenerating(false);
    }
  };

  const fetchDataFlows = async () => {
    setFlowsLoading(true);
    try {
      const data = await apiFetch<DataFlow[]>("/api/compliance-dashboard/data-flows");
      setDataFlows(data);
    } catch {
      setDataFlows([]);
    } finally {
      setFlowsLoading(false);
    }
  };

  const fetchRedactionQueue = async () => {
    setRedactionLoading(true);
    setRedactionUnavailable(false);
    try {
      const data = await apiFetch<RedactionQueue>("/api/compliance-dashboard/redaction-queue");
      setRedactionQueue(data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
        setRedactionUnavailable(true);
      }
      setRedactionQueue(null);
    } finally {
      setRedactionLoading(false);
    }
  };

  const fetchRetentionPolicies = async () => {
    setRetentionLoading(true);
    try {
      const data = await apiFetch<RetentionPolicy[]>("/api/compliance-dashboard/retention-policies");
      setRetentionPolicies(Array.isArray(data) ? data : []);
    } catch {
      // Fall back to deriving retention from data flows if available
      if (dataFlows.length > 0) {
        const derived: RetentionPolicy[] = dataFlows.map((f) => ({
          id: f.id,
          name: `${f.source} → ${f.destination}`,
          retention_days: f.retention_days,
          data_type: f.data_type,
          last_purge: null,
          next_purge: null,
        }));
        setRetentionPolicies(derived);
      } else {
        setRetentionPolicies([]);
      }
    } finally {
      setRetentionLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "Silhouette Config") fetchSilhouetteConfig();
    if (activeTab === "Video Access Audit") fetchAccessLogs();
    if (activeTab === "Data Flows") fetchDataFlows();
    if (activeTab === "Redaction Queue") fetchRedactionQueue();
    if (activeTab === "Retention") fetchRetentionPolicies();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  /* ---- Loading ---- */
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[#030712]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-10 w-10 animate-spin text-cyan-400" />
          <p className="text-sm text-gray-500">Loading privacy center...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#030712]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-900/30 border border-teal-800/50">
            <Shield className="h-5 w-5 text-teal-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Privacy & Compliance Center
            </h1>
            <p className="text-xs text-gray-500">
              Privacy controls, compliance scoring, and data governance
            </p>
          </div>
        </div>
        <button
          onClick={() => { setLoading(true); fetchInitial(); }}
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

      {/* Compliance scorecard overview */}
      {scorecard && (
        <div className="border-b border-gray-800 px-6 py-4">
          <div className="flex items-center gap-8">
            <CircularProgress score={scorecard.overall_score} />
            <div className="flex-1 grid grid-cols-5 gap-3">
              {(Object.entries(scorecard.categories) as [string, number][]).map(([cat, score]) => (
                <div key={cat} className="rounded-lg border border-gray-800 bg-zinc-900/60 p-3">
                  <div className="flex items-center gap-2 mb-1">
                    {cat === "retention" && <Clock className="h-3.5 w-3.5 text-blue-400" />}
                    {cat === "consent" && <UserCheck className="h-3.5 w-3.5 text-green-400" />}
                    {cat === "access" && <KeyRound className="h-3.5 w-3.5 text-purple-400" />}
                    {cat === "redaction" && <EyeOff className="h-3.5 w-3.5 text-orange-400" />}
                    {cat === "audit" && <FileText className="h-3.5 w-3.5 text-cyan-400" />}
                    <span className="text-[10px] text-gray-500 uppercase tracking-wider">{cat}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn("text-lg font-bold", scoreColor(score))}>{score}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${score}%`,
                          backgroundColor: scoreStrokeColor(score),
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          {scorecard.last_assessed && (
            <p className="text-[10px] text-gray-600 mt-2">Last assessed: {timeAgo(scorecard.last_assessed)}</p>
          )}
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
        {/* ============ SCORECARD TAB ============ */}
        {activeTab === "Scorecard" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-teal-400" />
                Compliance Assessment
              </h2>
              <button
                onClick={runAssessment}
                disabled={assessing}
                className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-500 disabled:opacity-50 transition-colors"
              >
                {assessing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                Run Assessment
              </button>
            </div>

            {/* Issues list */}
            {issues.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                  Issues Found ({issues.length})
                </h3>
                {issues.map((issue) => (
                  <div key={issue.id} className={cn(
                    "rounded-xl border p-4",
                    issue.resolved ? "border-gray-800/50 bg-gray-900/30 opacity-60" :
                    issue.severity === "critical" ? "border-red-800/60 bg-red-950/20" :
                    issue.severity === "high" ? "border-orange-800/50 bg-orange-950/10" :
                    "border-gray-800 bg-zinc-900/30"
                  )}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold text-gray-200">{issue.title}</span>
                          <span className={cn(
                            "rounded px-1.5 py-0.5 text-[9px] font-bold uppercase border",
                            SEVERITY_BADGE[issue.severity]
                          )}>
                            {issue.severity}
                          </span>
                          <span className="rounded bg-gray-800/60 px-1.5 py-0.5 text-[9px] text-gray-500">
                            {issue.category}
                          </span>
                        </div>
                        <p className="text-[11px] text-gray-400">{issue.description}</p>
                        {issue.recommendation && (
                          <div className="mt-2 flex items-start gap-2 rounded-lg bg-teal-500/5 border border-teal-500/20 px-3 py-2">
                            <CheckCircle2 className="h-3 w-3 text-teal-400 mt-0.5 shrink-0" />
                            <p className="text-[10px] text-teal-300">{issue.recommendation}</p>
                          </div>
                        )}
                      </div>
                      {issue.resolved && (
                        <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {issues.length === 0 && !assessing && (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <Shield className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">Run an assessment to check compliance status</p>
                <p className="text-xs mt-1">The AI will analyze your privacy configuration across all cameras and zones</p>
              </div>
            )}
          </div>
        )}

        {/* ============ SILHOUETTE CONFIG TAB ============ */}
        {activeTab === "Silhouette Config" && (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
              <EyeOff className="h-4 w-4 text-orange-400" />
              Privacy Mode Configuration
            </h2>

            {silhouetteLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
              </div>
            ) : silhouetteConfigs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <Settings className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">No privacy configurations found</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-gray-800 bg-zinc-900/30">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-gray-800 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                      <th className="px-4 py-3">Camera</th>
                      <th className="px-4 py-3">Zone</th>
                      <th className="px-4 py-3">Privacy Mode</th>
                      <th className="px-4 py-3">Auto-Redaction</th>
                      <th className="px-4 py-3">Tier Roles</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {silhouetteConfigs.map((config) => (
                      <tr key={config.camera_id} className="border-b border-gray-800/30 hover:bg-gray-800/20 transition-colors">
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-1.5 text-xs text-gray-300">
                            <Camera className="h-3 w-3 text-gray-500" />
                            {config.camera_name}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-400">{config.zone}</td>
                        <td className="px-4 py-2.5">
                          <span className={cn(
                            "rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase",
                            PRIVACY_MODE_BADGE[config.privacy_mode]
                          )}>
                            {PRIVACY_MODE_LABELS[config.privacy_mode]}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          {config.auto_redaction ? (
                            <span className="flex items-center gap-1 text-[10px] text-green-400">
                              <CheckCircle2 className="h-3 w-3" /> On
                            </span>
                          ) : (
                            <span className="text-[10px] text-gray-600">Off</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {Object.entries(config.tier_roles).slice(0, 3).map(([tier, role]) => (
                              <span key={tier} className="rounded bg-gray-800/60 px-1.5 py-0.5 text-[9px] text-gray-500">
                                {tier}: {role}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            onClick={() => setEditingConfig(config)}
                            className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
                          >
                            <Settings className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ============ VIDEO ACCESS AUDIT TAB ============ */}
        {activeTab === "Video Access Audit" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                <Eye className="h-4 w-4 text-purple-400" />
                Video Access Audit Log
              </h2>
              <button
                onClick={fetchAccessLogs}
                disabled={accessLoading}
                className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 transition-colors disabled:opacity-50"
              >
                {accessLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              </button>
            </div>

            {accessLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
              </div>
            ) : accessLogs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <FileText className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">No access logs recorded</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-gray-800 bg-zinc-900/30">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-gray-800 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                      <th className="px-4 py-3">User</th>
                      <th className="px-4 py-3">Camera</th>
                      <th className="px-4 py-3">Access Tier</th>
                      <th className="px-4 py-3">Reason</th>
                      <th className="px-4 py-3">Duration</th>
                      <th className="px-4 py-3">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accessLogs.map((log) => (
                      <tr key={log.id} className="border-b border-gray-800/30 hover:bg-gray-800/20 transition-colors">
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-1.5 text-xs text-gray-300">
                            <Users className="h-3 w-3 text-gray-500" />
                            {log.user}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-1.5 text-xs text-gray-400">
                            <Camera className="h-3 w-3 text-gray-500" />
                            {log.camera_name}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={cn(
                            "rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase",
                            log.access_tier === "full" ? "text-red-400 bg-red-500/10 border-red-500/30" :
                            log.access_tier === "elevated" ? "text-orange-400 bg-orange-500/10 border-orange-500/30" :
                            "text-green-400 bg-green-500/10 border-green-500/30"
                          )}>
                            {log.access_tier}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-[11px] text-gray-400 max-w-[200px] truncate">{log.reason}</td>
                        <td className="px-4 py-2.5 text-xs text-gray-400 font-mono">{log.duration_seconds}s</td>
                        <td className="px-4 py-2.5 text-[11px] text-gray-500">{timeAgo(log.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ============ PIA TAB ============ */}
        {activeTab === "PIA" && (
          <div className="space-y-6">
            <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
              <FileText className="h-4 w-4 text-blue-400" />
              Privacy Impact Assessment
            </h2>

            <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-5">
              <p className="text-xs text-gray-500 mb-3">
                Generate a Privacy Impact Assessment for a specific camera or zone to identify risks and mitigations.
              </p>
              <div className="flex gap-3">
                <select
                  value={piaTargetType}
                  onChange={(e) => setPiaTargetType(e.target.value as "camera" | "zone")}
                  className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-300 focus:border-cyan-600 focus:outline-none"
                >
                  <option value="camera">Camera</option>
                  <option value="zone">Zone</option>
                </select>
                <input
                  type="text"
                  value={piaTarget}
                  onChange={(e) => setPiaTarget(e.target.value)}
                  placeholder={`Enter ${piaTargetType} name or ID...`}
                  className="flex-1 rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:border-cyan-600 focus:outline-none"
                />
                <button
                  onClick={generatePIA}
                  disabled={piaGenerating || !piaTarget}
                  className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                >
                  {piaGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                  Generate PIA
                </button>
              </div>
            </div>

            {piaGenerating && (
              <div className="flex flex-col items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-blue-400 mb-3" />
                <p className="text-xs text-gray-500">Generating privacy impact assessment...</p>
              </div>
            )}

            {piaResult && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-300">{piaResult.target}</span>
                    <span className={cn(
                      "rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase",
                      piaResult.risk_level === "high" ? "text-red-400 bg-red-500/10 border-red-500/30" :
                      piaResult.risk_level === "medium" ? "text-yellow-400 bg-yellow-500/10 border-yellow-500/30" :
                      "text-green-400 bg-green-500/10 border-green-500/30"
                    )}>
                      {piaResult.risk_level} risk
                    </span>
                  </div>
                  <span className="text-[10px] text-gray-600">Generated {timeAgo(piaResult.generated_at)}</span>
                </div>

                {/* Overall assessment */}
                <div className="rounded-xl border border-blue-800/40 bg-blue-950/20 p-4">
                  <h3 className="text-xs font-bold text-blue-300 uppercase tracking-wider mb-2">Overall Assessment</h3>
                  <p className="text-[11px] text-gray-300 leading-relaxed">{piaResult.overall_assessment}</p>
                </div>

                {/* Risks and mitigations */}
                <div className="space-y-2">
                  {piaResult.risks.map((risk, i) => (
                    <div key={i} className="rounded-xl border border-gray-800 bg-zinc-900/30 p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <AlertTriangle className={cn(
                          "h-3.5 w-3.5",
                          risk.severity === "high" ? "text-red-400" :
                          risk.severity === "medium" ? "text-yellow-400" : "text-blue-400"
                        )} />
                        <span className="text-xs font-medium text-gray-200">{risk.risk}</span>
                        <span className={cn(
                          "rounded px-1.5 py-0.5 text-[9px] font-bold uppercase border",
                          SEVERITY_BADGE[risk.severity] || "text-gray-400 bg-gray-500/10 border-gray-500/30"
                        )}>
                          {risk.severity}
                        </span>
                      </div>
                      <div className="flex items-start gap-2 rounded-lg bg-green-500/5 border border-green-500/20 px-3 py-2">
                        <CheckCircle2 className="h-3 w-3 text-green-400 mt-0.5 shrink-0" />
                        <p className="text-[10px] text-green-300">{risk.mitigation}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ============ DATA FLOWS TAB ============ */}
        {activeTab === "Data Flows" && (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
              <Database className="h-4 w-4 text-purple-400" />
              Data Flow Mapping
            </h2>

            {flowsLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
              </div>
            ) : dataFlows.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <Database className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">No data flows configured</p>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Group by flow_type */}
                {(["processing", "storage", "external"] as const).map((flowType) => {
                  const flows = dataFlows.filter((f) => f.flow_type === flowType);
                  if (flows.length === 0) return null;
                  return (
                    <div key={flowType} className="rounded-xl border border-gray-800 bg-zinc-900/30 p-4">
                      <h3 className="text-xs font-bold text-gray-300 uppercase tracking-wider mb-3 flex items-center gap-2">
                        {flowType === "processing" && <Server className="h-3.5 w-3.5 text-blue-400" />}
                        {flowType === "storage" && <Database className="h-3.5 w-3.5 text-purple-400" />}
                        {flowType === "external" && <Globe className="h-3.5 w-3.5 text-orange-400" />}
                        {flowType.charAt(0).toUpperCase() + flowType.slice(1)} ({flows.length})
                      </h3>
                      <div className="space-y-2">
                        {flows.map((flow) => (
                          <div key={flow.id} className="flex items-center gap-3 rounded-lg border border-gray-800/60 bg-zinc-900/50 p-3">
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <span className="text-xs text-gray-300 font-medium shrink-0">{flow.source}</span>
                              <ArrowRight className="h-3 w-3 text-gray-600 shrink-0" />
                              <span className="text-xs text-gray-300 font-medium shrink-0">{flow.destination}</span>
                            </div>
                            <span className="rounded bg-gray-800/60 px-1.5 py-0.5 text-[9px] text-gray-500 shrink-0">
                              {flow.data_type}
                            </span>
                            <span className="text-[10px] text-gray-500 shrink-0 max-w-[150px] truncate">
                              {flow.purpose}
                            </span>
                            <span className="text-[10px] text-gray-600 font-mono shrink-0">
                              {flow.retention_days}d
                            </span>
                            {flow.encrypted ? (
                              <Lock className="h-3 w-3 text-green-400 shrink-0" />
                            ) : (
                              <AlertTriangle className="h-3 w-3 text-red-400 shrink-0" />
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ============ REDACTION QUEUE TAB ============ */}
        {activeTab === "Redaction Queue" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                <EyeOff className="h-4 w-4 text-orange-400" />
                Redaction Queue Dashboard
              </h2>
              <button
                onClick={fetchRedactionQueue}
                disabled={redactionLoading}
                className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 transition-colors disabled:opacity-50"
              >
                {redactionLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              </button>
            </div>

            {redactionLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
              </div>
            ) : redactionUnavailable ? (
              <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-6 text-center">
                <EyeOff className="h-10 w-10 mx-auto mb-3 text-gray-700" />
                <p className="text-sm text-gray-500">Redaction queue not available</p>
                <p className="text-xs text-gray-600 mt-1">The redaction API endpoint is not configured.</p>
              </div>
            ) : redactionQueue ? (
              <div className="grid grid-cols-3 gap-4">
                {/* Pending */}
                <div className="rounded-xl border border-amber-800/50 bg-amber-950/20 p-5 flex flex-col items-center gap-2">
                  <Clock className="h-6 w-6 text-amber-400" />
                  <span className="text-3xl font-bold text-amber-400">{redactionQueue.pending}</span>
                  <span className="text-xs text-gray-500 uppercase tracking-wider">Pending</span>
                </div>
                {/* In Progress */}
                <div className="rounded-xl border border-blue-800/50 bg-blue-950/20 p-5 flex flex-col items-center gap-2">
                  <Loader2 className="h-6 w-6 text-blue-400 animate-spin" />
                  <span className="text-3xl font-bold text-blue-400">{redactionQueue.in_progress}</span>
                  <span className="text-xs text-gray-500 uppercase tracking-wider">In Progress</span>
                </div>
                {/* Completed */}
                <div className="rounded-xl border border-green-800/50 bg-green-950/20 p-5 flex flex-col items-center gap-2">
                  <CheckCircle2 className="h-6 w-6 text-green-400" />
                  <span className="text-3xl font-bold text-green-400">{redactionQueue.completed}</span>
                  <span className="text-xs text-gray-500 uppercase tracking-wider">Completed</span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <EyeOff className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">No redaction queue data</p>
              </div>
            )}
          </div>
        )}

        {/* ============ RETENTION TAB ============ */}
        {activeTab === "Retention" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                <Database className="h-4 w-4 text-blue-400" />
                Data Retention Policies
              </h2>
              <button
                onClick={fetchRetentionPolicies}
                disabled={retentionLoading}
                className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 transition-colors disabled:opacity-50"
              >
                {retentionLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              </button>
            </div>

            {retentionLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
              </div>
            ) : retentionPolicies.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <Database className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">No retention policies configured</p>
              </div>
            ) : (
              <div className="space-y-3">
                {retentionPolicies.map((policy) => {
                  // Calculate days-until-purge and progress
                  const now = Date.now();
                  let daysUntilPurge: number | null = null;
                  let progressPct = 0;
                  if (policy.next_purge) {
                    const msUntil = new Date(policy.next_purge).getTime() - now;
                    daysUntilPurge = Math.max(0, Math.round(msUntil / 86400000));
                    progressPct = Math.max(0, Math.min(100, 100 - (daysUntilPurge / policy.retention_days) * 100));
                  } else if (policy.last_purge) {
                    const msSinceLastPurge = now - new Date(policy.last_purge).getTime();
                    const daysSince = msSinceLastPurge / 86400000;
                    daysUntilPurge = Math.max(0, Math.round(policy.retention_days - daysSince));
                    progressPct = Math.min(100, (daysSince / policy.retention_days) * 100);
                  }

                  const urgencyColor =
                    daysUntilPurge !== null && daysUntilPurge <= 3
                      ? "text-red-400"
                      : daysUntilPurge !== null && daysUntilPurge <= 7
                      ? "text-amber-400"
                      : "text-gray-400";

                  const barColor =
                    progressPct >= 90 ? "#ef4444" : progressPct >= 70 ? "#f59e0b" : "#22d3ee";

                  return (
                    <div key={policy.id} className="rounded-xl border border-gray-800 bg-zinc-900/40 p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-gray-200 truncate">{policy.name}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="rounded bg-gray-800/60 px-1.5 py-0.5 text-[9px] text-gray-500 uppercase">
                              {policy.data_type}
                            </span>
                            <span className="text-[10px] text-gray-600">
                              {policy.retention_days}d retention
                            </span>
                          </div>
                        </div>
                        {daysUntilPurge !== null ? (
                          <div className="text-right shrink-0">
                            <span className={cn("text-sm font-bold font-mono", urgencyColor)}>
                              {daysUntilPurge}d
                            </span>
                            <p className="text-[10px] text-gray-600">until purge</p>
                          </div>
                        ) : (
                          <span className="text-[10px] text-gray-700 shrink-0">No schedule</span>
                        )}
                      </div>

                      {/* Progress bar toward next purge */}
                      {daysUntilPurge !== null && (
                        <div>
                          <div className="flex justify-between text-[9px] text-gray-600 mb-1">
                            <span>Last purge: {policy.last_purge ? timeAgo(policy.last_purge) : "Never"}</span>
                            <span>{Math.round(progressPct)}% elapsed</span>
                          </div>
                          <div className="h-2 w-full rounded-full bg-gray-800 overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{ width: `${progressPct}%`, backgroundColor: barColor }}
                            />
                          </div>
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

      {/* Silhouette Config Edit Modal */}
      {editingConfig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-lg rounded-2xl border border-gray-800 bg-gray-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-gray-200">
                Configure Privacy: {editingConfig.camera_name}
              </h2>
              <button onClick={() => setEditingConfig(null)} className="text-gray-500 hover:text-gray-300">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1.5">Privacy Mode</label>
                <select
                  value={editingConfig.privacy_mode}
                  onChange={(e) => setEditingConfig({ ...editingConfig, privacy_mode: e.target.value as SilhouetteConfig["privacy_mode"] })}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-300 focus:border-cyan-600 focus:outline-none"
                >
                  <option value="silhouette_only">Silhouette Only</option>
                  <option value="blurred_faces">Blurred Faces</option>
                  <option value="full_video">Full Video</option>
                </select>
              </div>
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editingConfig.auto_redaction}
                    onChange={(e) => setEditingConfig({ ...editingConfig, auto_redaction: e.target.checked })}
                    className="rounded border-gray-700"
                  />
                  <span className="text-xs text-gray-300">Enable auto-redaction</span>
                </label>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setEditingConfig(null)}
                  className="rounded-lg border border-gray-700 px-4 py-2 text-xs text-gray-400 hover:bg-gray-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => saveSilhouetteConfig(editingConfig)}
                  disabled={configSaving}
                  className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-xs font-medium text-white hover:bg-teal-500 disabled:opacity-50 transition-colors"
                >
                  {configSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
