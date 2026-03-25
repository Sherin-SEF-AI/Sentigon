"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import {
  ShieldAlert,
  Activity,
  Radio,
  Clock,
  MapPin,
  Camera,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  Siren,
  Building2,
  Cross,
  Flame,
  Phone,
  ChevronDown,
  ChevronRight,
  History,
  Zap,
  Shield,
  FileText,
  Users,
  Truck,
  PlayCircle,
  Ban,
  RefreshCw,
  GitBranch,
  BarChart2,
  ClipboardCheck,
  X,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import { useThreatResponse } from "@/hooks/useThreatResponse";
import type {
  ThreatResponse,
  ThreatResponseAction,
  EmergencyService,
  Severity,
} from "@/lib/types";

// ── Types ─────────────────────────────────────────────────────────────

interface ResponseMetrics {
  avg_time_to_dispatch_seconds: number | null;
  total_responses_24h: number;
  resolved_count: number;
  active_count: number;
}

interface AfterActionReview {
  what_worked: string;
  what_could_improve: string;
  lessons_learned: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

const SEVERITY_COLORS: Record<Severity, { bg: string; text: string; border: string; pulse: string }> = {
  critical: { bg: "bg-red-500/20", text: "text-red-400", border: "border-red-500/60", pulse: "animate-pulse" },
  high: { bg: "bg-orange-500/20", text: "text-orange-400", border: "border-orange-500/60", pulse: "animate-pulse" },
  medium: { bg: "bg-yellow-500/20", text: "text-yellow-400", border: "border-yellow-500/50", pulse: "" },
  low: { bg: "bg-blue-500/20", text: "text-blue-400", border: "border-blue-500/50", pulse: "" },
  info: { bg: "bg-zinc-500/20", text: "text-zinc-400", border: "border-zinc-500/50", pulse: "" },
};

const STEP_ICONS: Record<string, typeof ShieldAlert> = {
  threat_confirmed: ShieldAlert,
  alert_created: AlertTriangle,
  incident_recording: Camera,
  sop_activated: FileText,
  dispatch_recommended: Truck,
  emergency_services_located: MapPin,
  operators_notified: Users,
  response_aborted: Ban,
};

const STEP_LABELS: Record<string, string> = {
  threat_confirmed: "Threat Confirmed",
  alert_created: "Alert Created",
  incident_recording: "Incident Recording",
  sop_activated: "SOP Activated",
  dispatch_recommended: "Dispatch Recommended",
  emergency_services_located: "Emergency Services Located",
  operators_notified: "Operators Notified",
  response_aborted: "Response Aborted",
};

const SVC_TYPE_META: Record<string, { icon: typeof Building2; color: string; label: string }> = {
  police: { icon: Shield, color: "text-blue-400", label: "Police" },
  hospital: { icon: Cross, color: "text-red-400", label: "Hospital" },
  fire_station: { icon: Flame, color: "text-orange-400", label: "Fire Station" },
  clinic: { icon: Cross, color: "text-emerald-400", label: "Clinic" },
};

const ESCALATION_TIERS: { level: Severity; label: string; dot: string; line: string }[] = [
  { level: "critical", label: "Critical", dot: "bg-red-500", line: "bg-red-500/40" },
  { level: "high",     label: "High",     dot: "bg-orange-500", line: "bg-orange-500/40" },
  { level: "medium",   label: "Medium",   dot: "bg-yellow-500", line: "bg-yellow-500/40" },
  { level: "low",      label: "Low",      dot: "bg-blue-500", line: "bg-blue-500/40" },
  { level: "info",     label: "Info",     dot: "bg-zinc-500", line: "bg-zinc-500/40" },
];

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ── Main Page ────────────────────────────────────────────────────────

export default function ThreatResponsePage() {
  const {
    activeResponses,
    responseHistory,
    emergencyServices,
    facilityLocation,
    connected,
    loading,
    triggerTest,
    abortResponse,
    refreshHistory,
  } = useThreatResponse();

  const { addToast } = useToast();

  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [showHistory, setShowHistory] = useState(false);

  // Response metrics
  const [metrics, setMetrics] = useState<ResponseMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);

  // After-action review modal
  const [reviewTargetId, setReviewTargetId] = useState<string | null>(null);
  const [reviewForm, setReviewForm] = useState<AfterActionReview>({ what_worked: "", what_could_improve: "", lessons_learned: "" });
  const [reviewSubmitting, setReviewSubmitting] = useState(false);

  // Counterfactual "What If?" analysis
  const [cfIncidentId, setCfIncidentId] = useState("");
  const [cfPolicyChange, setCfPolicyChange] = useState("");
  const [cfResult, setCfResult] = useState<any>(null);
  const [cfLoading, setCfLoading] = useState(false);

  // Fetch response metrics
  const fetchMetrics = useCallback(async () => {
    setMetricsLoading(true);
    try {
      const data = await apiFetch<ResponseMetrics>("/api/threat-response/metrics");
      setMetrics(data);
    } catch {
      // 404 or unavailable — compute from available history data
      const now = Date.now();
      const cutoff = now - 24 * 60 * 60 * 1000;
      const recent = responseHistory.filter(
        (r) => r.started_at && new Date(r.started_at).getTime() > cutoff
      );
      const resolved = recent.filter((r) => r.status === "completed").length;
      const active = activeResponses.length;

      // Compute avg time-to-dispatch from history (dispatch_recommended step timestamp minus started_at)
      const dispatchDelays: number[] = [];
      for (const r of recent) {
        const dispatchAction = r.actions?.find((a: ThreatResponseAction) => a.action === "dispatch_recommended" && a.timestamp);
        if (dispatchAction?.timestamp && r.started_at) {
          const delta = (new Date(dispatchAction.timestamp).getTime() - new Date(r.started_at).getTime()) / 1000;
          if (delta > 0) dispatchDelays.push(delta);
        }
      }
      const avgDispatch = dispatchDelays.length > 0
        ? Math.round(dispatchDelays.reduce((a, b) => a + b, 0) / dispatchDelays.length)
        : null;

      setMetrics({
        avg_time_to_dispatch_seconds: avgDispatch,
        total_responses_24h: recent.length,
        resolved_count: resolved,
        active_count: active,
      });
    } finally {
      setMetricsLoading(false);
    }
  }, [responseHistory, activeResponses]);

