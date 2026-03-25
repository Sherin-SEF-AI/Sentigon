"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  BarChart3,
  AlertTriangle,
  Clock,
  CheckCircle2,
  XCircle,
  Download,
  Loader2,
  TrendingUp,
  ShieldAlert,
  RefreshCw,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { cn, apiFetch, severityColor } from "@/lib/utils";
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
  created_at: string;
  acknowledged_at?: string | null;
  resolved_at?: string | null;
}

interface SLAMetrics {
  severity: string;
  targetMinutes: number;
  avgResponseMinutes: number;
  compliancePercent: number;
  withinSLA: number;
  breached: number;
  total: number;
}

interface BreachRecord {
  id: string;
  title: string;
  severity: string;
  responseMinutes: number;
  targetMinutes: number;
  breachMinutes: number;
  date: string;
}

interface DayDataPoint {
  date: string;
  compliance: number;
  total: number;
  breaches: number;
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

const SLA_SEVERITY_ORDER = ["critical", "high", "medium", "low"];

const SEVERITY_CONFIG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  critical: { label: "Critical", color: "text-red-400", bg: "bg-red-900/20", border: "border-red-800/50" },
  high: { label: "High", color: "text-orange-400", bg: "bg-orange-900/20", border: "border-orange-800/50" },
  medium: { label: "Medium", color: "text-yellow-400", bg: "bg-yellow-900/20", border: "border-yellow-800/50" },
  low: { label: "Low", color: "text-blue-400", bg: "bg-blue-900/20", border: "border-blue-800/50" },
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function responseMinutes(alert: Alert): number | null {
  if (!alert.acknowledged_at) return null;
  const created = new Date(alert.created_at).getTime();
  const acked = new Date(alert.acknowledged_at).getTime();
  return (acked - created) / 60000;
}

function complianceColor(pct: number): string {
  if (pct >= 95) return "text-emerald-400";
  if (pct >= 85) return "text-amber-400";
  return "text-red-400";
}

function complianceBg(pct: number): string {
  if (pct >= 95) return "bg-emerald-900/20 border-emerald-800/40";
  if (pct >= 85) return "bg-amber-900/20 border-amber-800/40";
  return "bg-red-900/20 border-red-800/40";
}

function formatMinutes(min: number): string {
  if (min < 1) return `${Math.round(min * 60)}s`;
  if (min < 60) return `${min.toFixed(1)}m`;
  return `${(min / 60).toFixed(1)}h`;
}

function getLast30Days(): string[] {
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/* ------------------------------------------------------------------ */
/*  Compliance Gauge                                                    */
/* ------------------------------------------------------------------ */

function ComplianceGauge({ pct }: { pct: number }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const strokePct = (pct / 100) * circumference;
  const color = pct >= 95 ? "#10b981" : pct >= 85 ? "#f59e0b" : "#ef4444";

  return (
    <div className="relative flex items-center justify-center">
      <svg width={130} height={130} className="-rotate-90">
        <circle cx={65} cy={65} r={radius} fill="none" stroke="#1f2937" strokeWidth={10} />
        <circle
          cx={65}
          cy={65}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={10}
          strokeDasharray={circumference}
          strokeDashoffset={circumference - strokePct}
          strokeLinecap="round"
          className="transition-all duration-700"
        />
      </svg>
      <div className="absolute text-center">
        <p className={cn("text-2xl font-black tabular-nums", complianceColor(pct))}>{pct.toFixed(1)}%</p>
        <p className="text-[9px] text-gray-500 uppercase tracking-wider">Compliance</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Mini bar — compliance bar for each severity                        */
/* ------------------------------------------------------------------ */

function MiniBar({ pct }: { pct: number }) {
  const color = pct >= 95 ? "bg-emerald-500" : pct >= 85 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden w-full mt-1">
      <div
        className={cn("h-full rounded-full transition-all duration-500", color)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  SLADashboardPage                                                    */
/* ------------------------------------------------------------------ */

export default function SLADashboardPage() {
  const { addToast } = useToast();

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<keyof BreachRecord>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  /* --- Fetch alerts --- */
  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<Alert[]>("/api/alerts?limit=200");
      setAlerts(data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load alerts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  /* --- Compute SLA metrics --- */
  const slaMetrics = useMemo((): SLAMetrics[] => {
    return SLA_SEVERITY_ORDER.map((severity) => {
      const relevant = alerts.filter(
        (a) => a.severity === severity && a.acknowledged_at
      );
      const targetMin = SLA_TARGETS[severity] ?? 60;

      if (relevant.length === 0) {
        return {
          severity,
          targetMinutes: targetMin,
          avgResponseMinutes: 0,
          compliancePercent: 100,
          withinSLA: 0,
          breached: 0,
          total: 0,
        };
      }

      const responseTimes = relevant.map((a) => responseMinutes(a)!).filter((t) => t >= 0);
      const avg = responseTimes.reduce((s, t) => s + t, 0) / (responseTimes.length || 1);
      const withinSLA = responseTimes.filter((t) => t <= targetMin).length;
      const breached = responseTimes.length - withinSLA;
      const compliancePercent = (withinSLA / responseTimes.length) * 100;

      return {
        severity,
        targetMinutes: targetMin,
        avgResponseMinutes: avg,
        compliancePercent,
        withinSLA,
        breached,
        total: relevant.length,
      };
    });
  }, [alerts]);

  /* --- Overall metrics --- */
  const overallMetrics = useMemo(() => {
    const acknowledged = alerts.filter((a) => a.acknowledged_at);
    if (acknowledged.length === 0)
      return { compliance: 100, avgResponse: 0, breachCount: 0, withinSLA: 0 };

    let withinSLACount = 0;
    let totalResponseMs = 0;
    let breachCount = 0;

    for (const a of acknowledged) {
      const respMin = responseMinutes(a);
      if (respMin === null || respMin < 0) continue;
      const target = SLA_TARGETS[a.severity] ?? 60;
      if (respMin <= target) withinSLACount++;
      else breachCount++;
      totalResponseMs += respMin;
    }

    const compliance = (withinSLACount / acknowledged.length) * 100;
    const avgResponse = totalResponseMs / acknowledged.length;

    return { compliance, avgResponse, breachCount, withinSLA: withinSLACount };
  }, [alerts]);

  /* --- Breach history --- */
  const breachHistory = useMemo((): BreachRecord[] => {
    const records: BreachRecord[] = [];
    for (const a of alerts) {
      if (!a.acknowledged_at) continue;
      const respMin = responseMinutes(a);
      if (respMin === null || respMin < 0) continue;
      const target = SLA_TARGETS[a.severity] ?? 60;
      if (respMin > target) {
        records.push({
          id: a.id,
          title: a.title,
          severity: a.severity,
          responseMinutes: respMin,
          targetMinutes: target,
          breachMinutes: respMin - target,
          date: a.created_at,
        });
      }
    }

    return records.sort((a, b) => {
      const aVal = a[sortCol];
      const bVal = b[sortCol];
      const cmp =
        typeof aVal === "string" && typeof bVal === "string"
          ? aVal.localeCompare(bVal)
          : (aVal as number) - (bVal as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [alerts, sortCol, sortDir]);

  /* --- Trend data (last 30 days) --- */
  const trendData = useMemo((): DayDataPoint[] => {
    const days = getLast30Days();
    return days.map((date) => {
      const dayAlerts = alerts.filter(
        (a) => a.acknowledged_at && a.created_at.slice(0, 10) === date
      );
      let withinSLACount = 0;
      let breachCount = 0;
      for (const a of dayAlerts) {
        const respMin = responseMinutes(a);
        if (respMin === null || respMin < 0) continue;
        const target = SLA_TARGETS[a.severity] ?? 60;
        if (respMin <= target) withinSLACount++;
        else breachCount++;
      }
      const total = withinSLACount + breachCount;
      const compliance = total > 0 ? Math.round((withinSLACount / total) * 100) : 100;
      return { date: date.slice(5), compliance, total, breaches: breachCount };
    });
  }, [alerts]);

  /* --- Sort handler --- */
  const handleSort = useCallback((col: keyof BreachRecord) => {
    setSortCol((prev) => {
      if (prev === col) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prev;
      }
      setSortDir("desc");
      return col;
    });
  }, []);

  /* --- Export --- */
  const handleExport = useCallback(() => {
    if (breachHistory.length === 0) {
      addToast("info", "No breaches to export.");
      return;
    }
    try {
      exportCSV(
        breachHistory.map((b) => ({
          title: b.title,
          severity: b.severity,
          response_time: formatMinutes(b.responseMinutes),
          sla_target: formatMinutes(b.targetMinutes),
          breach_amount: formatMinutes(b.breachMinutes),
          date: new Date(b.date).toLocaleDateString(),
        })),
        `sla_report_${new Date().toISOString().slice(0, 10)}.csv`,
        [
          { key: "title", label: "Alert" },
          { key: "severity", label: "Severity" },
          { key: "response_time", label: "Response Time" },
          { key: "sla_target", label: "SLA Target" },
          { key: "breach_amount", label: "Breached By" },
          { key: "date", label: "Date" },
        ]
      );
      addToast("success", `Exported ${breachHistory.length} breach records.`);
    } catch {
      addToast("error", "Export failed. Please try again.");
    }
  }, [breachHistory, addToast]);

  /* --- Render --- */
  return (
    <div className="flex h-full flex-col bg-gray-950 overflow-hidden">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-900/30 border border-cyan-800/50">
            <BarChart3 className="h-5 w-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-wide text-gray-100">SLA Compliance</h1>
            <p className="text-xs text-gray-500">
              Service level agreement tracking and breach analysis
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <ComplianceGauge pct={overallMetrics.compliance} />
          <div className="flex gap-2">
            <button
              onClick={fetchAlerts}
              disabled={loading}
              className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs font-semibold text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              Refresh
            </button>
            <button
              onClick={handleExport}
              disabled={loading}
              className="flex items-center gap-2 rounded-lg border border-cyan-800/60 bg-cyan-900/20 px-3 py-2 text-xs font-semibold text-cyan-400 hover:bg-cyan-900/30 transition-colors disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              Export SLA Report
            </button>
          </div>
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
            <AlertTriangle className="h-8 w-8 text-red-500 mb-2" />
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={fetchAlerts}
              className="mt-3 text-xs text-gray-500 underline hover:text-gray-300"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="p-6 space-y-6">

            {/* ---- Overall SLA Metrics Row ---- */}
            <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                {
                  label: "Overall Compliance",
                  value: `${overallMetrics.compliance.toFixed(1)}%`,
                  icon: <TrendingUp className="h-4 w-4" />,
                  color: complianceColor(overallMetrics.compliance),
                  bg: complianceBg(overallMetrics.compliance),
                },
                {
                  label: "Avg Response Time",
                  value: formatMinutes(overallMetrics.avgResponse),
                  icon: <Clock className="h-4 w-4" />,
                  color: "text-cyan-400",
                  bg: "bg-cyan-900/10 border-cyan-800/30",
                },
                {
                  label: "Breaches This Month",
                  value: overallMetrics.breachCount,
                  icon: <XCircle className="h-4 w-4" />,
                  color: overallMetrics.breachCount > 0 ? "text-red-400" : "text-emerald-400",
                  bg: overallMetrics.breachCount > 0 ? "bg-red-900/10 border-red-800/30" : "bg-emerald-900/10 border-emerald-800/30",
                },
                {
                  label: "Alerts Within SLA",
                  value: overallMetrics.withinSLA,
                  icon: <CheckCircle2 className="h-4 w-4" />,
                  color: "text-emerald-400",
                  bg: "bg-emerald-900/10 border-emerald-800/30",
                },
              ].map(({ label, value, icon, color, bg }) => (
                <div key={label} className={cn("rounded-xl border p-5", bg)}>
                  <div className={cn("flex items-center gap-2 mb-2", color)}>
                    {icon}
                    <span className="text-[10px] font-bold uppercase tracking-wider opacity-80">{label}</span>
                  </div>
                  <p className={cn("text-2xl font-black tabular-nums", color)}>{value}</p>
                </div>
              ))}
            </section>

            {/* ---- Compliance by Severity ---- */}
            <section>
              <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-3">
                Compliance by Severity
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {slaMetrics.map((m) => {
                  const cfg = SEVERITY_CONFIG[m.severity];
                  return (
                    <div
                      key={m.severity}
                      className={cn("rounded-xl border p-4 flex flex-col gap-2", cfg.bg, cfg.border)}
                    >
                      <div className="flex items-center gap-2">
                        <ShieldAlert className={cn("h-4 w-4", cfg.color)} />
                        <span className={cn("text-xs font-bold uppercase tracking-wider", cfg.color)}>
                          {cfg.label}
                        </span>
                      </div>

                      <div className="space-y-1">
                        <div className="flex justify-between text-[10px] text-gray-500">
                          <span>SLA Target</span>
                          <span className="font-mono text-gray-300">{formatMinutes(m.targetMinutes)}</span>
                        </div>
                        <div className="flex justify-between text-[10px] text-gray-500">
                          <span>Avg Response</span>
                          <span className={cn("font-mono font-bold", m.avgResponseMinutes > m.targetMinutes ? "text-red-400" : "text-emerald-400")}>
                            {m.total > 0 ? formatMinutes(m.avgResponseMinutes) : "—"}
                          </span>
                        </div>
                        <div className="flex justify-between text-[10px] text-gray-500">
                          <span>Breaches</span>
                          <span className={cn("font-mono font-bold", m.breached > 0 ? "text-red-400" : "text-gray-400")}>
                            {m.breached}
                          </span>
                        </div>
                      </div>

                      <div>
                        <div className="flex justify-between items-center">
                          <span className="text-[10px] text-gray-500">Compliance</span>
                          <span className={cn("text-sm font-black tabular-nums", complianceColor(m.compliancePercent))}>
                            {m.total > 0 ? `${m.compliancePercent.toFixed(0)}%` : "N/A"}
                          </span>
                        </div>
                        <MiniBar pct={m.compliancePercent} />
                      </div>

                      <p className="text-[9px] text-gray-600">
                        {m.withinSLA} of {m.total} alerts acknowledged on time
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* ---- Trend Chart ---- */}
            <section>
              <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-3">
                30-Day Compliance Trend
              </h2>
              <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-4">
                {trendData.some((d) => d.total > 0) ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={trendData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 9, fill: "#6b7280" }}
                        interval={4}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis
                        domain={[0, 100]}
                        tick={{ fontSize: 9, fill: "#6b7280" }}
                        tickLine={false}
                        axisLine={false}
                        width={28}
                        tickFormatter={(v) => `${v}%`}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "#111827",
                          border: "1px solid #1f2937",
                          borderRadius: "8px",
                          fontSize: "11px",
                          color: "#d1d5db",
                        }}
                        formatter={(value: number) => [`${value}%`, "Compliance"]}
                        labelFormatter={(label) => `Date: ${label}`}
                      />
                      <ReferenceLine y={95} stroke="#10b981" strokeDasharray="4 2" strokeWidth={1} label={{ value: "95%", position: "right", fontSize: 8, fill: "#10b981" }} />
                      <ReferenceLine y={85} stroke="#f59e0b" strokeDasharray="4 2" strokeWidth={1} label={{ value: "85%", position: "right", fontSize: 8, fill: "#f59e0b" }} />
                      <Line
                        type="monotone"
                        dataKey="compliance"
                        stroke="#22d3ee"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, fill: "#22d3ee", strokeWidth: 0 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex flex-col items-center justify-center h-40">
                    <BarChart3 className="h-8 w-8 text-gray-700 mb-2" />
                    <p className="text-sm text-gray-600">Not enough data for trend analysis</p>
                    <p className="text-xs text-gray-700 mt-1">
                      Trend will populate as acknowledged alerts accumulate
                    </p>
                  </div>
                )}
              </div>
            </section>

            {/* ---- Breach History Table ---- */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">
                  Breach History
                </h2>
                <span className="text-xs text-gray-600">{breachHistory.length} breaches</span>
              </div>

              {breachHistory.length === 0 ? (
                <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-10 text-center">
                  <CheckCircle2 className="h-10 w-10 text-emerald-700 mx-auto mb-3" />
                  <p className="text-sm font-bold text-gray-400">No SLA Breaches</p>
                  <p className="text-xs text-gray-600 mt-1">
                    All alerts with acknowledgement times are within SLA targets
                  </p>
                </div>
              ) : (
                <div className="rounded-xl border border-gray-800 bg-gray-900/60 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-800 bg-gray-900/80">
                          {[
                            { key: "title" as const, label: "Alert" },
                            { key: "severity" as const, label: "Severity" },
                            { key: "responseMinutes" as const, label: "Response Time" },
                            { key: "targetMinutes" as const, label: "SLA Target" },
                            { key: "breachMinutes" as const, label: "Breached By" },
                            { key: "date" as const, label: "Date" },
                          ].map(({ key, label }) => (
                            <th
                              key={key}
                              onClick={() => handleSort(key)}
                              className="px-4 py-3 text-left font-bold uppercase tracking-wider text-gray-500 cursor-pointer hover:text-gray-300 transition-colors select-none whitespace-nowrap"
                            >
                              {label}
                              {sortCol === key && (
                                <span className="ml-1 text-cyan-500">
                                  {sortDir === "asc" ? "↑" : "↓"}
                                </span>
                              )}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800/60">
                        {breachHistory.map((breach) => (
                          <tr
                            key={breach.id}
                            className="hover:bg-gray-800/30 transition-colors"
                          >
                            <td className="px-4 py-3 text-gray-200 max-w-[200px] truncate">
                              {breach.title}
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold uppercase border",
                                  severityColor(breach.severity)
                                )}
                              >
                                {breach.severity}
                              </span>
                            </td>
                            <td className="px-4 py-3 font-mono text-red-400 font-bold">
                              {formatMinutes(breach.responseMinutes)}
                            </td>
                            <td className="px-4 py-3 font-mono text-gray-400">
                              {formatMinutes(breach.targetMinutes)}
                            </td>
                            <td className="px-4 py-3 font-mono text-red-500 font-bold">
                              +{formatMinutes(breach.breachMinutes)}
                            </td>
                            <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                              {new Date(breach.date).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                                hour12: false,
                              })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
