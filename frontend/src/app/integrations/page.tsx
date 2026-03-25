"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Plug,
  Loader2,
  AlertTriangle,
  Plus,
  Pencil,
  Trash2,
  TestTube2,
  RefreshCw,
  Zap,
  Send,
  CheckCircle2,
  XCircle,
  Clock,
  Server,
  Webhook,
  Radio,
  Globe,
  X,
  ChevronDown,
  Activity,
  BarChart3,
  FileText,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";

/* ---------- Types ---------- */
interface IntegrationStats {
  active_connectors: number;
  events_today: number;
  failed_today: number;
}

interface Connector {
  id: string;
  name: string;
  type: string;
  config: Record<string, string>;
  event_filter: { types: string[]; min_severity: string };
  active: boolean;
  status: string;
  events_sent: number;
  last_sync: string | null;
  created_at: string;
  uptime_pct?: number | null;
  failed_count?: number | null;
}

interface DeliveryLog {
  id: string;
  connector_id: string;
  connector_name: string;
  event_type: string;
  status: string;
  error: string | null;
  timestamp: string;
}

interface TestResult {
  success: boolean;
  message: string;
  response_time_ms: number;
}

type TabId = "connectors" | "logs" | "test";

const TABS: { id: TabId; label: string; icon: typeof Plug }[] = [
  { id: "connectors", label: "Connectors", icon: Plug },
  { id: "logs", label: "Delivery Logs", icon: FileText },
  { id: "test", label: "Test Panel", icon: TestTube2 },
];

const CONNECTOR_TYPES = [
  { value: "syslog", label: "Syslog", icon: Server },
  { value: "cef", label: "CEF", icon: Radio },
  { value: "webhook", label: "Webhook", icon: Webhook },
  { value: "rest_api", label: "REST API", icon: Globe },
];

const typeIcons: Record<string, typeof Plug> = {
  syslog: Server,
  cef: Radio,
  webhook: Webhook,
  rest_api: Globe,
};

/* ---- Sync health dot helper ---- */
function syncHealthDot(lastSync: string | null, status: string): { cls: string; label: string } {
  if (status === "error" || status === "failed") return { cls: "bg-red-400", label: "Error" };
  if (!lastSync) return { cls: "bg-zinc-500", label: "No sync data" };
  const ageMin = (Date.now() - new Date(lastSync).getTime()) / 60000;
  if (ageMin < 5) return { cls: "bg-green-400", label: "Healthy" };
  return { cls: "bg-amber-400", label: "Stale" };
}

