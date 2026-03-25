"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  FolderOpen,
  Plus,
  Clock,
  Tag,
  Loader2,
  Play,
  FileText,
  X,
  CheckCircle2,
  Archive,
  Search as SearchIcon,
  Brain,
  ChevronDown,
  ChevronRight,
  Shield,
  Target,
  Activity,
  GitBranch,
  Microscope,
  AlertTriangle,
  Users,
  MapPin,
  ListChecks,
  Layers,
  StickyNote,
  Sparkles,
  BarChart3,
  Link2,
  TrendingDown,
  TrendingUp,
  Hash,
} from "lucide-react";
import { cn, apiFetch, severityColor, formatTimestamp } from "@/lib/utils";
import type {
  Case,
  CaseEvidence,
  InvestigationRun,
  Severity,
} from "@/lib/types";

/* ─── Constants ─────────────────────────────────────────────── */

const STATUS_COLORS: Record<string, string> = {
  open: "bg-blue-900/40 text-blue-400 border-blue-800",
  investigating: "bg-amber-900/40 text-amber-400 border-amber-800",
  closed: "bg-emerald-900/40 text-emerald-400 border-emerald-800",
  archived: "bg-gray-800 text-gray-500 border-gray-700",
};

const STATUS_TABS = ["all", "open", "investigating", "closed", "archived"] as const;
const PRIORITY_OPTIONS: Severity[] = ["critical", "high", "medium", "low"];

const AGENT_TYPES = [
  {
    id: "general",
    label: "General Analysis",
    icon: Brain,
    desc: "Comprehensive multi-step investigation with semantic search, frame analysis, and correlation",
  },
  {
    id: "threat_analyzer",
    label: "Threat Analysis",
    icon: Shield,
    desc: "Focused threat assessment — evaluates risk level, attack vectors, and recommended countermeasures",
  },
  {
    id: "timeline_builder",
    label: "Timeline Builder",
    icon: Clock,
    desc: "Constructs chronological incident timeline from all correlated events",
  },
  {
    id: "correlation_engine",
    label: "Correlation Engine",
    icon: GitBranch,
    desc: "Cross-camera subject tracking — finds the same entities across multiple camera feeds",
  },
  {
    id: "forensic_agent",
    label: "Forensic Agent",
    icon: Microscope,
    desc: "Deep forensic frame analysis — person descriptions, vehicle IDs, evidence markers",
  },
] as const;

interface CaseWithDetails extends Case {
  evidence?: CaseEvidence[];
  investigations?: InvestigationRun[];
}

/* ─── Page ──────────────────────────────────────────────────── */

