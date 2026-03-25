"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Shield,
  Camera,
  AlertTriangle,
  CheckCircle2,
  Clock,
  MapPin,
  TrendingUp,
  Download,
  Loader2,
  RefreshCw,
  Building,
  Activity,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import { exportCSV } from "@/lib/export";

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface Alert {
  id: string;
  title: string;
  severity: string;
  status: string;
  threat_type?: string | null;
  created_at: string;
  acknowledged_at?: string | null;
  resolved_at?: string | null;
  zone_name?: string | null;
}

interface CameraItem {
  id: string;
  name: string;
  status: string;
  location?: string | null;
}

interface Zone {
  id: string;
  name: string;
  zone_type: string;
  is_active?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const SLA_TARGETS: Record<string, number> = {
  critical: 2,
  high: 10,
  medium: 30,
  low: 120,
};

const CAMERA_STATUS_COLORS: Record<string, string> = {
  online: "#10b981",
  offline: "#ef4444",
  maintenance: "#f59e0b",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function getLast30Days(): string[] {
  return Array.from({ length: 30 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (29 - i));
    return d.toISOString().slice(0, 10);
  });
}

function responseMinutes(alert: Alert): number | null {
  if (!alert.acknowledged_at) return null;
  const created = new Date(alert.created_at).getTime();
  const acked = new Date(alert.acknowledged_at).getTime();
  return (acked - created) / 60000;
}

function formatResponseTime(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < 60) return `${minutes.toFixed(1)} min`;
  return `${(minutes / 60).toFixed(1)} hrs`;
}

function severityLabel(sev: string): string {
  return sev.charAt(0).toUpperCase() + sev.slice(1);
}

function friendlyIncidentType(threatType: string | null | undefined): string {
  if (!threatType) return "Security Incident";
  const map: Record<string, string> = {
    intrusion: "Unauthorised Access",
    fire: "Fire / Smoke",
    crowd: "Crowd Congestion",
    theft: "Suspicious Activity",
    loitering: "Loitering",
    aggression: "Disturbance",
    tailgating: "Access Violation",
    violence: "Physical Altercation",
    vandalism: "Property Damage",
  };
  const key = Object.keys(map).find((k) => threatType.toLowerCase().includes(k));
  return key ? map[key] : "Security Incident";
}

/* ------------------------------------------------------------------ */
/*  KPI Card                                                            */
/* ------------------------------------------------------------------ */

interface KPICardProps {
  label: string;
  value: string | number;
  subtext?: string;
  icon: React.ReactNode;
  color: string;
  bg: string;
  border: string;
}

