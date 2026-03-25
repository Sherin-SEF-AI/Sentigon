"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ClipboardCheck,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  Filter,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Edit3,
  History,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import type { PendingAction, OperationModeStatus, Severity } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Severity helpers                                                    */
/* ------------------------------------------------------------------ */

const severityColor: Record<string, string> = {
  critical: "bg-red-500/10 text-red-400 border-red-500/30",
  high: "bg-orange-500/10 text-orange-400 border-orange-500/30",
  medium: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  low: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  info: "bg-gray-500/10 text-gray-400 border-gray-500/30",
};

const statusColor: Record<string, string> = {
  pending: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  approved: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  rejected: "bg-red-500/10 text-red-400 border-red-500/30",
  expired: "bg-purple-500/10 text-purple-400 border-purple-500/30",
};

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function countdown(dateStr: string | null): string {
  if (!dateStr) return "No timeout";
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff <= 0) return "Expired";
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

/* ------------------------------------------------------------------ */
/*  Action Card                                                         */
/* ------------------------------------------------------------------ */

interface ActionCardProps {
  action: PendingAction;
  onApprove: (id: string, notes?: string, modifiedArgs?: Record<string, unknown>) => void;
  onReject: (id: string, notes?: string) => void;
  isPending: boolean;
  selected?: boolean;
  onSelect?: (id: string, checked: boolean) => void;
}