export default function IntegrationsPage() {
  const { addToast } = useToast();
  const [tab, setTab] = useState<TabId>("connectors");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<IntegrationStats>({ active_connectors: 0, events_today: 0, failed_today: 0 });

  /* ---- Connector State ---- */
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingConnector, setEditingConnector] = useState<Connector | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "", type: "webhook",
    host: "", port: "514", url: "", auth_token: "",
    event_types: "alert,incident", min_severity: "low", active: true,
  });

  /* ---- Logs State ---- */
  const [logs, setLogs] = useState<DeliveryLog[]>([]);
  const [logsConnectorId, setLogsConnectorId] = useState<string>("");

  /* ---- Test State ---- */
  const [testConnectorId, setTestConnectorId] = useState<string>("");
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  /* ========== Fetch ========== */

  const fetchStats = useCallback(async () => {
    try {
      const data = await apiFetch<any>("/api/integrations/stats");
      setStats({
        active_connectors: data.active_connectors ?? 0,
        events_today: data.events_today ?? data.delivered_today ?? 0,
        failed_today: data.failed_today ?? 0,
      });
    } catch { /* ignore */ }
  }, []);

  const fetchConnectors = useCallback(async () => {
    try {
      const data = await apiFetch<Connector[]>("/api/integrations/connectors");
      setConnectors(Array.isArray(data) ? data : []);
    } catch { /* ignore */ }
  }, []);

  const fetchLogs = useCallback(async (connectorId?: string) => {
    try {
      const cid = connectorId || logsConnectorId;
      const url = cid ? `/api/integrations/connectors/${cid}/logs` : "/api/integrations/connectors/all/logs";
      const data = await apiFetch<DeliveryLog[]>(url);
      setLogs(Array.isArray(data) ? data : []);
    } catch { /* ignore */ }
  }, [logsConnectorId]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const loader = async () => {
      try {
        await fetchStats();
        if (tab === "connectors") await fetchConnectors();
        if (tab === "logs") await fetchLogs();
        if (tab === "test") await fetchConnectors();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Load failed");
      } finally {
        setLoading(false);
      }
    };
    loader();
  }, [tab, fetchStats, fetchConnectors, fetchLogs]);

  /* ========== Connector Actions ========== */

  const saveConnector = async () => {
    try {
      const payload = {
        name: form.name,
        type: form.type,
        config: {
          ...(form.type === "syslog" || form.type === "cef" ? { host: form.host, port: form.port } : {}),
          ...(form.type === "webhook" || form.type === "rest_api" ? { url: form.url, auth_token: form.auth_token } : {}),
        },
        event_filter: {
          types: form.event_types.split(",").map((s) => s.trim()).filter(Boolean),
          min_severity: form.min_severity,
        },
        active: form.active,
      };
      if (editingConnector) {
        await apiFetch(`/api/integrations/connectors/${editingConnector.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/api/integrations/connectors", { method: "POST", body: JSON.stringify(payload) });
      }
      setShowForm(false);
      setEditingConnector(null);
      resetForm();
      await fetchConnectors();
      await fetchStats();
    } catch (err) { addToast("error", err instanceof Error ? err.message : "Save failed"); }
  };

  const deleteConnector = async (id: string) => {
    if (!window.confirm("Delete this connector?")) return;
    try {
      await apiFetch(`/api/integrations/connectors/${id}`, { method: "DELETE" });
      await fetchConnectors();
      await fetchStats();
    } catch (err) { addToast("error", err instanceof Error ? err.message : "Delete failed"); }
  };

  const handleRetry = async (id: string) => {
    setRetryingId(id);
    try {
      await apiFetch(`/api/integrations/${id}/retry`, { method: "POST" });
      addToast("success", "Retry queued successfully");
      await fetchConnectors();
      await fetchStats();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Retry failed";
      if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
        addToast("error", "Retry endpoint not available for this connector");
      } else {
        addToast("error", msg);
      }
    } finally {
      setRetryingId(null);
    }
  };

  const testConnector = async (id?: string) => {
    const cid = id || testConnectorId;
    if (!cid) return;
    setTesting(true);
    setTestResult(null);
    try {
      const data = await apiFetch<TestResult>(`/api/integrations/connectors/${cid}/test`, { method: "POST" });
      setTestResult(data);
    } catch (err) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : "Test failed", response_time_ms: 0 });
    } finally {
      setTesting(false);
    }
  };

  const startEdit = (c: Connector) => {
    setEditingConnector(c);
    setForm({
      name: c.name, type: c.type,
      host: c.config.host || "", port: c.config.port || "514",
      url: c.config.url || "", auth_token: c.config.auth_token || "",
      event_types: c.event_filter.types.join(", "),
      min_severity: c.event_filter.min_severity || "low",
      active: c.active,
    });
    setShowForm(true);
  };

  const resetForm = () => {
    setForm({ name: "", type: "webhook", host: "", port: "514", url: "", auth_token: "", event_types: "alert,incident", min_severity: "low", active: true });
  };

  const statusDot = (status: string) => {
    const map: Record<string, string> = {
      connected: "bg-green-400", healthy: "bg-green-400", active: "bg-green-400",
      error: "bg-red-400", failed: "bg-red-400",
      disconnected: "bg-zinc-500", inactive: "bg-zinc-500",
      warning: "bg-yellow-400",
    };
    return map[status] || "bg-zinc-500";
  };

  const logStatusBadge = (status: string) => {
    const map: Record<string, string> = {
      delivered: "bg-green-500/20 text-green-400 border-green-500/40",
      success: "bg-green-500/20 text-green-400 border-green-500/40",
      failed: "bg-red-500/20 text-red-400 border-red-500/40",
      pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/40",
      retrying: "bg-blue-500/20 text-blue-400 border-blue-500/40",
    };
    return map[status] || "bg-zinc-700 text-zinc-400 border-zinc-600";
  };

  return (
    <div className="min-h-screen bg-[#030712] text-zinc-100">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Plug className="w-5 h-5 text-cyan-400" />
          <h1 className="text-lg font-semibold">Integration Hub</h1>
        </div>
      </header>

      {/* Stats Bar */}
      <div className="border-b border-zinc-800 bg-zinc-950/40 px-6 py-4">
        <div className="grid grid-cols-3 gap-4 max-w-3xl">
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-cyan-400">{stats.active_connectors}</p>
            <p className="text-xs text-zinc-500 mt-1">Active Connectors</p>
          </div>
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-green-400">{stats.events_today.toLocaleString()}</p>
            <p className="text-xs text-zinc-500 mt-1">Events Delivered Today</p>
          </div>
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-red-400">{stats.failed_today}</p>
            <p className="text-xs text-zinc-500 mt-1">Failed Today</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-zinc-800 bg-zinc-950/40 px-6">
        <nav className="flex gap-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={cn("flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition",
                  tab === t.id ? "border-cyan-400 text-cyan-400" : "border-transparent text-zinc-500 hover:text-zinc-300")}>
                <Icon className="w-4 h-4" /> {t.label}
              </button>
            );
          })}
        </nav>
      </div>

      <main className="p-6 max-w-7xl mx-auto">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin text-cyan-400" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-64 gap-3">
            <AlertTriangle className="w-8 h-8 text-red-400" />
            <p className="text-red-400">{error}</p>
          </div>
        ) : (
          <>
            {/* ========== CONNECTORS ========== */}
            {tab === "connectors" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Connectors</h2>
                  <button onClick={() => { setEditingConnector(null); resetForm(); setShowForm(true); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600/20 text-cyan-400 hover:bg-cyan-600/30 text-sm transition">
                    <Plus className="w-4 h-4" /> New Connector
                  </button>
                </div>

                {/* Connector Form */}
                {showForm && (
                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium text-zinc-200">{editingConnector ? "Edit Connector" : "New Connector"}</h3>
                      <button onClick={() => { setShowForm(false); setEditingConnector(null); }} className="text-zinc-500 hover:text-zinc-300"><X className="w-4 h-4" /></button>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div>
                        <label className="text-xs text-zinc-500 mb-1 block">Name</label>
                        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500" placeholder="My SIEM Connector" />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-500 mb-1 block">Type</label>
                        <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500">
                          {CONNECTOR_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                      </div>
                      <div className="flex items-end">
                        <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
                          <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })}
                            className="rounded bg-zinc-700 border-zinc-600 text-cyan-500 focus:ring-cyan-500" />
                          Active
                        </label>
                      </div>
                    </div>

                    {/* Config fields based on type */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {(form.type === "syslog" || form.type === "cef") && (
                        <>
                          <div>
                            <label className="text-xs text-zinc-500 mb-1 block">Host</label>
                            <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })}
                              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500" placeholder="syslog.example.com" />
                          </div>
                          <div>
                            <label className="text-xs text-zinc-500 mb-1 block">Port</label>
                            <input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })}
                              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500" placeholder="514" />
                          </div>
                        </>
                      )}
                      {(form.type === "webhook" || form.type === "rest_api") && (
                        <>
                          <div>
                            <label className="text-xs text-zinc-500 mb-1 block">URL</label>
                            <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })}
                              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500" placeholder="https://api.example.com/events" />
                          </div>
                          <div>
                            <label className="text-xs text-zinc-500 mb-1 block">Auth Token</label>
                            <input type="password" value={form.auth_token} onChange={(e) => setForm({ ...form, auth_token: e.target.value })}
                              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500" placeholder="Bearer token" />
                          </div>
                        </>
                      )}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-zinc-500 mb-1 block">Event Types (comma-separated)</label>
                        <input value={form.event_types} onChange={(e) => setForm({ ...form, event_types: e.target.value })}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500" placeholder="alert, incident, camera_event" />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-500 mb-1 block">Min Severity</label>
                        <select value={form.min_severity} onChange={(e) => setForm({ ...form, min_severity: e.target.value })}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500">
                          <option value="info">Info</option>
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                          <option value="critical">Critical</option>
                        </select>
                      </div>
                    </div>

                    <div className="flex justify-end gap-2">
                      <button onClick={() => { setShowForm(false); setEditingConnector(null); }}
                        className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition">Cancel</button>
                      <button onClick={saveConnector}
                        className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-medium transition">
                        {editingConnector ? "Update" : "Create"}
                      </button>
                    </div>
                  </div>
                )}

                {/* Connector Cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {connectors.map((c) => {
                    const Icon = typeIcons[c.type] || Plug;
                    const syncDot = syncHealthDot(c.last_sync, c.status);
                    const hasFailures = (c.failed_count ?? 0) > 0;
                    return (
                      <div key={c.id} className="bg-zinc-950/60 border border-zinc-800 rounded-xl p-4 hover:border-zinc-700 transition">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-zinc-900 flex items-center justify-center">
                              <Icon className="w-5 h-5 text-cyan-400" />
                            </div>
                            <div>
                              <h3 className="text-sm font-medium text-zinc-200">{c.name}</h3>
                              <p className="text-xs text-zinc-500 capitalize">{c.type.replace("_", " ")}</p>
                            </div>
                          </div>
                          {/* Sync health dot with tooltip label */}
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className={cn("w-2.5 h-2.5 rounded-full shrink-0", syncDot.cls)} title={syncDot.label} />
                            <span className="text-[10px] text-zinc-500">{syncDot.label}</span>
                          </div>
                        </div>
                        <div className="space-y-1.5 text-xs mb-3">
                          <div className="flex justify-between">
                            <span className="text-zinc-500">Events Sent</span>
                            <span className="text-zinc-300">{c.events_sent.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-zinc-500">Last Sync</span>
                            <span className="text-zinc-400">
                              {c.last_sync ? new Date(c.last_sync).toLocaleString() : "No sync data"}
                            </span>
                          </div>
                          {c.uptime_pct != null && (
                            <div className="flex justify-between">
                              <span className="text-zinc-500">Uptime</span>
                              <span className="text-zinc-300">{c.uptime_pct.toFixed(1)}%</span>
                            </div>
                          )}
                          <div className="flex justify-between">
                            <span className="text-zinc-500">Status</span>
                            <span className={cn("capitalize", c.active ? "text-green-400" : "text-zinc-500")}>{c.active ? "Active" : "Inactive"}</span>
                          </div>
                        </div>
                        {/* Failed count badge + Retry */}
                        {hasFailures && (
                          <div className="flex items-center justify-between mb-2 rounded-lg bg-red-900/20 border border-red-800/40 px-2.5 py-1.5">
                            <span className="flex items-center gap-1.5 text-xs text-red-400">
                              <XCircle className="w-3 h-3" />
                              Failed: {c.failed_count}
                            </span>
                            <button
                              onClick={() => handleRetry(c.id)}
                              disabled={retryingId === c.id}
                              className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-600/30 hover:bg-red-600/50 text-red-300 text-[10px] transition disabled:opacity-50"
                            >
                              {retryingId === c.id ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <RefreshCw className="w-2.5 h-2.5" />}
                              Retry
                            </button>
                          </div>
                        )}
                        <div className="flex gap-1.5 border-t border-zinc-800 pt-3">
                          <button onClick={() => startEdit(c)}
                            className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 text-xs transition">
                            <Pencil className="w-3 h-3" /> Edit
                          </button>
                          <button onClick={() => testConnector(c.id)}
                            className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg bg-cyan-600/20 hover:bg-cyan-600/30 text-cyan-400 text-xs transition">
                            <TestTube2 className="w-3 h-3" /> Test
                          </button>
                          <button onClick={() => deleteConnector(c.id)}
                            className="flex items-center justify-center px-2 py-1.5 rounded-lg bg-zinc-800 hover:bg-red-900/30 text-zinc-500 hover:text-red-400 text-xs transition">
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {connectors.length === 0 && (
                    <div className="col-span-full flex flex-col items-center justify-center py-16 text-zinc-600">
                      <Plug className="w-12 h-12 mb-3" />
                      <p>No connectors configured</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ========== DELIVERY LOGS ========== */}
            {tab === "logs" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Delivery Logs</h2>
                  <div className="flex items-center gap-2">
                    <select value={logsConnectorId} onChange={(e) => { setLogsConnectorId(e.target.value); fetchLogs(e.target.value); }}
                      className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500">
                      <option value="">All Connectors</option>
                      {connectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <button onClick={() => fetchLogs()} className="p-1.5 rounded-lg bg-zinc-800 text-zinc-400 hover:bg-zinc-700 transition">
                      <RefreshCw className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="bg-zinc-950/60 border border-zinc-800 rounded-xl overflow-hidden max-h-[600px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-zinc-900/90 backdrop-blur">
                      <tr className="border-b border-zinc-800">
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Time</th>
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Connector</th>
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Event Type</th>
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Status</th>
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Error</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/60">
                      {logs.map((l) => (
                        <tr key={l.id} className="hover:bg-zinc-900/30 transition">
                          <td className="px-4 py-2.5 text-zinc-500 text-xs whitespace-nowrap">{new Date(l.timestamp).toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-zinc-300">{l.connector_name}</td>
                          <td className="px-4 py-2.5">
                            <span className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 text-xs">{l.event_type}</span>
                          </td>
                          <td className="px-4 py-2.5">
                            <span className={cn("px-2 py-0.5 rounded border text-xs capitalize", logStatusBadge(l.status))}>
                              {l.status}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-red-400/70 text-xs max-w-xs truncate">{l.error || "-"}</td>
                        </tr>
                      ))}
                      {logs.length === 0 && (
                        <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-600">No delivery logs found</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ========== TEST PANEL ========== */}
            {tab === "test" && (
              <div className="space-y-6 max-w-2xl">
                <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Test Connector</h2>
                <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-6 space-y-4">
                  <div>
                    <label className="text-xs text-zinc-500 mb-1 block">Select Connector</label>
                    <select value={testConnectorId} onChange={(e) => { setTestConnectorId(e.target.value); setTestResult(null); }}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500">
                      <option value="">-- Select a connector --</option>
                      {connectors.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.type})</option>)}
                    </select>
                  </div>
                  <button onClick={() => testConnector()} disabled={!testConnectorId || testing}
                    className="flex items-center justify-center gap-2 w-full px-4 py-3 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-medium transition disabled:opacity-50">
                    {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    Send Test Event
                  </button>

                  {testResult && (
                    <div className={cn("rounded-xl border p-4 space-y-2",
                      testResult.success ? "border-green-500/40 bg-green-500/10" : "border-red-500/40 bg-red-500/10")}>
                      <div className="flex items-center gap-2">
                        {testResult.success ? <CheckCircle2 className="w-5 h-5 text-green-400" /> : <XCircle className="w-5 h-5 text-red-400" />}
                        <span className={cn("font-medium", testResult.success ? "text-green-400" : "text-red-400")}>
                          {testResult.success ? "Test Passed" : "Test Failed"}
                        </span>
                      </div>
                      <p className="text-sm text-zinc-300">{testResult.message}</p>
                      {testResult.response_time_ms > 0 && (
                        <p className="text-xs text-zinc-500">Response time: {testResult.response_time_ms}ms</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
