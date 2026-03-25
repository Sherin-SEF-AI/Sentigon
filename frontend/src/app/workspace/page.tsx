"use client";

import { useState, useEffect, useCallback } from "react";
import {
  LayoutGrid,
  Settings2,
  Sun,
  Moon,
  ClipboardList,
  AlertTriangle,
  Gauge,
  Hash,
  Users,
  Cpu,
  TrendingUp,
  Clock,
  Zap,
  GripVertical,
  Plus,
  Save,
  RotateCcw,
  X,
  Loader2,
  Shield,
  Lock,
  CheckCircle2,
  RefreshCw,
  Activity,
  BarChart3,
  Settings,
  ExternalLink,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import { useRouter } from "next/navigation";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

/* ---------- Types ---------- */
interface WidgetConfig {
  id: string;
  type: string;
  title: string;
  col_span: number;
  row_span: number;
  position: number;
  config: Record<string, unknown>;
}

interface WorkspaceLayout {
  user_id: string;
  widgets: WidgetConfig[];
  theme: string;
}

interface ShiftBriefing {
  shift: string;
  summary: string;
  key_events: string[];
  recommendations: string[];
  generated_at: string;
}

/* Map each widget type to its real API endpoint */
const WIDGET_ENDPOINTS: Record<string, string> = {
  AlertFeed:     "/api/alerts?limit=20",
  ThreatLevel:   "/api/analytics/soc-metrics",
  IncidentCount: "/api/alerts/stats",
  ZoneOccupancy: "/api/analytics/zone-occupancy",
  AgentStatus:   "/api/cameras",
  MetricsChart:  "/api/analytics/events-over-time?hours=24&bucket_minutes=60",
  ShiftInfo:     "/api/health/deep",
};

/* Transform raw API responses into the shape each widget renderer expects */
function transformWidgetData(type: string, raw: unknown): unknown {
  if (raw == null) return null;

  switch (type) {
    case "AlertFeed": {
      // GET /api/alerts returns an array of AlertResponse objects
      const alerts = Array.isArray(raw) ? raw : [];
      return alerts.map((a: Record<string, unknown>) => ({
        severity: (a.severity as string) || "info",
        message: (a.title as string) || (a.description as string) || "Alert",
        time: a.created_at
          ? new Date(a.created_at as string).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
          : "",
      }));
    }

    case "ThreatLevel": {
      // GET /api/analytics/soc-metrics returns SOCMetrics
      const d = raw as Record<string, unknown>;
      const levelMap: Record<string, number> = { normal: 1, elevated: 3, high: 4, critical: 5 };
      const labelMap: Record<string, string> = { normal: "Normal", elevated: "Elevated", high: "High", critical: "Critical" };
      const tl = (d.threat_level as string) || "normal";
      return { level: levelMap[tl] ?? 1, label: labelMap[tl] ?? "Normal" };
    }

    case "IncidentCount": {
      // GET /api/alerts/stats returns { total, by_severity, by_status }
      const d = raw as Record<string, unknown>;
      const byStatus = (d.by_status as Record<string, number>) || {};
      const active = (byStatus["new"] || 0) + (byStatus["acknowledged"] || 0) + (byStatus["investigating"] || 0) + (byStatus["escalated"] || 0);
      return { count: active, change: 0 };
    }

    case "ZoneOccupancy": {
      // GET /api/analytics/zone-occupancy returns AnalyticsResponse { data: [...] }
      const d = raw as Record<string, unknown>;
      const zones = Array.isArray(d.data) ? d.data : [];
      return zones.map((z: Record<string, unknown>) => ({
        name: (z.zone_name as string) || "Zone",
        occupancy: Number(z.current_occupancy ?? 0),
        capacity: Number(z.max_occupancy ?? 100),
      }));
    }

    case "AgentStatus": {
      // GET /api/cameras returns a list of CameraResponse objects — use cameras as agent proxies
      const cameras = Array.isArray(raw) ? raw : [];
      return cameras.map((c: Record<string, unknown>) => ({
        name: (c.name as string) || "Camera",
        running: (c.status as string) === "online" && c.is_active === true,
      }));
    }

    case "MetricsChart": {
      // GET /api/analytics/events-over-time returns AnalyticsResponse { data: [{timestamp, count}] }
      const d = raw as Record<string, unknown>;
      const points = Array.isArray(d.data) ? d.data : [];
      return points.map((p: Record<string, unknown>) => ({
        time: p.timestamp
          ? new Date(p.timestamp as string).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
          : "",
        value: Number(p.count ?? 0),
      }));
    }

    case "ShiftInfo": {
      // GET /api/health/deep returns { status, checks, timestamp }
      const d = raw as Record<string, unknown>;
      const checks = (d.checks as Record<string, Record<string, unknown>>) || {};
      const ts = (d.timestamp as string) || "";
      const dbStatus = (checks.database?.status as string) || "unknown";
      const memUsed = (checks.memory?.details as Record<string, unknown>)?.used_pct;
      return {
        shift_name: `System ${(d.status as string) === "healthy" ? "Healthy" : d.status || "Unknown"}`,
        operator: `DB: ${dbStatus}`,
        start_time: ts ? new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) : "N/A",
        end_time: memUsed != null ? `Mem: ${memUsed}%` : "N/A",
      };
    }

    default:
      return raw;
  }
}

