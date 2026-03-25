"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Microscope,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Camera,
  MapPin,
  Loader2,
  ShieldAlert,
  Brain,
  FileText,
  Download,
  Layers,
} from "lucide-react";
import {
  cn,
  apiFetch,
  severityColor,
  statusColor,
  formatTimestamp,
} from "@/lib/utils";
import type { Alert, Severity, AlertStatus } from "@/lib/types";
import { useToast } from "@/components/common/Toaster";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const SEVERITY_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All Severities" },
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "info", label: "Info" },
];

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All Statuses" },
  { value: "new", label: "New" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "investigating", label: "Investigating" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
];

const PAGE_SIZE = 20;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function timeAgo(iso: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(iso).getTime()) / 1000
  );
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function alertsToCSV(alerts: Alert[]): string {
  const header = [
    "ID",
    "Title",
    "Description",
    "Severity",
    "Status",
    "Threat Type",
    "Source Camera",
    "Zone",
    "Confidence",
    "Created At",
    "Acknowledged At",
    "Resolved At",
  ];

  const escape = (val: unknown): string => {
    const s = val == null ? "" : String(val);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const rows = alerts.map((a) =>
    [
      a.id,
      a.title,
      a.description ?? "",
      a.severity,
      a.status,
      a.threat_type ?? "",
      a.source_camera ?? "",
      a.zone_name ?? "",
      a.confidence != null ? Math.round(a.confidence * 100) + "%" : "",
      a.created_at,
      a.acknowledged_at ?? "",
      a.resolved_at ?? "",
    ]
      .map(escape)
      .join(",")
  );

  return [header.join(","), ...rows].join("\n");
}

function downloadCSV(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/*  AlertRow (expandable)                                              */
/* ------------------------------------------------------------------ */

interface AlertRowProps {
  alert: Alert;
  expanded: boolean;
  onToggle: () => void;
  onAction: (id: string, action: string) => void;
  actionLoading: string | null;
  selected: boolean;
  onSelect: (id: string, checked: boolean) => void;
  dedupCount?: number;
  onSeverityChange: (id: string, severity: string) => Promise<void>;
}

function AlertRow({
  alert,
  expanded,
  onToggle,
  onAction,
  actionLoading,
  selected,
  onSelect,
  dedupCount,
  onSeverityChange,
}: AlertRowProps) {
  const isActioning = actionLoading === alert.id;
  const [xaiChain, setXaiChain] = useState<any>(null);
  const [xaiLoading, setXaiLoading] = useState(false);
  const [severityOverride, setSeverityOverride] = useState<string>(alert.severity);
  const [severityUpdating, setSeverityUpdating] = useState(false);

  useEffect(() => {
    if (expanded && !xaiChain && !xaiLoading) {
      setXaiLoading(true);
      apiFetch(`/api/intelligence/explain/${alert.id}`)
        .then((data: any) => setXaiChain(data))
        .catch(() => {})
        .finally(() => setXaiLoading(false));
    }
  }, [expanded, alert.id, xaiChain, xaiLoading]);

  return (
    <div
      className={cn(
        "border rounded-lg transition-all duration-200",
        selected
          ? "border-cyan-700/60 bg-cyan-950/10"
          : expanded
          ? "border-gray-800 bg-gray-900/90"
          : "border-gray-800 bg-gray-900/50 hover:bg-gray-900/80"
      )}
    >
      {/* Main row */}
      <div className="flex w-full items-center gap-3 px-4 py-3">
        {/* Checkbox */}
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => {
            e.stopPropagation();
            onSelect(alert.id, e.target.checked);
          }}
          onClick={(e) => e.stopPropagation()}
          className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-cyan-500 rounded"
          aria-label={`Select alert ${alert.title}`}
        />

        {/* Expand toggle — wraps the rest of the content */}
        <button
          onClick={onToggle}
          className="flex flex-1 items-center gap-3 text-left min-w-0"
        >
          {/* Severity badge */}
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
              severityColor(alert.severity)
            )}
          >
            <ShieldAlert className="h-3 w-3" />
            {alert.severity}
          </span>

          {/* Title */}
          <span className="flex-1 truncate text-sm font-medium text-gray-200">
            {alert.title}
          </span>

          {/* Source camera — click to open video wall */}
          {alert.source_camera ? (
            <a
              href={`/video-wall?camera=${encodeURIComponent(alert.source_camera)}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="hidden items-center gap-1 text-xs text-cyan-500 hover:text-cyan-300 hover:underline md:flex"
              title={`View camera ${alert.source_camera} on video wall`}
            >
              <Camera className="h-3 w-3" />
              {alert.source_camera}
            </a>
          ) : (
            <span className="hidden items-center gap-1 text-xs text-gray-500 md:flex">
              <Camera className="h-3 w-3" />
              Unknown
            </span>
          )}

          {/* Dedup count badge */}
          {dedupCount && dedupCount > 1 && (
            <span className="hidden shrink-0 items-center gap-1 rounded-full bg-cyan-900/50 border border-cyan-700/50 px-2 py-0.5 text-[10px] font-bold text-cyan-400 md:flex">
              ×{dedupCount}
            </span>
          )}

          {/* Zone */}
          <span className="hidden items-center gap-1 text-xs text-gray-500 lg:flex">
            <MapPin className="h-3 w-3" />
            {alert.zone_name || "---"}
          </span>

          {/* Status badge */}
          <span
            className={cn(
              "shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
              "bg-gray-800 border border-gray-700",
              statusColor(alert.status)
            )}
          >
            {alert.status}
          </span>

          {/* Time ago */}
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-gray-500">
            <Clock className="h-3 w-3" />
            {timeAgo(alert.created_at)}
          </span>

          {/* Confidence */}
          <span className="shrink-0 w-12 text-right font-mono text-xs text-cyan-400">
            {Math.round((alert.confidence ?? 0) * 100)}%
          </span>

          {/* Expand indicator */}
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-gray-600 transition-transform duration-200",
              expanded && "rotate-180"
            )}
          />
        </button>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-gray-800 px-4 py-4 space-y-4">
          {/* Description */}
          {alert.description && (
            <div>
              <h4 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
                <FileText className="h-3.5 w-3.5" />
                Description
              </h4>
              <p className="text-sm leading-relaxed text-gray-300">
                {alert.description}
              </p>
            </div>
          )}

          {/* Gemini analysis - threat_type serves as a summary */}
          {alert.threat_type && (
            <div>
              <h4 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
                <Brain className="h-3.5 w-3.5 text-purple-400" />
                Gemini Analysis
              </h4>
              <p className="rounded-lg border border-purple-900/50 bg-purple-950/20 px-3 py-2 text-sm text-purple-300">
                Threat type: <span className="font-semibold">{alert.threat_type}</span>
              </p>
            </div>
          )}

          {/* Resolution notes */}
          {alert.resolution_notes && (
            <div>
              <h4 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
                <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />
                Resolution Notes
              </h4>
              <p className="rounded-lg border border-green-900/50 bg-green-950/20 px-3 py-2 text-sm text-green-300">
                {alert.resolution_notes}
              </p>
            </div>
          )}

          {/* Metadata row */}
          <div className="flex flex-wrap gap-4 text-xs text-gray-500">
            <span>ID: <span className="font-mono text-gray-400">{alert.id.slice(0, 8)}</span></span>
            {alert.event_id && (
              <span>Event: <span className="font-mono text-gray-400">{alert.event_id.slice(0, 8)}</span></span>
            )}
            <span>Created: <span className="text-gray-400">{formatTimestamp(alert.created_at)}</span></span>
            {alert.acknowledged_at && (
              <span>Acked: <span className="text-gray-400">{formatTimestamp(alert.acknowledged_at)}</span></span>
            )}
            {alert.resolved_at && (
              <span>Resolved: <span className="text-gray-400">{formatTimestamp(alert.resolved_at)}</span></span>
            )}
            {alert.assigned_to && (
              <span>Assigned: <span className="text-gray-400">{alert.assigned_to}</span></span>
            )}
          </div>

          {/* XAI Explanation Chain */}
          {expanded && (
            <div className="mt-3 border-t border-gray-800/50 pt-3">
              <div className="flex items-center gap-1.5 mb-2">
                <Brain className="h-3.5 w-3.5 text-purple-400" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-purple-400">Why This Alert</span>
              </div>
              {xaiLoading ? (
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Analyzing reasoning chain...
                </div>
              ) : xaiChain?.steps?.length > 0 ? (
                <div className="space-y-1.5">
                  {xaiChain.steps.map((step: any, i: number) => (
                    <div key={i} className="flex items-start gap-2">
                      <div className="flex flex-col items-center shrink-0">
                        <div className={cn(
                          "h-5 w-5 rounded-full flex items-center justify-center text-[8px] font-bold border",
                          step.impact === "high" ? "border-red-500/50 bg-red-500/10 text-red-400" :
                          step.impact === "medium" ? "border-yellow-500/50 bg-yellow-500/10 text-yellow-400" :
                          "border-cyan-500/50 bg-cyan-500/10 text-cyan-400"
                        )}>
                          {i + 1}
                        </div>
                        {i < xaiChain.steps.length - 1 && (
                          <div className="w-px h-3 bg-gray-700/50" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1 pb-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[9px] font-bold text-gray-300 uppercase">{step.stage}</span>
                          {step.confidence != null && (
                            <span className="text-[8px] text-gray-500 tabular-nums">{Math.round(step.confidence * 100)}%</span>
                          )}
                        </div>
                        <p className="text-[10px] text-gray-400 leading-tight">{step.description}</p>
                      </div>
                    </div>
                  ))}
                  {xaiChain.final_confidence != null && (
                    <div className="flex items-center gap-2 pt-1 border-t border-gray-800/30">
                      <span className="text-[9px] font-bold text-gray-500">Combined Confidence:</span>
                      <span className={cn(
                        "text-xs font-bold tabular-nums",
                        xaiChain.final_confidence >= 0.8 ? "text-red-400" :
                        xaiChain.final_confidence >= 0.5 ? "text-yellow-400" : "text-cyan-400"
                      )}>
                        {Math.round(xaiChain.final_confidence * 100)}%
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-[9px] text-gray-600">No explanation chain available for this alert.</p>
              )}
            </div>
          )}

          {/* Priority override */}
          <div className="flex items-center gap-2 pt-1 border-t border-gray-800/50">
            <ShieldAlert className="h-3.5 w-3.5 text-gray-500" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Override Severity</span>
            <div className="relative">
              <select
                value={severityOverride}
                disabled={severityUpdating}
                onChange={async (e) => {
                  const newSeverity = e.target.value;
                  setSeverityUpdating(true);
                  setSeverityOverride(newSeverity);
                  try {
                    await onSeverityChange(alert.id, newSeverity);
                  } finally {
                    setSeverityUpdating(false);
                  }
                }}
                className={cn(
                  "appearance-none rounded-lg border bg-gray-900 pl-2 pr-6 py-1 text-[11px] font-semibold focus:outline-none focus:ring-1 focus:ring-cyan-700",
                  severityOverride === "critical" ? "border-red-700/60 text-red-400" :
                  severityOverride === "high" ? "border-orange-700/60 text-orange-400" :
                  severityOverride === "medium" ? "border-yellow-700/60 text-yellow-400" :
                  severityOverride === "low" ? "border-blue-700/60 text-blue-400" :
                  "border-gray-700 text-gray-400",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
              >
                {["critical", "high", "medium", "low", "info"].map((s) => (
                  <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-500" />
            </div>
            {severityUpdating && <Loader2 className="h-3 w-3 animate-spin text-cyan-400" />}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 pt-1">
            {alert.status === "new" && (
              <>
                <button
                  onClick={() => onAction(alert.id, "acknowledge")}
                  disabled={isActioning}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                    "bg-yellow-900/40 text-yellow-400 border border-yellow-800/60",
                    "hover:bg-yellow-800/50 hover:text-yellow-300",
                    "disabled:opacity-50 disabled:cursor-not-allowed"
                  )}
                >
                  {isActioning ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  )}
                  Acknowledge
                </button>
                <button
                  onClick={() => onAction(alert.id, "dismiss")}
                  disabled={isActioning}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                    "bg-gray-800 text-gray-400 border border-gray-700",
                    "hover:bg-gray-700 hover:text-gray-300",
                    "disabled:opacity-50 disabled:cursor-not-allowed"
                  )}
                >
                  {isActioning ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5" />
                  )}
                  Dismiss
                </button>
              </>
            )}

            {alert.status === "acknowledged" && (
              <>
                <button
                  onClick={() => onAction(alert.id, "investigate")}
                  disabled={isActioning}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                    "bg-blue-900/40 text-blue-400 border border-blue-800/60",
                    "hover:bg-blue-800/50 hover:text-blue-300",
                    "disabled:opacity-50 disabled:cursor-not-allowed"
                  )}
                >
                  {isActioning ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Microscope className="h-3.5 w-3.5" />
                  )}
                  Investigate
                </button>
                <button
                  onClick={() => onAction(alert.id, "resolve")}
                  disabled={isActioning}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                    "bg-green-900/40 text-green-400 border border-green-800/60",
                    "hover:bg-green-800/50 hover:text-green-300",
                    "disabled:opacity-50 disabled:cursor-not-allowed"
                  )}
                >
                  {isActioning ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CheckCheck className="h-3.5 w-3.5" />
                  )}
                  Resolve
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AlertManagementPage                                                */
/* ------------------------------------------------------------------ */

export default function AlertManagementPage() {
  const { addToast } = useToast();

  /* --- State --- */
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [severity, setSeverity] = useState("all");
  const [status, setStatus] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Pagination
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  // UI state
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // New alerts badge count
  const [newCount, setNewCount] = useState(0);

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  // Deduplication toggle
  const [deduplicate, setDeduplicate] = useState(false);

  /* --- Fetch alerts --- */
  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    setError(null);
    setExpandedId(null);
    setSelectedIds(new Set());

    try {
      const offset = (page - 1) * PAGE_SIZE;
      const params = new URLSearchParams();
      if (severity !== "all") params.set("severity", severity);
      if (status !== "all") params.set("status", status);
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));

      const data = await apiFetch<Alert[]>(
        `/api/alerts?${params.toString()}`
      );
      setAlerts(data);
      setHasMore(data.length === PAGE_SIZE);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch alerts");
      setAlerts([]);
    } finally {
      setLoading(false);
    }
  }, [severity, status, dateFrom, dateTo, page]);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  /* --- Fetch new alerts count --- */
  useEffect(() => {
    apiFetch<Alert[]>("/api/alerts?status=new&limit=100")
      .then((data) => setNewCount(data.length))
      .catch((err: Error) => { console.warn("New alerts count failed:", err.message); });
  }, [alerts]);

  /* --- Reset page when filters change --- */
  useEffect(() => {
    setPage(1);
  }, [severity, status, dateFrom, dateTo]);

  /* --- Actions --- */
  const handleAction = useCallback(
    async (id: string, action: string) => {
      setActionLoading(id);
      try {
        const endpoint = `/api/alerts/${id}/${action}`;
        const updated = await apiFetch<Alert>(endpoint, { method: "POST" });
        setAlerts((prev) =>
          prev.map((a) => (a.id === id ? updated : a))
        );
        setError(null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Action failed";
        setError(`Failed to ${action} alert: ${msg}`);
        setTimeout(() => setError(null), 5000);
      } finally {
        setActionLoading(null);
      }
    },
    []
  );

  /* --- Deduplication derived state --- */
  // Group alerts with same threat_type + source_camera within 5-min windows
  const displayedAlerts = useMemo(() => {
    if (!deduplicate) return alerts;
    const FIVE_MIN_MS = 5 * 60 * 1000;
    const groups = new Map<string, { representative: Alert; count: number }>();
    for (const alert of alerts) {
      const bucket = Math.floor(new Date(alert.created_at).getTime() / FIVE_MIN_MS);
      const key = `${alert.threat_type ?? "__"}|${alert.source_camera ?? "__"}|${bucket}`;
      if (!groups.has(key)) {
        groups.set(key, { representative: alert, count: 1 });
      } else {
        groups.get(key)!.count += 1;
      }
    }
    return Array.from(groups.values()).map((g) => ({
      ...g.representative,
      _dedupCount: g.count,
    }));
  }, [alerts, deduplicate]);

  /* --- Selection helpers --- */
  const allSelected = displayedAlerts.length > 0 && selectedIds.size === displayedAlerts.length;
  const someSelected = selectedIds.size > 0 && selectedIds.size < displayedAlerts.length;

  const handleSelectAll = useCallback(
    (checked: boolean) => {
      if (checked) {
        setSelectedIds(new Set(displayedAlerts.map((a) => a.id)));
      } else {
        setSelectedIds(new Set());
      }
    },
    [displayedAlerts]
  );

  const handleSelectRow = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  /* --- Bulk Acknowledge --- */
  const handleBulkAcknowledge = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      const result = await apiFetch<{ acknowledged: number; total: number; errors: any[] }>(
        "/api/alerts/bulk-acknowledge",
        {
          method: "POST",
          body: JSON.stringify({ alert_ids: Array.from(selectedIds) }),
        }
      );
      addToast(
        "success",
        `Acknowledged ${result.acknowledged} of ${result.total} selected alert${result.total !== 1 ? "s" : ""}.`
      );
      setSelectedIds(new Set());
      // Refresh alerts to reflect new statuses
      await fetchAlerts();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bulk acknowledge failed";
      addToast("error", `Bulk acknowledge failed: ${msg}`);
    } finally {
      setBulkLoading(false);
    }
  }, [selectedIds, addToast, fetchAlerts]);

  /* --- Priority override (severity PATCH) --- */
  const handleSeverityChange = useCallback(
    async (id: string, newSeverity: string) => {
      try {
        const updated = await apiFetch<Alert>(`/api/alerts/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ severity: newSeverity }),
        });
        setAlerts((prev) => prev.map((a) => (a.id === id ? updated : a)));
        addToast("success", `Severity updated to ${newSeverity}.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Update failed";
        addToast("error", `Failed to update severity: ${msg}`);
      }
    },
    [addToast]
  );

  /* --- CSV Export --- */
  const handleExportCSV = useCallback(() => {
    if (alerts.length === 0) {
      addToast("info", "No alerts to export.");
      return;
    }
    try {
      const csv = alertsToCSV(alerts);
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      downloadCSV(csv, `alerts_export_${ts}.csv`);
      addToast("success", `Exported ${alerts.length} alert${alerts.length !== 1 ? "s" : ""} to CSV.`);
    } catch (err) {
      addToast("error", "CSV export failed. Please try again.");
    }
  }, [alerts, addToast]);

  /* --- Derived --- */
  const offset = (page - 1) * PAGE_SIZE;

  /* --- Render --- */
  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-900/30 border border-amber-800/50">
            <AlertTriangle className="h-5 w-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Alert Management
            </h1>
            <p className="text-xs text-gray-500">
              Monitor, triage, and resolve security alerts
            </p>
          </div>
        </div>

        {/* New alerts badge */}
        {newCount > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-red-800/60 bg-red-900/20 px-3 py-1.5">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
            </span>
            <span className="text-sm font-semibold text-red-400">
              {newCount} new
            </span>
          </div>
        )}
      </div>

      {/* ---- Filter bar ---- */}
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-800 px-6 py-3">
        {/* Severity filter */}
        <div className="relative">
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className="appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          >
            {SEVERITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
        </div>

        {/* Status filter */}
        <div className="relative">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
        </div>

        {/* Date from */}
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          placeholder="From"
        />

        {/* Date to */}
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          placeholder="To"
        />

        {/* Deduplicate toggle */}
        <button
          onClick={() => setDeduplicate((v) => !v)}
          title="Group duplicate alerts (same threat type + camera within 5 min)"
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors border",
            deduplicate
              ? "bg-cyan-900/40 text-cyan-400 border-cyan-700/60"
              : "bg-gray-800 text-gray-400 border-gray-700 hover:bg-gray-700 hover:text-gray-200"
          )}
        >
          <Layers className="h-3.5 w-3.5" />
          Deduplicate
          <span
            className={cn(
              "ml-0.5 inline-flex h-4 w-7 items-center rounded-full border transition-colors",
              deduplicate
                ? "border-cyan-600 bg-cyan-600"
                : "border-gray-600 bg-gray-700"
            )}
          >
            <span
              className={cn(
                "inline-block h-3 w-3 rounded-full bg-white shadow transition-transform",
                deduplicate ? "translate-x-3.5" : "translate-x-0.5"
              )}
            />
          </span>
        </button>

        {/* Export CSV button */}
        <button
          onClick={handleExportCSV}
          disabled={loading || alerts.length === 0}
          title="Export current page to CSV"
          className={cn(
            "ml-auto flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors border",
            "bg-gray-800 text-gray-300 border-gray-700",
            "hover:bg-gray-700 hover:text-gray-100",
            "disabled:opacity-40 disabled:cursor-not-allowed"
          )}
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </button>

        {/* Results info */}
        <div className="text-xs text-gray-500">
          {!loading && (
            <span>
              Showing {displayedAlerts.length > 0 ? offset + 1 : 0}
              &ndash;
              {offset + displayedAlerts.length} alerts
              {deduplicate && alerts.length !== displayedAlerts.length && (
                <span className="ml-1 text-cyan-500">
                  ({alerts.length} total, deduplicated)
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      {/* ---- Bulk action toolbar (visible when rows selected) ---- */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 border-b border-cyan-900/50 bg-cyan-950/20 px-6 py-2.5">
          <span className="text-xs font-semibold text-cyan-400">
            {selectedIds.size} alert{selectedIds.size !== 1 ? "s" : ""} selected
          </span>
          <button
            onClick={handleBulkAcknowledge}
            disabled={bulkLoading}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors border",
              "bg-yellow-900/40 text-yellow-400 border-yellow-800/60",
              "hover:bg-yellow-800/50 hover:text-yellow-300",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            {bulkLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCheck className="h-3.5 w-3.5" />
            )}
            Acknowledge Selected
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            disabled={bulkLoading}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* ---- Alert list ---- */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {/* Select All header row */}
        {!loading && !error && displayedAlerts.length > 0 && (
          <div className="flex items-center gap-3 px-4 py-1.5">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = someSelected;
              }}
              onChange={(e) => handleSelectAll(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-cyan-500 rounded"
              aria-label="Select all alerts"
            />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Select All
            </span>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
            <p className="mt-3 text-sm text-gray-500">Loading alerts...</p>
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="flex flex-col items-center justify-center py-20">
            <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={fetchAlerts}
              className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && displayedAlerts.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20">
            <CheckCircle2 className="mb-2 h-10 w-10 text-emerald-700" />
            <p className="text-sm font-medium text-gray-400">No alerts found</p>
            <p className="mt-1 text-xs text-gray-600">
              Adjust your filters or check back later
            </p>
          </div>
        )}

        {/* Alert rows */}
        {!loading &&
          !error &&
          (displayedAlerts as (Alert & { _dedupCount?: number })[]).map((alert) => (
            <AlertRow
              key={alert.id}
              alert={alert}
              expanded={expandedId === alert.id}
              onToggle={() =>
                setExpandedId(expandedId === alert.id ? null : alert.id)
              }
              onAction={handleAction}
              actionLoading={actionLoading}
              selected={selectedIds.has(alert.id)}
              onSelect={handleSelectRow}
              dedupCount={alert._dedupCount}
              onSeverityChange={handleSeverityChange}
            />
          ))}
      </div>

      {/* ---- Pagination ---- */}
      {!loading && !error && displayedAlerts.length > 0 && (
        <div className="flex items-center justify-between border-t border-gray-800 px-6 py-3">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              "border border-gray-700 bg-gray-900 text-gray-400",
              "hover:bg-gray-800 hover:text-gray-200",
              "disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-gray-900 disabled:hover:text-gray-400"
            )}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Previous
          </button>

          <span className="text-xs text-gray-500">
            Page <span className="font-semibold text-gray-300">{page}</span>
          </span>

          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={!hasMore}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              "border border-gray-700 bg-gray-900 text-gray-400",
              "hover:bg-gray-800 hover:text-gray-200",
              "disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-gray-900 disabled:hover:text-gray-400"
            )}
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
