"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Bell,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  BarChart3,
  TrendingUp,
  ThumbsUp,
  ThumbsDown,
  Filter,
  RefreshCw,
  Loader2,
  X,
  Shield,
  Users,
  Camera,
  ChevronDown,
  Zap,
  Activity,
  Send,
  Eye,
  Gauge,
  Ban,
  ChevronsUp,
  Plus,
  Trash2,
  Save,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import MetricSparkline from "@/components/common/MetricSparkline";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AlarmStats {
  total_alarms_24h: number;
  auto_cleared: number;
  real_threats: number;
  false_alarm_rate: number;
  avg_response_time: number;
}

interface AlarmCorrelationEvent {
  id: string;
  source_type: string;
  fusion_score: number;
  classification: "real_threat" | "false_alarm" | "auto_cleared" | "pending";
  cascade_match: boolean;
  camera_name: string;
  zone: string;
  description: string;
  timestamp: string;
  sources: string[];
}

interface FeedbackForm {
  alert_id: string;
  is_correct: boolean;
  fp_reason: string;
  notes: string;
}

interface FPReportEntry {
  camera_name: string;
  signature: string;
  tp_rate: number;
  fp_count: number;
  total_count: number;
  threshold_adjustment: number;
  top_reasons: string[];
}

interface FPReportSummary {
  total_feedback: number;
  fp_rate: number;
  top_sources: { source: string; count: number }[];
}

interface FatigueEntry {
  operator_id: string;
  operator_name: string;
  fatigue_score: number;
  alerts_handled: number;
  avg_response_time: number;
  response_time_trend: "improving" | "degrading" | "stable";
  shift_start: string;
  consecutive_hours: number;
}

interface AlertOption {
  id: string;
  title: string;
  timestamp: string;
}

interface SuppressionRule {
  id?: string;
  alarm_type: string;
  zone: string;
  start_hour: number;
  end_hour: number;
  created_at?: string;
}

interface EscalationRule {
  id?: string;
  unacknowledged_minutes: number;
  escalate_to_severity: string;
  created_at?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TABS = ["Correlations", "Feedback", "FP Report", "Fatigue Monitor", "Suppression", "Auto-Escalation"] as const;
type Tab = (typeof TABS)[number];

const CLASSIFICATION_BADGE: Record<string, string> = {
  real_threat: "text-red-400 bg-red-500/10 border-red-500/30",
  false_alarm: "text-gray-400 bg-gray-500/10 border-gray-500/30",
  auto_cleared: "text-green-400 bg-green-500/10 border-green-500/30",
  pending: "text-yellow-400 bg-yellow-500/10 border-yellow-500/30",
};

const FP_REASONS = [
  "lighting",
  "weather",
  "animal",
  "authorized_person",
  "shadow",
  "reflection",
  "equipment",
  "other",
];

const ALARM_TYPES = [
  "motion_detected",
  "perimeter_breach",
  "loitering",
  "unauthorized_access",
  "fight_detected",
  "fire_smoke",
  "object_left",
  "crowd_density",
  "face_recognition",
  "other",
];

const SEVERITY_LEVELS = ["low", "medium", "high", "critical"];

const LS_SUPPRESSION_KEY = "sentinel_suppression_rules";
const LS_ESCALATION_KEY = "sentinel_escalation_rules";

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

function fatigueColor(score: number): string {
  if (score >= 0.7) return "text-red-400";
  if (score >= 0.4) return "text-yellow-400";
  return "text-green-400";
}

function fatigueBarColor(score: number): string {
  if (score >= 0.7) return "bg-red-500";
  if (score >= 0.4) return "bg-yellow-500";
  return "bg-green-500";
}

function trendIcon(trend: string) {
  if (trend === "degrading") return <TrendingUp className="h-3 w-3 text-red-400 rotate-0" />;
  if (trend === "improving") return <TrendingUp className="h-3 w-3 text-green-400 rotate-180" />;
  return <Activity className="h-3 w-3 text-gray-400" />;
}

/** Group alarm events by hour-of-day bucket (0..23) and return counts as an array of 24 values */
function buildHourlySparkline(events: AlarmCorrelationEvent[]): number[] {
  const buckets = new Array<number>(24).fill(0);
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  events.forEach(e => {
    const ts = new Date(e.timestamp).getTime();
    if (ts < cutoff) return;
    // hours ago (0 = most recent hour, 23 = oldest)
    const hoursAgo = Math.floor((now - ts) / (60 * 60 * 1000));
    const idx = Math.min(hoursAgo, 23);
    // index 0 = oldest hour, 23 = most recent — reverse
    buckets[23 - idx] += 1;
  });
  return buckets;
}

/* ------------------------------------------------------------------ */
/*  localStorage helpers                                               */
/* ------------------------------------------------------------------ */

function loadFromLS<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    return JSON.parse(raw) as T[];
  } catch {
    return [];
  }
}