/* ---------- Widget Meta ---------- */
const WIDGET_TYPES: Record<string, { icon: typeof AlertTriangle; label: string; defaultSpan: [number, number] }> = {
  AlertFeed:     { icon: AlertTriangle, label: "Alert Feed",      defaultSpan: [4, 2] },
  ThreatLevel:   { icon: Gauge,         label: "Threat Level",    defaultSpan: [2, 1] },
  IncidentCount: { icon: Hash,          label: "Incident Count",  defaultSpan: [2, 1] },
  ZoneOccupancy: { icon: BarChart3,     label: "Zone Occupancy",  defaultSpan: [4, 1] },
  AgentStatus:   { icon: Cpu,           label: "Camera Status",   defaultSpan: [4, 1] },
  MetricsChart:  { icon: TrendingUp,    label: "Metrics Chart",   defaultSpan: [6, 2] },
  ShiftInfo:     { icon: Clock,         label: "Shift Info",      defaultSpan: [3, 1] },
  QuickActions:  { icon: Zap,           label: "Quick Actions",   defaultSpan: [3, 1] },
};

/* Widget type → destination page */
const WIDGET_DRILL_DOWN: Record<string, string> = {
  AlertFeed:     "/alerts",
  ThreatLevel:   "/alerts",
  IncidentCount: "/alerts",
  ZoneOccupancy: "/zones",
  AgentStatus:   "/cameras",
  MetricsChart:  "/analytics",
  ShiftInfo:     "/workspace",
  QuickActions:  "/workspace",
};

/* KPI threshold helpers — stored in localStorage */
function getThreshold(widgetType: string): number | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(`kpi_threshold_${widgetType}`);
  return raw !== null ? Number(raw) : null;
}

function setThreshold(widgetType: string, value: number | null) {
  if (typeof window === "undefined") return;
  if (value === null) {
    localStorage.removeItem(`kpi_threshold_${widgetType}`);
  } else {
    localStorage.setItem(`kpi_threshold_${widgetType}`, String(value));
  }
}

/* KPI widget types that support threshold highlighting */
const KPI_TYPES = new Set(["ThreatLevel", "IncidentCount"]);

/* Numeric value extracted from widget data for threshold comparison */
function getWidgetNumericValue(type: string, data: unknown): number | null {
  if (data == null) return null;
  const d = data as Record<string, unknown>;
  if (type === "ThreatLevel") return Number(d?.level ?? null);
  if (type === "IncidentCount") return Number(d?.count ?? null);
  return null;
}

/* ========== Widget Renderers ========== */

