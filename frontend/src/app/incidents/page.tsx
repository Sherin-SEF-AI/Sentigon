"use client";

import { useState, useEffect, useCallback } from "react";
import {
  AlertTriangle,
  Shield,
  Clock,
  CheckCircle2,
  XCircle,
  Plus,
  Search,
  ChevronDown,
  ChevronRight,
  Loader2,
  User,
  MapPin,
  FileText,
  Brain,
  Timer,
  ArrowRight,
  X,
  Activity,
  TrendingUp,
  Eye,
  Image,
  Paperclip,
  Upload,
  Link2,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import FileUpload, { type UploadedFile } from "@/components/common/FileUpload";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface IncidentStats {
  open: number;
  sla_breaches: number;
  resolved_today: number;
  avg_response_time_minutes: number;
}

interface Incident {
  id: string;
  title: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  status: string;
  type: string;
  zone_name: string;
  assigned_to: string | null;
  sla_deadline: string | null;
  created_at: string;
  updated_at: string;
  evidence_count?: number;
}

interface TimelineEntry {
  id: string;
  action: string;
  actor: string;
  timestamp: string;
  details: string;
}

interface Evidence {
  id: string;
  type: string;
  url: string;
  label: string;
  timestamp: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const WORKFLOW_STEPS = [
  "detected",
  "triaged",
  "assigned",
  "in_progress",
  "resolved",
  "closed",
  "reviewed",
];

const WORKFLOW_LABELS: Record<string, string> = {
  detected: "Detected",
  triaged: "Triaged",
  assigned: "Assigned",
  in_progress: "In Progress",
  resolved: "Resolved",
  closed: "Closed",
  reviewed: "Reviewed",
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: "text-red-500 bg-red-500/10 border-red-500/50",
  high: "text-orange-500 bg-orange-500/10 border-orange-500/50",
  medium: "text-yellow-500 bg-yellow-500/10 border-yellow-500/50",
  low: "text-blue-400 bg-blue-400/10 border-blue-400/50",
};

const STATUS_COLORS: Record<string, string> = {
  detected: "text-red-400 bg-red-900/30",
  triaged: "text-yellow-400 bg-yellow-900/30",
  assigned: "text-blue-400 bg-blue-900/30",
  in_progress: "text-cyan-400 bg-cyan-900/30",
  resolved: "text-green-400 bg-green-900/30",
  closed: "text-gray-400 bg-gray-800",
  reviewed: "text-emerald-400 bg-emerald-900/30",
};

const PAGE_SIZE = 20;

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
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function slaTimeRemaining(deadline: string | null): {
  text: string;
  color: string;
} {
  if (!deadline) return { text: "No SLA", color: "text-gray-500" };
  const remaining = new Date(deadline).getTime() - Date.now();
  if (remaining <= 0) return { text: "BREACHED", color: "text-red-500" };
  const minutes = Math.floor(remaining / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 2) return { text: `${hours}h ${minutes % 60}m`, color: "text-green-400" };
  if (hours >= 1) return { text: `${hours}h ${minutes % 60}m`, color: "text-yellow-400" };
  return { text: `${minutes}m`, color: "text-red-400" };
}

/* ------------------------------------------------------------------ */
/*  Workflow Step Indicator                                            */
/* ------------------------------------------------------------------ */

function WorkflowStepper({ currentStatus }: { currentStatus: string }) {
  const currentIndex = WORKFLOW_STEPS.indexOf(currentStatus);

  return (
    <div className="flex items-center gap-1">
      {WORKFLOW_STEPS.map((step, i) => {
        const isComplete = i < currentIndex;
        const isCurrent = i === currentIndex;
        return (
          <div key={step} className="flex items-center gap-1">
            <div
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full text-[9px] font-bold border transition-colors",
                isComplete &&
                  "border-green-500 bg-green-500/20 text-green-400",
                isCurrent &&
                  "border-cyan-400 bg-cyan-400/20 text-cyan-400 ring-2 ring-cyan-400/30",
                !isComplete &&
                  !isCurrent &&
                  "border-gray-700 bg-gray-800 text-gray-600"
              )}
            >
              {isComplete ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                i + 1
              )}
            </div>
            {i < WORKFLOW_STEPS.length - 1 && (
              <div
                className={cn(
                  "h-px w-4",
                  isComplete ? "bg-green-500/50" : "bg-gray-700"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Link Evidence Modal                                                */
/* ------------------------------------------------------------------ */

function LinkEvidenceModal({
  incidentId,
  onClose,
  onLinked,
}: {
  incidentId: string;
  onClose: () => void;
  onLinked: () => void;
}) {
  const { addToast } = useToast();
  const [evidenceList, setEvidenceList] = useState<Evidence[]>([]);
  const [loadingEvidence, setLoadingEvidence] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [tab, setTab] = useState<"select" | "upload">("select");

  useEffect(() => {
    setLoadingEvidence(true);
    apiFetch<Evidence[]>("/api/evidence")
      .then(setEvidenceList)
      .catch(() => {
        addToast("error", "Failed to load evidence list");
        setEvidenceList([]);
      })
      .finally(() => setLoadingEvidence(false));
  }, []);

  const filteredEvidence = evidenceList.filter((e) => {
    const q = searchQuery.toLowerCase();
    return (
      !q ||
      e.label?.toLowerCase().includes(q) ||
      e.type?.toLowerCase().includes(q) ||
      e.id?.toLowerCase().includes(q)
    );
  });

  const handleLink = async () => {
    if (!selectedId) return;
    setLinking(true);
    try {
      await apiFetch(`/api/incidents/${incidentId}/evidence`, {
        method: "POST",
        body: JSON.stringify({ evidence_type: "evidence", reference_id: selectedId }),
      });
      addToast("success", "Evidence linked to incident");
      onLinked();
      onClose();
    } catch (e) {
      addToast("error", e instanceof Error ? e.message : "Failed to link evidence");
    } finally {
      setLinking(false);
    }
  };

  const handleUploadSuccess = async (file: UploadedFile) => {
    const evidenceId = file.id;
    if (!evidenceId) {
      addToast("info", "File uploaded — link it manually from the evidence list");
      return;
    }
    try {
      await apiFetch(`/api/incidents/${incidentId}/evidence`, {
        method: "POST",
        body: JSON.stringify({ evidence_type: "evidence", reference_id: evidenceId }),
      });
      addToast("success", `${file.name} uploaded and linked`);
      onLinked();
      onClose();
    } catch (e) {
      addToast("error", e instanceof Error ? e.message : "Uploaded but failed to link evidence");
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border border-gray-800 bg-[#030712] shadow-2xl flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-5 py-4 shrink-0">
          <div className="flex items-center gap-2">
            <Paperclip className="h-4 w-4 text-cyan-400" />
            <h2 className="text-sm font-bold text-gray-100">Link Evidence</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-800 shrink-0">
          <button
            onClick={() => setTab("select")}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-xs font-medium transition-colors",
              tab === "select"
                ? "border-cyan-400 text-cyan-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            )}
          >
            <Link2 className="h-3.5 w-3.5" />
            Select Existing
          </button>
          <button
            onClick={() => setTab("upload")}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-xs font-medium transition-colors",
              tab === "upload"
                ? "border-cyan-400 text-cyan-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            )}
          >
            <Upload className="h-3.5 w-3.5" />
            Upload New
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {tab === "select" ? (
            <div className="space-y-3">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search evidence by label or type..."
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 pl-9 pr-3 py-2 text-xs text-gray-300 placeholder:text-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
                />
              </div>

              {/* Evidence List */}
              {loadingEvidence ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-cyan-400" />
                </div>
              ) : filteredEvidence.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-lg border border-gray-800 bg-gray-900/40 py-8 text-center">
                  <FileText className="mb-2 h-8 w-8 text-gray-700" />
                  <p className="text-xs text-gray-500">No evidence found</p>
                </div>
              ) : (
                <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                  {filteredEvidence.map((ev) => (
                    <button
                      key={ev.id}
                      onClick={() => setSelectedId(ev.id === selectedId ? null : ev.id)}
                      className={cn(
                        "w-full flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                        selectedId === ev.id
                          ? "border-cyan-600/60 bg-cyan-900/20"
                          : "border-gray-800 bg-gray-900/40 hover:border-gray-700 hover:bg-gray-900/70"
                      )}
                    >
                      <div
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                          selectedId === ev.id
                            ? "border-cyan-400 bg-cyan-400/20"
                            : "border-gray-700 bg-gray-800"
                        )}
                      >
                        {selectedId === ev.id && (
                          <div className="h-2 w-2 rounded-full bg-cyan-400" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-gray-200">
                          {ev.label || ev.id.slice(0, 16)}
                        </p>
                        <div className="mt-0.5 flex items-center gap-2">
                          <span className="text-[10px] text-gray-500 uppercase">{ev.type}</span>
                          {ev.timestamp && (
                            <span className="text-[10px] text-gray-600">
                              {formatTimestamp(ev.timestamp)}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-gray-500">
                Upload a new file — it will be saved as evidence and automatically linked to this incident.
              </p>
              <FileUpload
                endpoint="/api/evidence/upload"
                accept="image/*,video/*,.pdf,.txt,.json,.csv"
                multiple={false}
                label="Drag & drop or click to upload evidence"
                onUpload={handleUploadSuccess}
                onError={(msg) => addToast("error", msg)}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        {tab === "select" && (
          <div className="flex items-center justify-end gap-3 border-t border-gray-800 px-5 py-3 shrink-0">
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-700 px-4 py-2 text-xs font-medium text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={handleLink}
              disabled={!selectedId || linking}
              className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-4 py-2 text-xs font-bold text-white hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {linking ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Paperclip className="h-3.5 w-3.5" />
              )}
              Link Evidence
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Detail Side Panel                                                  */
/* ------------------------------------------------------------------ */

function IncidentDetailPanel({
  incident,
  onClose,
  onRefresh,
}: {
  incident: Incident;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const { addToast } = useToast();
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [linkedEvidence, setLinkedEvidence] = useState<Evidence[]>([]);
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignInput, setAssignInput] = useState("");
  const [showAssignInput, setShowAssignInput] = useState(false);
  const [showLinkEvidence, setShowLinkEvidence] = useState(false);

  useEffect(() => {
    apiFetch<TimelineEntry[]>(`/api/incidents/${incident.id}/timeline`)
      .then(setTimeline)
      .catch(() => {});
  }, [incident.id]);

  const fetchLinkedEvidence = useCallback(() => {
    setLoadingEvidence(true);
    apiFetch<Evidence[]>(`/api/incidents/${incident.id}/evidence`)
      .then(setLinkedEvidence)
      .catch(() => setLinkedEvidence([]))
      .finally(() => setLoadingEvidence(false));
  }, [incident.id]);

  useEffect(() => {
    fetchLinkedEvidence();
  }, [fetchLinkedEvidence]);

  const handleStatusChange = async (newStatus: string) => {
    setStatusLoading(true);
    try {
      await apiFetch(`/api/incidents/${incident.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
      addToast("success", `Status advanced to ${WORKFLOW_LABELS[newStatus]}`);
      onRefresh();
    } catch (e) {
      addToast("error", e instanceof Error ? e.message : "Failed to update status");
    } finally {
      setStatusLoading(false);
    }
  };

  const handleAssign = async () => {
    if (!assignInput.trim()) return;
    setAssignLoading(true);
    try {
      await apiFetch(`/api/incidents/${incident.id}/assign`, {
        method: "POST",
        body: JSON.stringify({ user_id: assignInput.trim() }),
      });
      addToast("success", `Incident assigned to ${assignInput.trim()}`);
      setShowAssignInput(false);
      setAssignInput("");
      onRefresh();
    } catch (e) {
      addToast("error", e instanceof Error ? e.message : "Failed to assign incident");
    } finally {
      setAssignLoading(false);
    }
  };

  const handleAiSummary = async () => {
    setAiLoading(true);
    try {
      const data = await apiFetch<{ summary: string }>(
        `/api/incidents/${incident.id}/ai-summary`,
        { method: "POST" }
      );
      setAiSummary(data.summary);
    } catch {
      setAiSummary("Failed to generate summary.");
    } finally {
      setAiLoading(false);
    }
  };

  const sla = slaTimeRemaining(incident.sla_deadline);
  const currentIdx = WORKFLOW_STEPS.indexOf(incident.status);
  const nextStatus =
    currentIdx >= 0 && currentIdx < WORKFLOW_STEPS.length - 1
      ? WORKFLOW_STEPS[currentIdx + 1]
      : null;

  return (
    <>
      <div className="fixed inset-y-0 right-0 z-50 flex w-[520px] flex-col border-l border-gray-800 bg-[#030712] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-bold text-gray-100">
              {incident.title}
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              ID: {incident.id.slice(0, 12)}
            </p>
          </div>
          <div className="flex items-center gap-2 ml-3">
            {/* Link Evidence Button */}
            <button
              onClick={() => setShowLinkEvidence(true)}
              className="flex items-center gap-1.5 rounded-lg bg-gray-800 border border-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-300 hover:bg-gray-700 hover:text-white transition-colors"
              title="Link Evidence"
            >
              <Paperclip className="h-3.5 w-3.5" />
              Link Evidence
              {linkedEvidence.length > 0 && (
                <span className="ml-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-cyan-600 px-1 text-[9px] font-bold text-white">
                  {linkedEvidence.length}
                </span>
              )}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
          {/* Badges */}
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded px-2 py-0.5 text-[10px] font-bold uppercase border",
                SEVERITY_COLORS[incident.severity]
              )}
            >
              {incident.severity}
            </span>
            <span
              className={cn(
                "rounded px-2 py-0.5 text-[10px] font-semibold uppercase",
                STATUS_COLORS[incident.status] || "text-gray-400 bg-gray-800"
              )}
            >
              {incident.status.replace("_", " ")}
            </span>
            <span className="text-[10px] text-gray-500">
              {incident.type}
            </span>
          </div>

          {/* SLA Timer */}
          <div className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2">
            <Timer className="h-4 w-4 text-gray-500" />
            <span className="text-xs text-gray-400">SLA:</span>
            <span className={cn("text-sm font-mono font-bold", sla.color)}>
              {sla.text}
            </span>
          </div>

          {/* Workflow Stepper */}
          <div>
            <h4 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-500">
              Workflow
            </h4>
            <WorkflowStepper currentStatus={incident.status} />
            <div className="mt-2 flex items-center gap-2">
              {nextStatus && (
                <button
                  onClick={() => handleStatusChange(nextStatus)}
                  disabled={statusLoading}
                  className="flex items-center gap-1.5 rounded-lg bg-cyan-900/30 border border-cyan-800/50 px-3 py-1.5 text-xs font-semibold text-cyan-400 hover:bg-cyan-800/40 disabled:opacity-50"
                >
                  {statusLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ArrowRight className="h-3 w-3" />
                  )}
                  Advance to {WORKFLOW_LABELS[nextStatus]}
                </button>
              )}
            </div>
          </div>

          {/* Description */}
          {incident.description && (
            <div>
              <h4 className="mb-1 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                Description
              </h4>
              <p className="text-sm text-gray-300 leading-relaxed">
                {incident.description}
              </p>
            </div>
          )}

          {/* Details */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
              <span className="text-[10px] text-gray-500 uppercase">Zone</span>
              <p className="mt-0.5 text-sm font-medium text-gray-200">
                {incident.zone_name || "---"}
              </p>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
              <span className="text-[10px] text-gray-500 uppercase">
                Assigned To
              </span>
              <p className="mt-0.5 text-sm font-medium text-gray-200">
                {incident.assigned_to || "Unassigned"}
              </p>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
              <span className="text-[10px] text-gray-500 uppercase">
                Created
              </span>
              <p className="mt-0.5 text-sm font-medium text-gray-200">
                {formatTimestamp(incident.created_at)}
              </p>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
              <span className="text-[10px] text-gray-500 uppercase">Type</span>
              <p className="mt-0.5 text-sm font-medium text-gray-200">
                {incident.type}
              </p>
            </div>
          </div>

          {/* Linked Evidence */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
                Linked Evidence
                {linkedEvidence.length > 0 && (
                  <span className="ml-1.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-cyan-900/50 px-1 text-[9px] font-bold text-cyan-400">
                    {linkedEvidence.length}
                  </span>
                )}
              </h4>
              <button
                onClick={() => setShowLinkEvidence(true)}
                className="flex items-center gap-1 text-[10px] text-cyan-400 hover:text-cyan-300 transition-colors"
              >
                <Plus className="h-3 w-3" />
                Add
              </button>
            </div>
            {loadingEvidence ? (
              <div className="flex items-center gap-2 py-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-500" />
                <span className="text-xs text-gray-600">Loading evidence...</span>
              </div>
            ) : linkedEvidence.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-800 bg-gray-900/20 px-4 py-3 text-center">
                <p className="text-xs text-gray-600">No evidence linked yet</p>
                <button
                  onClick={() => setShowLinkEvidence(true)}
                  className="mt-1 text-[11px] text-cyan-500 hover:text-cyan-400"
                >
                  Link evidence now
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                {linkedEvidence.map((ev) => (
                  <div
                    key={ev.id}
                    className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-cyan-500" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-gray-300">
                        {ev.label || ev.id.slice(0, 16)}
                      </p>
                      <p className="text-[10px] text-gray-600 uppercase">{ev.type}</p>
                    </div>
                    {ev.url && (
                      <a
                        href={ev.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 rounded p-1 text-gray-600 hover:text-cyan-400"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Assign */}
          <div>
            <h4 className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-500">
              Assignment
            </h4>
            {showAssignInput ? (
              <div className="flex items-center gap-2">
                <input
                  value={assignInput}
                  onChange={(e) => setAssignInput(e.target.value)}
                  placeholder="Enter user ID or name..."
                  className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none"
                />
                <button
                  onClick={handleAssign}
                  disabled={assignLoading}
                  className="rounded-lg bg-cyan-900/40 border border-cyan-800/50 px-3 py-1.5 text-xs font-semibold text-cyan-400 hover:bg-cyan-800/40 disabled:opacity-50"
                >
                  {assignLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Assign"
                  )}
                </button>
                <button
                  onClick={() => setShowAssignInput(false)}
                  className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-800"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowAssignInput(true)}
                className="flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300"
              >
                <User className="h-3.5 w-3.5" />
                {incident.assigned_to ? "Reassign" : "Assign someone"}
              </button>
            )}
          </div>

          {/* AI Summary */}
          <div>
            <h4 className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-500">
              AI Summary
            </h4>
            {aiSummary ? (
              <div className="rounded-lg border border-purple-900/50 bg-purple-950/20 p-3">
                <p className="text-sm text-purple-300 leading-relaxed">
                  {aiSummary}
                </p>
              </div>
            ) : (
              <button
                onClick={handleAiSummary}
                disabled={aiLoading}
                className="flex items-center gap-1.5 rounded-lg bg-purple-900/30 border border-purple-800/50 px-3 py-1.5 text-xs font-semibold text-purple-400 hover:bg-purple-800/40 disabled:opacity-50"
              >
                {aiLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Brain className="h-3.5 w-3.5" />
                )}
                Generate AI Summary
              </button>
            )}
          </div>

          {/* Timeline */}
          <div>
            <h4 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-500">
              Timeline
            </h4>
            {timeline.length === 0 ? (
              <p className="text-xs text-gray-600">No timeline entries yet.</p>
            ) : (
              <div className="space-y-2">
                {timeline.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-start gap-2 rounded-lg border border-gray-800 bg-gray-900/40 p-2.5"
                  >
                    <div className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-cyan-500" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-gray-200">
                          {entry.action}
                        </span>
                        <span className="text-[10px] text-gray-500">
                          {formatTimestamp(entry.timestamp)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-gray-400">
                        {entry.actor} &mdash; {entry.details}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Link Evidence Modal — layered above the panel */}
      {showLinkEvidence && (
        <LinkEvidenceModal
          incidentId={incident.id}
          onClose={() => setShowLinkEvidence(false)}
          onLinked={() => {
            fetchLinkedEvidence();
            onRefresh();
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  New Incident Modal                                                 */
/* ------------------------------------------------------------------ */

function NewIncidentModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { addToast } = useToast();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState("medium");
  const [type, setType] = useState("security");
  const [zoneName, setZoneName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/api/incidents", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          severity,
          type,
          zone_name: zoneName.trim() || null,
        }),
      });
      addToast("success", "Incident created successfully");
      onCreated();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to create incident";
      setError(msg);
      addToast("error", msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border border-gray-800 bg-[#030712] p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-gray-100">New Incident</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-400">
              Title *
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Incident title..."
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-400">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Describe the incident..."
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700 resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-gray-400">
                Severity
              </label>
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value)}
                className="w-full appearance-none rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-300 focus:border-cyan-700 focus:outline-none"
              >
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-gray-400">
                Type
              </label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full appearance-none rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-300 focus:border-cyan-700 focus:outline-none"
              >
                <option value="security">Security</option>
                <option value="safety">Safety</option>
                <option value="access_control">Access Control</option>
                <option value="environmental">Environmental</option>
                <option value="equipment">Equipment</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-400">
              Zone
            </label>
            <input
              value={zoneName}
              onChange={(e) => setZoneName(e.target.value)}
              placeholder="Zone name (optional)..."
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-700 px-4 py-2 text-xs font-medium text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-4 py-2 text-xs font-bold text-white hover:bg-cyan-500 disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Create Incident
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function IncidentManagementPage() {
  const { addToast } = useToast();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [stats, setStats] = useState<IncidentStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filterStatus, setFilterStatus] = useState("all");
  const [filterSeverity, setFilterSeverity] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);
  // Track which incident row triggered the link-evidence modal (from table)
  const [linkEvidenceRowId, setLinkEvidenceRowId] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  /* --- Fetch --- */
  const fetchStats = useCallback(() => {
    apiFetch<IncidentStats>("/api/incidents/stats")
      .then(setStats)
      .catch(() => {});
  }, []);

  const fetchIncidents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterStatus !== "all") params.set("status", filterStatus);
      if (filterSeverity !== "all") params.set("severity", filterSeverity);
      if (searchQuery.trim()) params.set("q", searchQuery.trim());
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));

      const data = await apiFetch<Incident[]>(
        `/api/incidents?${params.toString()}`
      );
      setIncidents(data);
      setHasMore(data.length === PAGE_SIZE);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch incidents");
      setIncidents([]);
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterSeverity, searchQuery, page]);

  useEffect(() => {
    fetchStats();
    fetchIncidents();
  }, [fetchStats, fetchIncidents]);

  useEffect(() => {
    setPage(1);
  }, [filterStatus, filterSeverity, searchQuery]);

  const handleRefresh = () => {
    fetchStats();
    fetchIncidents();
    if (selectedIncident) {
      apiFetch<Incident>(`/api/incidents/${selectedIncident.id}`)
        .then((updated) => setSelectedIncident(updated))
        .catch(() => {});
    }
  };

  const sev = (s: string) => SEVERITY_COLORS[s] || "text-gray-400 bg-gray-800 border-gray-700";
  const stat = (s: string) => STATUS_COLORS[s] || "text-gray-400 bg-gray-800";

  const linkEvidenceIncident = linkEvidenceRowId
    ? incidents.find((i) => i.id === linkEvidenceRowId) ?? null
    : null;

  return (
    <div className="flex h-full flex-col bg-[#030712]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-900/30 border border-red-800/50">
            <Shield className="h-5 w-5 text-red-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Incident Management
            </h1>
            <p className="text-xs text-gray-500">
              Track, manage, and resolve security incidents
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowNewModal(true)}
          className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-4 py-2 text-xs font-bold text-white hover:bg-cyan-500 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Incident
        </button>
      </div>

      {/* Stats Bar */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 border-b border-gray-800 px-6 py-3">
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 p-3">
            <AlertTriangle className="h-5 w-5 text-red-400" />
            <div>
              <p className="text-lg font-bold text-gray-100">{stats.open}</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                Open Incidents
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-red-900/50 bg-red-950/20 p-3">
            <Timer className="h-5 w-5 text-red-500" />
            <div>
              <p className="text-lg font-bold text-red-400">
                {stats.sla_breaches}
              </p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                SLA Breaches
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 p-3">
            <CheckCircle2 className="h-5 w-5 text-green-400" />
            <div>
              <p className="text-lg font-bold text-gray-100">
                {stats.resolved_today}
              </p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                Resolved Today
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 p-3">
            <TrendingUp className="h-5 w-5 text-cyan-400" />
            <div>
              <p className="text-lg font-bold text-gray-100">
                {stats.avg_response_time_minutes}m
              </p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                Avg Response
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-800 px-6 py-3">
        <div className="relative">
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          >
            <option value="all">All Statuses</option>
            {WORKFLOW_STEPS.map((s) => (
              <option key={s} value={s}>
                {WORKFLOW_LABELS[s]}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
        </div>

        <div className="relative">
          <select
            value={filterSeverity}
            onChange={(e) => setFilterSeverity(e.target.value)}
            className="appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          >
            <option value="all">All Severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
        </div>

        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search incidents..."
            className="w-full rounded-lg border border-gray-700 bg-gray-900 pl-9 pr-3 py-2 text-xs text-gray-300 placeholder:text-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          />
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {loading && (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
            <p className="mt-3 text-sm text-gray-500">Loading incidents...</p>
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center justify-center py-20">
            <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={fetchIncidents}
              className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && incidents.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20">
            <CheckCircle2 className="mb-2 h-10 w-10 text-emerald-700" />
            <p className="text-sm font-medium text-gray-400">
              No incidents found
            </p>
            <p className="mt-1 text-xs text-gray-600">
              Adjust your filters or create a new incident
            </p>
          </div>
        )}

        {!loading && !error && incidents.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-zinc-900/90 backdrop-blur">
              <tr className="border-b border-gray-800 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                <th className="px-6 py-3">Title</th>
                <th className="px-3 py-3">Severity</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Type</th>
                <th className="px-3 py-3">Zone</th>
                <th className="px-3 py-3">Assigned</th>
                <th className="px-3 py-3">SLA</th>
                <th className="px-3 py-3">Evidence</th>
                <th className="px-3 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((inc) => {
                const slaInfo = slaTimeRemaining(inc.sla_deadline);
                return (
                  <tr
                    key={inc.id}
                    onClick={() => setSelectedIncident(inc)}
                    className={cn(
                      "border-b border-gray-800/50 cursor-pointer transition-colors hover:bg-zinc-900/70",
                      selectedIncident?.id === inc.id && "bg-zinc-900/90"
                    )}
                  >
                    <td className="px-6 py-3">
                      <span className="font-medium text-gray-200 truncate block max-w-[240px]">
                        {inc.title}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={cn(
                          "rounded px-2 py-0.5 text-[10px] font-bold uppercase border",
                          sev(inc.severity)
                        )}
                      >
                        {inc.severity}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={cn(
                          "rounded px-2 py-0.5 text-[10px] font-semibold uppercase",
                          stat(inc.status)
                        )}
                      >
                        {inc.status.replace("_", " ")}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-xs text-gray-400">
                      {inc.type}
                    </td>
                    <td className="px-3 py-3">
                      <span className="flex items-center gap-1 text-xs text-gray-400">
                        <MapPin className="h-3 w-3" />
                        {inc.zone_name || "---"}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <span className="flex items-center gap-1 text-xs text-gray-400">
                        <User className="h-3 w-3" />
                        {inc.assigned_to || "Unassigned"}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={cn(
                          "flex items-center gap-1 text-xs font-mono font-semibold",
                          slaInfo.color
                        )}
                      >
                        <Timer className="h-3 w-3" />
                        {slaInfo.text}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setLinkEvidenceRowId(inc.id);
                        }}
                        className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-gray-400 hover:bg-gray-800 hover:text-cyan-400 transition-colors"
                        title="Link Evidence"
                      >
                        <Paperclip className="h-3 w-3" />
                        {inc.evidence_count != null && inc.evidence_count > 0 ? (
                          <span className="font-semibold text-cyan-400">{inc.evidence_count}</span>
                        ) : (
                          <span className="text-gray-600">Link</span>
                        )}
                      </button>
                    </td>
                    <td className="px-3 py-3">
                      <span className="flex items-center gap-1 text-[11px] text-gray-500">
                        <Clock className="h-3 w-3" />
                        {timeAgo(inc.created_at)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {!loading && !error && incidents.length > 0 && (
        <div className="flex items-center justify-between border-t border-gray-800 px-6 py-3">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs font-medium text-gray-400 hover:bg-gray-800 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          <span className="text-xs text-gray-500">
            Page <span className="font-semibold text-gray-300">{page}</span>
          </span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={!hasMore}
            className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs font-medium text-gray-400 hover:bg-gray-800 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      )}

      {/* Detail Panel */}
      {selectedIncident && (
        <IncidentDetailPanel
          incident={selectedIncident}
          onClose={() => setSelectedIncident(null)}
          onRefresh={handleRefresh}
        />
      )}

      {/* New Incident Modal */}
      {showNewModal && (
        <NewIncidentModal
          onClose={() => setShowNewModal(false)}
          onCreated={handleRefresh}
        />
      )}

      {/* Link Evidence Modal (from table row) */}
      {linkEvidenceIncident && (
        <LinkEvidenceModal
          incidentId={linkEvidenceIncident.id}
          onClose={() => setLinkEvidenceRowId(null)}
          onLinked={() => {
            handleRefresh();
            addToast("success", `Evidence linked to "${linkEvidenceIncident.title}"`);
          }}
        />
      )}
    </div>
  );
}
