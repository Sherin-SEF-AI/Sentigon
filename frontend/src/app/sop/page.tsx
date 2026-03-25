"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  ClipboardList,
  Loader2,
  AlertTriangle,
  Plus,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  Zap,
  Clock,
  Play,
  SkipForward,
  XCircle,
  Search,
  History,
  BarChart3,
  Activity,
  Timer,
} from "lucide-react";
import { cn, apiFetch, severityColor, formatTimestamp } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import type { SOPTemplate, SOPInstance } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type TabKey = "templates" | "instances";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TABS: { key: TabKey; label: string }[] = [
  { key: "templates", label: "Templates" },
  { key: "instances", label: "Active Instances" },
];

const INSTANCE_STATUS_BADGE: Record<string, string> = {
  active: "bg-blue-900/40 text-blue-400 border-blue-800",
  completed: "bg-green-900/40 text-green-400 border-green-800",
  aborted: "bg-red-900/40 text-red-400 border-red-800",
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function SOPPage() {
  const { addToast } = useToast();
  const [templates, setTemplates] = useState<SOPTemplate[]>([]);
  const [instances, setInstances] = useState<SOPInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("templates");

  /* Template expansion */
  const [expandedTemplateId, setExpandedTemplateId] = useState<string | null>(null);

  /* Create template form */
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newThreatType, setNewThreatType] = useState("");
  const [newSeverity, setNewSeverity] = useState("medium");
  const [newStages, setNewStages] = useState("");

  /* Trigger condition fields */
  const [triggerAlertSeverity, setTriggerAlertSeverity] = useState("any");
  const [triggerThreatType, setTriggerThreatType] = useState("");
  const [triggerZone, setTriggerZone] = useState("");

  /* Template search */
  const [templateSearch, setTemplateSearch] = useState("");

  /* Instance expansion */
  const [expandedInstanceId, setExpandedInstanceId] = useState<string | null>(null);

  /* Action loading states */
  const [activatingTemplateId, setActivatingTemplateId] = useState<string | null>(null);
  const [advancingInstanceId, setAdvancingInstanceId] = useState<string | null>(null);
  const [abortingInstanceId, setAbortingInstanceId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [templatesData, instancesData] = await Promise.all([
        apiFetch<SOPTemplate[]>("/api/sop/templates"),
        apiFetch<SOPInstance[]>("/api/sop/instances"),
      ]);
      setTemplates(templatesData);
      setInstances(instancesData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch SOP data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /* Create template handler */
  const handleCreateTemplate = useCallback(async () => {
    if (!newName.trim() || !newThreatType.trim()) return;
    setCreating(true);
    try {
      /* Parse stages: each line becomes a stage object */
      const stageLines = newStages
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const workflow_stages = stageLines.map((line, i) => ({
        stage: i + 1,
        name: line,
      }));

      // Build trigger_conditions object only if any field is set
      const trigger_conditions: Record<string, string> = {};
      if (triggerAlertSeverity !== "any") trigger_conditions.alert_severity = triggerAlertSeverity;
      if (triggerThreatType.trim()) trigger_conditions.threat_type = triggerThreatType.trim();
      if (triggerZone.trim()) trigger_conditions.zone = triggerZone.trim();

      const created = await apiFetch<SOPTemplate>("/api/sop/templates", {
        method: "POST",
        body: JSON.stringify({
          name: newName,
          threat_type: newThreatType,
          severity: newSeverity,
          workflow_stages,
          ...(Object.keys(trigger_conditions).length > 0 && { trigger_conditions }),
          auto_trigger: Object.keys(trigger_conditions).length > 0,
        }),
      });
      setTemplates((prev) => [created, ...prev]);
      setShowCreateForm(false);
      setNewName("");
      setNewThreatType("");
      setNewSeverity("medium");
      setNewStages("");
      setTriggerAlertSeverity("any");
      setTriggerThreatType("");
      setTriggerZone("");
    } catch {
      addToast("error", "Operation failed");
    } finally {
      setCreating(false);
    }
  }, [newName, newThreatType, newSeverity, newStages, triggerAlertSeverity, triggerThreatType, triggerZone, addToast]);

  /* Activate SOP from template */
  const handleActivate = useCallback(async (templateId: string) => {
    setActivatingTemplateId(templateId);
    try {
      const created = await apiFetch<SOPInstance>(
        `/api/sop/instances/${templateId}/activate`,
        { method: "POST" }
      );
      setInstances((prev) => [created, ...prev]);
    } catch {
      addToast("error", "Operation failed");
    } finally {
      setActivatingTemplateId(null);
    }
  }, [addToast]);

  /* Advance instance to next stage */
  const handleAdvance = useCallback(async (instanceId: string) => {
    setAdvancingInstanceId(instanceId);
    try {
      const updated = await apiFetch<SOPInstance>(
        `/api/sop/instances/${instanceId}/advance`,
        { method: "PUT" }
      );
      setInstances((prev) =>
        prev.map((inst) => (inst.id === instanceId ? updated : inst))
      );
    } catch {
      addToast("error", "Operation failed");
    } finally {
      setAdvancingInstanceId(null);
    }
  }, [addToast]);

  /* Abort instance */
  const handleAbort = useCallback(async (instanceId: string) => {
    setAbortingInstanceId(instanceId);
    try {
      const updated = await apiFetch<SOPInstance>(
        `/api/sop/instances/${instanceId}/abort`,
        { method: "POST" }
      );
      setInstances((prev) =>
        prev.map((inst) => (inst.id === instanceId ? updated : inst))
      );
    } catch {
      addToast("error", "Operation failed");
    } finally {
      setAbortingInstanceId(null);
    }
  }, [addToast]);

  /* Lookup maps built from templates – avoids repeated .find() per render row */
  const templateNameMap = useMemo(() => {
    const map = new Map<string, string>();
    templates.forEach((tpl) => map.set(tpl.id, tpl.name));
    return map;
  }, [templates]);

  const templateStageCountMap = useMemo(() => {
    const map = new Map<string, number>();
    templates.forEach((tpl) => map.set(tpl.id, tpl.workflow_stages.length));
    return map;
  }, [templates]);

  /* Lookup template name by id */
  const templateName = useCallback(
    (id: string): string => templateNameMap.get(id) ?? id.slice(0, 8),
    [templateNameMap]
  );

  /* Get total stages for a template */
  const templateStageCount = useCallback(
    (templateId: string): number => templateStageCountMap.get(templateId) ?? 0,
    [templateStageCountMap]
  );

  /* Active instance count for the tab badge */
  const activeInstanceCount = useMemo(
    () => instances.filter((inst) => inst.status === "active").length,
    [instances]
  );

  /* --- Compliance metrics derived from real data --- */
  const sopMetrics = useMemo(() => {
    const totalSOPs = templates.length;
    const activeInstances = instances.filter((i) => i.status === "active").length;

    // Avg completion time: calculated from completed instances that have created_at & updated_at
    const completedInstances = instances.filter(
      (i) => i.status === "completed" && i.created_at && i.updated_at
    );
    const avgCompletionMs =
      completedInstances.length === 0
        ? null
        : completedInstances.reduce((sum, i) => {
            const start = new Date(i.created_at!).getTime();
            const end = new Date(i.updated_at!).getTime();
            return sum + Math.max(0, end - start);
          }, 0) / completedInstances.length;

    const avgCompletionLabel =
      avgCompletionMs === null
        ? "N/A"
        : avgCompletionMs < 60_000
        ? `${Math.round(avgCompletionMs / 1000)}s`
        : avgCompletionMs < 3_600_000
        ? `${Math.round(avgCompletionMs / 60_000)}m`
        : `${(avgCompletionMs / 3_600_000).toFixed(1)}h`;

    return { totalSOPs, activeInstances, avgCompletionLabel };
  }, [templates, instances]);

  /* Filtered templates by search */
  const filteredTemplates = useMemo(
    () =>
      templateSearch.trim()
        ? templates.filter((tpl) =>
            tpl.name.toLowerCase().includes(templateSearch.toLowerCase())
          )
        : templates,
    [templates, templateSearch]
  );

  /* Lookup template stages by id for instance detail view */
  const templateStagesMap = useMemo(() => {
    const map = new Map<string, Record<string, unknown>[]>();
    templates.forEach((tpl) => map.set(tpl.id, tpl.workflow_stages));
    return map;
  }, [templates]);

  return (
    <div className="min-h-screen bg-gray-950 p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
            <ClipboardList className="h-5 w-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-cyan-400 tracking-wide">
              Standard Operating Procedures
            </h1>
            <p className="text-xs text-gray-500">
              Manage SOP templates and track active instances
            </p>
          </div>
        </div>
        {tab === "templates" && (
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500"
          >
            <Plus className="h-4 w-4" />
            Create Template
          </button>
        )}
      </div>

      {/* ---- Compliance Metrics Row ---- */}
      {!loading && !error && (
        <div className="mb-5 grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
              <BarChart3 className="h-3.5 w-3.5 text-cyan-400/70" />
              Total SOPs
            </div>
            <p className="text-2xl font-bold tabular-nums text-gray-100">{sopMetrics.totalSOPs}</p>
          </div>
          <div className="rounded-lg border border-blue-900/40 bg-blue-950/20 px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
              <Activity className="h-3.5 w-3.5 text-blue-400/70" />
              Active Instances
            </div>
            <p className="text-2xl font-bold tabular-nums text-blue-400">{sopMetrics.activeInstances}</p>
          </div>
          <div className="rounded-lg border border-green-900/40 bg-green-950/20 px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
              <Timer className="h-3.5 w-3.5 text-green-400/70" />
              Avg Completion Time
            </div>
            <p className="text-2xl font-bold tabular-nums text-green-400">{sopMetrics.avgCompletionLabel}</p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-4 flex gap-1 border-b border-gray-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px",
              tab === t.key
                ? "border-cyan-400 text-cyan-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            )}
          >
            {t.label}
            {t.key === "instances" && instances.length > 0 && (
              <span className="ml-2 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-mono text-gray-500">
                {activeInstanceCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          <p className="mt-3 text-sm text-gray-500">Loading SOP data...</p>
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="flex flex-col items-center justify-center py-20">
          <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={fetchData}
            className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Templates Tab ---- */}
      {!loading && !error && tab === "templates" && (
        <div className="space-y-4">
          {/* Create Template Form */}
          {showCreateForm && (
            <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-5">
              <h3 className="mb-4 text-sm font-semibold text-gray-200">
                Create New SOP Template
              </h3>
              <div className="space-y-3">
                <input
                  type="text"
                  placeholder="Template name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
                />
                <div className="flex gap-3">
                  <input
                    type="text"
                    placeholder="Threat type (e.g. intrusion, fire)"
                    value={newThreatType}
                    onChange={(e) => setNewThreatType(e.target.value)}
                    className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
                  />
                  <select
                    value={newSeverity}
                    onChange={(e) => setNewSeverity(e.target.value)}
                    className="rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-gray-100 focus:border-cyan-700 focus:outline-none"
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
                {/* Trigger Condition Section */}
                <div className="rounded-lg border border-cyan-900/40 bg-cyan-950/10 p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Zap className="h-3.5 w-3.5 text-cyan-400" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-cyan-400">
                      Trigger Condition
                    </span>
                    <span className="text-[10px] text-gray-600">(optional — enables auto-trigger)</span>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-gray-500">
                        Alert Severity
                      </label>
                      <select
                        value={triggerAlertSeverity}
                        onChange={(e) => setTriggerAlertSeverity(e.target.value)}
                        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-cyan-700 focus:outline-none"
                      >
                        <option value="any">Any severity</option>
                        <option value="critical">Critical</option>
                        <option value="high">High</option>
                        <option value="medium">Medium</option>
                        <option value="low">Low</option>
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-gray-500">
                        Threat Type
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. intrusion, fire"
                        value={triggerThreatType}
                        onChange={(e) => setTriggerThreatType(e.target.value)}
                        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-gray-500">
                        Zone
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. Zone A, Loading Bay"
                        value={triggerZone}
                        onChange={(e) => setTriggerZone(e.target.value)}
                        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-500">
                    Workflow Stages (one per line)
                  </label>
                  <textarea
                    value={newStages}
                    onChange={(e) => setNewStages(e.target.value)}
                    rows={5}
                    placeholder={"Assess situation\nNotify command\nDeploy response team\nSecure perimeter\nPost-incident review"}
                    className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-gray-100 placeholder-gray-600 resize-none focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setShowCreateForm(false)}
                    className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:bg-gray-800"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreateTemplate}
                    disabled={creating || !newName.trim() || !newThreatType.trim()}
                    className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-50"
                  >
                    {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                    Create Template
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Template search */}
          {templates.length > 0 && (
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
              <input
                type="text"
                placeholder="Search templates by name..."
                value={templateSearch}
                onChange={(e) => setTemplateSearch(e.target.value)}
                className="w-full rounded-lg border border-gray-700 bg-gray-800 pl-10 pr-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
              />
            </div>
          )}

          {/* Template list */}
          {templates.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20">
              <ClipboardList className="mb-2 h-10 w-10 text-gray-700" />
              <p className="text-sm text-gray-500">No SOP templates</p>
              <p className="mt-1 text-xs text-gray-600">
                Create a template to get started
              </p>
            </div>
          ) : filteredTemplates.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Search className="mb-2 h-8 w-8 text-gray-700" />
              <p className="text-sm text-gray-500">No templates match &quot;{templateSearch}&quot;</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {filteredTemplates.map((tpl) => {
                const isExpanded = expandedTemplateId === tpl.id;
                return (
                  <div
                    key={tpl.id}
                    className="rounded-lg border border-gray-800 bg-gray-900/60 transition-colors hover:border-gray-700"
                  >
                    {/* Card header */}
                    <div className="p-5">
                      <div className="mb-3 flex items-start justify-between">
                        <h3 className="text-sm font-semibold text-gray-200">
                          {tpl.name}
                        </h3>
                        <div className="flex items-center gap-1.5">
                          {tpl.is_active ? (
                            <span className="inline-flex rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-green-900/40 text-green-400 border border-green-800">
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-gray-800 text-gray-500 border border-gray-700">
                              Inactive
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Metadata badges */}
                      <div className="mb-3 flex flex-wrap gap-2">
                        <span className="inline-flex rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-gray-800 text-gray-400 border border-gray-700">
                          {tpl.threat_type}
                        </span>
                        <span
                          className={cn(
                            "inline-flex rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                            severityColor(tpl.severity)
                          )}
                        >
                          {tpl.severity}
                        </span>
                      </div>

                      {/* Auto trigger toggle display */}
                      <div className="flex items-center gap-2 text-xs text-gray-500">
                        <Zap className="h-3.5 w-3.5" />
                        <span>Auto Trigger:</span>
                        {tpl.auto_trigger ? (
                          <span className="font-semibold text-cyan-400">ON</span>
                        ) : (
                          <span className="font-semibold text-gray-600">OFF</span>
                        )}
                      </div>

                      {/* Expand button + Activate */}
                      <div className="mt-3 flex items-center justify-between">
                        <button
                          onClick={() =>
                            setExpandedTemplateId(isExpanded ? null : tpl.id)
                          }
                          className="flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                          {isExpanded ? "Hide" : "Show"} Workflow Stages (
                          {tpl.workflow_stages.length})
                        </button>
                        <button
                          onClick={() => handleActivate(tpl.id)}
                          disabled={activatingTemplateId === tpl.id}
                          className="flex items-center gap-1.5 rounded-lg border border-cyan-800 bg-cyan-900/30 px-3 py-1.5 text-xs font-semibold text-cyan-400 transition-colors hover:bg-cyan-900/50 hover:text-cyan-300 disabled:opacity-50"
                        >
                          {activatingTemplateId === tpl.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Play className="h-3 w-3" />
                          )}
                          Activate SOP
                        </button>
                      </div>
                    </div>

                    {/* Expanded: workflow stages */}
                    {isExpanded && tpl.workflow_stages.length > 0 && (
                      <div className="border-t border-gray-800 p-5">
                        <ol className="space-y-2">
                          {tpl.workflow_stages.map((stage, i) => {
                            const stageName =
                              typeof stage === "object" && stage !== null
                                ? (stage as Record<string, unknown>).name ||
                                  (stage as Record<string, unknown>).title ||
                                  JSON.stringify(stage)
                                : String(stage);
                            return (
                              <li
                                key={i}
                                className="flex items-start gap-3 text-sm text-gray-300"
                              >
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cyan-900/30 border border-cyan-800/50 text-xs font-bold text-cyan-400">
                                  {i + 1}
                                </span>
                                <span className="pt-0.5">{String(stageName)}</span>
                              </li>
                            );
                          })}
                        </ol>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ---- Instances Tab ---- */}
      {!loading && !error && tab === "instances" && (
        <div>
          {instances.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20">
              <ClipboardList className="mb-2 h-10 w-10 text-gray-700" />
              <p className="text-sm text-gray-500">No active SOP instances</p>
              <p className="mt-1 text-xs text-gray-600">
                Instances are created when SOPs are triggered
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-800">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-800 bg-gray-900/80">
                    <th className="w-8 px-2 py-3" />
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                      Template
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                      Alert ID
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                      Progress
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                      Status
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                      <div className="flex items-center gap-1.5"><Clock className="h-3 w-3" />Created</div>
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {instances.map((inst) => {
                    const totalStages = templateStageCount(inst.template_id);
                    const currentStage = inst.current_stage;
                    const isInstanceExpanded = expandedInstanceId === inst.id;
                    const stages = templateStagesMap.get(inst.template_id) ?? [];

                    return (
                      <React.Fragment key={inst.id}>
                        <tr
                          className={cn(
                            "transition-colors cursor-pointer",
                            isInstanceExpanded ? "bg-gray-900/80" : "hover:bg-gray-900/60"
                          )}
                          onClick={() =>
                            setExpandedInstanceId(isInstanceExpanded ? null : inst.id)
                          }
                        >
                          {/* Expand chevron */}
                          <td className="px-2 py-3 text-gray-500">
                            {isInstanceExpanded ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </td>

                          {/* Template name */}
                          <td className="px-4 py-3 text-sm font-medium text-gray-200">
                            {templateName(inst.template_id)}
                          </td>

                          {/* Alert ID */}
                          <td className="px-4 py-3 font-mono text-xs text-gray-500">
                            {inst.alert_id ? inst.alert_id.slice(0, 8) : "---"}
                          </td>

                          {/* Progress dots */}
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              {totalStages > 0 ? (
                                Array.from({ length: totalStages }, (_, i) => (
                                  <div
                                    key={i}
                                    className={cn(
                                      "h-3 w-3 rounded-full border transition-colors",
                                      i < currentStage
                                        ? "bg-cyan-500 border-cyan-400"
                                        : i === currentStage
                                        ? "bg-cyan-900/50 border-cyan-600 ring-2 ring-cyan-500/30"
                                        : "bg-gray-800 border-gray-700"
                                    )}
                                    title={`Stage ${i + 1}${
                                      i < currentStage
                                        ? " (completed)"
                                        : i === currentStage
                                        ? " (current)"
                                        : ""
                                    }`}
                                  />
                                ))
                              ) : (
                                <span className="text-xs text-gray-600">
                                  Stage {currentStage + 1}
                                </span>
                              )}
                              <span className="ml-2 text-[10px] font-mono text-gray-500">
                                {currentStage + 1}/{totalStages || "?"}
                              </span>
                            </div>
                          </td>

                          {/* Status badge */}
                          <td className="px-4 py-3">
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                                INSTANCE_STATUS_BADGE[inst.status] ||
                                  "bg-gray-800 text-gray-400 border-gray-700"
                              )}
                            >
                              {inst.status === "completed" && (
                                <Check className="h-2.5 w-2.5" />
                              )}
                              {inst.status === "aborted" && (
                                <X className="h-2.5 w-2.5" />
                              )}
                              {inst.status}
                            </span>
                          </td>

                          {/* Created at */}
                          <td className="px-4 py-3 text-xs text-gray-500">
                            {inst.created_at
                              ? formatTimestamp(inst.created_at)
                              : "---"}
                          </td>

                          {/* Actions */}
                          <td className="px-4 py-3">
                            {inst.status === "active" && (
                              <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                <button
                                  onClick={() => handleAdvance(inst.id)}
                                  disabled={advancingInstanceId === inst.id}
                                  title="Advance to next stage"
                                  className="flex items-center gap-1 rounded border border-cyan-800 bg-cyan-900/30 px-2.5 py-1 text-xs font-semibold text-cyan-400 transition-colors hover:bg-cyan-900/50 disabled:opacity-50"
                                >
                                  {advancingInstanceId === inst.id ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <SkipForward className="h-3 w-3" />
                                  )}
                                  Advance
                                </button>
                                <button
                                  onClick={() => handleAbort(inst.id)}
                                  disabled={abortingInstanceId === inst.id}
                                  title="Abort this instance"
                                  className="flex items-center gap-1 rounded border border-red-800 bg-red-900/30 px-2.5 py-1 text-xs font-semibold text-red-400 transition-colors hover:bg-red-900/50 disabled:opacity-50"
                                >
                                  {abortingInstanceId === inst.id ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <XCircle className="h-3 w-3" />
                                  )}
                                  Abort
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>

                        {/* Expanded: stage history */}
                        {isInstanceExpanded && (
                          <tr>
                            <td colSpan={7} className="border-t border-gray-800/50 bg-gray-900/40 px-6 py-4">
                              <div className="flex items-center gap-2 mb-3">
                                <History className="h-4 w-4 text-gray-500" />
                                <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                                  Stage History
                                </h4>
                              </div>
                              {inst.stage_history.length === 0 ? (
                                <p className="text-xs text-gray-600 italic">No stage history recorded yet.</p>
                              ) : (
                                <ol className="space-y-2">
                                  {inst.stage_history.map((entry, idx) => {
                                    const entryStage = (entry as Record<string, unknown>).stage;
                                    const entryTsRaw = (entry as Record<string, unknown>).completed_at ??
                                      (entry as Record<string, unknown>).timestamp ??
                                      (entry as Record<string, unknown>).started_at;
                                    const entryTs = typeof entryTsRaw === "string" ? entryTsRaw : null;
                                    const entryName =
                                      (entry as Record<string, unknown>).name ??
                                      (entry as Record<string, unknown>).stage_name ??
                                      (stages[Number(entryStage) ?? idx] as Record<string, unknown> | undefined)?.name ??
                                      `Stage ${typeof entryStage === "number" ? entryStage + 1 : idx + 1}`;
                                    return (
                                      <li key={idx} className="flex items-center gap-3 text-sm">
                                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cyan-900/30 border border-cyan-800/50 text-xs font-bold text-cyan-400">
                                          {typeof entryStage === "number" ? entryStage + 1 : idx + 1}
                                        </span>
                                        <span className="text-gray-300">{String(entryName)}</span>
                                        {entryTs && (
                                          <span className="ml-auto text-[10px] text-gray-600 font-mono">
                                            {formatTimestamp(entryTs)}
                                          </span>
                                        )}
                                      </li>
                                    );
                                  })}
                                </ol>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
