"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { BarChart3, Loader2, Download, TrendingUp, AlertCircle } from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { exportCSV } from "@/lib/export";
import { useToast } from "@/components/common/Toaster";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

/* ---------- type helpers for API responses ---------- */

interface EventOverTimePoint {
  time: string;
  count: number;
}

interface SeveritySlice {
  severity: string;
  count: number;
}

interface ZoneOccupancyItem {
  zone: string;
  current: number;
  max: number;
}

interface CameraActivityItem {
  camera: string;
  events: number;
}

interface ResponseTimePoint {
  time: string;
  avg_seconds: number;
}

interface ForecastPoint {
  hour: string;
  predicted_volume: number;
}

/* ---------- constants ---------- */

const TIME_RANGES: { label: string; hours: number }[] = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
  { label: "90d", hours: 2160 },
];

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#3b82f6",
  info: "#6b7280",
};

const CARD =
  "rounded-lg border border-gray-800 bg-gray-900/60 p-4 flex flex-col";

const TICK_STYLE = { fill: "#9ca3af", fontSize: 12 };

/* ---------- small reusable pieces ---------- */

function Spinner() {
  return (
    <div className="flex flex-1 items-center justify-center py-16">
      <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
    </div>
  );
}

function ChartCard({
  title,
  children,
  className,
  onExport,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  onExport?: () => void;
}) {
  return (
    <div className={cn(CARD, className)}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-300">{title}</h3>
        {onExport && (
          <button
            onClick={onExport}
            title="Export chart data as CSV"
            className="flex items-center gap-1 rounded-md border border-gray-700 bg-gray-800 px-2 py-1 text-[10px] font-medium text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-200"
          >
            <Download className="h-3 w-3" />
            CSV
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/* ---------- custom tooltip ---------- */

function DarkTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color?: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-xs shadow-lg">
      {label && <p className="mb-1 text-gray-400">{label}</p>}
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color || "#06b6d4" }}>
          {p.name}: {p.value}
        </p>
      ))}
    </div>
  );
}

/* ---------- anomaly dot renderer ---------- */

function AnomalyDot(props: {
  cx?: number;
  cy?: number;
  payload?: EventOverTimePoint & { _isAnomaly?: boolean };
}) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null) return null;
  if (payload?._isAnomaly) {
    return (
      <g>
        <circle cx={cx} cy={cy} r={6} fill="#ef4444" stroke="#fca5a5" strokeWidth={2} />
        <circle cx={cx} cy={cy} r={10} fill="#ef444420" />
      </g>
    );
  }
  return <circle cx={cx} cy={cy} r={3} fill="#06b6d4" />;
}

/* ---------- anomaly tooltip ---------- */

function AnomalyTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { name: string; value: number; payload?: EventOverTimePoint & { _isAnomaly?: boolean } }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const isAnomaly = payload[0]?.payload?._isAnomaly;
  return (
    <div className={cn(
      "rounded-md border px-3 py-2 text-xs shadow-lg",
      isAnomaly
        ? "border-red-700 bg-red-950"
        : "border-gray-700 bg-gray-900"
    )}>
      {label && <p className="mb-1 text-gray-400">{label}</p>}
      {isAnomaly && (
        <p className="mb-1 flex items-center gap-1 font-semibold text-red-400">
          <AlertCircle className="h-3 w-3" />
          Anomaly detected
        </p>
      )}
      {payload.map((p) => (
        <p key={p.name} style={{ color: isAnomaly ? "#f87171" : "#06b6d4" }}>
          {p.name}: {p.value}
        </p>
      ))}
    </div>
  );
}

/* ---------- main page component ---------- */

