"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Activity,
  Loader2,
  AlertTriangle,
  TrendingUp,
  Clock,
  Car,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface FlowDataPoint {
  hour: string;
  total: number;
  cars: number;
  trucks: number;
  motorcycles: number;
  other: number;
}

interface FlowPatterns {
  data: FlowDataPoint[];
  total_vehicles: number;
  peak_hour: string;
  peak_count: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CARD = "rounded-lg border border-gray-800 bg-gray-900/60 backdrop-blur p-4";

type TimeRange = "24h" | "48h" | "7d";

const TIME_RANGE_HOURS: Record<TimeRange, number> = {
  "24h": 24,
  "48h": 48,
  "7d": 168,
};

const AREA_COLORS = {
  cars: { stroke: "#22d3ee", fill: "#22d3ee" },
  trucks: { stroke: "#a78bfa", fill: "#a78bfa" },
  motorcycles: { stroke: "#fb923c", fill: "#fb923c" },
  other: { stroke: "#6b7280", fill: "#6b7280" },
} as const;

/* ------------------------------------------------------------------ */
/*  Custom Tooltip                                                     */
/* ------------------------------------------------------------------ */

interface TooltipPayload {
  name: string;
  value: number;
  color: string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 shadow-xl">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
        {label}
      </p>
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center justify-between gap-4 text-xs">
          <span className="flex items-center gap-1.5 capitalize text-gray-400">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            {entry.name}
          </span>
          <span className="font-mono tabular-nums text-gray-200">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface VehicleFlowChartProps {
  hours?: number;
}

export default function VehicleFlowChart({
  hours: defaultHours,
}: VehicleFlowChartProps) {
  const [flowData, setFlowData] = useState<FlowPatterns | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* Time range selector */
  const initialRange: TimeRange = defaultHours
    ? defaultHours <= 24
      ? "24h"
      : defaultHours <= 48
        ? "48h"
        : "7d"
    : "24h";

  const [timeRange, setTimeRange] = useState<TimeRange>(initialRange);

  const activeHours = defaultHours ?? TIME_RANGE_HOURS[timeRange];

  const fetchFlow = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<FlowPatterns>(
        `/api/lpr/analytics/flow-patterns?hours=${activeHours}`
      );
      setFlowData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load flow data");
    } finally {
      setLoading(false);
    }
  }, [activeHours]);

  useEffect(() => {
    fetchFlow();
  }, [fetchFlow]);

  /* Stat cards */
  const stats = useMemo(() => {
    if (!flowData) return [];
    return [
      {
        label: "Total Vehicles",
        value: (flowData.total_vehicles ?? 0).toLocaleString(),
        icon: Car,
        accent: "text-cyan-400",
      },
      {
        label: "Peak Hour",
        value: flowData.peak_hour,
        icon: TrendingUp,
        accent: "text-amber-400",
      },
      {
        label: "Peak Count",
        value: flowData.peak_count.toLocaleString(),
        icon: Activity,
        accent: "text-emerald-400",
      },
    ];
  }, [flowData]);

  return (
    <div className={CARD}>
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
            <Activity className="h-4 w-4 text-cyan-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-gray-300">
              Vehicle Flow Patterns
            </h2>
            <p className="text-[11px] text-gray-600">
              Hourly vehicle traffic analysis
            </p>
          </div>
        </div>

        {/* Time range selector */}
        <div className="flex items-center rounded-lg border border-gray-700 bg-gray-800 p-0.5">
          {(["24h", "48h", "7d"] as TimeRange[]).map((range) => (
            <button
              key={range}
              onClick={() => setTimeRange(range)}
              className={cn(
                "rounded-md px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors",
                timeRange === range
                  ? "bg-gray-700 text-cyan-400"
                  : "text-gray-500 hover:text-gray-300"
              )}
            >
              {range}
            </button>
          ))}
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          <p className="mt-3 text-sm text-gray-500">Loading flow data...</p>
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="flex flex-col items-center justify-center py-16">
          <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={fetchFlow}
            className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Content */}
      {!loading && !error && flowData && (
        <>
          {/* Stat cards row */}
          <div className="mb-4 flex items-center gap-3 overflow-x-auto">
            {stats.map((stat) => (
              <div
                key={stat.label}
                className="flex items-center gap-2.5 rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3 min-w-[140px]"
              >
                <stat.icon className={cn("h-4 w-4 shrink-0", stat.accent)} />
                <div>
                  <span
                    className={cn(
                      "block text-lg font-bold tabular-nums",
                      stat.accent
                    )}
                  >
                    {stat.value}
                  </span>
                  <span className="text-[10px] text-gray-500 whitespace-nowrap">
                    {stat.label}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* Vehicle type legend */}
          <div className="mb-3 flex items-center gap-4">
            {Object.entries(AREA_COLORS).map(([key, colors]) => (
              <span key={key} className="flex items-center gap-1.5 text-[10px] text-gray-500">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: colors.fill }}
                />
                <span className="capitalize">{key}</span>
              </span>
            ))}
          </div>

          {/* Chart */}
          {flowData.data.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Activity className="mb-2 h-10 w-10 text-gray-700" />
              <p className="text-sm font-medium text-gray-400">
                No flow data available for this period
              </p>
            </div>
          ) : (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={flowData.data}
                  margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
                >
                  <defs>
                    {Object.entries(AREA_COLORS).map(([key, colors]) => (
                      <linearGradient
                        key={key}
                        id={`gradient-${key}`}
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="5%"
                          stopColor={colors.fill}
                          stopOpacity={0.3}
                        />
                        <stop
                          offset="95%"
                          stopColor={colors.fill}
                          stopOpacity={0.05}
                        />
                      </linearGradient>
                    ))}
                  </defs>

                  <XAxis
                    dataKey="hour"
                    tick={{ fill: "#6b7280", fontSize: 10 }}
                    tickLine={false}
                    axisLine={{ stroke: "#374151" }}
                  />
                  <YAxis
                    tick={{ fill: "#6b7280", fontSize: 10 }}
                    tickLine={false}
                    axisLine={{ stroke: "#374151" }}
                    width={40}
                  />
                  <Tooltip content={<CustomTooltip />} />

                  <Area
                    type="monotone"
                    dataKey="cars"
                    stroke={AREA_COLORS.cars.stroke}
                    strokeWidth={2}
                    fill={`url(#gradient-cars)`}
                    stackId="1"
                  />
                  <Area
                    type="monotone"
                    dataKey="trucks"
                    stroke={AREA_COLORS.trucks.stroke}
                    strokeWidth={2}
                    fill={`url(#gradient-trucks)`}
                    stackId="1"
                  />
                  <Area
                    type="monotone"
                    dataKey="motorcycles"
                    stroke={AREA_COLORS.motorcycles.stroke}
                    strokeWidth={2}
                    fill={`url(#gradient-motorcycles)`}
                    stackId="1"
                  />
                  <Area
                    type="monotone"
                    dataKey="other"
                    stroke={AREA_COLORS.other.stroke}
                    strokeWidth={2}
                    fill={`url(#gradient-other)`}
                    stackId="1"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
    </div>
  );
}