  useEffect(() => {
    if (!loading) fetchMetrics();
  }, [loading, fetchMetrics]);

  // Submit after-action review
  const submitReview = async () => {
    if (!reviewTargetId || reviewSubmitting) return;
    setReviewSubmitting(true);
    try {
      await apiFetch(`/api/threat-response/${reviewTargetId}/review`, {
        method: "POST",
        body: JSON.stringify(reviewForm),
      });
      addToast("success", "After-action review submitted.");
      setReviewTargetId(null);
      setReviewForm({ what_worked: "", what_could_improve: "", lessons_learned: "" });
    } catch {
      addToast("info", "Review endpoint not available.");
      setReviewTargetId(null);
    } finally {
      setReviewSubmitting(false);
    }
  };

  // The "primary" response to display (active one or selected history)
  const primaryResponse = useMemo(() => {
    if (activeResponses.length > 0) return activeResponses[0];
    if (selectedHistoryId) return responseHistory.find((r) => r.response_id === selectedHistoryId) ?? null;
    return null;
  }, [activeResponses, responseHistory, selectedHistoryId]);

  const isActive = primaryResponse?.status === "active";

  const toggleStep = (key: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  // Emergency services grouped by type
  const servicesByType = useMemo(() => {
    const grouped: Record<string, EmergencyService[]> = {};
    for (const svc of emergencyServices) {
      (grouped[svc.type] ??= []).push(svc);
    }
    return grouped;
  }, [emergencyServices]);

  const handleCounterfactual = async () => {
    if (!cfIncidentId.trim() || !cfPolicyChange.trim() || cfLoading) return;
    setCfLoading(true);
    setCfResult(null);
    try {
      const result = await apiFetch("/api/intelligence/counterfactual", {
        method: "POST",
        body: JSON.stringify({ incident_id: cfIncidentId, policy_change: cfPolicyChange }),
      });
      setCfResult(result);
    } catch (err) {
      console.error("Counterfactual analysis failed:", err);
    } finally {
      setCfLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-zinc-500" />
      </div>
    );
  }

  const sev = (primaryResponse?.severity ?? "info") as Severity;
  const colors = SEVERITY_COLORS[sev];

  return (
    <div className="h-full flex flex-col gap-0 overflow-hidden">
      {/* ── Top Banner ──────────────────────────────────────── */}
      {primaryResponse ? (
        <ActiveBanner
          response={primaryResponse}
          colors={colors}
          isActive={isActive}
          onAbort={(id) => abortResponse(id)}
          connected={connected}
        />
      ) : (
        <IdleBanner connected={connected} onTriggerTest={triggerTest} />
      )}

      {/* ── Main 3-Panel Layout ─────────────────────────────── */}
      <div className="flex-1 flex gap-3 p-3 overflow-hidden min-h-0">
        {/* Left — Actions Timeline */}
        <div className="w-[340px] flex flex-col gap-3 overflow-hidden shrink-0">
          <ActionsTimeline
            response={primaryResponse}
            expandedSteps={expandedSteps}
            toggleStep={toggleStep}
            isActive={isActive}
          />
          <HistoryPanel
            history={responseHistory}
            selectedId={selectedHistoryId}
            onSelect={(id) => { setSelectedHistoryId(id); setShowHistory(false); }}
            show={showHistory}
            onToggle={() => setShowHistory((v) => !v)}
            onRefresh={refreshHistory}
          />
        </div>

        {/* Center — Emergency Services */}
        <div className="flex-1 flex flex-col gap-3 overflow-y-auto min-w-0">
          <EmergencyServicesPanel
            services={emergencyServices}
            servicesByType={servicesByType}
            facilityLocation={facilityLocation}
            responseData={primaryResponse}
          />
          {primaryResponse && <DispatchPanel response={primaryResponse} />}
        </div>

        {/* Right — Threat Intel + SOP + Details */}
        <div className="w-[340px] flex flex-col gap-3 overflow-y-auto shrink-0">
          {/* Escalation Ladder (always visible) */}
          <EscalationLadder currentSeverity={(primaryResponse?.severity ?? null) as Severity | null} />
          {/* Response Effectiveness Metrics */}
          <ResponseMetricsCard metrics={metrics} loading={metricsLoading} />
          {primaryResponse ? (
            <>
              <ThreatIntelPanel response={primaryResponse} />
              <SOPPanel response={primaryResponse} />
              <AlertDetailsPanel
                response={primaryResponse}
                onRequestReview={(id) => setReviewTargetId(id)}
              />
            </>
          ) : (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-center">
              <ShieldAlert className="w-12 h-12 mx-auto mb-3 text-zinc-600" />
              <p className="text-zinc-500 text-sm">No active threat response</p>
              <p className="text-zinc-600 text-xs mt-1">
                System is monitoring. Responses trigger automatically on HIGH/CRITICAL threats.
              </p>
              <button
                onClick={triggerTest}
                className="mt-4 px-4 py-2 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md transition-colors"
              >
                <PlayCircle className="w-3.5 h-3.5 inline mr-1.5" />
                Trigger Test Response
              </button>
            </div>
          )}
        </div>
      </div>

      {/* After-Action Review Modal */}
      {reviewTargetId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <ClipboardCheck className="w-4 h-4 text-emerald-400" />
                <h3 className="text-sm font-bold text-white">After-Action Review</h3>
              </div>
              <button onClick={() => setReviewTargetId(null)} className="text-zinc-500 hover:text-zinc-300">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="text-xs text-zinc-400 mb-1 block font-medium">What worked well?</label>
                <textarea
                  rows={3}
                  value={reviewForm.what_worked}
                  onChange={(e) => setReviewForm((f) => ({ ...f, what_worked: e.target.value }))}
                  placeholder="Describe what went well during this response..."
                  className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-emerald-500/50 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-400 mb-1 block font-medium">What could improve?</label>
                <textarea
                  rows={3}
                  value={reviewForm.what_could_improve}
                  onChange={(e) => setReviewForm((f) => ({ ...f, what_could_improve: e.target.value }))}
                  placeholder="Areas or procedures that could be improved..."
                  className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-yellow-500/50 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-400 mb-1 block font-medium">Lessons learned</label>
                <textarea
                  rows={3}
                  value={reviewForm.lessons_learned}
                  onChange={(e) => setReviewForm((f) => ({ ...f, lessons_learned: e.target.value }))}
                  placeholder="Key takeaways and actionable lessons..."
                  className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-blue-500/50 focus:outline-none"
                />
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={submitReview}
                  disabled={reviewSubmitting || (!reviewForm.what_worked && !reviewForm.what_could_improve && !reviewForm.lessons_learned)}
                  className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-40"
                >
                  {reviewSubmitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <ClipboardCheck className="w-3 h-3" />}
                  Submit Review
                </button>
                <button
                  onClick={() => setReviewTargetId(null)}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-xs text-zinc-400 hover:text-zinc-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Counterfactual Analysis — "What If?" */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 mt-4">
        <div className="flex items-center gap-2 mb-3">
          <GitBranch className="h-4 w-4 text-purple-400" />
          <h3 className="text-sm font-bold text-white">Counterfactual Analysis</h3>
          <span className="text-[9px] text-gray-500 bg-gray-800 rounded px-1.5 py-0.5">&quot;What If?&quot;</span>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Analyze how a policy change would have affected a past incident. SENTINEL AI reasons step-by-step through the counterfactual scenario.
        </p>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <input
            type="text"
            value={cfIncidentId}
            onChange={(e) => setCfIncidentId(e.target.value)}
            placeholder="Incident / Alert ID"
            className="rounded-md border border-gray-700 bg-gray-800/60 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-purple-500/50 focus:outline-none"
          />
          <input
            type="text"
            value={cfPolicyChange}
            onChange={(e) => setCfPolicyChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCounterfactual()}
            placeholder='e.g. "Auto-lock doors after 18:00"'
            className="rounded-md border border-gray-700 bg-gray-800/60 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-purple-500/50 focus:outline-none"
          />
        </div>
        <button
          onClick={handleCounterfactual}
          disabled={cfLoading || !cfIncidentId.trim() || !cfPolicyChange.trim()}
          className="flex items-center gap-1.5 rounded-md border border-purple-500/30 bg-purple-500/10 px-4 py-2 text-xs font-bold text-purple-400 hover:bg-purple-500/20 disabled:opacity-50 transition-all mb-3"
        >
          {cfLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />}
          Analyze Counterfactual
        </button>

        {cfResult && (
          <div className="space-y-3 mt-2">
            {/* Outcome badge */}
            <div className="flex items-center gap-3">
              <span className={cn(
                "rounded-full px-3 py-1 text-xs font-bold uppercase",
                cfResult.outcome === "prevented" ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" :
                cfResult.outcome === "mitigated" ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30" :
                "bg-gray-800 text-gray-400 border border-gray-700"
              )}>
                {cfResult.outcome || "Unknown"}
              </span>
              {cfResult.confidence != null && (
                <span className="text-xs text-gray-500">Confidence: <span className="font-bold text-white">{Math.round(cfResult.confidence * 100)}%</span></span>
              )}
            </div>

            {/* Impact Summary */}
            {cfResult.impact_summary && (
              <div className="rounded-md border border-gray-800/50 bg-gray-900/60 p-3">
                <p className="text-xs text-gray-300 leading-relaxed">{cfResult.impact_summary}</p>
              </div>
            )}

            {/* Reasoning Steps */}
            {cfResult.reasoning?.length > 0 && (
              <div>
                <p className="text-[9px] font-bold uppercase tracking-wider text-gray-500 mb-2">Step-by-Step Reasoning</p>
                <div className="space-y-2">
                  {cfResult.reasoning.map((step: any, i: number) => (
                    <div key={i} className="rounded-md border border-gray-800/40 bg-gray-900/40 p-2">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[9px] font-bold text-purple-400">Step {step.step || i + 1}</span>
                        <span className={cn(
                          "text-[8px] font-bold uppercase px-1.5 py-0.5 rounded",
                          step.impact === "prevented" ? "bg-emerald-500/20 text-emerald-400" :
                          step.impact === "mitigated" ? "bg-yellow-500/20 text-yellow-400" :
                          "bg-gray-800 text-gray-500"
                        )}>
                          {step.impact}
                        </span>
                      </div>
                      <p className="text-[10px] text-gray-500 mb-0.5">{step.original_event}</p>
                      <p className="text-[10px] text-gray-300">{step.counterfactual_event}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Cost-Benefit */}
            {cfResult.cost_benefit && (
              <div className="flex items-center gap-4 pt-2 border-t border-gray-800/30 text-[9px] text-gray-500">
                <span>Risk Reduction: <span className="font-bold text-emerald-400">{cfResult.cost_benefit.risk_reduction_pct ?? "?"}%</span></span>
                <span>Complexity: <span className="font-bold text-gray-300">{cfResult.cost_benefit.implementation_complexity ?? "?"}</span></span>
                <span>Recommended: <span className={cfResult.cost_benefit.recommended ? "font-bold text-emerald-400" : "font-bold text-gray-400"}>{cfResult.cost_benefit.recommended ? "Yes" : "No"}</span></span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Active Banner ────────────────────────────────────────────────────

function ActiveBanner({
  response,
  colors,
  isActive,
  onAbort,
  connected,
}: {
  response: ThreatResponse;
  colors: (typeof SEVERITY_COLORS)[Severity];
  isActive: boolean;
  onAbort: (id: string) => void;
  connected: boolean;
}) {
  const completedSteps = response.actions.filter((a) => a.status === "completed").length;
  const totalSteps = response.actions[0]?.total_steps ?? 7;
  const progress = Math.round((completedSteps / totalSteps) * 100);

  return (
    <div className={cn("border-b-2 px-4 py-3", colors.border, isActive && colors.pulse)}>
      <div className="flex items-center justify-between gap-4">
        {/* Left: threat info */}
        <div className="flex items-center gap-3 min-w-0">
          <div className={cn("p-2 rounded-lg", colors.bg)}>
            <Siren className={cn("w-6 h-6", colors.text)} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn("px-2 py-0.5 rounded text-xs font-bold uppercase", colors.bg, colors.text)}>
                {response.severity}
              </span>
              <span className="text-sm font-medium text-white truncate">
                {response.title || response.threat_type.replace(/_/g, " ")}
              </span>
            </div>
            <div className="flex items-center gap-3 mt-0.5 text-xs text-zinc-400">
              {response.source_camera && (
                <span className="flex items-center gap-1">
                  <Camera className="w-3 h-3" /> {response.source_camera}
                </span>
              )}
              {response.zone_name && (
                <span className="flex items-center gap-1">
                  <MapPin className="w-3 h-3" /> {response.zone_name}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Zap className="w-3 h-3" /> {(response.confidence * 100).toFixed(0)}%
              </span>
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" /> {timeAgo(response.started_at)}
              </span>
            </div>
          </div>
        </div>

        {/* Center: progress bar */}
        <div className="flex-1 max-w-xs hidden md:block">
          <div className="flex items-center justify-between text-xs text-zinc-400 mb-1">
            <span>{completedSteps}/{totalSteps} actions</span>
            <span>{progress}%</span>
          </div>
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all duration-700", isActive ? "bg-blue-500" : response.status === "completed" ? "bg-emerald-500" : "bg-red-500")}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* Right: status + actions */}
        <div className="flex items-center gap-3 shrink-0">
          <div className={cn(
            "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
            isActive ? "bg-blue-500/20 text-blue-400" :
            response.status === "completed" ? "bg-emerald-500/20 text-emerald-400" :
            "bg-red-500/20 text-red-400"
          )}>
            {isActive ? <Radio className="w-3 h-3 animate-pulse" /> :
             response.status === "completed" ? <CheckCircle2 className="w-3 h-3" /> :
             <XCircle className="w-3 h-3" />}
            {isActive ? "AUTONOMOUS RESPONSE ACTIVE" : response.status.toUpperCase()}
          </div>
          <div className={cn("w-2 h-2 rounded-full", connected ? "bg-emerald-500" : "bg-red-500")} title={connected ? "Connected" : "Disconnected"} />
          {isActive && (
            <button
              onClick={() => onAbort(response.response_id)}
              className="px-3 py-1 text-xs bg-zinc-800 hover:bg-red-900/50 text-zinc-400 hover:text-red-400 rounded border border-zinc-700 hover:border-red-700 transition-colors"
            >
              Abort
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Idle Banner ──────────────────────────────────────────────────────

function IdleBanner({ connected, onTriggerTest }: { connected: boolean; onTriggerTest: () => void }) {
  return (
    <div className="border-b border-zinc-800 px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-zinc-800">
            <Shield className="w-5 h-5 text-emerald-500" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-white">Autonomous Threat Response</h1>
            <p className="text-xs text-zinc-500">System monitoring — no active threats</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500 flex items-center gap-1.5">
            <div className={cn("w-2 h-2 rounded-full", connected ? "bg-emerald-500" : "bg-red-500")} />
            {connected ? "Connected" : "Disconnected"}
          </span>
          <button
            onClick={onTriggerTest}
            className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md transition-colors flex items-center gap-1.5"
          >
            <PlayCircle className="w-3.5 h-3.5" />
            Test Response
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Actions Timeline ─────────────────────────────────────────────────

function ActionsTimeline({
  response,
  expandedSteps,
  toggleStep,
  isActive,
}: {
  response: ThreatResponse | null;
  expandedSteps: Set<string>;
  toggleStep: (key: string) => void;
  isActive: boolean;
}) {
  if (!response) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 flex-1">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Actions Timeline</h3>
        <p className="text-zinc-600 text-xs">Waiting for threat response…</p>
      </div>
    );
  }

  // Build full 7-step list, filling in pending for missing steps
  const ALL_STEPS = [
    "threat_confirmed", "alert_created", "incident_recording",
    "sop_activated", "dispatch_recommended", "emergency_services_located", "operators_notified",
  ];
  const actionMap = new Map(response.actions.map((a) => [a.action, a]));
  const steps = ALL_STEPS.map((action, i) => {
    const existing = actionMap.get(action);
    return existing ?? {
      step_number: i + 1,
      total_steps: 7,
      action,
      status: "pending" as const,
      details: {},
      timestamp: "",
    };
  });

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 flex-1 overflow-y-auto">
      <div className="p-3 border-b border-zinc-800/50">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
          <Activity className="w-3.5 h-3.5" /> Autonomous Actions
        </h3>
      </div>
      <div className="p-2">
        {steps.map((step, i) => {
          const Icon = STEP_ICONS[step.action] ?? ShieldAlert;
          const label = STEP_LABELS[step.action] ?? step.action;
          const key = `${response.response_id}-${step.action}`;
          const expanded = expandedSteps.has(key);
          const isExecuting = step.status === "executing";
          const isCompleted = step.status === "completed";
          const isFailed = step.status === "failed";
          const isPending = step.status === "pending";

          return (
            <div key={step.action} className="relative">
              {/* Vertical connector line */}
              {i < steps.length - 1 && (
                <div className={cn(
                  "absolute left-[19px] top-10 w-0.5 h-[calc(100%-24px)]",
                  isCompleted ? "bg-emerald-500/40" : isPending ? "bg-zinc-700" : "bg-blue-500/40"
                )} />
              )}

              <button
                onClick={() => isCompleted || isFailed ? toggleStep(key) : undefined}
                className={cn(
                  "w-full flex items-start gap-3 p-2 rounded-md text-left transition-colors",
                  (isCompleted || isFailed) && "hover:bg-zinc-800/50 cursor-pointer",
                  isPending && "opacity-50 cursor-default",
                )}
              >
                {/* Step icon */}
                <div className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center shrink-0 border",
                  isCompleted ? "bg-emerald-500/20 border-emerald-500/40" :
                  isExecuting ? "bg-blue-500/20 border-blue-500/40" :
                  isFailed ? "bg-red-500/20 border-red-500/40" :
                  "bg-zinc-800 border-zinc-700"
                )}>
                  {isExecuting ? (
                    <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                  ) : (
                    <Icon className={cn(
                      "w-4 h-4",
                      isCompleted ? "text-emerald-400" :
                      isFailed ? "text-red-400" : "text-zinc-500"
                    )} />
                  )}
                </div>

                {/* Step text */}
                <div className="flex-1 min-w-0 pt-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className={cn(
                      "text-sm font-medium",
                      isCompleted ? "text-white" :
                      isExecuting ? "text-blue-300" :
                      isFailed ? "text-red-300" : "text-zinc-500"
                    )}>
                      {label}
                    </span>
                    {(isCompleted || isFailed) && (
                      expanded ? <ChevronDown className="w-3 h-3 text-zinc-500" /> : <ChevronRight className="w-3 h-3 text-zinc-500" />
                    )}
                  </div>
                  {/* Brief status message */}
                  {step.details?.message && (
                    <p className="text-xs text-zinc-500 mt-0.5 truncate">
                      {step.details.message as string}
                    </p>
                  )}
                  {step.timestamp && (
                    <p className="text-[10px] text-zinc-600 mt-0.5">
                      {new Date(step.timestamp).toLocaleTimeString()}
                    </p>
                  )}
                </div>
              </button>

              {/* Expanded details */}
              {expanded && step.details && (
                <div className="ml-11 mr-2 mb-2 p-2 rounded bg-zinc-800/50 border border-zinc-700/50">
                  <StepDetails details={step.details} action={step.action} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Step Details (expanded) ──────────────────────────────────────────

function StepDetails({ details, action }: { details: Record<string, unknown>; action: string }) {
  // Filter out the message field (already shown inline)
  const entries = Object.entries(details).filter(([k]) => k !== "message");

  if (action === "dispatch_recommended" && details.recommended_resources) {
    const res = details.recommended_resources as Record<string, unknown>;
    return (
      <div className="space-y-1">
        <p className="text-xs text-zinc-400">Priority: <span className="text-white font-medium">{(res.priority as string) ?? "standard"}</span></p>
        <div className="flex flex-wrap gap-2 mt-1">
          {["police", "ems", "fire", "security"].map((type) => (
            <span key={type} className="px-2 py-0.5 bg-zinc-700/50 rounded text-xs text-zinc-300">
              {type}: {(res[type] as number) ?? 0}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (action === "sop_activated" && details.workflow_stages) {
    const stages = details.workflow_stages as { title: string; instructions: string }[];
    return (
      <div className="space-y-1">
        <p className="text-xs text-zinc-400">SOP: <span className="text-white font-medium">{(details.sop_name as string) ?? "Unknown"}</span></p>
        <div className="mt-1 space-y-1">
          {stages.slice(0, 4).map((s, i) => (
            <div key={i} className="flex items-start gap-1.5 text-xs">
              <span className="text-zinc-600 shrink-0">{i + 1}.</span>
              <span className="text-zinc-400">{s.title}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {entries.map(([key, val]) => (
        <div key={key} className="text-xs">
          <span className="text-zinc-500">{key.replace(/_/g, " ")}: </span>
          <span className="text-zinc-300">
            {typeof val === "object" ? JSON.stringify(val) : String(val)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── History Panel ────────────────────────────────────────────────────

function HistoryPanel({
  history,
  selectedId,
  onSelect,
  show,
  onToggle,
  onRefresh,
}: {
  history: ThreatResponse[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  show: boolean;
  onToggle: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      <div role="button" tabIndex={0} onClick={onToggle} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }} className="w-full p-3 flex items-center justify-between hover:bg-zinc-800/30 transition-colors cursor-pointer">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
          <History className="w-3.5 h-3.5" /> Response History ({history.length})
        </h3>
        <div className="flex items-center gap-2">
          <button onClick={(e) => { e.stopPropagation(); onRefresh(); }} className="text-zinc-600 hover:text-zinc-400">
            <RefreshCw className="w-3 h-3" />
          </button>
          {show ? <ChevronDown className="w-3.5 h-3.5 text-zinc-500" /> : <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />}
        </div>
      </div>
      {show && (
        <div className="border-t border-zinc-800/50 max-h-48 overflow-y-auto">
          {history.length === 0 ? (
            <p className="p-3 text-xs text-zinc-600">No previous responses</p>
          ) : (
            history.map((r) => {
              const sc = SEVERITY_COLORS[(r.severity ?? "info") as Severity];
              return (
                <button
                  key={r.response_id}
                  onClick={() => onSelect(r.response_id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-zinc-800/50 transition-colors border-b border-zinc-800/30 last:border-0",
                    selectedId === r.response_id && "bg-zinc-800/50"
                  )}
                >
                  <span className={cn("w-2 h-2 rounded-full shrink-0", sc.bg.replace("/20", ""))}/>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-zinc-300 truncate">{r.threat_type.replace(/_/g, " ")}</p>
                    <p className="text-[10px] text-zinc-600">{r.started_at ? new Date(r.started_at).toLocaleString() : ""}</p>
                  </div>
                  <span className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded",
                    r.status === "completed" ? "bg-emerald-500/20 text-emerald-400" :
                    r.status === "aborted" ? "bg-red-500/20 text-red-400" : "bg-zinc-700 text-zinc-400"
                  )}>
                    {r.status}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ── Emergency Services Panel ─────────────────────────────────────────

function EmergencyServicesPanel({
  services,
  servicesByType,
  facilityLocation,
  responseData,
}: {
  services: EmergencyService[];
  servicesByType: Record<string, EmergencyService[]>;
  facilityLocation: { latitude: number; longitude: number } | null;
  responseData: ThreatResponse | null;
}) {
  const [expandedType, setExpandedType] = useState<string | null>(null);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      <div className="p-3 border-b border-zinc-800/50">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
            <MapPin className="w-3.5 h-3.5" /> Nearby Emergency Services
          </h3>
          <span className="text-[10px] text-zinc-600">
            {services.length} services found
            {facilityLocation && ` • ${facilityLocation.latitude.toFixed(4)}°, ${facilityLocation.longitude.toFixed(4)}°`}
          </span>
        </div>
      </div>

      {services.length === 0 ? (
        <div className="p-6 text-center">
          <MapPin className="w-8 h-8 mx-auto mb-2 text-zinc-700" />
          <p className="text-zinc-500 text-sm">No emergency services data</p>
          <p className="text-zinc-600 text-xs mt-1">Services are fetched from OpenStreetMap when a response triggers</p>
        </div>
      ) : (
        <div className="p-3 space-y-2">
          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            {(["police", "hospital", "fire_station", "clinic"] as const).map((type) => {
              const meta = SVC_TYPE_META[type];
              const svcs = servicesByType[type] ?? [];
              const nearest = svcs[0];
              const Icon = meta?.icon ?? Building2;
              return (
                <button
                  key={type}
                  onClick={() => setExpandedType(expandedType === type ? null : type)}
                  className={cn(
                    "p-3 rounded-lg border text-left transition-colors",
                    expandedType === type ? "border-zinc-600 bg-zinc-800/50" : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
                  )}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <Icon className={cn("w-4 h-4", meta?.color ?? "text-zinc-400")} />
                    <span className="text-xs font-medium text-zinc-300">{meta?.label ?? type}</span>
                  </div>
                  <p className="text-lg font-bold text-white">{svcs.length}</p>
                  {nearest && (
                    <p className="text-[10px] text-zinc-500 mt-0.5">
                      Nearest: {nearest.distance_km}km
                    </p>
                  )}
                </button>
              );
            })}
          </div>

          {/* Expanded list for selected type */}
          {expandedType && servicesByType[expandedType] && (
            <div className="mt-2 rounded-lg border border-zinc-800 overflow-hidden">
              <div className="max-h-60 overflow-y-auto divide-y divide-zinc-800/50">
                {servicesByType[expandedType].map((svc, i) => (
                  <div key={i} className="px-3 py-2 flex items-center justify-between hover:bg-zinc-800/30">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-zinc-200 truncate">{svc.name}</p>
                      {svc.address && <p className="text-[10px] text-zinc-500 truncate">{svc.address}</p>}
                    </div>
                    <div className="flex items-center gap-3 shrink-0 ml-3">
                      {svc.phone && (
                        <a href={`tel:${svc.phone}`} className="text-blue-400 hover:text-blue-300" title={svc.phone}>
                          <Phone className="w-3.5 h-3.5" />
                        </a>
                      )}
                      <span className="text-xs text-zinc-400 font-mono">{svc.distance_km}km</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Response-specific emergency info */}
          {responseData?.actions && (() => {
            const emStep = responseData.actions.find((a) => a.action === "emergency_services_located" && a.status === "completed");
            if (!emStep) return null;
            const nearest = (emStep.details?.nearest ?? {}) as Record<string, { name: string; distance_km: number; phone?: string }>;
            if (Object.keys(nearest).length === 0) return null;
            return (
              <div className="mt-2 p-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5">
                <h4 className="text-xs font-semibold text-emerald-400 mb-2">Nearest to Facility</h4>
                <div className="space-y-1.5">
                  {Object.entries(nearest).map(([type, info]) => {
                    const meta = SVC_TYPE_META[type];
                    const Icon = meta?.icon ?? Building2;
                    return (
                      <div key={type} className="flex items-center gap-2 text-xs">
                        <Icon className={cn("w-3.5 h-3.5", meta?.color ?? "text-zinc-400")} />
                        <span className="text-zinc-300 flex-1">{info.name}</span>
                        <span className="text-zinc-500">{info.distance_km}km</span>
                        {info.phone && (
                          <a href={`tel:${info.phone}`} className="text-blue-400 hover:text-blue-300">
                            <Phone className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ── Dispatch Panel ───────────────────────────────────────────────────

function DispatchPanel({ response }: { response: ThreatResponse }) {
  const dispatchStep = response.actions.find(
    (a) => a.action === "dispatch_recommended" && a.status === "completed"
  );
  if (!dispatchStep) return null;

  const resources = (dispatchStep.details?.recommended_resources ?? {}) as Record<string, unknown>;
  const priority = (resources.priority as string) ?? "standard";

  const resourceTypes = [
    { key: "police", label: "Police Units", icon: Shield, color: "text-blue-400" },
    { key: "ems", label: "EMS / Ambulance", icon: Cross, color: "text-red-400" },
    { key: "fire", label: "Fire Units", icon: Flame, color: "text-orange-400" },
    { key: "security", label: "Security Teams", icon: Users, color: "text-violet-400" },
  ];

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      <div className="p-3 border-b border-zinc-800/50">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
            <Truck className="w-3.5 h-3.5" /> Dispatch Recommendation
          </h3>
          <span className={cn(
            "px-2 py-0.5 rounded text-[10px] font-bold uppercase",
            priority === "immediate" ? "bg-red-500/20 text-red-400" :
            priority === "urgent" ? "bg-orange-500/20 text-orange-400" :
            "bg-zinc-700 text-zinc-400"
          )}>
            {priority}
          </span>
        </div>
      </div>
      <div className="p-3">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          {resourceTypes.map(({ key, label, icon: Icon, color }) => {
            const count = (resources[key] as number) ?? 0;
            return (
              <div key={key} className={cn("p-3 rounded-lg border text-center", count > 0 ? "border-zinc-700 bg-zinc-800/30" : "border-zinc-800/50 bg-zinc-900/30 opacity-50")}>
                <Icon className={cn("w-5 h-5 mx-auto mb-1", count > 0 ? color : "text-zinc-600")} />
                <p className="text-xl font-bold text-white">{count}</p>
                <p className="text-[10px] text-zinc-500">{label}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Threat Intel Panel ───────────────────────────────────────────────

function ThreatIntelPanel({ response }: { response: ThreatResponse }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      <div className="p-3 border-b border-zinc-800/50">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
          <Zap className="w-3.5 h-3.5" /> Threat Intelligence
        </h3>
      </div>
      <div className="p-3 space-y-3">
        <div>
          <label className="text-[10px] text-zinc-600 uppercase">Threat Type</label>
          <p className="text-sm text-white font-medium">{response.threat_type.replace(/_/g, " ")}</p>
        </div>
        <div>
          <label className="text-[10px] text-zinc-600 uppercase">Confidence</label>
          <div className="flex items-center gap-2 mt-0.5">
            <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className={cn("h-full rounded-full",
                  response.confidence >= 0.9 ? "bg-red-500" :
                  response.confidence >= 0.7 ? "bg-orange-500" :
                  response.confidence >= 0.5 ? "bg-yellow-500" : "bg-blue-500"
                )}
                style={{ width: `${response.confidence * 100}%` }}
              />
            </div>
            <span className="text-xs text-zinc-300 font-mono">{(response.confidence * 100).toFixed(0)}%</span>
          </div>
        </div>
        {response.description && (
          <div>
            <label className="text-[10px] text-zinc-600 uppercase">Description</label>
            <p className="text-xs text-zinc-400 mt-0.5 leading-relaxed">{response.description}</p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-zinc-600 uppercase">Camera</label>
            <p className="text-xs text-zinc-300">{response.source_camera || "—"}</p>
          </div>
          <div>
            <label className="text-[10px] text-zinc-600 uppercase">Zone</label>
            <p className="text-xs text-zinc-300">{response.zone_name || "—"}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── SOP Panel ────────────────────────────────────────────────────────

function SOPPanel({ response }: { response: ThreatResponse }) {
  const sopStep = response.actions.find(
    (a) => a.action === "sop_activated" && a.status === "completed"
  );
  if (!sopStep) return null;

  const d = sopStep.details;
  const sopName = (d.sop_name as string) ?? "Standard Protocol";
  const totalStages = (d.total_stages as number) ?? 0;
  const currentStage = (d.current_stage as number) ?? 0;
  const stages = (d.workflow_stages as { title: string; instructions: string }[]) ?? [];

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      <div className="p-3 border-b border-zinc-800/50">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
          <FileText className="w-3.5 h-3.5" /> Active SOP
        </h3>
      </div>
      <div className="p-3">
        <p className="text-sm text-white font-medium">{sopName}</p>
        {totalStages > 0 && (
          <div className="mt-2">
            <div className="flex items-center justify-between text-[10px] text-zinc-500 mb-1">
              <span>Stage {currentStage + 1} of {totalStages}</span>
              <span>{Math.round(((currentStage + 1) / totalStages) * 100)}%</span>
            </div>
            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div className="h-full bg-violet-500 rounded-full transition-all" style={{ width: `${((currentStage + 1) / totalStages) * 100}%` }} />
            </div>
          </div>
        )}
        {stages.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {stages.map((s, i) => (
              <div key={i} className={cn("flex items-start gap-2 text-xs", i <= currentStage ? "text-zinc-300" : "text-zinc-600")}>
                <span className={cn(
                  "w-4 h-4 rounded-full flex items-center justify-center text-[10px] shrink-0 border",
                  i < currentStage ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-400" :
                  i === currentStage ? "bg-blue-500/20 border-blue-500/40 text-blue-400" :
                  "border-zinc-700 text-zinc-600"
                )}>
                  {i + 1}
                </span>
                <div>
                  <span className="font-medium">{s.title}</span>
                  <p className="text-[10px] text-zinc-500 mt-0.5">{s.instructions}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Alert Details Panel ──────────────────────────────────────────────

function AlertDetailsPanel({
  response,
  onRequestReview,
}: {
  response: ThreatResponse;
  onRequestReview: (id: string) => void;
}) {
  const isResolved = response.status === "completed" || response.status === "aborted";
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      <div className="p-3 border-b border-zinc-800/50">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5" /> Response Metadata
        </h3>
      </div>
      <div className="p-3 space-y-2 text-xs">
        <div className="flex justify-between">
          <span className="text-zinc-500">Response ID</span>
          <span className="text-zinc-400 font-mono">{response.response_id.slice(0, 12)}…</span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-500">Alert ID</span>
          <span className="text-zinc-400 font-mono">{response.alert_id.slice(0, 12)}…</span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-500">Started</span>
          <span className="text-zinc-400">{response.started_at ? new Date(response.started_at).toLocaleString() : "—"}</span>
        </div>
        {response.completed_at && (
          <div className="flex justify-between">
            <span className="text-zinc-500">Completed</span>
            <span className="text-zinc-400">{new Date(response.completed_at).toLocaleString()}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-zinc-500">Actions</span>
          <span className="text-zinc-400">{response.actions.filter((a) => a.status === "completed").length}/{response.actions[0]?.total_steps ?? 7}</span>
        </div>
        {isResolved && (
          <div className="pt-2">
            <button
              onClick={() => onRequestReview(response.response_id)}
              className="w-full flex items-center justify-center gap-2 rounded-md border border-emerald-700/40 bg-emerald-900/20 px-3 py-1.5 text-xs font-medium text-emerald-400 hover:bg-emerald-900/40 transition-colors"
            >
              <ClipboardCheck className="w-3.5 h-3.5" />
              After Action Review
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Escalation Ladder ─────────────────────────────────────────────────

function EscalationLadder({ currentSeverity }: { currentSeverity: Severity | null }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      <div className="p-3 border-b border-zinc-800/50">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
          <Zap className="w-3.5 h-3.5" /> Escalation Ladder
        </h3>
      </div>
      <div className="p-3">
        <div className="flex items-start gap-3">
          {/* Vertical line + dots */}
          <div className="flex flex-col items-center">
            {ESCALATION_TIERS.map((tier, i) => (
              <div key={tier.level} className="flex flex-col items-center">
                <div className={cn(
                  "w-3 h-3 rounded-full border-2 border-transparent transition-all",
                  tier.dot,
                  currentSeverity === tier.level
                    ? "scale-125 ring-2 ring-offset-1 ring-offset-zinc-900 ring-current animate-pulse"
                    : "opacity-40"
                )} />
                {i < ESCALATION_TIERS.length - 1 && (
                  <div className={cn("w-0.5 h-6", tier.line)} />
                )}
              </div>
            ))}
          </div>
          {/* Labels */}
          <div className="flex flex-col">
            {ESCALATION_TIERS.map((tier) => (
              <div
                key={tier.level}
                className={cn(
                  "h-[36px] flex items-center text-xs font-medium transition-all",
                  currentSeverity === tier.level
                    ? SEVERITY_COLORS[tier.level].text + " font-bold"
                    : "text-zinc-600"
                )}
              >
                {tier.label}
                {currentSeverity === tier.level && (
                  <span className="ml-2 text-[9px] uppercase tracking-wide opacity-70">← current</span>
                )}
              </div>
            ))}
          </div>
        </div>
        {!currentSeverity && (
          <p className="text-[10px] text-zinc-600 mt-1">No active threat — system at baseline</p>
        )}
      </div>
    </div>
  );
}

// ── Response Effectiveness Metrics Card ──────────────────────────────

function ResponseMetricsCard({
  metrics,
  loading,
}: {
  metrics: ResponseMetrics | null;
  loading: boolean;
}) {
  const formatDispatch = (secs: number | null) => {
    if (secs === null) return "N/A";
    if (secs < 60) return `${secs}s`;
    return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      <div className="p-3 border-b border-zinc-800/50">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
          <BarChart2 className="w-3.5 h-3.5" /> Response Metrics
        </h3>
      </div>
      <div className="p-3">
        {loading && !metrics ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="w-4 h-4 animate-spin text-zinc-600" />
          </div>
        ) : metrics ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2 text-center">
              <p className="text-lg font-bold tabular-nums text-blue-400">
                {formatDispatch(metrics.avg_time_to_dispatch_seconds)}
              </p>
              <p className="text-[10px] text-zinc-500 mt-0.5">Avg. Dispatch Time</p>
            </div>
            <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2 text-center">
              <p className="text-lg font-bold tabular-nums text-white">{metrics.total_responses_24h}</p>
              <p className="text-[10px] text-zinc-500 mt-0.5">Responses / 24h</p>
            </div>
            <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2 text-center">
              <p className="text-lg font-bold tabular-nums text-emerald-400">{metrics.resolved_count}</p>
              <p className="text-[10px] text-zinc-500 mt-0.5">Resolved</p>
            </div>
            <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2 text-center">
              <p className="text-lg font-bold tabular-nums text-orange-400">{metrics.active_count}</p>
              <p className="text-[10px] text-zinc-500 mt-0.5">Active</p>
            </div>
          </div>
        ) : (
          <p className="text-[10px] text-zinc-600 text-center py-3">Metrics unavailable</p>
        )}
      </div>
    </div>
  );
}