function saveToLS<T>(key: string, data: T[]) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {}
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function AlarmManagementPage() {
  const { addToast } = useToast();

  const [activeTab, setActiveTab] = useState<Tab>("Correlations");
  const [stats, setStats] = useState<AlarmStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Correlations state
  const [correlations, setCorrelations] = useState<AlarmCorrelationEvent[]>([]);
  const [corrLoading, setCorrLoading] = useState(false);
  const [corrFilter, setCorrFilter] = useState<string>("");

  // Feedback state
  const [alerts, setAlerts] = useState<AlertOption[]>([]);
  const [feedback, setFeedback] = useState<FeedbackForm>({
    alert_id: "",
    is_correct: true,
    fp_reason: "",
    notes: "",
  });
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackSuccess, setFeedbackSuccess] = useState(false);

  // FP Report state
  const [fpReport, setFpReport] = useState<FPReportEntry[]>([]);
  const [fpSummary, setFpSummary] = useState<FPReportSummary | null>(null);
  const [fpLoading, setFpLoading] = useState(false);

  // Fatigue state
  const [fatigue, setFatigue] = useState<FatigueEntry[]>([]);
  const [fatigueLoading, setFatigueLoading] = useState(false);

  // Suppression Rules state
  const [suppressionRules, setSuppressionRules] = useState<SuppressionRule[]>([]);
  const [newSupRule, setNewSupRule] = useState<SuppressionRule>({
    alarm_type: "",
    zone: "",
    start_hour: 0,
    end_hour: 6,
  });
  const [supSaving, setSupSaving] = useState(false);

  // Auto-Escalation state
  const [escalationRules, setEscalationRules] = useState<EscalationRule[]>([]);
  const [newEscRule, setNewEscRule] = useState<EscalationRule>({
    unacknowledged_minutes: 15,
    escalate_to_severity: "high",
  });
  const [escSaving, setEscSaving] = useState(false);

  /* ---- Initial load ---- */
  const fetchInitial = useCallback(async () => {
    try {
      const [statsData, corrData] = await Promise.all([
        apiFetch<AlarmStats>("/api/alarm-correlation/stats"),
        apiFetch<AlarmCorrelationEvent[]>("/api/alarm-correlation/events"),
      ]);
      const rawStats = statsData as any;
      setStats({
        total_alarms_24h: rawStats.total_alarms_24h ?? rawStats.total ?? 0,
        auto_cleared: rawStats.auto_cleared ?? 0,
        real_threats: rawStats.real_threats ?? 0,
        false_alarm_rate: rawStats.false_alarm_rate ?? (rawStats.total > 0 ? rawStats.false_alarms / rawStats.total : 0),
        avg_response_time: rawStats.avg_response_time ?? 0,
      });
      setCorrelations(Array.isArray(corrData) ? corrData : (corrData as any)?.items ?? []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load alarm data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInitial();
  }, [fetchInitial]);

  // Load suppression/escalation rules from localStorage on mount
  useEffect(() => {
    setSuppressionRules(loadFromLS<SuppressionRule>(LS_SUPPRESSION_KEY));
    setEscalationRules(loadFromLS<EscalationRule>(LS_ESCALATION_KEY));
  }, []);

  /* ---- Tab data fetching ---- */
  const fetchCorrelations = async () => {
    setCorrLoading(true);
    try {
      const data = await apiFetch<AlarmCorrelationEvent[]>("/api/alarm-correlation/events");
      setCorrelations(data);
    } catch {
    } finally {
      setCorrLoading(false);
    }
  };

  const fetchAlerts = async () => {
    try {
      const data = await apiFetch<AlertOption[]>("/api/alerts?limit=50");
      setAlerts(Array.isArray(data) ? data : []);
    } catch {
      setAlerts([]);
    }
  };

  const fetchFPReport = async () => {
    setFpLoading(true);
    try {
      const data = await apiFetch<{ entries: FPReportEntry[]; summary: FPReportSummary }>("/api/feedback/report");
      setFpReport(data.entries || []);
      setFpSummary(data.summary || null);
    } catch {
      setFpReport([]);
    } finally {
      setFpLoading(false);
    }
  };

  const fetchFatigue = async () => {
    setFatigueLoading(true);
    try {
      const data = await apiFetch<FatigueEntry[]>("/api/alarm-correlation/fatigue");
      setFatigue(data);
    } catch {
      setFatigue([]);
    } finally {
      setFatigueLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "Feedback") fetchAlerts();
    if (activeTab === "FP Report") fetchFPReport();
    if (activeTab === "Fatigue Monitor") fetchFatigue();
  }, [activeTab]);

  /* ---- Feedback submit ---- */
  const handleFeedbackSubmit = async () => {
    if (!feedback.alert_id) return;
    setFeedbackSubmitting(true);
    setFeedbackSuccess(false);
    try {
      await apiFetch("/api/feedback/", {
        method: "POST",
        body: JSON.stringify(feedback),
      });
      setFeedbackSuccess(true);
      setFeedback({ alert_id: "", is_correct: true, fp_reason: "", notes: "" });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Feedback submission failed");
    } finally {
      setFeedbackSubmitting(false);
    }
  };

  /* ---- Suppression rules ---- */
  const handleSaveSuppressionRule = async () => {
    if (!newSupRule.alarm_type) {
      addToast("error", "Please select an alarm type.");
      return;
    }
    setSupSaving(true);
    try {
      const saved = await apiFetch<SuppressionRule>("/api/alarm-correlation/suppression-rules", {
        method: "POST",
        body: JSON.stringify(newSupRule),
      });
      const updated = [...suppressionRules, { ...newSupRule, id: saved?.id || `local-${Date.now()}`, created_at: new Date().toISOString() }];
      setSuppressionRules(updated);
      saveToLS(LS_SUPPRESSION_KEY, updated);
      setNewSupRule({ alarm_type: "", zone: "", start_hour: 0, end_hour: 6 });
      addToast("success", "Suppression rule saved.");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("404") || msg.includes("Not Found")) {
        // Fallback to localStorage
        const rule: SuppressionRule = { ...newSupRule, id: `local-${Date.now()}`, created_at: new Date().toISOString() };
        const updated = [...suppressionRules, rule];
        setSuppressionRules(updated);
        saveToLS(LS_SUPPRESSION_KEY, updated);
        setNewSupRule({ alarm_type: "", zone: "", start_hour: 0, end_hour: 6 });
        addToast("info", "Suppression rule saved locally (API endpoint not yet available).");
      } else {
        addToast("error", `Failed to save: ${msg || "Unknown error"}`);
      }
    } finally {
      setSupSaving(false);
    }
  };

  const handleDeleteSuppressionRule = (id: string | undefined, idx: number) => {
    const updated = suppressionRules.filter((_, i) => i !== idx);
    setSuppressionRules(updated);
    saveToLS(LS_SUPPRESSION_KEY, updated);
    addToast("info", "Suppression rule deleted.");
  };

  /* ---- Escalation rules ---- */
  const handleSaveEscalationRule = async () => {
    if (newEscRule.unacknowledged_minutes < 1) {
      addToast("error", "Minutes must be at least 1.");
      return;
    }
    setEscSaving(true);
    try {
      const saved = await apiFetch<EscalationRule>("/api/alarm-correlation/escalation-rules", {
        method: "POST",
        body: JSON.stringify(newEscRule),
      });
      const updated = [...escalationRules, { ...newEscRule, id: saved?.id || `local-${Date.now()}`, created_at: new Date().toISOString() }];
      setEscalationRules(updated);
      saveToLS(LS_ESCALATION_KEY, updated);
      setNewEscRule({ unacknowledged_minutes: 15, escalate_to_severity: "high" });
      addToast("success", "Escalation rule saved.");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("404") || msg.includes("Not Found")) {
        const rule: EscalationRule = { ...newEscRule, id: `local-${Date.now()}`, created_at: new Date().toISOString() };
        const updated = [...escalationRules, rule];
        setEscalationRules(updated);
        saveToLS(LS_ESCALATION_KEY, updated);
        setNewEscRule({ unacknowledged_minutes: 15, escalate_to_severity: "high" });
        addToast("info", "Escalation rule saved locally (API endpoint not yet available).");
      } else {
        addToast("error", `Failed to save: ${msg || "Unknown error"}`);
      }
    } finally {
      setEscSaving(false);
    }
  };

  const handleDeleteEscalationRule = (idx: number) => {
    const updated = escalationRules.filter((_, i) => i !== idx);
    setEscalationRules(updated);
    saveToLS(LS_ESCALATION_KEY, updated);
    addToast("info", "Escalation rule deleted.");
  };

  /* ---- Sparkline data ---- */
  const hourlySparklineData = buildHourlySparkline(correlations);

  /* ---- Filtered correlations ---- */
  const filteredCorrelations = corrFilter
    ? correlations.filter((c) => c.classification === corrFilter)
    : correlations;

  /* ---- Loading ---- */
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[#030712]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-10 w-10 animate-spin text-cyan-400" />
          <p className="text-sm text-gray-500">Loading alarm management...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#030712]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-900/30 border border-amber-800/50">
            <Bell className="h-5 w-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Alarm Management
            </h1>
            <p className="text-xs text-gray-500">
              Intelligent alarm correlation, false positive reduction, and operator fatigue monitoring
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

      {/* Stat Cards — with sparkline */}
      {stats && (
        <div className="grid grid-cols-5 gap-4 border-b border-gray-800 px-6 py-3">
          {/* Total alarms with sparkline */}
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 p-3 col-span-2">
            <Bell className="h-5 w-5 text-cyan-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-lg font-bold text-gray-100">{stats.total_alarms_24h}</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">Total Alarms (24h)</p>
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <MetricSparkline
                data={hourlySparklineData}
                width={100}
                height={28}
                color="#06b6d4"
                fill={true}
                showValue={false}
              />
              <span className="text-[9px] text-gray-600">last 24h by hour</span>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-green-900/50 bg-green-950/20 p-3">
            <CheckCircle2 className="h-5 w-5 text-green-400" />
            <div>
              <p className="text-lg font-bold text-green-400">{stats.auto_cleared}</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">Auto-Cleared</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-red-900/50 bg-red-950/20 p-3">
            <AlertTriangle className="h-5 w-5 text-red-400" />
            <div>
              <p className="text-lg font-bold text-red-400">{stats.real_threats}</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">Real Threats</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 p-3">
            <XCircle className="h-5 w-5 text-yellow-400" />
            <div>
              <p className="text-lg font-bold text-yellow-400">{(stats.false_alarm_rate * 100).toFixed(1)}%</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">False Alarm Rate</p>
            </div>
          </div>
        </div>
      )}

      {/* Tab navigation */}
      <div className="flex items-center gap-1 border-b border-gray-800 px-6 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-4 py-2.5 text-xs font-medium border-b-2 transition-colors whitespace-nowrap",
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

        {/* ============ CORRELATIONS TAB ============ */}
        {activeTab === "Correlations" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                <Zap className="h-4 w-4 text-amber-400" />
                Alarm Correlation Events
              </h2>
              <div className="flex items-center gap-3">
                <select
                  value={corrFilter}
                  onChange={(e) => setCorrFilter(e.target.value)}
                  className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-1.5 text-xs text-gray-300 focus:border-cyan-600 focus:outline-none"
                >
                  <option value="">All Classifications</option>
                  <option value="real_threat">Real Threat</option>
                  <option value="false_alarm">False Alarm</option>
                  <option value="auto_cleared">Auto-Cleared</option>
                  <option value="pending">Pending</option>
                </select>
                <button
                  onClick={fetchCorrelations}
                  disabled={corrLoading}
                  className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 transition-colors disabled:opacity-50"
                >
                  {corrLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                </button>
              </div>
            </div>

            {filteredCorrelations.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <Bell className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">No correlation events found</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-gray-800 bg-zinc-900/30">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-gray-800 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                      <th className="px-4 py-3">Source</th>
                      <th className="px-4 py-3">Camera / Zone</th>
                      <th className="px-4 py-3">Description</th>
                      <th className="px-4 py-3">Fusion Score</th>
                      <th className="px-4 py-3">Classification</th>
                      <th className="px-4 py-3">Cascade</th>
                      <th className="px-4 py-3">Sources</th>
                      <th className="px-4 py-3">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCorrelations.map((event) => (
                      <tr key={event.id} className="border-b border-gray-800/30 hover:bg-gray-800/20 transition-colors">
                        <td className="px-4 py-2.5">
                          <span className="rounded bg-gray-800/60 px-1.5 py-0.5 text-[10px] text-gray-400 font-mono">
                            {event.source_type}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="text-xs text-gray-300">{event.camera_name}</div>
                          <div className="text-[10px] text-gray-600">{event.zone}</div>
                        </td>
                        <td className="px-4 py-2.5 text-[11px] text-gray-400 max-w-[250px] truncate">
                          {event.description}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={cn(
                            "text-xs font-bold font-mono",
                            event.fusion_score >= 0.8 ? "text-red-400" :
                            event.fusion_score >= 0.5 ? "text-yellow-400" : "text-green-400"
                          )}>
                            {event.fusion_score.toFixed(2)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={cn(
                            "rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                            CLASSIFICATION_BADGE[event.classification] || CLASSIFICATION_BADGE.pending
                          )}>
                            {event.classification.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          {event.cascade_match ? (
                            <CheckCircle2 className="h-4 w-4 text-amber-400" />
                          ) : (
                            <span className="text-[10px] text-gray-600">-</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {event.sources.slice(0, 3).map((s, i) => (
                              <span key={i} className="rounded bg-gray-800/60 px-1.5 py-0.5 text-[9px] text-gray-500">{s}</span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-[11px] text-gray-500">{timeAgo(event.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ============ FEEDBACK TAB ============ */}
        {activeTab === "Feedback" && (
          <div className="max-w-2xl space-y-6">
            <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
              <ThumbsUp className="h-4 w-4 text-green-400" />
              Submit Alert Feedback
            </h2>
            <p className="text-xs text-gray-500">
              Provide feedback on alarm accuracy to improve the AI classification model and reduce false positives.
            </p>

            {feedbackSuccess && (
              <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-xs text-green-400">
                <CheckCircle2 className="h-4 w-4" />
                Feedback submitted successfully. The system will adapt based on your input.
              </div>
            )}

            <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-6 space-y-4">
              {/* Select Alert */}
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1.5">Select Alert</label>
                <select
                  value={feedback.alert_id}
                  onChange={(e) => setFeedback({ ...feedback, alert_id: e.target.value })}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-300 focus:border-cyan-600 focus:outline-none"
                >
                  <option value="">Choose an alert...</option>
                  {alerts.map((a) => (
                    <option key={a.id} value={a.id}>{a.title} - {timeAgo(a.timestamp)}</option>
                  ))}
                </select>
              </div>

              {/* Correct / Incorrect */}
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-2">Was this alert accurate?</label>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setFeedback({ ...feedback, is_correct: true, fp_reason: "" })}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border px-4 py-2.5 text-xs font-medium transition-colors",
                      feedback.is_correct
                        ? "border-green-500/50 bg-green-500/10 text-green-400"
                        : "border-gray-800 bg-gray-900/50 text-gray-500 hover:text-gray-300"
                    )}
                  >
                    <ThumbsUp className="h-4 w-4" /> Correct (True Positive)
                  </button>
                  <button
                    onClick={() => setFeedback({ ...feedback, is_correct: false })}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border px-4 py-2.5 text-xs font-medium transition-colors",
                      !feedback.is_correct
                        ? "border-red-500/50 bg-red-500/10 text-red-400"
                        : "border-gray-800 bg-gray-900/50 text-gray-500 hover:text-gray-300"
                    )}
                  >
                    <ThumbsDown className="h-4 w-4" /> False Positive
                  </button>
                </div>
              </div>

              {/* FP Reason */}
              {!feedback.is_correct && (
                <div>
                  <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1.5">False Positive Reason</label>
                  <select
                    value={feedback.fp_reason}
                    onChange={(e) => setFeedback({ ...feedback, fp_reason: e.target.value })}
                    className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-300 focus:border-cyan-600 focus:outline-none"
                  >
                    <option value="">Select reason...</option>
                    {FP_REASONS.map((r) => (
                      <option key={r} value={r}>{r.replace(/_/g, " ")}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Notes */}
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1.5">Additional Notes</label>
                <textarea
                  value={feedback.notes}
                  onChange={(e) => setFeedback({ ...feedback, notes: e.target.value })}
                  rows={3}
                  placeholder="Any additional context or notes..."
                  className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:border-cyan-600 focus:outline-none resize-none"
                />
              </div>

              {/* Submit */}
              <div className="flex justify-end pt-2">
                <button
                  onClick={handleFeedbackSubmit}
                  disabled={feedbackSubmitting || !feedback.alert_id}
                  className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-4 py-2 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-50 transition-colors"
                >
                  {feedbackSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Submit Feedback
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ============ FP REPORT TAB ============ */}
        {activeTab === "FP Report" && (
          <div className="space-y-6">
            <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-orange-400" />
              False Positive Analysis Report
            </h2>

            {fpLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
              </div>
            ) : (
              <>
                {/* Summary cards */}
                {fpSummary && (
                  <div className="grid grid-cols-3 gap-4">
                    <div className="rounded-lg border border-gray-800 bg-zinc-900/50 p-4">
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider">Total Feedback</p>
                      <p className="text-xl font-bold text-gray-100">{fpSummary.total_feedback}</p>
                    </div>
                    <div className="rounded-lg border border-gray-800 bg-zinc-900/50 p-4">
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider">Overall FP Rate</p>
                      <p className="text-xl font-bold text-yellow-400">{(fpSummary.fp_rate * 100).toFixed(1)}%</p>
                    </div>
                    <div className="rounded-lg border border-gray-800 bg-zinc-900/50 p-4">
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider">Top FP Sources</p>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {fpSummary.top_sources.slice(0, 5).map((s) => (
                          <span key={s.source} className="rounded bg-orange-500/10 border border-orange-500/30 px-1.5 py-0.5 text-[9px] text-orange-400">
                            {s.source} ({s.count})
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Bar chart visualization */}
                {fpSummary && fpSummary.top_sources.length > 0 && (
                  <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-4">
                    <h3 className="mb-3 text-xs font-bold text-gray-300 uppercase tracking-wider">
                      Top 10 FP Sources
                    </h3>
                    <div className="space-y-2">
                      {fpSummary.top_sources.slice(0, 10).map((s) => {
                        const maxCount = fpSummary.top_sources[0]?.count || 1;
                        const pct = (s.count / maxCount) * 100;
                        return (
                          <div key={s.source} className="flex items-center gap-3">
                            <span className="text-[10px] text-gray-400 w-32 truncate shrink-0">{s.source}</span>
                            <div className="flex-1 h-4 rounded bg-gray-800 overflow-hidden">
                              <div className="h-full rounded bg-orange-500/60 transition-all" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="text-[10px] text-gray-400 font-mono w-8 text-right">{s.count}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Detail table */}
                {fpReport.length > 0 && (
                  <div className="overflow-x-auto rounded-xl border border-gray-800 bg-zinc-900/30">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="border-b border-gray-800 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                          <th className="px-4 py-3">Camera</th>
                          <th className="px-4 py-3">Signature</th>
                          <th className="px-4 py-3">TP Rate</th>
                          <th className="px-4 py-3">FP Count</th>
                          <th className="px-4 py-3">Total</th>
                          <th className="px-4 py-3">Threshold Adj.</th>
                          <th className="px-4 py-3">Top Reasons</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fpReport.map((entry, i) => (
                          <tr key={i} className="border-b border-gray-800/30 hover:bg-gray-800/20 transition-colors">
                            <td className="px-4 py-2.5 text-xs text-gray-300">{entry.camera_name}</td>
                            <td className="px-4 py-2.5 text-xs text-gray-400">{entry.signature}</td>
                            <td className="px-4 py-2.5">
                              <span className={cn(
                                "text-xs font-bold font-mono",
                                entry.tp_rate >= 0.8 ? "text-green-400" :
                                entry.tp_rate >= 0.5 ? "text-yellow-400" : "text-red-400"
                              )}>
                                {(entry.tp_rate * 100).toFixed(1)}%
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-red-400 font-mono">{entry.fp_count}</td>
                            <td className="px-4 py-2.5 text-xs text-gray-400 font-mono">{entry.total_count}</td>
                            <td className="px-4 py-2.5">
                              <span className={cn(
                                "text-xs font-mono",
                                entry.threshold_adjustment > 0 ? "text-green-400" :
                                entry.threshold_adjustment < 0 ? "text-red-400" : "text-gray-500"
                              )}>
                                {entry.threshold_adjustment > 0 ? "+" : ""}{entry.threshold_adjustment.toFixed(2)}
                              </span>
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex flex-wrap gap-1">
                                {entry.top_reasons.slice(0, 3).map((r, j) => (
                                  <span key={j} className="rounded bg-gray-800/60 px-1.5 py-0.5 text-[9px] text-gray-500">
                                    {r.replace(/_/g, " ")}
                                  </span>
                                ))}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {fpReport.length === 0 && !fpLoading && (
                  <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                    <BarChart3 className="h-10 w-10 mb-3 opacity-30" />
                    <p className="text-sm">No false positive data available yet</p>
                    <p className="text-xs mt-1">Submit feedback to start building FP analysis</p>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ============ FATIGUE MONITOR TAB ============ */}
        {activeTab === "Fatigue Monitor" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                <Gauge className="h-4 w-4 text-purple-400" />
                Operator Fatigue Monitor
              </h2>
              <button
                onClick={fetchFatigue}
                disabled={fatigueLoading}
                className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 transition-colors disabled:opacity-50"
              >
                {fatigueLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Refresh
              </button>
            </div>

            {fatigueLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
              </div>
            ) : fatigue.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <Users className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">No operator data available</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {fatigue.map((op) => (
                  <div
                    key={op.operator_id}
                    className={cn(
                      "rounded-xl border p-4 transition-colors",
                      op.fatigue_score >= 0.7
                        ? "border-red-800/60 bg-red-950/20"
                        : op.fatigue_score >= 0.4
                        ? "border-yellow-800/50 bg-yellow-950/10"
                        : "border-gray-800 bg-zinc-900/50"
                    )}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-gray-500" />
                        <span className="text-sm font-semibold text-gray-200">{op.operator_name}</span>
                      </div>
                      <span className={cn("text-xl font-bold font-mono", fatigueColor(op.fatigue_score))}>
                        {(op.fatigue_score * 100).toFixed(0)}
                      </span>
                    </div>

                    <div className="h-2.5 w-full rounded-full bg-gray-800 overflow-hidden mb-3">
                      <div
                        className={cn("h-full rounded-full transition-all duration-500", fatigueBarColor(op.fatigue_score))}
                        style={{ width: `${Math.min(op.fatigue_score * 100, 100)}%` }}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-lg bg-gray-900/50 p-2">
                        <p className="text-[8px] text-gray-600 uppercase tracking-wider">Alerts Handled</p>
                        <p className="text-xs font-bold text-gray-300">{op.alerts_handled}</p>
                      </div>
                      <div className="rounded-lg bg-gray-900/50 p-2">
                        <p className="text-[8px] text-gray-600 uppercase tracking-wider">Avg Response</p>
                        <p className="text-xs font-bold text-gray-300">{op.avg_response_time.toFixed(0)}s</p>
                      </div>
                      <div className="rounded-lg bg-gray-900/50 p-2">
                        <p className="text-[8px] text-gray-600 uppercase tracking-wider">Hours On</p>
                        <p className={cn(
                          "text-xs font-bold",
                          op.consecutive_hours >= 10 ? "text-red-400" :
                          op.consecutive_hours >= 6 ? "text-yellow-400" : "text-gray-300"
                        )}>
                          {op.consecutive_hours.toFixed(1)}h
                        </p>
                      </div>
                      <div className="rounded-lg bg-gray-900/50 p-2">
                        <p className="text-[8px] text-gray-600 uppercase tracking-wider">Trend</p>
                        <div className="flex items-center gap-1">
                          {trendIcon(op.response_time_trend)}
                          <span className="text-[10px] text-gray-400 capitalize">{op.response_time_trend}</span>
                        </div>
                      </div>
                    </div>

                    {op.fatigue_score >= 0.7 && (
                      <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[10px] text-red-400">
                        <AlertTriangle className="h-3 w-3 shrink-0" />
                        High fatigue detected. Consider shift rotation.
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ============ SUPPRESSION RULES TAB ============ */}
        {activeTab === "Suppression" && (
          <div className="space-y-6 max-w-3xl">
            <div>
              <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2 mb-1">
                <Ban className="h-4 w-4 text-orange-400" />
                Intelligent Suppression Rules
              </h2>
              <p className="text-xs text-gray-500">
                Define time windows during which specific alarm types are suppressed to reduce noise (e.g., scheduled maintenance periods, night-mode cameras).
              </p>
            </div>

            {/* Create new rule form */}
            <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-5 space-y-4">
              <h3 className="text-xs font-bold text-gray-300 uppercase tracking-wider">New Suppression Rule</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1.5">Alarm Type</label>
                  <select
                    value={newSupRule.alarm_type}
                    onChange={e => setNewSupRule({ ...newSupRule, alarm_type: e.target.value })}
                    className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-300 focus:border-cyan-600 focus:outline-none"
                  >
                    <option value="">Select alarm type...</option>
                    {ALARM_TYPES.map(t => (
                      <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1.5">Zone (optional)</label>
                  <input
                    type="text"
                    placeholder="e.g. Parking Lot A, all zones"
                    value={newSupRule.zone}
                    onChange={e => setNewSupRule({ ...newSupRule, zone: e.target.value })}
                    className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:border-cyan-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1.5">
                    Start Hour (0–23)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={newSupRule.start_hour}
                    onChange={e => setNewSupRule({ ...newSupRule, start_hour: parseInt(e.target.value) || 0 })}
                    className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-200 focus:border-cyan-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1.5">
                    End Hour (0–23)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={newSupRule.end_hour}
                    onChange={e => setNewSupRule({ ...newSupRule, end_hour: parseInt(e.target.value) || 0 })}
                    className="w-full rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-200 focus:border-cyan-600 focus:outline-none"
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={handleSaveSuppressionRule}
                  disabled={supSaving || !newSupRule.alarm_type}
                  className="flex items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-xs font-medium text-white hover:bg-orange-500 disabled:opacity-50 transition-colors"
                >
                  {supSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Save Rule
                </button>
              </div>
            </div>

            {/* Existing rules */}
            <div>
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">
                Active Suppression Rules ({suppressionRules.length})
              </h3>
              {suppressionRules.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-gray-600 rounded-xl border border-dashed border-gray-800">
                  <Ban className="h-8 w-8 mb-2 opacity-30" />
                  <p className="text-sm">No suppression rules configured</p>
                  <p className="text-xs mt-1">Create a rule above to suppress noise during scheduled windows</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {suppressionRules.map((rule, idx) => (
                    <div
                      key={rule.id || idx}
                      className="flex items-center gap-4 rounded-lg border border-gray-800 bg-zinc-900/40 px-4 py-3"
                    >
                      <Ban className="h-4 w-4 text-orange-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-medium text-gray-200">
                            {rule.alarm_type.replace(/_/g, " ")}
                          </span>
                          {rule.zone && (
                            <span className="rounded bg-gray-800/60 px-1.5 py-0.5 text-[9px] text-gray-400">
                              Zone: {rule.zone}
                            </span>
                          )}
                          <span className="rounded bg-orange-500/10 border border-orange-500/30 px-1.5 py-0.5 text-[9px] text-orange-400">
                            {String(rule.start_hour).padStart(2, "0")}:00 – {String(rule.end_hour).padStart(2, "0")}:00
                          </span>
                        </div>
                        {rule.created_at && (
                          <p className="text-[9px] text-gray-600 mt-0.5">
                            Created {new Date(rule.created_at).toLocaleString()}
                            {rule.id?.startsWith("local-") && " (local)"}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => handleDeleteSuppressionRule(rule.id, idx)}
                        className="rounded p-1.5 text-gray-600 hover:bg-red-900/30 hover:text-red-400 transition-colors"
                        title="Delete rule"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ============ AUTO-ESCALATION TAB ============ */}
        {activeTab === "Auto-Escalation" && (
          <div className="space-y-6 max-w-3xl">
            <div>
              <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2 mb-1">
                <ChevronsUp className="h-4 w-4 text-red-400" />
                Auto-Escalation Configuration
              </h2>
              <p className="text-xs text-gray-500">
                Automatically escalate alarms that remain unacknowledged beyond a time threshold. Rules are evaluated in order.
              </p>
            </div>

            {/* Create new rule */}
            <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-5 space-y-4">
              <h3 className="text-xs font-bold text-gray-300 uppercase tracking-wider">New Escalation Rule</h3>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-xs text-gray-400">If alarm not acknowledged within</span>
                <input
                  type="number"
                  min={1}
                  value={newEscRule.unacknowledged_minutes}
                  onChange={e => setNewEscRule({ ...newEscRule, unacknowledged_minutes: parseInt(e.target.value) || 1 })}
                  className="w-20 rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-200 focus:border-cyan-600 focus:outline-none text-center"
                />
                <span className="text-xs text-gray-400">minutes, escalate to severity</span>
                <select
                  value={newEscRule.escalate_to_severity}
                  onChange={e => setNewEscRule({ ...newEscRule, escalate_to_severity: e.target.value })}
                  className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-300 focus:border-cyan-600 focus:outline-none"
                >
                  {SEVERITY_LEVELS.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={handleSaveEscalationRule}
                  disabled={escSaving}
                  className="flex items-center gap-1.5 rounded-lg bg-red-700 px-4 py-2 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50 transition-colors"
                >
                  {escSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Save Rule
                </button>
              </div>
            </div>

            {/* Existing escalation rules */}
            <div>
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">
                Active Escalation Rules ({escalationRules.length})
              </h3>
              {escalationRules.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-gray-600 rounded-xl border border-dashed border-gray-800">
                  <ChevronsUp className="h-8 w-8 mb-2 opacity-30" />
                  <p className="text-sm">No escalation rules configured</p>
                  <p className="text-xs mt-1">Define a rule above to automatically escalate unacknowledged alarms</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {escalationRules.map((rule, idx) => (
                    <div
                      key={rule.id || idx}
                      className="flex items-center gap-4 rounded-lg border border-gray-800 bg-zinc-900/40 px-4 py-3"
                    >
                      <ChevronsUp className="h-4 w-4 text-red-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-gray-300">
                            Unacknowledged for
                          </span>
                          <span className="rounded bg-red-500/10 border border-red-500/30 px-2 py-0.5 text-xs font-bold text-red-400">
                            {rule.unacknowledged_minutes} min
                          </span>
                          <span className="text-xs text-gray-300">escalates to</span>
                          <span className={cn(
                            "rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                            rule.escalate_to_severity === "critical"
                              ? "bg-red-500/20 text-red-400 border-red-500/40"
                              : rule.escalate_to_severity === "high"
                              ? "bg-orange-500/20 text-orange-400 border-orange-500/40"
                              : rule.escalate_to_severity === "medium"
                              ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/40"
                              : "bg-blue-400/20 text-blue-400 border-blue-400/40"
                          )}>
                            {rule.escalate_to_severity}
                          </span>
                        </div>
                        {rule.created_at && (
                          <p className="text-[9px] text-gray-600 mt-0.5">
                            Created {new Date(rule.created_at).toLocaleString()}
                            {rule.id?.startsWith("local-") && " (local)"}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => handleDeleteEscalationRule(idx)}
                        className="rounded p-1.5 text-gray-600 hover:bg-red-900/30 hover:text-red-400 transition-colors"
                        title="Delete rule"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