function AlertFeedWidget({ data }: { data: unknown }) {
  const alerts = Array.isArray(data) ? data : [];
  const sevColors: Record<string, string> = {
    critical: "bg-red-500/20 text-red-400 border-red-500/40",
    high: "bg-orange-500/20 text-orange-400 border-orange-500/40",
    medium: "bg-yellow-500/20 text-yellow-400 border-yellow-500/40",
    low: "bg-blue-400/20 text-blue-300 border-blue-400/40",
    info: "bg-zinc-700/40 text-zinc-400 border-zinc-600",
  };
  return (
    <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1 scrollbar-thin">
      {alerts.length === 0 && <p className="text-zinc-500 text-sm">No recent alerts</p>}
      {alerts.map((a: Record<string, string>, i: number) => (
        <div key={i} className="flex items-center gap-2 bg-zinc-900/60 rounded px-2 py-1.5 text-xs">
          <span className={cn("px-1.5 py-0.5 rounded border text-[10px] uppercase font-semibold", sevColors[a.severity] || sevColors.info)}>
            {a.severity}
          </span>
          <span className="text-zinc-300 truncate flex-1">{a.message || a.title}</span>
          <span className="text-zinc-600 whitespace-nowrap">{a.time || ""}</span>
        </div>
      ))}
    </div>
  );
}

function ThreatLevelWidget({ data }: { data: unknown }) {
  const d = data as Record<string, unknown> | null;
  const level = Number(d?.level ?? 1);
  const label = (d?.label as string) || "Normal";
  const colors = ["#22c55e", "#84cc16", "#eab308", "#f97316", "#ef4444"];
  const color = colors[Math.min(level, 5) - 1] || colors[0];
  return (
    <div className="flex flex-col items-center justify-center gap-2">
      <div className="relative w-24 h-24">
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
          <circle cx="50" cy="50" r="42" fill="none" stroke="#27272a" strokeWidth="10" />
          <circle cx="50" cy="50" r="42" fill="none" stroke={color} strokeWidth="10"
            strokeDasharray={`${(level / 5) * 264} 264`} strokeLinecap="round" />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-3xl font-bold" style={{ color }}>
          {level}
        </span>
      </div>
      <span className="text-sm font-medium" style={{ color }}>{label}</span>
    </div>
  );
}

function IncidentCountWidget({ data }: { data: unknown }) {
  const d = data as Record<string, unknown> | null;
  const count = Number(d?.count ?? 0);
  const change = Number(d?.change ?? 0);
  return (
    <div className="flex flex-col items-center justify-center gap-1">
      <span className="text-5xl font-bold text-cyan-400">{count}</span>
      <span className="text-xs text-zinc-500">Active Incidents</span>
      {change !== 0 && (
        <span className={cn("text-xs", change > 0 ? "text-red-400" : "text-green-400")}>
          {change > 0 ? "+" : ""}{change} from last shift
        </span>
      )}
    </div>
  );
}