function ActionCard({ action, onApprove, onReject, isPending, selected, onSelect }: ActionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showModify, setShowModify] = useState(false);
  const [notes, setNotes] = useState("");
  const [modifiedArgs, setModifiedArgs] = useState(JSON.stringify(action.tool_args, null, 2));
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const handleApprove = async () => {
    setApproving(true);
    try {
      if (showModify) {
        const parsed = JSON.parse(modifiedArgs);
        await onApprove(action.id, notes || undefined, parsed);
      } else {
        await onApprove(action.id, notes || undefined);
      }
    } finally {
      setApproving(false);
    }
  };

  const handleReject = async () => {
    setRejecting(true);
    try {
      await onReject(action.id, notes || undefined);
    } finally {
      setRejecting(false);
    }
  };

  return (
    <div
      className={cn(
        "rounded-lg border bg-gray-900/60 transition-colors",
        isPending ? "border-gray-800 hover:border-gray-700" : "border-gray-800/50 opacity-75"
      )}
    >
      {/* Header */}
      <div
        className="flex items-start justify-between gap-4 px-4 py-3 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Checkbox for batch selection */}
        {isPending && onSelect && (
          <input
            type="checkbox"
            checked={selected || false}
            onChange={(e) => {
              e.stopPropagation();
              onSelect(action.id, e.target.checked);
            }}
            onClick={(e) => e.stopPropagation()}
            className="mt-1 h-3.5 w-3.5 shrink-0 cursor-pointer accent-cyan-500 rounded"
            aria-label={`Select ${action.tool_name}`}
          />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm font-semibold text-gray-200">
              {action.tool_name}
            </span>
            <span className="text-xs text-gray-600">by</span>
            <span className="text-xs text-cyan-400">{action.agent_name}</span>
            <span
              className={cn(
                "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                severityColor[action.severity] || severityColor.medium
              )}
            >
              {action.severity}
            </span>
            <span
              className={cn(
                "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                statusColor[action.status] || statusColor.pending
              )}
            >
              {action.status}
            </span>
          </div>
          <p className="text-xs text-gray-400 line-clamp-2">{action.context_summary}</p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {isPending && (
            <div className="text-right">
              <p className="text-[10px] text-gray-500">{timeAgo(action.created_at)}</p>
              <p className="flex items-center gap-1 text-[10px] text-amber-500">
                <Clock className="h-3 w-3" />
                {countdown(action.expires_at)}
              </p>
            </div>
          )}
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-gray-500" />
          ) : (
            <ChevronDown className="h-4 w-4 text-gray-500" />
          )}
        </div>
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className="border-t border-gray-800 px-4 py-3 space-y-3">
          {/* Tool Arguments */}
          <div>
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-gray-500">
              Tool Arguments
            </p>
            <pre className="overflow-x-auto rounded-lg border border-gray-800 bg-gray-950 p-3 text-xs text-gray-300 font-mono max-h-48">
              {JSON.stringify(action.tool_args, null, 2)}
            </pre>
          </div>

          {/* Execution Result (for resolved actions) */}
          {action.execution_result && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-gray-500">
                Execution Result
              </p>
              <pre className="overflow-x-auto rounded-lg border border-gray-800 bg-gray-950 p-3 text-xs text-emerald-300 font-mono max-h-48">
                {JSON.stringify(action.execution_result, null, 2)}
              </pre>
            </div>
          )}

          {/* Resolution Info (for resolved actions) */}
          {action.resolved_at && (
            <div className="flex items-center gap-4 text-xs text-gray-500">
              {action.resolution_notes && (
                <span>Notes: {action.resolution_notes}</span>
              )}
              <span>Resolved: {formatTimestamp(action.resolved_at)}</span>
            </div>
          )}

          {/* Modify Args Section */}
          {isPending && showModify && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-gray-500">
                Modified Arguments
              </p>
              <textarea
                value={modifiedArgs}
                onChange={(e) => setModifiedArgs(e.target.value)}
                rows={6}
                className="w-full rounded-lg border border-gray-700 bg-gray-950 p-3 text-xs text-gray-300 font-mono focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
              />
            </div>
          )}

          {/* Notes */}
          {isPending && (
            <div>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional notes..."
                className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
              />
            </div>
          )}

          {/* Action Buttons */}
          {isPending && (
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={handleApprove}
                disabled={approving || rejecting}
                className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {approving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                {showModify ? "Approve Modified" : "Approve"}
              </button>

              <button
                onClick={() => setShowModify(!showModify)}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors",
                  showModify
                    ? "border-cyan-700 text-cyan-400 bg-cyan-900/20"
                    : "border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                )}
              >
                <Edit3 className="h-4 w-4" />
                {showModify ? "Cancel Modify" : "Modify & Approve"}
              </button>

              <button
                onClick={handleReject}
                disabled={approving || rejecting}
                className="flex items-center gap-2 rounded-lg bg-red-600/20 border border-red-700/50 px-4 py-2 text-sm font-semibold text-red-400 transition-colors hover:bg-red-600/30 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {rejecting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                Reject
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Pending Actions Page                                                */
/* ------------------------------------------------------------------ */

type ViewTab = "pending" | "history";

export default function PendingActionsPage() {
  const { addToast } = useToast();
  const [tab, setTab] = useState<ViewTab>("pending");
  const [modeStatus, setModeStatus] = useState<OperationModeStatus | null>(null);
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [historyActions, setHistoryActions] = useState<PendingAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string>("");
  const [approvingAll, setApprovingAll] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [mode, pending] = await Promise.all([
        apiFetch<OperationModeStatus>("/api/operation-mode"),
        apiFetch<PendingAction[]>(
          `/api/operation-mode/pending-actions${severityFilter ? `?severity=${severityFilter}` : ""}`
        ),
      ]);
      setModeStatus(mode);
      setPendingActions(pending);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [severityFilter]);

  const fetchHistory = useCallback(async () => {
    try {
      const history = await apiFetch<PendingAction[]>(
        "/api/operation-mode/pending-actions/history?limit=100"
      );
      setHistoryActions(history);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  useEffect(() => {
    if (tab === "history") fetchHistory();
  }, [tab, fetchHistory]);

  const handleApprove = async (
    id: string,
    notes?: string,
    modifiedArgs?: Record<string, unknown>
  ) => {
    try {
      await apiFetch(`/api/operation-mode/pending-actions/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ notes, modified_args: modifiedArgs }),
      });
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve");
    }
  };

  const handleReject = async (id: string, notes?: string) => {
    try {
      await apiFetch(`/api/operation-mode/pending-actions/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ notes }),
      });
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reject");
    }
  };

  const handleApproveAll = async () => {
    setApprovingAll(true);
    try {
      await apiFetch("/api/operation-mode/pending-actions/approve-all", {
        method: "POST",
      });
      addToast("success", "All pending actions approved");
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve all");
    } finally {
      setApprovingAll(false);
    }
  };

  const handleSelectRow = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(
    (checked: boolean) => {
      if (checked) {
        setSelectedIds(new Set(pendingActions.map((a) => a.id)));
      } else {
        setSelectedIds(new Set());
      }
    },
    [pendingActions]
  );

  const handleBulkApprove = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      const ids = Array.from(selectedIds);
      await Promise.all(
        ids.map((id) =>
          apiFetch(`/api/operation-mode/pending-actions/${id}/approve`, {
            method: "POST",
            body: JSON.stringify({ notes: "Bulk approved" }),
          })
        )
      );
      addToast("success", `Approved ${ids.length} action${ids.length !== 1 ? "s" : ""}`);
      setSelectedIds(new Set());
      fetchData();
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "Bulk approve failed");
    } finally {
      setBulkLoading(false);
    }
  }, [selectedIds, addToast, fetchData]);

  const handleBulkReject = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      const ids = Array.from(selectedIds);
      await Promise.all(
        ids.map((id) =>
          apiFetch(`/api/operation-mode/pending-actions/${id}/reject`, {
            method: "POST",
            body: JSON.stringify({ notes: "Bulk rejected" }),
          })
        )
      );
      addToast("success", `Rejected ${ids.length} action${ids.length !== 1 ? "s" : ""}`);
      setSelectedIds(new Set());
      fetchData();
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "Bulk reject failed");
    } finally {
      setBulkLoading(false);
    }
  }, [selectedIds, addToast, fetchData]);

  const allSelected = pendingActions.length > 0 && selectedIds.size === pendingActions.length;
  const someSelected = selectedIds.size > 0 && selectedIds.size < pendingActions.length;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
              <ClipboardCheck className="h-5 w-5 text-cyan-400" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-wider text-gray-100 uppercase">
                Pending Actions
              </h1>
              <p className="text-xs text-gray-500">
                Review and approve agent actions in HITL mode
              </p>
            </div>
          </div>

          {/* Mode Badge */}
          {modeStatus && (
            <span
              className={cn(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold uppercase tracking-wider",
                modeStatus.mode === "autonomous"
                  ? "border-emerald-700/50 bg-emerald-900/20 text-emerald-400"
                  : "border-amber-700/50 bg-amber-900/20 text-amber-400"
              )}
            >
              {modeStatus.mode === "autonomous" ? (
                <ShieldCheck className="h-4 w-4" />
              ) : (
                <ShieldAlert className="h-4 w-4" />
              )}
              {modeStatus.mode === "autonomous" ? "AUTONOMOUS" : "HITL MODE"}
            </span>
          )}
        </div>

        {/* Autonomous Mode Notice */}
        {modeStatus?.mode === "autonomous" && (
          <div className="rounded-lg border border-emerald-800/50 bg-emerald-900/10 px-4 py-3 flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-emerald-400 shrink-0" />
            <p className="text-sm text-emerald-300">
              System is in <strong>Autonomous mode</strong>. All agent actions execute
              immediately without approval. Switch to HITL mode in Settings to enable
              human approval.
            </p>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Tabs + Controls */}
        <div className="flex items-center justify-between border-b border-gray-800 pb-0">
          <div className="flex gap-1">
            <button
              onClick={() => setTab("pending")}
              className={cn(
                "flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors",
                tab === "pending"
                  ? "border-cyan-400 text-cyan-400"
                  : "border-transparent text-gray-500 hover:border-gray-700 hover:text-gray-300"
              )}
            >
              <ClipboardCheck className="h-4 w-4" />
              Pending
              {pendingActions.length > 0 && (
                <span className="ml-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-600 px-1.5 text-[10px] font-bold text-white">
                  {pendingActions.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setTab("history")}
              className={cn(
                "flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors",
                tab === "history"
                  ? "border-cyan-400 text-cyan-400"
                  : "border-transparent text-gray-500 hover:border-gray-700 hover:text-gray-300"
              )}
            >
              <History className="h-4 w-4" />
              History
            </button>
          </div>

          <div className="flex items-center gap-2 pb-2">
            {tab === "pending" && (
              <>
                {/* Severity Filter */}
                <div className="flex items-center gap-1">
                  <Filter className="h-3.5 w-3.5 text-gray-500" />
                  <select
                    value={severityFilter}
                    onChange={(e) => setSeverityFilter(e.target.value)}
                    className="rounded-lg border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none"
                  >
                    <option value="">All severities</option>
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>

                {/* Approve All */}
                {pendingActions.length > 1 && (
                  <button
                    onClick={handleApproveAll}
                    disabled={approvingAll}
                    className="flex items-center gap-2 rounded-lg bg-emerald-600/20 border border-emerald-700/50 px-3 py-1.5 text-xs font-semibold text-emerald-400 transition-colors hover:bg-emerald-600/30 disabled:opacity-50"
                  >
                    {approvingAll ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    )}
                    Approve All
                  </button>
                )}

                {/* Refresh */}
                <button
                  onClick={() => fetchData()}
                  className="rounded-lg border border-gray-700 p-1.5 text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-300"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
          </div>
        ) : tab === "pending" ? (
          <div className="space-y-3">
            {/* Bulk action toolbar */}
            {pendingActions.length > 0 && (
              <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-2.5">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected; }}
                  onChange={(e) => handleSelectAll(e.target.checked)}
                  className="h-3.5 w-3.5 cursor-pointer accent-cyan-500 rounded"
                  aria-label="Select all"
                />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  {selectedIds.size > 0 ? `${selectedIds.size} selected` : "Select All"}
                </span>
                {selectedIds.size > 0 && (
                  <>
                    <button
                      onClick={handleBulkApprove}
                      disabled={bulkLoading}
                      className="flex items-center gap-1.5 rounded-lg bg-emerald-600/20 border border-emerald-700/50 px-3 py-1.5 text-xs font-semibold text-emerald-400 hover:bg-emerald-600/30 disabled:opacity-50 transition-colors"
                    >
                      {bulkLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      Approve Selected
                    </button>
                    <button
                      onClick={handleBulkReject}
                      disabled={bulkLoading}
                      className="flex items-center gap-1.5 rounded-lg bg-red-600/20 border border-red-700/50 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-600/30 disabled:opacity-50 transition-colors"
                    >
                      {bulkLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                      Reject Selected
                    </button>
                    <button
                      onClick={() => setSelectedIds(new Set())}
                      disabled={bulkLoading}
                      className="ml-auto text-xs text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
                    >
                      Clear
                    </button>
                  </>
                )}
              </div>
            )}

            {pendingActions.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-lg border border-gray-800 bg-gray-900/60 py-16 text-center">
                <CheckCircle2 className="mb-3 h-10 w-10 text-emerald-600" />
                <p className="text-sm font-medium text-gray-300">No pending actions</p>
                <p className="mt-1 text-xs text-gray-600">
                  {modeStatus?.mode === "hitl"
                    ? "All actions have been reviewed. New actions will appear here when agents request them."
                    : "Switch to HITL mode in Settings to enable action approval."}
                </p>
              </div>
            ) : (
              pendingActions.map((action) => (
                <ActionCard
                  key={action.id}
                  action={action}
                  onApprove={handleApprove}
                  onReject={handleReject}
                  isPending={true}
                  selected={selectedIds.has(action.id)}
                  onSelect={handleSelectRow}
                />
              ))
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {historyActions.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-lg border border-gray-800 bg-gray-900/60 py-16 text-center">
                <History className="mb-3 h-10 w-10 text-gray-700" />
                <p className="text-sm font-medium text-gray-300">No action history</p>
                <p className="mt-1 text-xs text-gray-600">
                  Approved, rejected, and expired actions will appear here.
                </p>
              </div>
            ) : (
              historyActions.map((action) => (
                <ActionCard
                  key={action.id}
                  action={action}
                  onApprove={handleApprove}
                  onReject={handleReject}
                  isPending={false}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