export default function CasesPage() {
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CaseWithDetails | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Full-text search
  const [searchQuery, setSearchQuery] = useState("");

  // New case form
  const [showNewForm, setShowNewForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newPriority, setNewPriority] = useState<Severity>("medium");
  const [newTags, setNewTags] = useState("");

  // Investigation launcher
  const [investigationQuery, setInvestigationQuery] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("general");
  const [launching, setLaunching] = useState(false);

  // Investigation results
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [activeFindings, setActiveFindings] = useState<Record<string, any> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [activeSteps, setActiveSteps] = useState<{ action: string; result: Record<string, any>; timestamp: string }[] | null>(null);
  const [stepsExpanded, setStepsExpanded] = useState(false);

  // Add evidence note
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  // Polling
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ─── Data fetching ───────────────────────────────────────── */

  const fetchCases = useCallback(async () => {
    try {
      const url =
        statusFilter !== "all"
          ? `/api/cases?status=${statusFilter}`
          : "/api/cases";
      const data = await apiFetch<Case[]>(url);
      setCases(data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchCases();
  }, [fetchCases]);

  const loadDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      setActiveRunId(null);
      setActiveFindings(null);
      setActiveSteps(null);
      try {
        const [caseData, evidence, investigations] = await Promise.all([
          apiFetch<Case>(`/api/cases/${id}`),
          apiFetch<CaseEvidence[]>(`/api/cases/${id}/evidence`),
          apiFetch<InvestigationRun[]>(`/api/cases/${id}/investigations`).catch(
            () => []
          ),
        ]);
        const d: CaseWithDetails = { ...caseData, evidence, investigations };
        setDetail(d);
        setInvestigationQuery(
          caseData.title +
            (caseData.description ? `. ${caseData.description}` : "")
        );

        // If latest investigation completed, show its findings
        if (investigations.length > 0) {
          const latest = investigations[0];
          setActiveRunId(latest.id);
          if (latest.findings) setActiveFindings(latest.findings);
          if (latest.steps) setActiveSteps(latest.steps);
        }
      } catch {
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    []
  );

  const selectCase = useCallback(
    (id: string) => {
      if (selectedId === id) return;
      setSelectedId(id);
      loadDetail(id);
    },
    [selectedId, loadDetail]
  );

  /* ─── Polling for running investigations ──────────────────── */

  const pollInvestigations = useCallback(async () => {
    if (!selectedId) return;
    try {
      const investigations = await apiFetch<InvestigationRun[]>(
        `/api/cases/${selectedId}/investigations`
      );
      const hasRunning = investigations.some((r) => r.status === "running");

      setDetail((prev) =>
        prev ? { ...prev, investigations } : prev
      );

      // If we have a completed investigation, update findings
      if (investigations.length > 0) {
        const latest = investigations[0];
        setActiveRunId(latest.id);
        if (latest.findings) setActiveFindings(latest.findings);
        if (latest.steps) setActiveSteps(latest.steps);
      }

      // Also refresh case data (summary might have been updated)
      if (!hasRunning) {
        const caseData = await apiFetch<Case>(`/api/cases/${selectedId}`);
        setDetail((prev) => (prev ? { ...prev, ...caseData } : prev));
        setCases((prev) =>
          prev.map((c) => (c.id === selectedId ? { ...c, ...caseData } : c))
        );
      }

      // Stop polling if no running investigations
      if (!hasRunning && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch {
      /* ignore */
    }
  }, [selectedId]);

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(pollInvestigations, 3000);
  }, [pollInvestigations]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  /* ─── Actions ─────────────────────────────────────────────── */

  const createCase = useCallback(async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const tags = newTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const created = await apiFetch<Case>("/api/cases", {
        method: "POST",
        body: JSON.stringify({
          title: newTitle,
          description: newDescription || null,
          priority: newPriority,
          tags: tags.length ? tags : null,
        }),
      });
      setCases((prev) => [created, ...prev]);
      setShowNewForm(false);
      setNewTitle("");
      setNewDescription("");
      setNewPriority("medium");
      setNewTags("");
      selectCase(created.id);
    } catch {
      /* ignore */
    } finally {
      setCreating(false);
    }
  }, [newTitle, newDescription, newPriority, newTags, selectCase]);

  const updateStatus = useCallback(
    async (id: string, status: string) => {
      try {
        const updated = await apiFetch<Case>(`/api/cases/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ status }),
        });
        setCases((prev) => prev.map((c) => (c.id === id ? updated : c)));
        setDetail((prev) =>
          prev?.id === id ? { ...prev, ...updated } : prev
        );
      } catch {
        /* ignore */
      }
    },
    []
  );

  const launchInvestigation = useCallback(async () => {
    if (!selectedId || !investigationQuery.trim()) return;
    setLaunching(true);
    try {
      await apiFetch(`/api/cases/${selectedId}/investigate`, {
        method: "POST",
        body: JSON.stringify({
          case_id: selectedId,
          agent_type: selectedAgent,
          query: investigationQuery,
          input_params: { query: investigationQuery },
        }),
      });
      // Start polling for results
      startPolling();
      // Refresh investigations list
      const investigations = await apiFetch<InvestigationRun[]>(
        `/api/cases/${selectedId}/investigations`
      );
      setDetail((prev) =>
        prev ? { ...prev, investigations } : prev
      );
      // Update case in list (status → investigating)
      await fetchCases();
    } catch {
      /* ignore */
    } finally {
      setLaunching(false);
    }
  }, [selectedId, investigationQuery, selectedAgent, startPolling, fetchCases]);

  const addEvidenceNote = useCallback(async () => {
    if (!selectedId || !noteTitle.trim()) return;
    setAddingNote(true);
    try {
      await apiFetch(`/api/cases/${selectedId}/evidence`, {
        method: "POST",
        body: JSON.stringify({
          evidence_type: "note",
          title: noteTitle,
          content: noteContent || null,
        }),
      });
      setNoteTitle("");
      setNoteContent("");
      setShowNoteForm(false);
      // Refresh evidence
      const evidence = await apiFetch<CaseEvidence[]>(
        `/api/cases/${selectedId}/evidence`
      );
      setDetail((prev) => (prev ? { ...prev, evidence } : prev));
    } catch {
      /* ignore */
    } finally {
      setAddingNote(false);
    }
  }, [selectedId, noteTitle, noteContent]);

  /* ─── Derived ─────────────────────────────────────────────── */

  const hasRunning =
    detail?.investigations?.some((r) => r.status === "running") || false;

  // Case metrics summary
  const caseMetrics = useMemo(() => {
    const total = cases.length;
    const openCount = cases.filter((c) => c.status === "open" || c.status === "investigating").length;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentlyClosed = cases.filter(
      (c) => c.status === "closed" && c.closed_at && new Date(c.closed_at).getTime() >= sevenDaysAgo
    ).length;
    // Evidence count from detail panel evidence list — only per-loaded case available client-side
    // We show the total from what we have
    return { total, openCount, recentlyClosed };
  }, [cases]);

  // Full-text case filter
  const filteredCases = useMemo(() => {
    if (!searchQuery.trim()) return cases;
    const q = searchQuery.toLowerCase();
    return cases.filter((c) =>
      c.title.toLowerCase().includes(q) ||
      (c.description ?? "").toLowerCase().includes(q) ||
      (c.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  }, [cases, searchQuery]);

  // Related cases for current detail
  const relatedCases = useMemo(() => {
    if (!detail) return [];
    const keywords = [detail.title, detail.description ?? ""]
      .join(" ")
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    return cases
      .filter((c) => {
        if (c.id === detail.id) return false;
        const haystack = `${c.title} ${c.description ?? ""}`.toLowerCase();
        return keywords.some((kw) => haystack.includes(kw));
      })
      .slice(0, 5);
  }, [cases, detail]);

  // Auto-start polling if there's a running investigation when we load
  useEffect(() => {
    if (hasRunning && !pollRef.current) {
      startPolling();
    }
  }, [hasRunning, startPolling]);

  const selectedAgentInfo = AGENT_TYPES.find((a) => a.id === selectedAgent);

  /* ─── Render ──────────────────────────────────────────────── */

  return (
    <div className="flex h-screen bg-gray-950 overflow-hidden">
      {/* ─── LEFT PANEL: Case List ──────────────────────────── */}
      <div
        className={cn(
          "flex flex-col border-r border-gray-800 bg-gray-950 transition-all",
          selectedId ? "w-80 shrink-0" : "w-full"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 p-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-900/30 border border-violet-800/50">
              <FolderOpen className="h-4 w-4 text-violet-400" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-gray-100">
                Case Management
              </h1>
              <p className="text-[10px] text-gray-500">
                {cases.length} case{cases.length !== 1 ? "s" : ""}
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowNewForm(!showNewForm)}
            className="flex items-center gap-1 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-violet-500"
          >
            <Plus className="h-3 w-3" />
            New
          </button>
        </div>

        {/* Case Metrics Summary */}
        {!loading && cases.length > 0 && (
          <div className="grid grid-cols-3 gap-px border-b border-gray-800 bg-gray-800">
            <div className="flex flex-col items-center justify-center bg-gray-950 py-2 px-1 gap-0.5">
              <span className="text-base font-bold text-white tabular-nums">{caseMetrics.total}</span>
              <span className="text-[9px] uppercase tracking-wider text-gray-500 flex items-center gap-0.5">
                <Hash className="w-2.5 h-2.5" /> Total
              </span>
            </div>
            <div className="flex flex-col items-center justify-center bg-gray-950 py-2 px-1 gap-0.5">
              <span className="text-base font-bold text-blue-400 tabular-nums">{caseMetrics.openCount}</span>
              <span className="text-[9px] uppercase tracking-wider text-gray-500 flex items-center gap-0.5">
                <TrendingUp className="w-2.5 h-2.5" /> Open
              </span>
            </div>
            <div className="flex flex-col items-center justify-center bg-gray-950 py-2 px-1 gap-0.5">
              <span className="text-base font-bold text-emerald-400 tabular-nums">{caseMetrics.recentlyClosed}</span>
              <span className="text-[9px] uppercase tracking-wider text-gray-500 flex items-center gap-0.5">
                <TrendingDown className="w-2.5 h-2.5" /> Closed 7d
              </span>
            </div>
          </div>
        )}

        {/* Full-text search */}
        <div className="border-b border-gray-800 px-3 py-2">
          <div className="relative">
            <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-600 pointer-events-none" />
            <input
              type="text"
              placeholder="Search cases…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded border border-gray-800 bg-gray-900 pl-6 pr-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:border-violet-600 focus:outline-none"
            />
            {searchQuery && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-gray-500 tabular-nums">
                {filteredCases.length} match{filteredCases.length !== 1 ? "es" : ""}
              </span>
            )}
          </div>
        </div>

        {/* Status Tabs */}
        <div className="flex gap-1 border-b border-gray-800 px-3 py-2">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setStatusFilter(tab)}
              className={cn(
                "rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors",
                statusFilter === tab
                  ? "bg-violet-900/40 text-violet-400"
                  : "text-gray-500 hover:text-gray-300 hover:bg-gray-800"
              )}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* New Case Form */}
        {showNewForm && (
          <div className="border-b border-gray-800 p-3 space-y-2">
            <input
              type="text"
              placeholder="Case title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-100 placeholder-gray-500 focus:border-violet-600 focus:outline-none"
            />
            <textarea
              placeholder="Description (optional)"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              rows={2}
              className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-100 placeholder-gray-500 focus:border-violet-600 focus:outline-none resize-none"
            />
            <div className="flex gap-2">
              <select
                value={newPriority}
                onChange={(e) => setNewPriority(e.target.value as Severity)}
                className="rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-100 focus:border-violet-600 focus:outline-none"
              >
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Tags (comma-separated)"
                value={newTags}
                onChange={(e) => setNewTags(e.target.value)}
                className="flex-1 rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-100 placeholder-gray-500 focus:border-violet-600 focus:outline-none"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowNewForm(false)}
                className="rounded px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={createCase}
                disabled={creating || !newTitle.trim()}
                className="flex items-center gap-1 rounded bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
              >
                {creating && <Loader2 className="h-3 w-3 animate-spin" />}
                Create
              </button>
            </div>
          </div>
        )}

        {/* Case List */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-violet-400" />
            </div>
          )}

          {!loading && filteredCases.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center px-4">
              <FolderOpen className="mb-2 h-8 w-8 text-gray-700" />
              <p className="text-xs text-gray-500">
                {searchQuery ? `No cases match "${searchQuery}"` : "No cases found"}
              </p>
            </div>
          )}

          {filteredCases.map((c) => (
            <button
              key={c.id}
              onClick={() => selectCase(c.id)}
              className={cn(
                "w-full border-b border-gray-800/50 p-3 text-left transition-colors",
                selectedId === c.id
                  ? "bg-violet-900/20 border-l-2 border-l-violet-500"
                  : "hover:bg-gray-900/60"
              )}
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={cn(
                    "inline-flex shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider border",
                    STATUS_COLORS[c.status] || STATUS_COLORS.open
                  )}
                >
                  {c.status}
                </span>
                <span
                  className={cn(
                    "inline-flex shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                    severityColor(c.priority)
                  )}
                >
                  {c.priority}
                </span>
              </div>
              <p className="text-xs font-medium text-gray-200 truncate">
                {c.title}
              </p>
              <div className="flex items-center gap-2 mt-1">
                {c.tags &&
                  c.tags.slice(0, 2).map((tag) => (
                    <span
                      key={tag}
                      className="rounded bg-gray-800 px-1.5 py-0.5 text-[9px] text-gray-500"
                    >
                      {tag}
                    </span>
                  ))}
                <span className="ml-auto text-[9px] text-gray-600 font-mono">
                  {formatTimestamp(c.created_at)}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ─── RIGHT PANEL: Case Detail & Investigation ───────── */}
      {selectedId && (
        <div className="flex-1 overflow-y-auto">
          {detailLoading && (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
            </div>
          )}

          {!detailLoading && detail && (
            <div className="p-6 space-y-6 max-w-5xl mx-auto">
              {/* Header */}
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <h2 className="text-lg font-bold text-gray-100">
                    {detail.title}
                  </h2>
                  {detail.description && (
                    <p className="mt-1 text-sm text-gray-400 leading-relaxed">
                      {detail.description}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={cn(
                      "rounded px-2 py-1 text-[10px] font-bold uppercase border",
                      STATUS_COLORS[detail.status]
                    )}
                  >
                    {detail.status}
                  </span>
                  <span
                    className={cn(
                      "rounded px-2 py-1 text-[10px] font-bold uppercase",
                      severityColor(detail.priority)
                    )}
                  >
                    {detail.priority}
                  </span>
                </div>
              </div>

              {/* Investigation Milestones Progress Bar */}
              <InvestigationMilestones status={detail.status} />

              {/* Status Transitions */}
              <div className="flex items-center gap-2 flex-wrap">
                {detail.status === "open" && (
                  <button
                    onClick={() => updateStatus(detail.id, "investigating")}
                    className="flex items-center gap-1 rounded px-3 py-1.5 text-xs font-medium bg-amber-900/30 text-amber-400 border border-amber-800/50 hover:bg-amber-900/50"
                  >
                    <SearchIcon className="h-3 w-3" />
                    Start Investigation
                  </button>
                )}
                {detail.status === "investigating" && (
                  <button
                    onClick={() => updateStatus(detail.id, "closed")}
                    className="flex items-center gap-1 rounded px-3 py-1.5 text-xs font-medium bg-emerald-900/30 text-emerald-400 border border-emerald-800/50 hover:bg-emerald-900/50"
                  >
                    <CheckCircle2 className="h-3 w-3" />
                    Close Case
                  </button>
                )}
                {detail.status === "closed" && (
                  <button
                    onClick={() => updateStatus(detail.id, "archived")}
                    className="flex items-center gap-1 rounded px-3 py-1.5 text-xs font-medium bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700"
                  >
                    <Archive className="h-3 w-3" />
                    Archive
                  </button>
                )}
                <button
                  onClick={() => {
                    setSelectedId(null);
                    setDetail(null);
                  }}
                  className="ml-auto flex items-center gap-1 rounded px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-800"
                >
                  <X className="h-3 w-3" />
                  Close
                </button>
              </div>

              {/* ─── AI Summary (from completed investigations) ─── */}
              {detail.summary && (
                <div className="rounded-lg border border-violet-800/30 bg-violet-900/10 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Sparkles className="h-4 w-4 text-violet-400" />
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-violet-400">
                      AI Case Summary
                    </h3>
                  </div>
                  <p className="text-sm leading-relaxed text-gray-300">
                    {detail.summary}
                  </p>
                </div>
              )}

              {/* ─── Investigation Launcher ─────────────────────── */}
              <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-5">
                <div className="flex items-center gap-2 mb-4">
                  <Brain className="h-5 w-5 text-violet-400" />
                  <h3 className="text-sm font-bold text-gray-100">
                    AI Investigation
                  </h3>
                  {hasRunning && (
                    <span className="flex items-center gap-1 ml-2 rounded-full bg-cyan-900/40 px-2.5 py-0.5 text-[10px] font-semibold text-cyan-400 border border-cyan-800/50">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Running
                    </span>
                  )}
                </div>

                {/* Query */}
                <textarea
                  placeholder="What should the AI investigate? (e.g., 'Suspicious person near loading dock between 2-4 AM')"
                  value={investigationQuery}
                  onChange={(e) => setInvestigationQuery(e.target.value)}
                  rows={2}
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-600 resize-none mb-3"
                />

                {/* Agent Type Selector */}
                <div className="grid grid-cols-5 gap-2 mb-4">
                  {AGENT_TYPES.map((agent) => {
                    const Icon = agent.icon;
                    return (
                      <button
                        key={agent.id}
                        onClick={() => setSelectedAgent(agent.id)}
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-lg border p-3 transition-all text-center",
                          selectedAgent === agent.id
                            ? "border-violet-600 bg-violet-900/30 text-violet-400"
                            : "border-gray-700 bg-gray-800/50 text-gray-500 hover:border-gray-600 hover:text-gray-300"
                        )}
                      >
                        <Icon className="h-4 w-4" />
                        <span className="text-[10px] font-semibold leading-tight">
                          {agent.label}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {selectedAgentInfo && (
                  <p className="text-[11px] text-gray-500 mb-3">
                    {selectedAgentInfo.desc}
                  </p>
                )}

                {/* Launch Button */}
                <button
                  onClick={launchInvestigation}
                  disabled={
                    launching ||
                    hasRunning ||
                    !investigationQuery.trim()
                  }
                  className="flex items-center gap-2 rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {launching || hasRunning ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  {hasRunning
                    ? "Investigation Running..."
                    : "Launch Investigation"}
                </button>
              </div>

              {/* ─── Investigation Results ──────────────────────── */}
              {activeFindings && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <BarChart3 className="h-5 w-5 text-violet-400" />
                    <h3 className="text-sm font-bold text-gray-100">
                      Investigation Results
                    </h3>
                  </div>

                  {/* Incident Summary */}
                  {activeFindings.incident_summary && (
                    <div className="rounded-lg border border-cyan-800/30 bg-cyan-900/10 p-4">
                      <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-cyan-400">
                        <Target className="h-3.5 w-3.5" />
                        Incident Summary
                      </h4>
                      <p className="text-sm leading-relaxed text-gray-300">
                        {activeFindings.incident_summary}
                      </p>
                    </div>
                  )}

                  {/* Key Findings + Risk Assessment Row */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {/* Key Findings */}
                    {activeFindings.key_findings &&
                      (activeFindings.key_findings as string[]).length > 0 && (
                        <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
                          <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-400">
                            <ListChecks className="h-3.5 w-3.5" />
                            Key Findings
                          </h4>
                          <ol className="space-y-2">
                            {(activeFindings.key_findings as string[]).map(
                              (finding: string, i: number) => (
                                <li
                                  key={i}
                                  className="flex items-start gap-2 text-sm text-gray-300"
                                >
                                  <span className="shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-amber-900/30 text-[10px] font-bold text-amber-400 mt-0.5">
                                    {i + 1}
                                  </span>
                                  <span className="leading-relaxed">{finding}</span>
                                </li>
                              )
                            )}
                          </ol>
                        </div>
                      )}

                    {/* Risk Assessment */}
                    {activeFindings.risk_assessment && (
                      <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
                        <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-red-400">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          Risk Assessment
                        </h4>
                        {typeof activeFindings.risk_assessment === "string" ? (
                          <p className="text-sm leading-relaxed text-gray-300">
                            {activeFindings.risk_assessment}
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {activeFindings.risk_assessment.level && (
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-gray-500">
                                  Level:
                                </span>
                                <span
                                  className={cn(
                                    "rounded px-2 py-0.5 text-xs font-bold uppercase",
                                    (
                                      activeFindings.risk_assessment
                                        .level as string
                                    )
                                      ?.toLowerCase()
                                      .includes("critical") ||
                                      (
                                        activeFindings.risk_assessment
                                          .level as string
                                      )
                                        ?.toLowerCase()
                                        .includes("high")
                                      ? "bg-red-900/40 text-red-400"
                                      : (
                                          activeFindings.risk_assessment
                                            .level as string
                                        )
                                          ?.toLowerCase()
                                          .includes("medium")
                                      ? "bg-amber-900/40 text-amber-400"
                                      : "bg-emerald-900/40 text-emerald-400"
                                  )}
                                >
                                  {activeFindings.risk_assessment.level}
                                </span>
                              </div>
                            )}
                            {activeFindings.risk_assessment.score != null && (
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-gray-500">
                                  Score:
                                </span>
                                <div className="flex-1 h-2 rounded-full bg-gray-700 overflow-hidden">
                                  <div
                                    className={cn(
                                      "h-full rounded-full",
                                      Number(
                                        activeFindings.risk_assessment.score
                                      ) > 70
                                        ? "bg-red-500"
                                        : Number(
                                            activeFindings.risk_assessment.score
                                          ) > 40
                                        ? "bg-amber-500"
                                        : "bg-emerald-500"
                                    )}
                                    style={{
                                      width: `${Math.min(100, Number(activeFindings.risk_assessment.score))}%`,
                                    }}
                                  />
                                </div>
                                <span className="text-xs font-mono text-gray-400">
                                  {activeFindings.risk_assessment.score}/100
                                </span>
                              </div>
                            )}
                            {activeFindings.risk_assessment.summary && (
                              <p className="text-xs leading-relaxed text-gray-400 mt-2">
                                {activeFindings.risk_assessment.summary}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Timeline Narrative */}
                  {activeFindings.timeline_narrative && (
                    <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
                      <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-blue-400">
                        <Activity className="h-3.5 w-3.5" />
                        Timeline Narrative
                      </h4>
                      <p className="text-sm leading-relaxed text-gray-300 whitespace-pre-line">
                        {activeFindings.timeline_narrative}
                      </p>
                    </div>
                  )}

                  {/* Subjects Involved */}
                  {activeFindings.subjects_involved &&
                    (activeFindings.subjects_involved as string[]).length >
                      0 && (
                      <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
                        <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-purple-400">
                          <Users className="h-3.5 w-3.5" />
                          Subjects Involved
                        </h4>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {(activeFindings.subjects_involved as string[]).map(
                            (subject: string, i: number) => (
                              <div
                                key={i}
                                className="flex items-start gap-2 rounded-lg border border-gray-700 bg-gray-800/50 p-3"
                              >
                                <Users className="h-4 w-4 shrink-0 text-purple-400 mt-0.5" />
                                <span className="text-xs text-gray-300 leading-relaxed">
                                  {subject}
                                </span>
                              </div>
                            )
                          )}
                        </div>
                      </div>
                    )}

                  {/* Cross-Camera Correlations */}
                  {activeFindings.correlation &&
                    (
                      activeFindings.correlation
                        .cross_camera_matches as Array<{
                        camera_a: string;
                        camera_b: string;
                        similarity: number;
                        event_a: string;
                        event_b: string;
                      }>
                    )?.length > 0 && (
                      <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
                        <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-teal-400">
                          <MapPin className="h-3.5 w-3.5" />
                          Cross-Camera Correlations
                        </h4>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-gray-500 border-b border-gray-700">
                                <th className="text-left py-2 pr-3">Camera A</th>
                                <th className="text-left py-2 pr-3">Camera B</th>
                                <th className="text-left py-2 pr-3">
                                  Similarity
                                </th>
                                <th className="text-left py-2">Events</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(
                                activeFindings.correlation
                                  .cross_camera_matches as Array<{
                                  camera_a: string;
                                  camera_b: string;
                                  similarity: number;
                                  event_a: string;
                                  event_b: string;
                                }>
                              ).map(
                                (
                                  match: {
                                    camera_a: string;
                                    camera_b: string;
                                    similarity: number;
                                    event_a: string;
                                    event_b: string;
                                  },
                                  i: number
                                ) => (
                                  <tr
                                    key={i}
                                    className="border-b border-gray-800"
                                  >
                                    <td className="py-2 pr-3 font-mono text-gray-400">
                                      {(match.camera_a || "").slice(0, 8)}...
                                    </td>
                                    <td className="py-2 pr-3 font-mono text-gray-400">
                                      {(match.camera_b || "").slice(0, 8)}...
                                    </td>
                                    <td className="py-2 pr-3">
                                      <span
                                        className={cn(
                                          "rounded px-1.5 py-0.5 font-bold",
                                          match.similarity > 0.8
                                            ? "bg-emerald-900/40 text-emerald-400"
                                            : match.similarity > 0.5
                                            ? "bg-amber-900/40 text-amber-400"
                                            : "bg-gray-800 text-gray-500"
                                        )}
                                      >
                                        {(match.similarity * 100).toFixed(0)}%
                                      </span>
                                    </td>
                                    <td className="py-2 font-mono text-gray-500">
                                      {(match.event_a || "").slice(0, 8)}
                                      {" ↔ "}
                                      {(match.event_b || "").slice(0, 8)}
                                    </td>
                                  </tr>
                                )
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                  {/* Recommended Actions */}
                  {activeFindings.recommended_actions &&
                    (activeFindings.recommended_actions as string[]).length >
                      0 && (
                      <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
                        <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-400">
                          <ListChecks className="h-3.5 w-3.5" />
                          Recommended Actions
                        </h4>
                        <ul className="space-y-2">
                          {(activeFindings.recommended_actions as string[]).map(
                            (action: string, i: number) => (
                              <li
                                key={i}
                                className="flex items-start gap-2 text-xs text-gray-300"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500 mt-0.5" />
                                <span>{action}</span>
                              </li>
                            )
                          )}
                        </ul>
                      </div>
                    )}

                  {/* Pipeline Steps (collapsible) */}
                  {activeSteps && activeSteps.length > 0 && (
                    <div className="rounded-lg border border-gray-800 bg-gray-900/60">
                      <button
                        onClick={() => setStepsExpanded(!stepsExpanded)}
                        className="flex w-full items-center gap-2 p-4 text-left"
                      >
                        {stepsExpanded ? (
                          <ChevronDown className="h-4 w-4 text-gray-500" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-gray-500" />
                        )}
                        <Layers className="h-3.5 w-3.5 text-gray-500" />
                        <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                          Investigation Pipeline ({activeSteps.length} steps)
                        </span>
                      </button>
                      {stepsExpanded && (
                        <div className="border-t border-gray-800 p-4 space-y-3">
                          {activeSteps.map((step, i) => (
                            <div
                              key={i}
                              className="flex items-start gap-3 text-xs"
                            >
                              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-800 text-[10px] font-bold text-gray-500">
                                {i + 1}
                              </span>
                              <div className="flex-1">
                                <p className="font-semibold text-gray-300 capitalize">
                                  {step.action.replace(/_/g, " ")}
                                </p>
                                <pre className="mt-1 text-[10px] text-gray-500 overflow-x-auto whitespace-pre-wrap">
                                  {typeof step.result === "string"
                                    ? step.result
                                    : JSON.stringify(step.result, null, 2)}
                                </pre>
                                <span className="text-[9px] text-gray-600 font-mono">
                                  {formatTimestamp(step.timestamp)}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ─── Investigation History ──────────────────────── */}
              {detail.investigations && detail.investigations.length > 0 && (
                <div>
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Investigation History ({detail.investigations.length})
                  </h3>
                  <div className="space-y-2">
                    {detail.investigations.map((run) => (
                      <button
                        key={run.id}
                        onClick={() => {
                          setActiveRunId(run.id);
                          if (run.findings) setActiveFindings(run.findings);
                          if (run.steps) setActiveSteps(run.steps);
                        }}
                        className={cn(
                          "w-full rounded-lg border p-3 text-left transition-colors",
                          activeRunId === run.id
                            ? "border-violet-700 bg-violet-900/20"
                            : "border-gray-800 bg-gray-900 hover:border-gray-700"
                        )}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-gray-300 capitalize">
                              {run.agent_type.replace(/_/g, " ")}
                            </span>
                            <span
                              className={cn(
                                "rounded px-1.5 py-0.5 text-[9px] font-bold uppercase",
                                run.status === "completed"
                                  ? "bg-emerald-900/40 text-emerald-400"
                                  : run.status === "running"
                                  ? "bg-cyan-900/40 text-cyan-400"
                                  : "bg-red-900/40 text-red-400"
                              )}
                            >
                              {run.status === "running" && (
                                <Loader2 className="inline h-2.5 w-2.5 animate-spin mr-1" />
                              )}
                              {run.status}
                            </span>
                          </div>
                          <span className="text-[9px] text-gray-600 font-mono">
                            {formatTimestamp(run.started_at)}
                          </span>
                        </div>
                        {run.summary && (
                          <p className="text-[11px] text-gray-500 line-clamp-2 leading-relaxed">
                            {run.summary}
                          </p>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* ─── Evidence ───────────────────────────────────── */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Evidence ({detail.evidence?.length || 0})
                  </h3>
                  <button
                    onClick={() => setShowNoteForm(!showNoteForm)}
                    className="flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-violet-400 hover:bg-violet-900/20 border border-violet-800/50"
                  >
                    <StickyNote className="h-3 w-3" />
                    Add Note
                  </button>
                </div>

                {/* Add Note Form */}
                {showNoteForm && (
                  <div className="mb-3 rounded-lg border border-gray-800 bg-gray-900/60 p-3 space-y-2">
                    <input
                      type="text"
                      placeholder="Note title"
                      value={noteTitle}
                      onChange={(e) => setNoteTitle(e.target.value)}
                      className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-100 placeholder-gray-500 focus:border-violet-600 focus:outline-none"
                    />
                    <textarea
                      placeholder="Details (optional)"
                      value={noteContent}
                      onChange={(e) => setNoteContent(e.target.value)}
                      rows={2}
                      className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-100 placeholder-gray-500 focus:border-violet-600 focus:outline-none resize-none"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setShowNoteForm(false)}
                        className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-800"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={addEvidenceNote}
                        disabled={addingNote || !noteTitle.trim()}
                        className="flex items-center gap-1 rounded bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
                      >
                        {addingNote && (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        )}
                        Add
                      </button>
                    </div>
                  </div>
                )}

                {/* Evidence List */}
                {detail.evidence && detail.evidence.length > 0 ? (
                  <div className="space-y-2">
                    {detail.evidence.map((ev) => (
                      <div
                        key={ev.id}
                        className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900 p-3"
                      >
                        <FileText className="h-4 w-4 shrink-0 text-gray-500" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-gray-300 truncate">
                            {ev.title}
                          </p>
                          {ev.content && (
                            <p className="text-[10px] text-gray-500 truncate mt-0.5">
                              {ev.content}
                            </p>
                          )}
                          <div className="flex items-center gap-2 mt-1">
                            <span
                              className={cn(
                                "rounded px-1.5 py-0.5 text-[9px] uppercase font-bold",
                                ev.evidence_type === "note"
                                  ? "bg-violet-900/40 text-violet-400"
                                  : ev.evidence_type === "alert"
                                  ? "bg-red-900/40 text-red-400"
                                  : ev.evidence_type === "event"
                                  ? "bg-blue-900/40 text-blue-400"
                                  : ev.evidence_type === "recording"
                                  ? "bg-amber-900/40 text-amber-400"
                                  : "bg-gray-800 text-gray-500"
                              )}
                            >
                              {ev.evidence_type}
                            </span>
                            <span className="text-[9px] text-gray-600">
                              {formatTimestamp(ev.added_at)}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-600">
                    No evidence attached yet
                  </p>
                )}
              </div>

              {/* ─── Related Cases ───────────────────────────────── */}
              {relatedCases.length > 0 && (
                <div>
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
                    <Link2 className="h-3.5 w-3.5" />
                    Related Cases ({relatedCases.length})
                  </h3>
                  <div className="space-y-1.5">
                    {relatedCases.map((rc) => (
                      <button
                        key={rc.id}
                        onClick={() => selectCase(rc.id)}
                        className="w-full flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/60 p-2.5 text-left hover:border-gray-700 hover:bg-gray-900 transition-colors group"
                      >
                        <span
                          className={cn(
                            "inline-flex shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider border",
                            STATUS_COLORS[rc.status] || STATUS_COLORS.open
                          )}
                        >
                          {rc.status}
                        </span>
                        <span className="text-xs text-gray-300 truncate group-hover:text-white transition-colors">
                          {rc.title}
                        </span>
                        <span className="ml-auto shrink-0 text-[9px] text-gray-600 font-mono">
                          {rc.id.slice(0, 6)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* ─── Metadata Footer ───────────────────────────── */}
              <div className="flex flex-wrap gap-4 text-[10px] text-gray-600 pt-4 border-t border-gray-800">
                <span>ID: {detail.id.slice(0, 8)}</span>
                <span>Created: {formatTimestamp(detail.created_at)}</span>
                <span>Updated: {formatTimestamp(detail.updated_at)}</span>
                {detail.closed_at && (
                  <span>Closed: {formatTimestamp(detail.closed_at)}</span>
                )}
              </div>
            </div>
          )}

          {/* Empty State */}
          {!detailLoading && !detail && selectedId && (
            <div className="flex items-center justify-center py-20">
              <p className="text-sm text-gray-500">Case not found</p>
            </div>
          )}
        </div>
      )}

      {/* ─── Empty state when no case selected ──────────────── */}
      {!selectedId && !loading && cases.length > 0 && (
        <div className="hidden md:flex flex-1 items-center justify-center">
          <div className="text-center">
            <FolderOpen className="mx-auto mb-3 h-12 w-12 text-gray-800" />
            <p className="text-sm text-gray-600">
              Select a case to view details
            </p>
            <p className="mt-1 text-xs text-gray-700">
              or create a new investigation
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Investigation Milestones ───────────────────────────────── */

const MILESTONES: { key: string; label: string }[] = [
  { key: "created", label: "Created" },
  { key: "open", label: "Open" },
  { key: "investigating", label: "Investigating" },
  { key: "closed", label: "Resolved" },
  { key: "archived", label: "Closed" },
];

const MILESTONE_STATUS_INDEX: Record<string, number> = {
  open: 1,
  investigating: 2,
  closed: 3,
  archived: 4,
};

function InvestigationMilestones({ status }: { status: string }) {
  const activeIdx = MILESTONE_STATUS_INDEX[status] ?? 1;

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/60 px-4 py-3">
      <div className="flex items-center justify-between relative">
        {/* Connector lines drawn behind dots */}
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 flex px-[10px]">
          {MILESTONES.slice(0, -1).map((_, i) => (
            <div
              key={i}
              className={cn(
                "flex-1 h-0.5 transition-colors",
                i < activeIdx ? "bg-violet-500" : "bg-gray-700"
              )}
            />
          ))}
        </div>

        {/* Dots + labels */}
        {MILESTONES.map((m, i) => {
          const isActive = i === activeIdx;
          const isPast = i < activeIdx;
          return (
            <div key={m.key} className="relative flex flex-col items-center gap-1.5 z-10">
              <div
                className={cn(
                  "w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors",
                  isActive
                    ? "bg-violet-600 border-violet-400 shadow-[0_0_6px_rgba(139,92,246,0.6)]"
                    : isPast
                    ? "bg-violet-900/60 border-violet-600"
                    : "bg-gray-800 border-gray-600"
                )}
              >
                {isPast && (
                  <CheckCircle2 className="w-2.5 h-2.5 text-violet-400" />
                )}
                {isActive && (
                  <div className="w-1.5 h-1.5 rounded-full bg-white" />
                )}
              </div>
              <span
                className={cn(
                  "text-[9px] font-semibold uppercase tracking-wider whitespace-nowrap",
                  isActive ? "text-violet-400" : isPast ? "text-gray-500" : "text-gray-700"
                )}
              >
                {m.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