function KPICard({ label, value, subtext, icon, color, bg, border }: KPICardProps) {
  return (
    <div className={cn("rounded-2xl border p-5 flex flex-col gap-3", bg, border)}>
      <div className={cn("flex items-center gap-2", color)}>
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-wider opacity-80">{label}</span>
      </div>
      <div>
        <p className={cn("text-3xl font-black tabular-nums", color)}>{value}</p>
        {subtext && <p className="text-[11px] text-gray-500 mt-0.5">{subtext}</p>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Custom tooltip for bar chart                                        */
/* ------------------------------------------------------------------ */

function BarTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs shadow-lg">
      <p className="font-semibold text-gray-300 mb-1">{label}</p>
      <p className="text-gray-400">
        <span className="font-bold text-cyan-400">{payload[0].value}</span> incidents
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  CustomerPortalPage                                                  */
/* ------------------------------------------------------------------ */

export default function CustomerPortalPage() {
  const { addToast } = useToast();

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [cameras, setCameras] = useState<CameraItem[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* --- Fetch all data --- */
  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [alertsData, camerasData, zonesData] = await Promise.allSettled([
        apiFetch<Alert[]>("/api/alerts?limit=500"),
        apiFetch<CameraItem[]>("/api/cameras"),
        apiFetch<Zone[]>("/api/zones"),
      ]);

      if (alertsData.status === "fulfilled") setAlerts(alertsData.value || []);
      if (camerasData.status === "fulfilled") setCameras(camerasData.value || []);
      if (zonesData.status === "fulfilled") setZones(zonesData.value || []);

      if (
        alertsData.status === "rejected" &&
        camerasData.status === "rejected" &&
        zonesData.status === "rejected"
      ) {
        setError("Unable to load data. Please check your connection.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  /* --- Current month alerts --- */
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const thisMonthAlerts = useMemo(
    () => alerts.filter((a) => a.created_at >= monthStart),
    [alerts, monthStart]
  );

  /* --- Avg response time --- */
  const avgResponseTime = useMemo(() => {
    const acked = thisMonthAlerts.filter((a) => a.acknowledged_at);
    if (acked.length === 0) return 0;
    const total = acked.reduce((s, a) => s + (responseMinutes(a) ?? 0), 0);
    return total / acked.length;
  }, [thisMonthAlerts]);

  /* --- Camera uptime --- */
  const cameraUptime = useMemo(() => {
    if (cameras.length === 0) return null;
    const online = cameras.filter((c) => c.status === "online").length;
    return Math.round((online / cameras.length) * 100);
  }, [cameras]);

  /* --- Active zones --- */
  const activeZones = useMemo(
    () => zones.filter((z) => z.is_active !== false).length,
    [zones]
  );

  /* --- SLA compliance --- */
  const slaCompliance = useMemo(() => {
    const acked = alerts.filter((a) => a.acknowledged_at);
    if (acked.length === 0) return 100;
    const withinSLA = acked.filter((a) => {
      const resp = responseMinutes(a);
      if (resp === null) return true;
      const target = SLA_TARGETS[a.severity] ?? 60;
      return resp <= target;
    }).length;
    return Math.round((withinSLA / acked.length) * 100);
  }, [alerts]);

  /* --- Incident trend data (last 30 days) --- */
  const incidentTrend = useMemo(() => {
    const days = getLast30Days();
    return days.map((date) => ({
      date: date.slice(5),
      incidents: alerts.filter((a) => a.created_at.slice(0, 10) === date).length,
    }));
  }, [alerts]);

  /* --- Recent resolved incidents (last 10) --- */
  const recentResolved = useMemo(
    () =>
      alerts
        .filter((a) => a.status === "resolved" && a.resolved_at)
        .sort((a, b) => new Date(b.resolved_at!).getTime() - new Date(a.resolved_at!).getTime())
        .slice(0, 10),
    [alerts]
  );

  /* --- Camera health breakdown --- */
  const cameraHealth = useMemo(() => {
    const counts: Record<string, number> = { online: 0, offline: 0, maintenance: 0 };
    cameras.forEach((c) => {
      const s = c.status?.toLowerCase() || "offline";
      if (s in counts) counts[s]++;
      else counts.offline++;
    });
    return [
      { name: "Online", value: counts.online, color: "#10b981" },
      { name: "Offline", value: counts.offline, color: "#ef4444" },
      { name: "Maintenance", value: counts.maintenance, color: "#f59e0b" },
    ].filter((c) => c.value > 0);
  }, [cameras]);

  /* --- Export report --- */
  const handleExport = useCallback(() => {
    if (thisMonthAlerts.length === 0) {
      addToast("info", "No incidents to export this month.");
      return;
    }
    try {
      exportCSV(
        thisMonthAlerts.map((a) => ({
          date: new Date(a.created_at).toLocaleDateString(),
          type: friendlyIncidentType(a.threat_type),
          severity: severityLabel(a.severity),
          response_time: a.acknowledged_at ? formatResponseTime(responseMinutes(a) ?? 0) : "—",
          status: a.status,
          zone: a.zone_name || "—",
          resolved: a.resolved_at ? new Date(a.resolved_at).toLocaleDateString() : "—",
        })),
        `security_report_${now.toISOString().slice(0, 7)}.csv`,
        [
          { key: "date", label: "Date" },
          { key: "type", label: "Incident Type" },
          { key: "severity", label: "Severity" },
          { key: "response_time", label: "Response Time" },
          { key: "status", label: "Status" },
          { key: "zone", label: "Zone" },
          { key: "resolved", label: "Resolved" },
        ]
      );
      addToast("success", `Monthly report exported (${thisMonthAlerts.length} incidents).`);
    } catch {
      addToast("error", "Export failed. Please try again.");
    }
  }, [thisMonthAlerts, addToast, now]);

  /* --- Render --- */
  return (
    <div className="flex h-full flex-col bg-gray-950 overflow-hidden">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-8 py-5">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-900/30 border border-cyan-800/50 shadow-lg shadow-cyan-900/20">
            <Shield className="h-6 w-6 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-wide text-gray-100">Security Overview</h1>
            <p className="text-sm text-gray-500">
              {now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={fetchAll}
            disabled={loading}
            className="flex items-center gap-2 rounded-xl border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm font-semibold text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            Refresh
          </button>
          <button
            onClick={handleExport}
            disabled={loading}
            className="flex items-center gap-2 rounded-xl border border-cyan-800/60 bg-cyan-900/20 px-4 py-2.5 text-sm font-semibold text-cyan-400 hover:bg-cyan-900/30 transition-colors disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            Download Monthly Report
          </button>
        </div>
      </div>

      {/* ---- Main content ---- */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-64">
            <AlertTriangle className="h-8 w-8 text-red-500 mb-3" />
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={fetchAll}
              className="mt-3 text-sm text-gray-500 underline hover:text-gray-300"
            >
              Try again
            </button>
          </div>
        ) : (
          <div className="p-8 space-y-8">

            {/* ---- KPI Row ---- */}
            <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              <KPICard
                label="Total Incidents This Month"
                value={thisMonthAlerts.length}
                subtext={`${alerts.length} total on record`}
                icon={<AlertTriangle className="h-5 w-5" />}
                color="text-amber-400"
                bg="bg-amber-900/10"
                border="border-amber-800/30"
              />
              <KPICard
                label="Avg Response Time"
                value={avgResponseTime > 0 ? formatResponseTime(avgResponseTime) : "—"}
                subtext="From alert to acknowledgement"
                icon={<Clock className="h-5 w-5" />}
                color="text-cyan-400"
                bg="bg-cyan-900/10"
                border="border-cyan-800/30"
              />
              <KPICard
                label="Camera Uptime"
                value={cameraUptime !== null ? `${cameraUptime}%` : "—"}
                subtext={`${cameras.filter((c) => c.status === "online").length} of ${cameras.length} cameras online`}
                icon={<Camera className="h-5 w-5" />}
                color={cameraUptime !== null && cameraUptime >= 95 ? "text-emerald-400" : "text-amber-400"}
                bg={cameraUptime !== null && cameraUptime >= 95 ? "bg-emerald-900/10" : "bg-amber-900/10"}
                border={cameraUptime !== null && cameraUptime >= 95 ? "border-emerald-800/30" : "border-amber-800/30"}
              />
              <KPICard
                label="Active Zones"
                value={activeZones}
                subtext={`${zones.length} zones configured`}
                icon={<MapPin className="h-5 w-5" />}
                color="text-purple-400"
                bg="bg-purple-900/10"
                border="border-purple-800/30"
              />
              <KPICard
                label="SLA Compliance"
                value={`${slaCompliance}%`}
                subtext={slaCompliance >= 95 ? "Excellent" : slaCompliance >= 85 ? "Good" : "Needs attention"}
                icon={<TrendingUp className="h-5 w-5" />}
                color={slaCompliance >= 95 ? "text-emerald-400" : slaCompliance >= 85 ? "text-amber-400" : "text-red-400"}
                bg={slaCompliance >= 95 ? "bg-emerald-900/10" : slaCompliance >= 85 ? "bg-amber-900/10" : "bg-red-900/10"}
                border={slaCompliance >= 95 ? "border-emerald-800/30" : slaCompliance >= 85 ? "border-amber-800/30" : "border-red-800/30"}
              />
            </section>

            {/* ---- Charts row ---- */}
            <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Incident Trend Bar Chart */}
              <div className="lg:col-span-2 rounded-2xl border border-gray-800 bg-gray-900/60 p-6">
                <div className="flex items-center gap-2 mb-5">
                  <Activity className="h-4 w-4 text-cyan-400" />
                  <h2 className="text-sm font-bold text-gray-300 uppercase tracking-wider">
                    Incident Trend — Last 30 Days
                  </h2>
                </div>
                {incidentTrend.some((d) => d.incidents > 0) ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={incidentTrend} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 9, fill: "#4b5563" }}
                        tickLine={false}
                        axisLine={false}
                        interval={4}
                      />
                      <YAxis
                        tick={{ fontSize: 9, fill: "#4b5563" }}
                        tickLine={false}
                        axisLine={false}
                        allowDecimals={false}
                      />
                      <Tooltip content={<BarTooltip />} />
                      <Bar
                        dataKey="incidents"
                        fill="#22d3ee"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={20}
                        fillOpacity={0.8}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex flex-col items-center justify-center h-[220px]">
                    <CheckCircle2 className="h-10 w-10 text-emerald-800 mb-3" />
                    <p className="text-sm text-gray-500 font-medium">No incidents recorded this period</p>
                  </div>
                )}
              </div>

              {/* Camera Health Pie */}
              <div className="rounded-2xl border border-gray-800 bg-gray-900/60 p-6">
                <div className="flex items-center gap-2 mb-5">
                  <Camera className="h-4 w-4 text-cyan-400" />
                  <h2 className="text-sm font-bold text-gray-300 uppercase tracking-wider">
                    Camera Health
                  </h2>
                </div>
                {cameras.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-[220px]">
                    <Camera className="h-10 w-10 text-gray-700 mb-3" />
                    <p className="text-sm text-gray-600">No cameras configured</p>
                  </div>
                ) : (
                  <>
                    <ResponsiveContainer width="100%" height={160}>
                      <PieChart>
                        <Pie
                          data={cameraHealth}
                          cx="50%"
                          cy="50%"
                          innerRadius={45}
                          outerRadius={70}
                          paddingAngle={3}
                          dataKey="value"
                        >
                          {cameraHealth.map((entry) => (
                            <Cell key={entry.name} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "#111827",
                            border: "1px solid #1f2937",
                            borderRadius: "8px",
                            fontSize: "11px",
                            color: "#d1d5db",
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="flex flex-col gap-2 mt-2">
                      {cameraHealth.map((entry) => (
                        <div key={entry.name} className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: entry.color }}
                            />
                            <span className="text-gray-400">{entry.name}</span>
                          </div>
                          <span className="font-bold text-gray-200 tabular-nums">{entry.value}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </section>

            {/* ---- Recent Incidents Table ---- */}
            <section>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Building className="h-4 w-4 text-cyan-400" />
                  <h2 className="text-sm font-bold text-gray-300 uppercase tracking-wider">
                    Recent Resolved Incidents
                  </h2>
                </div>
                <span className="text-xs text-gray-600">{recentResolved.length} shown</span>
              </div>

              {recentResolved.length === 0 ? (
                <div className="rounded-2xl border border-gray-800 bg-gray-900/40 p-10 text-center">
                  <CheckCircle2 className="h-10 w-10 text-emerald-700 mx-auto mb-3" />
                  <p className="text-base font-bold text-gray-400">No resolved incidents</p>
                  <p className="text-sm text-gray-600 mt-1">Resolved incidents will appear here</p>
                </div>
              ) : (
                <div className="rounded-2xl border border-gray-800 bg-gray-900/60 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-800 bg-gray-900/80">
                          {["Date", "Incident Type", "Severity", "Response Time", "Resolution", "Zone"].map(
                            (col) => (
                              <th
                                key={col}
                                className="px-5 py-4 text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 whitespace-nowrap"
                              >
                                {col}
                              </th>
                            )
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800/40">
                        {recentResolved.map((incident) => {
                          const respMin = responseMinutes(incident);
                          const target = SLA_TARGETS[incident.severity] ?? 60;
                          const withinSLA = respMin !== null && respMin <= target;
                          return (
                            <tr
                              key={incident.id}
                              className="hover:bg-gray-800/30 transition-colors"
                            >
                              <td className="px-5 py-4 text-gray-400 whitespace-nowrap">
                                {new Date(incident.created_at).toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                  year: "numeric",
                                })}
                              </td>
                              <td className="px-5 py-4 text-gray-200 font-medium">
                                {friendlyIncidentType(incident.threat_type)}
                              </td>
                              <td className="px-5 py-4">
                                <span
                                  className={cn(
                                    "inline-flex rounded-full px-3 py-1 text-[10px] font-bold uppercase",
                                    incident.severity === "critical"
                                      ? "bg-red-900/40 text-red-300"
                                      : incident.severity === "high"
                                      ? "bg-orange-900/40 text-orange-300"
                                      : incident.severity === "medium"
                                      ? "bg-yellow-900/40 text-yellow-300"
                                      : "bg-blue-900/40 text-blue-300"
                                  )}
                                >
                                  {severityLabel(incident.severity)}
                                </span>
                              </td>
                              <td className="px-5 py-4">
                                {respMin !== null ? (
                                  <span
                                    className={cn(
                                      "font-medium tabular-nums",
                                      withinSLA ? "text-emerald-400" : "text-red-400"
                                    )}
                                  >
                                    {formatResponseTime(respMin)}
                                  </span>
                                ) : (
                                  <span className="text-gray-600">—</span>
                                )}
                              </td>
                              <td className="px-5 py-4 text-gray-400 whitespace-nowrap">
                                {incident.resolved_at
                                  ? new Date(incident.resolved_at).toLocaleDateString("en-US", {
                                      month: "short",
                                      day: "numeric",
                                    })
                                  : "—"}
                              </td>
                              <td className="px-5 py-4 text-gray-500">
                                {incident.zone_name || "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>

            {/* ---- Footer note ---- */}
            <div className="flex items-center gap-2 text-xs text-gray-700 pb-2">
              <Shield className="h-3.5 w-3.5" />
              <span>
                Data is updated in real time. Contact your security operations team for further details.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