export default function AnalyticsPage() {
  const { addToast } = useToast();
  const [hours, setHours] = useState(24);

  /* data buckets */
  const [eventsData, setEventsData] = useState<EventOverTimePoint[] | null>(null);
  const [severityData, setSeverityData] = useState<SeveritySlice[] | null>(null);
  const [occupancyData, setOccupancyData] = useState<ZoneOccupancyItem[] | null>(null);
  const [cameraData, setCameraData] = useState<CameraActivityItem[] | null>(null);
  const [responseData, setResponseData] = useState<ResponseTimePoint[] | null>(null);
  const [forecastData, setForecastData] = useState<ForecastPoint[] | null>(null);
  const [forecastUnavailable, setForecastUnavailable] = useState(false);

  /* loaders */
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [loadingSeverity, setLoadingSeverity] = useState(true);
  const [loadingOccupancy, setLoadingOccupancy] = useState(true);
  const [loadingCamera, setLoadingCamera] = useState(true);
  const [loadingResponse, setLoadingResponse] = useState(true);
  const [loadingForecast, setLoadingForecast] = useState(true);

  /* fetch helpers ------------------------------------------------------------- */

  const fetchEvents = useCallback((h: number) => {
    setLoadingEvents(true);
    apiFetch<{ data: EventOverTimePoint[] }>(`/api/analytics/events-over-time?hours=${h}`)
      .then((res) => setEventsData(res.data))
      .catch(() => setEventsData([]))
      .finally(() => setLoadingEvents(false));
  }, []);

  const fetchSeverity = useCallback(() => {
    setLoadingSeverity(true);
    apiFetch<{ data: SeveritySlice[] }>("/api/analytics/alerts-by-severity")
      .then((res) => setSeverityData(res.data))
      .catch(() => setSeverityData([]))
      .finally(() => setLoadingSeverity(false));
  }, []);

  const fetchOccupancy = useCallback(() => {
    setLoadingOccupancy(true);
    apiFetch<{ data: ZoneOccupancyItem[] }>("/api/analytics/zone-occupancy")
      .then((res) => setOccupancyData(res.data))
      .catch(() => setOccupancyData([]))
      .finally(() => setLoadingOccupancy(false));
  }, []);

  const fetchCamera = useCallback(() => {
    setLoadingCamera(true);
    apiFetch<{ data: CameraActivityItem[] }>("/api/analytics/camera-activity")
      .then((res) => setCameraData(res.data))
      .catch(() => setCameraData([]))
      .finally(() => setLoadingCamera(false));
  }, []);

  const fetchResponse = useCallback(() => {
    setLoadingResponse(true);
    apiFetch<{ data: ResponseTimePoint[] }>("/api/analytics/response-times")
      .then((res) => setResponseData(res.data))
      .catch(() => setResponseData([]))
      .finally(() => setLoadingResponse(false));
  }, []);

  const fetchForecast = useCallback(() => {
    setLoadingForecast(true);
    setForecastUnavailable(false);
    apiFetch<{ data: ForecastPoint[] } | ForecastPoint[]>("/api/threat-engine/forecast")
      .then((res) => {
        // Support both { data: [...] } and direct array responses
        const points = Array.isArray(res) ? res : (res as { data: ForecastPoint[] }).data;
        setForecastData(points);
      })
      .catch((err: Error) => {
        // 404 or any error → show placeholder
        if (err.message?.includes("404") || err.message?.includes("Not Found")) {
          setForecastUnavailable(true);
        } else {
          setForecastUnavailable(true);
        }
        setForecastData(null);
      })
      .finally(() => setLoadingForecast(false));
  }, []);

  /* initial + time-range-dependent loads */
  useEffect(() => {
    fetchEvents(hours);
  }, [hours, fetchEvents]);

  useEffect(() => {
    fetchSeverity();
    fetchOccupancy();
    fetchCamera();
    fetchResponse();
    fetchForecast();
  }, [fetchSeverity, fetchOccupancy, fetchCamera, fetchResponse, fetchForecast]);

  /* ---------- memoised chart data -------------------------------------------- */

  const eventsChartData = useMemo(() => eventsData ?? [], [eventsData]);
  const severityChartData = useMemo(() => severityData ?? [], [severityData]);
  const occupancyChartData = useMemo(() => occupancyData ?? [], [occupancyData]);
  const cameraChartData = useMemo(() => cameraData ?? [], [cameraData]);
  const responseChartData = useMemo(() => responseData ?? [], [responseData]);
  const forecastChartData = useMemo(() => forecastData ?? [], [forecastData]);

  // Anomaly detection: mark points exceeding mean + 2*stddev
  const eventsChartDataWithAnomalies = useMemo(() => {
    const data = eventsChartData;
    if (data.length < 3) return data.map((d) => ({ ...d, _isAnomaly: false }));
    const values = data.map((d) => d.count);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const stddev = Math.sqrt(variance);
    const threshold = mean + 2 * stddev;
    return data.map((d) => ({ ...d, _isAnomaly: d.count > threshold }));
  }, [eventsChartData]);

  const severityCells = useMemo(
    () =>
      severityChartData.map((entry) => (
        <Cell
          key={entry.severity}
          fill={SEVERITY_COLORS[entry.severity] || "#6b7280"}
        />
      )),
    [severityChartData]
  );

  /* ---------- per-chart CSV export handlers ----------------------------------- */

  const ts = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  const handleExportEvents = useCallback(() => {
    if (!eventsChartData.length) { addToast("info", "No events data to export."); return; }
    try {
      exportCSV(eventsChartData as Record<string, unknown>[], `events_over_time_${ts()}.csv`);
      addToast("success", "Events Over Time exported.");
    } catch { addToast("error", "Export failed."); }
  }, [eventsChartData, addToast]);

  const handleExportSeverity = useCallback(() => {
    if (!severityChartData.length) { addToast("info", "No severity data to export."); return; }
    try {
      exportCSV(severityChartData as Record<string, unknown>[], `alerts_by_severity_${ts()}.csv`);
      addToast("success", "Alerts by Severity exported.");
    } catch { addToast("error", "Export failed."); }
  }, [severityChartData, addToast]);

  const handleExportOccupancy = useCallback(() => {
    if (!occupancyChartData.length) { addToast("info", "No occupancy data to export."); return; }
    try {
      exportCSV(occupancyChartData as Record<string, unknown>[], `zone_occupancy_${ts()}.csv`);
      addToast("success", "Zone Occupancy exported.");
    } catch { addToast("error", "Export failed."); }
  }, [occupancyChartData, addToast]);

  const handleExportCamera = useCallback(() => {
    if (!cameraChartData.length) { addToast("info", "No camera data to export."); return; }
    try {
      exportCSV(cameraChartData as Record<string, unknown>[], `camera_activity_${ts()}.csv`);
      addToast("success", "Camera Activity exported.");
    } catch { addToast("error", "Export failed."); }
  }, [cameraChartData, addToast]);

  const handleExportResponse = useCallback(() => {
    if (!responseChartData.length) { addToast("info", "No response time data to export."); return; }
    try {
      exportCSV(responseChartData as Record<string, unknown>[], `response_times_${ts()}.csv`);
      addToast("success", "Response Time Trend exported.");
    } catch { addToast("error", "Export failed."); }
  }, [responseChartData, addToast]);

  const handleExportForecast = useCallback(() => {
    if (!forecastChartData.length) { addToast("info", "No forecast data to export."); return; }
    try {
      exportCSV(forecastChartData as Record<string, unknown>[], `threat_forecast_${ts()}.csv`);
      addToast("success", "Threat Forecast exported.");
    } catch { addToast("error", "Export failed."); }
  }, [forecastChartData, addToast]);

  /* ---------- render --------------------------------------------------------- */

  return (
    <div className="flex h-full flex-col overflow-auto bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <BarChart3 className="h-6 w-6 text-cyan-400" />
          <h1 className="text-xl font-bold tracking-tight">Security Analytics</h1>
        </div>

        {/* Time range selector */}
        <div className="flex gap-1 rounded-lg border border-gray-800 bg-gray-900/60 p-1">
          {TIME_RANGES.map((r) => (
            <button
              key={r.hours}
              onClick={() => setHours(r.hours)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                hours === r.hours
                  ? "bg-cyan-500/20 text-cyan-400"
                  : "text-gray-400 hover:text-gray-200"
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>

      {/* Charts grid */}
      <div className="flex-1 space-y-4 p-6">
        <div className="grid gap-4 md:grid-cols-2">
          {/* 1. Events Over Time ------------------------------------------------ */}
          <ChartCard title="Events Over Time" onExport={handleExportEvents}>
            {loadingEvents ? (
              <Spinner />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={eventsChartDataWithAnomalies}>
                  <defs>
                    <linearGradient id="cyanGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis dataKey="time" tick={TICK_STYLE} />
                  <YAxis tick={TICK_STYLE} />
                  <Tooltip content={<AnomalyTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="count"
                    stroke="#06b6d4"
                    fill="url(#cyanGrad)"
                    strokeWidth={2}
                    name="Events"
                    dot={<AnomalyDot />}
                    activeDot={{ r: 5, fill: "#22d3ee" }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          {/* 2. Alerts by Severity --------------------------------------------- */}
          <ChartCard title="Alerts by Severity" onExport={handleExportSeverity}>
            {loadingSeverity ? (
              <Spinner />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={severityChartData}
                    dataKey="count"
                    nameKey="severity"
                    cx="50%"
                    cy="50%"
                    outerRadius={90}
                    innerRadius={50}
                    paddingAngle={2}
                    label={({ name, percent }: { name?: string; percent?: number }) =>
                      `${name ?? ""} ${((percent ?? 0) * 100).toFixed(0)}%`
                    }
                  >
                    {severityCells}
                  </Pie>
                  <Tooltip content={<DarkTooltip />} />
                  <Legend
                    wrapperStyle={{ fontSize: 12, color: "#9ca3af" }}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          {/* 3. Zone Occupancy ------------------------------------------------- */}
          <ChartCard title="Zone Occupancy" onExport={handleExportOccupancy}>
            {loadingOccupancy ? (
              <Spinner />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={occupancyChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis dataKey="zone" tick={TICK_STYLE} />
                  <YAxis tick={TICK_STYLE} />
                  <Tooltip content={<DarkTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 12, color: "#9ca3af" }} />
                  <Bar
                    dataKey="current"
                    name="Current"
                    fill="#06b6d4"
                    radius={[4, 4, 0, 0]}
                  />
                  <Bar
                    dataKey="max"
                    name="Max"
                    fill="#374151"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          {/* 4. Camera Activity ------------------------------------------------ */}
          <ChartCard title="Camera Activity" onExport={handleExportCamera}>
            {loadingCamera ? (
              <Spinner />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart
                  data={cameraChartData}
                  layout="vertical"
                  margin={{ left: 20 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis type="number" tick={TICK_STYLE} />
                  <YAxis
                    type="category"
                    dataKey="camera"
                    tick={TICK_STYLE}
                    width={100}
                  />
                  <Tooltip content={<DarkTooltip />} />
                  <Bar
                    dataKey="events"
                    name="Events"
                    fill="#06b6d4"
                    radius={[0, 4, 4, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </ChartCard>
        </div>

        {/* 5. Response Time Trend ---------------------------------------------- */}
        <ChartCard title="Response Time Trend" className="w-full" onExport={handleExportResponse}>
          {loadingResponse ? (
            <Spinner />
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={responseChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="time" tick={TICK_STYLE} />
                <YAxis
                  tick={TICK_STYLE}
                  label={{
                    value: "seconds",
                    angle: -90,
                    position: "insideLeft",
                    style: { fill: "#9ca3af", fontSize: 12 },
                  }}
                />
                <Tooltip content={<DarkTooltip />} />
                <Line
                  type="monotone"
                  dataKey="avg_seconds"
                  stroke="#06b6d4"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "#06b6d4" }}
                  activeDot={{ r: 5, fill: "#22d3ee" }}
                  name="Avg Response"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* 6. Threat Forecast (24h) -------------------------------------------- */}
        <ChartCard
          title="Threat Forecast (24h)"
          className="w-full"
          onExport={forecastChartData.length > 0 ? handleExportForecast : undefined}
        >
          {loadingForecast ? (
            <Spinner />
          ) : forecastUnavailable || forecastChartData.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16">
              <div className="flex h-12 w-12 items-center justify-center rounded-full border border-gray-700 bg-gray-800">
                <TrendingUp className="h-6 w-6 text-gray-600" />
              </div>
              <p className="text-sm font-medium text-gray-500">Forecast unavailable</p>
              <p className="text-xs text-gray-600">
                The threat forecast engine is not reachable or has no data for the next 24 hours.
              </p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={forecastChartData}>
                <defs>
                  <linearGradient id="forecastGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#a855f7" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#a855f7" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="hour" tick={TICK_STYLE} />
                <YAxis
                  tick={TICK_STYLE}
                  label={{
                    value: "predicted alerts",
                    angle: -90,
                    position: "insideLeft",
                    style: { fill: "#9ca3af", fontSize: 11 },
                  }}
                />
                <Tooltip content={<DarkTooltip />} />
                <Line
                  type="monotone"
                  dataKey="predicted_volume"
                  stroke="#a855f7"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  dot={{ r: 3, fill: "#a855f7" }}
                  activeDot={{ r: 5, fill: "#c084fc" }}
                  name="Predicted Alerts"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>
    </div>
  );
}
