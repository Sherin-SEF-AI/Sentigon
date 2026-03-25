"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Webhook,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Plus,
  Trash2,
  TestTube2,
  RefreshCw,
  Send,
  XCircle,
  Clock,
  ChevronDown,
  Settings2,
  Activity,
  Eye,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface WebhookConfigType {
  id: string;
  name: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  secret: string | null;
  event_types: string[];
  severity_filter: string | null;
  is_active: boolean;
  retry_count: number;
  retry_delay_seconds: number;
  integration_type: string;
  template: Record<string, unknown> | null;
  last_triggered_at: string | null;
  last_status: string | null;
  created_at: string | null;
}

interface DeliveryLog {
  id: string;
  webhook_id: string;
  event_type: string;
  status_code: number | null;
  success: boolean;
  attempt_number: number;
  error_message: string | null;
  delivered_at: string | null;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const INTEGRATION_TYPES = [
  { value: "generic", label: "Generic Webhook" },
  { value: "slack", label: "Slack" },
  { value: "teams", label: "Microsoft Teams" },
  { value: "jira", label: "Jira" },
  { value: "splunk", label: "Splunk HEC" },
];

const EVENT_TYPES = [
  "alert",
  "threat",
  "compliance",
  "tamper",
  "anomaly",
  "incident",
];

const SEVERITY_OPTIONS = [
  { value: "", label: "All Severities" },
  { value: "info", label: "Info+" },
  { value: "low", label: "Low+" },
  { value: "medium", label: "Medium+" },
  { value: "high", label: "High+" },
  { value: "critical", label: "Critical Only" },
];

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

function statusBadge(status: string | null, isActive: boolean): string {
  if (!isActive) return "bg-gray-800 text-gray-500 border-gray-700";
  if (!status) return "bg-gray-800 text-gray-400 border-gray-700";
  if (status === "success")
    return "bg-green-900/40 text-green-400 border-green-800/60";
  return "bg-red-900/40 text-red-400 border-red-800/60";
}

function integrationColor(type: string): string {
  switch (type) {
    case "slack":
      return "text-purple-400";
    case "teams":
      return "text-blue-400";
    case "jira":
      return "text-blue-300";
    case "splunk":
      return "text-green-400";
    default:
      return "text-gray-400";
  }
}

/* ------------------------------------------------------------------ */
/*  WebhooksPage                                                       */
/* ------------------------------------------------------------------ */

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<WebhookConfigType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [showCreate, setShowCreate] = useState(false);
  const [formName, setFormName] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formType, setFormType] = useState("generic");
  const [formSecret, setFormSecret] = useState("");
  const [formEventTypes, setFormEventTypes] = useState<string[]>([]);
  const [formSeverity, setFormSeverity] = useState("");
  const [formSaving, setFormSaving] = useState(false);

  // Action state
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    id: string;
    success: boolean;
    message: string;
    status_code?: number | null;
    body?: string | null;
  } | null>(null);

  // Logs
  const [selectedWebhookId, setSelectedWebhookId] = useState<string | null>(null);
  const [logs, setLogs] = useState<DeliveryLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  /* --- Fetch webhooks --- */
  const fetchWebhooks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ webhooks: WebhookConfigType[] }>(
        "/api/webhooks"
      );
      setWebhooks(data.webhooks);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch webhooks"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWebhooks();
  }, [fetchWebhooks]);

  /* --- Create webhook --- */
  const handleCreate = useCallback(async () => {
    if (!formName.trim() || !formUrl.trim()) return;
    setFormSaving(true);
    try {
      await apiFetch("/api/webhooks", {
        method: "POST",
        body: JSON.stringify({
          name: formName,
          url: formUrl,
          integration_type: formType,
          secret: formSecret || null,
          event_types: formEventTypes.length > 0 ? formEventTypes : null,
          severity_filter: formSeverity || null,
        }),
      });
      setShowCreate(false);
      setFormName("");
      setFormUrl("");
      setFormType("generic");
      setFormSecret("");
      setFormEventTypes([]);
      setFormSeverity("");
      await fetchWebhooks();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create webhook"
      );
    } finally {
      setFormSaving(false);
    }
  }, [formName, formUrl, formType, formSecret, formEventTypes, formSeverity, fetchWebhooks]);

  /* --- Delete webhook --- */
  const handleDelete = useCallback(
    async (id: string) => {
      setActionLoading(`delete-${id}`);
      try {
        await apiFetch(`/api/webhooks/${id}`, { method: "DELETE" });
        await fetchWebhooks();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to delete webhook"
        );
      } finally {
        setActionLoading(null);
      }
    },
    [fetchWebhooks]
  );

  /* --- Toggle active --- */
  const handleToggle = useCallback(
    async (id: string, currentActive: boolean) => {
      setActionLoading(`toggle-${id}`);
      try {
        await apiFetch(`/api/webhooks/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ is_active: !currentActive }),
        });
        await fetchWebhooks();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to update webhook"
        );
      } finally {
        setActionLoading(null);
      }
    },
    [fetchWebhooks]
  );

  /* --- Test webhook --- */
  const handleTest = useCallback(async (id: string) => {
    setActionLoading(`test-${id}`);
    setTestResult(null);
    try {
      const result = await apiFetch<{
        webhook_id: string;
        success: boolean;
        error?: string;
        status_code?: number;
        response_body?: string;
      }>(`/api/webhooks/${id}/test`, { method: "POST" });
      setTestResult({
        id,
        success: result.success,
        status_code: result.status_code ?? null,
        body: result.response_body ?? null,
        message: result.success
          ? `Test passed${result.status_code ? ` (HTTP ${result.status_code})` : ""}`
          : result.error || "Test failed",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Test failed";
      const is404 = msg.includes("404") || msg.toLowerCase().includes("not found");
      setTestResult({
        id,
        success: false,
        status_code: is404 ? 404 : null,
        body: null,
        message: is404 ? "Test endpoint not available (404)" : msg,
      });
    } finally {
      setActionLoading(null);
    }
  }, []);

  /* --- Load logs --- */
  const handleViewLogs = useCallback(async (id: string) => {
    if (selectedWebhookId === id) {
      setSelectedWebhookId(null);
      return;
    }
    setSelectedWebhookId(id);
    setLogsLoading(true);
    try {
      const data = await apiFetch<{ logs: DeliveryLog[] }>(
        `/api/webhooks/${id}/logs?limit=20`
      );
      setLogs(data.logs);
    } catch {
      setLogs([]);
    } finally {
      setLogsLoading(false);
    }
  }, [selectedWebhookId]);

  /* --- Toggle event type selection --- */
  const toggleEventType = (type: string) => {
    setFormEventTypes((prev) =>
      prev.includes(type)
        ? prev.filter((t) => t !== type)
        : [...prev, type]
    );
  };

  /* --- Render --- */
  return (
    <div className="flex h-full flex-col overflow-auto bg-gray-950 text-gray-100">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-900/30 border border-indigo-800/50">
            <Webhook className="h-5 w-5 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Webhooks
            </h1>
            <p className="text-xs text-gray-500">
              Push events to Slack, Teams, Jira, Splunk, and custom endpoints
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={fetchWebhooks}
            className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-indigo-500"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Webhook
          </button>
        </div>
      </div>

      {/* ---- Create Form ---- */}
      {showCreate && (
        <div className="border-b border-gray-800 bg-gray-900/50 px-6 py-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-300">
            New Webhook
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {/* Name */}
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                Name
              </label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Slack Security Channel"
                className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:border-indigo-600 focus:outline-none"
              />
            </div>

            {/* URL */}
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                URL
              </label>
              <input
                type="url"
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                placeholder="https://hooks.slack.com/services/..."
                className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:border-indigo-600 focus:outline-none"
              />
            </div>

            {/* Integration Type */}
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                Integration
              </label>
              <div className="relative">
                <select
                  value={formType}
                  onChange={(e) => setFormType(e.target.value)}
                  className="w-full appearance-none rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 pr-8 text-xs text-gray-300 focus:border-indigo-600 focus:outline-none"
                >
                  {INTEGRATION_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
              </div>
            </div>

            {/* Secret */}
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                HMAC Secret (optional)
              </label>
              <input
                type="password"
                value={formSecret}
                onChange={(e) => setFormSecret(e.target.value)}
                placeholder="Signing key for X-Webhook-Signature"
                className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:border-indigo-600 focus:outline-none"
              />
            </div>

            {/* Severity Filter */}
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                Min Severity
              </label>
              <div className="relative">
                <select
                  value={formSeverity}
                  onChange={(e) => setFormSeverity(e.target.value)}
                  className="w-full appearance-none rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 pr-8 text-xs text-gray-300 focus:border-indigo-600 focus:outline-none"
                >
                  {SEVERITY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
              </div>
            </div>

            {/* Event Types */}
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                Event Types (empty = all)
              </label>
              <div className="flex flex-wrap gap-1.5">
                {EVENT_TYPES.map((type) => (
                  <button
                    key={type}
                    onClick={() => toggleEventType(type)}
                    className={cn(
                      "rounded px-2 py-1 text-[10px] font-medium border transition-colors",
                      formEventTypes.includes(type)
                        ? "bg-indigo-900/40 text-indigo-400 border-indigo-800/60"
                        : "bg-gray-800 text-gray-500 border-gray-700 hover:text-gray-300"
                    )}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              onClick={handleCreate}
              disabled={!formName.trim() || !formUrl.trim() || formSaving}
              className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {formSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Create Webhook
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="rounded-lg border border-gray-700 px-4 py-2 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ---- Test Result Card ---- */}
      {testResult && (
        <div
          className={cn(
            "mx-6 mt-4 rounded-lg border p-3 space-y-2",
            testResult.success
              ? "border-green-800/60 bg-green-950/30"
              : "border-red-800/60 bg-red-950/30"
          )}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {testResult.success ? (
                <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />
              ) : (
                <XCircle className="h-4 w-4 text-red-400 shrink-0" />
              )}
              <span
                className={cn(
                  "text-sm font-medium",
                  testResult.success ? "text-green-300" : "text-red-300"
                )}
              >
                {testResult.message}
              </span>
              {testResult.status_code != null && (
                <span className={cn(
                  "rounded px-1.5 py-0.5 font-mono text-[10px] font-bold border",
                  testResult.success
                    ? "bg-green-900/40 text-green-400 border-green-800/50"
                    : "bg-red-900/40 text-red-400 border-red-800/50"
                )}>
                  HTTP {testResult.status_code}
                </span>
              )}
            </div>
            <button
              onClick={() => setTestResult(null)}
              className="text-xs text-gray-500 hover:text-gray-300"
            >
              Dismiss
            </button>
          </div>
          {testResult.body && (
            <pre className="rounded bg-gray-950/60 border border-gray-800 px-3 py-2 text-[10px] text-gray-400 font-mono overflow-x-auto max-h-24 overflow-y-auto">
              {testResult.body}
            </pre>
          )}
        </div>
      )}

      {/* ---- Content ---- */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
            <p className="mt-3 text-sm text-gray-500">Loading webhooks...</p>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="flex flex-col items-center justify-center py-20">
            <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={() => {
                setError(null);
                fetchWebhooks();
              }}
              className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty */}
        {!loading && !error && webhooks.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20">
            <Webhook className="mb-2 h-10 w-10 text-gray-700" />
            <p className="text-sm font-medium text-gray-400">
              No webhooks configured
            </p>
            <p className="mt-1 text-xs text-gray-600">
              Click &quot;Add Webhook&quot; to set up your first integration
            </p>
          </div>
        )}

        {/* Webhook list */}
        {!loading && !error && webhooks.length > 0 && (
          <div className="px-6 py-4 space-y-3">
            {webhooks.map((wh) => (
              <div key={wh.id}>
                <div
                  className={cn(
                    "rounded-lg border p-4 transition-shadow hover:shadow-lg hover:shadow-indigo-900/10",
                    wh.is_active
                      ? "border-gray-800 bg-gray-900/60"
                      : "border-gray-800/50 bg-gray-900/30 opacity-60"
                  )}
                >
                  {/* Header row */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-lg border",
                          wh.is_active
                            ? "bg-indigo-900/30 border-indigo-800/50"
                            : "bg-gray-800 border-gray-700"
                        )}
                      >
                        <Send
                          className={cn(
                            "h-4 w-4",
                            wh.is_active ? "text-indigo-400" : "text-gray-600"
                          )}
                        />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-semibold text-gray-200">
                            {wh.name}
                          </h3>
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-[10px] font-medium border",
                              integrationColor(wh.integration_type),
                              "bg-gray-800 border-gray-700"
                            )}
                          >
                            {wh.integration_type}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-gray-500 font-mono truncate max-w-md">
                          {wh.url}
                        </p>
                      </div>
                    </div>

                    {/* Status + Actions */}
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "inline-flex items-center rounded px-2 py-0.5 text-[10px] font-semibold border",
                          statusBadge(wh.last_status, wh.is_active)
                        )}
                      >
                        {!wh.is_active
                          ? "Inactive"
                          : wh.last_status || "Never triggered"}
                      </span>

                      <button
                        onClick={() => handleTest(wh.id)}
                        disabled={actionLoading === `test-${wh.id}`}
                        className="flex items-center gap-1 rounded-lg border border-gray-700 bg-gray-900 px-2 py-1.5 text-[11px] text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors disabled:opacity-50"
                      >
                        {actionLoading === `test-${wh.id}` ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <TestTube2 className="h-3 w-3" />
                        )}
                        Test
                      </button>

                      <button
                        onClick={() => handleToggle(wh.id, wh.is_active)}
                        disabled={actionLoading === `toggle-${wh.id}`}
                        className={cn(
                          "flex items-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] transition-colors disabled:opacity-50",
                          wh.is_active
                            ? "border-yellow-800/50 text-yellow-400 hover:bg-yellow-900/20"
                            : "border-green-800/50 text-green-400 hover:bg-green-900/20"
                        )}
                      >
                        {wh.is_active ? "Disable" : "Enable"}
                      </button>

                      <button
                        onClick={() => handleViewLogs(wh.id)}
                        className="flex items-center gap-1 rounded-lg border border-gray-700 bg-gray-900 px-2 py-1.5 text-[11px] text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
                      >
                        <Eye className="h-3 w-3" />
                        Logs
                      </button>

                      <button
                        onClick={() => handleDelete(wh.id)}
                        disabled={actionLoading === `delete-${wh.id}`}
                        className="flex items-center gap-1 rounded-lg border border-red-800/40 px-2 py-1.5 text-[11px] text-red-400 hover:bg-red-900/20 transition-colors disabled:opacity-50"
                      >
                        {actionLoading === `delete-${wh.id}` ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Detail row */}
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-gray-500">
                    {wh.event_types.length > 0 && (
                      <div className="flex items-center gap-1">
                        <Activity className="h-3 w-3" />
                        Events: {wh.event_types.join(", ")}
                      </div>
                    )}
                    {wh.severity_filter && (
                      <div className="flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        Min severity: {wh.severity_filter}
                      </div>
                    )}
                    {wh.last_triggered_at && (
                      <div className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        Last: {timeAgo(wh.last_triggered_at)}
                      </div>
                    )}
                    <div className="flex items-center gap-1">
                      <Settings2 className="h-3 w-3" />
                      Retries: {wh.retry_count}
                    </div>
                  </div>
                </div>

                {/* Delivery Logs (expandable) */}
                {selectedWebhookId === wh.id && (
                  <div className="ml-4 mt-1 rounded-lg border border-gray-800/50 bg-gray-900/30 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                        Recent Deliveries
                      </h4>
                      {/* Last-5 delivery dots */}
                      {!logsLoading && logs.length > 0 && (
                        <div className="flex items-center gap-1" title="Last 5 delivery attempts (newest right)">
                          {logs.slice(0, 5).reverse().map((log) => (
                            <span
                              key={log.id}
                              title={`${log.event_type}${log.status_code ? ` HTTP ${log.status_code}` : ""}${log.delivered_at ? ` • ${timeAgo(log.delivered_at)}` : ""}`}
                              className={cn(
                                "h-2.5 w-2.5 rounded-full border",
                                log.success
                                  ? "bg-green-500 border-green-400"
                                  : "bg-red-500 border-red-400"
                              )}
                            />
                          ))}
                          <span className="ml-1 text-[9px] text-gray-600">last {Math.min(logs.length, 5)}</span>
                        </div>
                      )}
                    </div>
                    {logsLoading ? (
                      <div className="flex items-center gap-2 py-4">
                        <Loader2 className="h-4 w-4 animate-spin text-gray-500" />
                        <span className="text-xs text-gray-500">
                          Loading logs...
                        </span>
                      </div>
                    ) : logs.length === 0 ? (
                      <p className="py-2 text-xs text-gray-600">
                        No delivery logs yet
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {logs.map((log) => (
                          <div
                            key={log.id}
                            className="flex items-center justify-between rounded px-2 py-1.5 text-[11px] hover:bg-gray-800/50"
                          >
                            <div className="flex items-center gap-2">
                              {log.success ? (
                                <CheckCircle2 className="h-3 w-3 text-green-500" />
                              ) : (
                                <XCircle className="h-3 w-3 text-red-500" />
                              )}
                              <span className="text-gray-400">
                                {log.event_type}
                              </span>
                              {log.status_code && (
                                <span
                                  className={cn(
                                    "font-mono",
                                    log.success
                                      ? "text-green-500"
                                      : "text-red-500"
                                  )}
                                >
                                  HTTP {log.status_code}
                                </span>
                              )}
                              {log.error_message && (
                                <span className="text-red-400 truncate max-w-[200px]">
                                  {log.error_message}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 text-gray-600">
                              <span>Attempt {log.attempt_number}</span>
                              {log.delivered_at && (
                                <span>{timeAgo(log.delivered_at)}</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