function ZoneOccupancyWidget({ data }: { data: unknown }) {
  const zones = Array.isArray(data) ? data : [];
  return (
    <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
      {zones.map((z: Record<string, unknown>, i: number) => {
        const pct = Math.min(Number(z.occupancy ?? 0), 100);
        const cap = Number(z.capacity ?? 100);
        return (
          <div key={i} className="space-y-0.5">
            <div className="flex justify-between text-xs">
              <span className="text-zinc-300">{z.name as string}</span>
              <span className="text-zinc-500">{z.occupancy as number}/{cap}</span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all"
                style={{ width: `${pct}%`, backgroundColor: pct > 80 ? "#ef4444" : pct > 50 ? "#eab308" : "#22d3ee" }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AgentStatusWidget({ data }: { data: unknown }) {
  // Data source is /api/cameras — each item represents a camera's online/offline state
  const cameras = Array.isArray(data) ? data : [];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-48 overflow-y-auto pr-1">
      {cameras.length === 0 && <p className="text-zinc-500 text-sm col-span-full">No cameras found</p>}
      {cameras.map((c: Record<string, unknown>, i: number) => (
        <div key={i} className="flex items-center gap-2 bg-zinc-900/60 rounded px-2 py-1.5">
          <span className={cn("w-2 h-2 rounded-full", c.running ? "bg-green-400" : "bg-red-400")} />
          <span className="text-xs text-zinc-300 truncate">{c.name as string}</span>
        </div>
      ))}
    </div>
  );
}

function MetricsChartWidget({ data }: { data: unknown }) {
  const points = Array.isArray(data) ? data : [];
  return (
    <div className="h-48 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
          <XAxis dataKey="time" tick={{ fill: "#71717a", fontSize: 10 }} />
          <YAxis tick={{ fill: "#71717a", fontSize: 10 }} />
          <Tooltip contentStyle={{ backgroundColor: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: "#a1a1aa" }} />
          <Line type="monotone" dataKey="value" stroke="#22d3ee" strokeWidth={2} dot={false} />
          {points[0] && (points[0] as Record<string, unknown>).value2 !== undefined && (
            <Line type="monotone" dataKey="value2" stroke="#a78bfa" strokeWidth={2} dot={false} />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ShiftInfoWidget({ data }: { data: unknown }) {
  const d = data as Record<string, string> | null;
  return (
    <div className="space-y-2 text-sm">
      <div className="flex justify-between">
        <span className="text-zinc-500">Shift</span>
        <span className="text-zinc-200 font-medium">{d?.shift_name || "N/A"}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-zinc-500">Operator</span>
        <span className="text-zinc-200">{d?.operator || "N/A"}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-zinc-500">Started</span>
        <span className="text-zinc-200">{d?.start_time || "N/A"}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-zinc-500">Ends</span>
        <span className="text-zinc-200">{d?.end_time || "N/A"}</span>
      </div>
    </div>
  );
}

function QuickActionsWidget({ onAction }: { onAction: (action: string) => void }) {
  const actions = [
    { id: "ack_all", label: "Ack All", icon: CheckCircle2, color: "bg-green-600 hover:bg-green-700" },
    { id: "lockdown", label: "Lock Down", icon: Lock, color: "bg-red-600 hover:bg-red-700" },
    { id: "all_clear", label: "All Clear", icon: Shield, color: "bg-cyan-600 hover:bg-cyan-700" },
    { id: "refresh", label: "Refresh All", icon: RefreshCw, color: "bg-zinc-600 hover:bg-zinc-700" },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {actions.map((a) => {
        const Icon = a.icon;
        return (
          <button key={a.id} onClick={() => onAction(a.id)}
            className={cn("flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium text-white transition", a.color)}>
            <Icon className="w-3.5 h-3.5" /> {a.label}
          </button>
        );
      })}
    </div>
  );
}

/* ========== Main Page ========== */
export default function WorkspacePage() {
  const router = useRouter();
  const { addToast } = useToast();
  const [widgets, setWidgets] = useState<WidgetConfig[]>([]);
  const [widgetData, setWidgetData] = useState<Record<string, unknown>>({});
  const [widgetLoading, setWidgetLoading] = useState<Record<string, boolean>>({});
  const [widgetError, setWidgetError] = useState<Record<string, string | null>>({});
  const [editMode, setEditMode] = useState(false);
  const [availableWidgets, setAvailableWidgets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [darkMode, setDarkMode] = useState(true);
  const [briefing, setBriefing] = useState<ShiftBriefing | null>(null);
  const [showBriefing, setShowBriefing] = useState(false);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // KPI thresholds: widgetType → threshold number
  const [thresholds, setThresholds] = useState<Record<string, number | null>>({});
  // Which KPI widget has the threshold editor open
  const [editingThreshold, setEditingThreshold] = useState<string | null>(null);
  const [thresholdInput, setThresholdInput] = useState<string>("");

  const userId = (() => {
    if (typeof window === "undefined") return "default";
    const stored = localStorage.getItem("sentinel_user_id");
    if (stored) return stored;
    // Extract user ID from JWT token
    const token = localStorage.getItem("sentinel_token");
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        if (payload.sub) {
          localStorage.setItem("sentinel_user_id", payload.sub);
          return payload.sub;
        }
      } catch { /* ignore */ }
    }
    return "default";
  })();

  /* Fetch layout */
  const fetchLayout = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiFetch<WorkspaceLayout>(`/api/workspace/?user_id=${userId}`);
      setWidgets(data.widgets || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspace");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  /* Fetch data for each widget type from its real endpoint */
  const fetchWidgetData = useCallback(async () => {
    const types = [...new Set(widgets.map((w) => w.type))];
    // Mark all types as loading
    setWidgetLoading((prev) => {
      const next = { ...prev };
      types.forEach((t) => { next[t] = true; });
      return next;
    });

    const results: Record<string, unknown> = {};
    const errors: Record<string, string | null> = {};

    await Promise.allSettled(
      types.map(async (t) => {
        const endpoint = WIDGET_ENDPOINTS[t];
        if (!endpoint) {
          // No real endpoint mapped — leave data null, no error
          results[t] = null;
          errors[t] = null;
          return;
        }
        try {
          const raw = await apiFetch(endpoint);
          results[t] = transformWidgetData(t, raw);
          errors[t] = null;
        } catch (err) {
          results[t] = null;
          errors[t] = err instanceof Error ? err.message : "Failed to load";
        }
      })
    );

    setWidgetData((prev) => ({ ...prev, ...results }));
    setWidgetError((prev) => ({ ...prev, ...errors }));
    setWidgetLoading((prev) => {
      const next = { ...prev };
      types.forEach((t) => { next[t] = false; });
      return next;
    });
  }, [widgets]);

  /* Fetch available widget types for palette */
  const fetchAvailableWidgets = useCallback(async () => {
    try {
      const data = await apiFetch<{ types: string[] }>("/api/workspace/widgets");
      setAvailableWidgets(data.types || Object.keys(WIDGET_TYPES));
    } catch {
      setAvailableWidgets(Object.keys(WIDGET_TYPES));
    }
  }, []);

  // Load persisted thresholds from localStorage
  useEffect(() => {
    const loaded: Record<string, number | null> = {};
    KPI_TYPES.forEach((t) => { loaded[t] = getThreshold(t); });
    setThresholds(loaded);
  }, []);

  useEffect(() => { fetchLayout(); }, [fetchLayout]);
  useEffect(() => {
    if (widgets.length > 0) {
      fetchWidgetData();
      const iv = setInterval(fetchWidgetData, 15000);
      return () => clearInterval(iv);
    }
  }, [widgets, fetchWidgetData]);
  useEffect(() => { if (editMode) fetchAvailableWidgets(); }, [editMode, fetchAvailableWidgets]);

  /* Save layout */
  const handleSave = async () => {
    setSaving(true);
    try {
      await apiFetch("/api/workspace/", {
        method: "PUT",
        body: JSON.stringify({ user_id: userId, widgets }),
      });
      setEditMode(false);
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  /* Reset layout */
  const handleReset = async () => {
    try {
      const data = await apiFetch<WorkspaceLayout>("/api/workspace/reset", { method: "POST", body: JSON.stringify({ user_id: userId }) });
      setWidgets(data.widgets || []);
      setEditMode(false);
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "Reset failed");
    }
  };

  /* Add widget from palette */
  const addWidget = (type: string) => {
    const meta = WIDGET_TYPES[type];
    const w: WidgetConfig = {
      id: `${type}-${Date.now()}`,
      type,
      title: meta?.label || type,
      col_span: meta?.defaultSpan[0] || 4,
      row_span: meta?.defaultSpan[1] || 1,
      position: widgets.length,
      config: {},
    };
    setWidgets((prev) => [...prev, w]);
  };

  /* Remove widget */
  const removeWidget = (id: string) => {
    setWidgets((prev) => prev.filter((w) => w.id !== id));
  };

  /* Quick actions */
  const handleQuickAction = async (action: string) => {
    try {
      await apiFetch(`/api/workspace/widgets/QuickActions/action`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      fetchWidgetData();
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "Action failed");
    }
  };

  /* KPI threshold handlers */
  const openThresholdEditor = (widgetType: string) => {
    setEditingThreshold(widgetType);
    setThresholdInput(thresholds[widgetType] != null ? String(thresholds[widgetType]) : "");
  };

  const saveThreshold = (widgetType: string) => {
    const val = thresholdInput.trim() === "" ? null : Number(thresholdInput);
    const final = (val !== null && !isNaN(val)) ? val : null;
    setThreshold(widgetType, final);
    setThresholds((prev) => ({ ...prev, [widgetType]: final }));
    setEditingThreshold(null);
  };

  /* Shift briefing */
  const loadBriefing = async () => {
    setBriefingLoading(true);
    setShowBriefing(true);
    try {
      const data = await apiFetch<ShiftBriefing>("/api/workspace/shift-briefing");
      setBriefing(data);
    } catch {
      setBriefing(null);
    } finally {
      setBriefingLoading(false);
    }
  };

  /* Widget renderer dispatch */
  const renderWidget = (w: WidgetConfig) => {
    const isLoading = widgetLoading[w.type];
    const err = widgetError[w.type];
    const d = widgetData[w.type];

    // QuickActions has no data dependency
    if (w.type === "QuickActions") {
      return <QuickActionsWidget onAction={handleQuickAction} />;
    }

    if (isLoading) {
      return (
        <div className="flex items-center justify-center h-full">
          <Loader2 className="w-5 h-5 animate-spin text-cyan-400" />
        </div>
      );
    }

    if (err) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-2">
          <AlertTriangle className="w-5 h-5 text-red-400" />
          <p className="text-red-400 text-xs text-center">{err}</p>
          <button
            onClick={() => fetchWidgetData()}
            className="text-xs text-cyan-400 hover:underline"
          >
            Retry
          </button>
        </div>
      );
    }

    switch (w.type) {
      case "AlertFeed": return <AlertFeedWidget data={d} />;
      case "ThreatLevel": return <ThreatLevelWidget data={d} />;
      case "IncidentCount": return <IncidentCountWidget data={d} />;
      case "ZoneOccupancy": return <ZoneOccupancyWidget data={d} />;
      case "AgentStatus": return <AgentStatusWidget data={d} />;
      case "MetricsChart": return <MetricsChartWidget data={d} />;
      case "ShiftInfo": return <ShiftInfoWidget data={d} />;
      default: return <p className="text-zinc-500 text-sm">Unknown widget: {w.type}</p>;
    }
  };

  return (
    <div className={cn("min-h-screen transition-colors", darkMode ? "bg-[#030712] text-zinc-100" : "bg-zinc-100 text-zinc-900")}>
      {/* ===== Top Bar ===== */}
      <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <LayoutGrid className="w-5 h-5 text-cyan-400" />
          <h1 className="text-lg font-semibold">SOC Operator Workspace</h1>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={loadBriefing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600/20 text-cyan-400 hover:bg-cyan-600/30 text-sm transition">
            <ClipboardList className="w-4 h-4" /> Shift Briefing
          </button>
          <button onClick={() => setEditMode(!editMode)}
            className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition",
              editMode ? "bg-amber-500/20 text-amber-400" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700")}>
            <Settings2 className="w-4 h-4" /> Customize
          </button>
          <button onClick={() => setDarkMode(!darkMode)}
            className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:bg-zinc-700 transition">
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          {/* Sound toggle placeholder — audio API not yet implemented */}
        </div>
      </header>

      <div className="flex">
        {/* ===== Edit Mode Palette ===== */}
        {editMode && (
          <aside className="w-64 border-r border-zinc-800 bg-zinc-950 p-4 space-y-4 min-h-[calc(100vh-57px)]">
            <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Widget Palette</h2>
            <div className="space-y-2">
              {availableWidgets.map((type) => {
                const meta = WIDGET_TYPES[type];
                const Icon = meta?.icon || Activity;
                return (
                  <button key={type} onClick={() => addWidget(type)}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-sm text-zinc-300 transition">
                    <Plus className="w-3.5 h-3.5 text-cyan-400" />
                    <Icon className="w-4 h-4 text-zinc-500" />
                    {meta?.label || type}
                  </button>
                );
              })}
            </div>
            <div className="border-t border-zinc-800 pt-4 space-y-2">
              <button onClick={handleSave} disabled={saving}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-medium transition disabled:opacity-50">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save Layout
              </button>
              <button onClick={handleReset}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition">
                <RotateCcw className="w-4 h-4" /> Reset to Default
              </button>
            </div>
          </aside>
        )}

        {/* ===== Widget Grid ===== */}
        <main className="flex-1 p-6">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="w-8 h-8 animate-spin text-cyan-400" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3">
              <AlertTriangle className="w-8 h-8 text-red-400" />
              <p className="text-red-400">{error}</p>
              <button onClick={() => fetchLayout()} className="text-sm text-cyan-400 hover:underline">Retry</button>
            </div>
          ) : widgets.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3">
              <LayoutGrid className="w-12 h-12 text-zinc-700" />
              <p className="text-zinc-500">No widgets configured. Click Customize to add widgets.</p>
            </div>
          ) : (
            <div className="grid grid-cols-12 gap-4 auto-rows-[minmax(160px,auto)]">
              {widgets.map((w) => {
                const meta = WIDGET_TYPES[w.type];
                const Icon = meta?.icon || Activity;
                const drillPath = WIDGET_DRILL_DOWN[w.type];
                const isKpi = KPI_TYPES.has(w.type);
                const threshold = thresholds[w.type] ?? null;
                const numericVal = isKpi ? getWidgetNumericValue(w.type, widgetData[w.type]) : null;
                const exceedsThreshold = threshold !== null && numericVal !== null && numericVal > threshold;
                return (
                  <div key={w.id}
                    className={cn(
                      "rounded-xl border bg-zinc-950/60 p-4 flex flex-col transition-all",
                      exceedsThreshold
                        ? "border-red-500 animate-[pulse_2s_ease-in-out_infinite] shadow-[0_0_12px_rgba(239,68,68,0.3)]"
                        : "border-zinc-800",
                      editMode && "ring-1 ring-cyan-500/30 cursor-grab"
                    )}
                    style={{
                      gridColumn: `span ${Math.min(w.col_span, 12)}`,
                      gridRow: `span ${w.row_span}`,
                    }}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2 min-w-0">
                        {editMode && <GripVertical className="w-4 h-4 text-zinc-600 shrink-0" />}
                        <Icon className="w-4 h-4 text-cyan-400 shrink-0" />
                        {drillPath ? (
                          <button
                            onClick={() => router.push(drillPath)}
                            className="flex items-center gap-1 group text-left min-w-0"
                            title={`Go to ${drillPath}`}
                          >
                            <h3 className="text-sm font-medium text-zinc-200 truncate group-hover:text-cyan-400 transition-colors">
                              {w.title}
                            </h3>
                            <ExternalLink className="w-3 h-3 text-zinc-600 group-hover:text-cyan-400 transition-colors shrink-0" />
                          </button>
                        ) : (
                          <h3 className="text-sm font-medium text-zinc-200 truncate">{w.title}</h3>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {isKpi && !editMode && (
                          <button
                            onClick={() => openThresholdEditor(w.type)}
                            className="p-1 rounded hover:bg-zinc-800 text-zinc-600 hover:text-zinc-400 transition"
                            title="Set KPI threshold"
                          >
                            <Settings className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {editMode && (
                          <button onClick={() => removeWidget(w.id)} className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-red-400 transition">
                            <X className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                    {/* KPI threshold editor inline */}
                    {editingThreshold === w.type && (
                      <div className="mb-2 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5">
                        <span className="text-[10px] text-zinc-500 whitespace-nowrap">Alert if &gt;</span>
                        <input
                          type="number"
                          value={thresholdInput}
                          onChange={(e) => setThresholdInput(e.target.value)}
                          placeholder="value"
                          autoFocus
                          className="w-20 bg-transparent text-xs text-zinc-200 outline-none border-b border-zinc-700 focus:border-cyan-600"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveThreshold(w.type);
                            if (e.key === "Escape") setEditingThreshold(null);
                          }}
                        />
                        <button
                          onClick={() => saveThreshold(w.type)}
                          className="text-[10px] text-cyan-400 hover:text-cyan-300 font-medium"
                        >
                          Save
                        </button>
                        {threshold !== null && (
                          <button
                            onClick={() => { setThreshold(w.type, null); setThresholds((p) => ({ ...p, [w.type]: null })); setEditingThreshold(null); }}
                            className="text-[10px] text-red-400 hover:text-red-300"
                          >
                            Clear
                          </button>
                        )}
                        <button onClick={() => setEditingThreshold(null)} className="ml-auto text-zinc-600 hover:text-zinc-400">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                    {threshold !== null && !editingThreshold && isKpi && (
                      <div className="mb-1 text-[10px] text-zinc-600">
                        Threshold: <span className={cn("font-mono", exceedsThreshold ? "text-red-400" : "text-zinc-500")}>{threshold}</span>
                        {exceedsThreshold && <span className="ml-1 text-red-400 font-semibold">EXCEEDED</span>}
                      </div>
                    )}
                    <div className="flex-1 overflow-hidden">
                      {renderWidget(w)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>
      </div>

      {/* ===== Shift Briefing Modal ===== */}
      {showBriefing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowBriefing(false)}>
          <div className="w-full max-w-2xl bg-zinc-950 border border-zinc-800 rounded-2xl p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <ClipboardList className="w-5 h-5 text-cyan-400" />
                <h2 className="text-lg font-semibold text-zinc-100">Shift Briefing</h2>
              </div>
              <button onClick={() => setShowBriefing(false)} className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 transition">
                <X className="w-5 h-5" />
              </button>
            </div>
            {briefingLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-8 h-8 animate-spin text-cyan-400" />
                <span className="ml-3 text-zinc-400">Generating AI briefing...</span>
              </div>
            ) : briefing ? (
              <div className="space-y-4">
                <div className="bg-zinc-900/60 rounded-lg p-4">
                  <span className="text-xs text-zinc-500 uppercase tracking-wider">Current Shift</span>
                  <p className="text-zinc-200 mt-1 font-medium">{briefing.shift}</p>
                </div>
                <div className="bg-zinc-900/60 rounded-lg p-4">
                  <span className="text-xs text-zinc-500 uppercase tracking-wider">AI Summary</span>
                  <p className="text-zinc-300 mt-1 text-sm leading-relaxed">{briefing.summary}</p>
                </div>
                {briefing.key_events && briefing.key_events.length > 0 && (
                  <div className="bg-zinc-900/60 rounded-lg p-4">
                    <span className="text-xs text-zinc-500 uppercase tracking-wider">Key Events</span>
                    <ul className="mt-2 space-y-1.5">
                      {briefing.key_events.map((e, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                          {e}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {briefing.recommendations && briefing.recommendations.length > 0 && (
                  <div className="bg-zinc-900/60 rounded-lg p-4">
                    <span className="text-xs text-zinc-500 uppercase tracking-wider">Recommendations</span>
                    <ul className="mt-2 space-y-1.5">
                      {briefing.recommendations.map((r, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                          <CheckCircle2 className="w-3.5 h-3.5 text-cyan-400 mt-0.5 shrink-0" />
                          {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="text-xs text-zinc-600 text-right">Generated {briefing.generated_at}</p>
              </div>
            ) : (
              <p className="text-zinc-500 text-center py-8">Unable to generate briefing. Please try again.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
