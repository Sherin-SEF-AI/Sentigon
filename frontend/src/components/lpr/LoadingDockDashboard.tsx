"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Warehouse,
  Loader2,
  AlertTriangle,
  Clock,
  Truck,
  RefreshCw,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import {
  RadialBarChart,
  RadialBar,
  ResponsiveContainer,
} from "recharts";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface LoadingDock {
  id: string;
  zone_type: string;
  total_spots: number;
  occupied_spots: number;
  max_dwell_minutes: number;
  active_vehicles: string[];
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CARD = "rounded-lg border border-gray-800 bg-gray-900/60 backdrop-blur p-4";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function occupancyPercent(occupied: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((occupied / total) * 100);
}

function occupancyColorClass(percent: number): string {
  if (percent > 80) return "text-red-400";
  if (percent >= 50) return "text-yellow-400";
  return "text-emerald-400";
}

function occupancyBorderClass(percent: number): string {
  if (percent > 80) return "border-red-800/50";
  if (percent >= 50) return "border-yellow-800/40";
  return "border-gray-800";
}

function occupancyFill(percent: number): string {
  if (percent > 80) return "#f87171";
  if (percent >= 50) return "#facc15";
  return "#34d399";
}

function occupancyBgBar(percent: number): string {
  if (percent > 80) return "bg-red-400";
  if (percent >= 50) return "bg-yellow-400";
  return "bg-emerald-400";
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function LoadingDockDashboard() {
  const [docks, setDocks] = useState<LoadingDock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDocks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<LoadingDock[]>("/api/lpr/analytics/loading-docks");
      setDocks(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dock data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDocks();
  }, [fetchDocks]);

  /* Auto-refresh every 30 seconds */
  useEffect(() => {
    const interval = setInterval(fetchDocks, 30_000);
    return () => clearInterval(interval);
  }, [fetchDocks]);

  /* Summary stats */
  const totalSpots = docks.reduce((sum, d) => sum + d.total_spots, 0);
  const totalOccupied = docks.reduce((sum, d) => sum + d.occupied_spots, 0);
  const overallPercent = occupancyPercent(totalOccupied, totalSpots);

  return (
    <div className={CARD}>
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
            <Warehouse className="h-4 w-4 text-cyan-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-gray-300">
              Loading Dock Occupancy
            </h2>
            <p className="text-[11px] text-gray-600">
              Real-time dock utilization across all zones
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Overall stat */}
          {!loading && !error && docks.length > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Overall
              </span>
              <span
                className={cn(
                  "font-mono text-sm font-bold tabular-nums",
                  occupancyColorClass(overallPercent)
                )}
              >
                {overallPercent}%
              </span>
              <span className="text-[10px] text-gray-600">
                ({totalOccupied}/{totalSpots})
              </span>
            </div>
          )}

          <button
            onClick={fetchDocks}
            disabled={loading}
            className="rounded-lg border border-gray-700 p-2 text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-300 disabled:opacity-50"
          >
            <RefreshCw
              className={cn("h-4 w-4", loading && "animate-spin")}
            />
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading && docks.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          <p className="mt-3 text-sm text-gray-500">Loading dock data...</p>
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="flex flex-col items-center justify-center py-16">
          <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={fetchDocks}
            className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && docks.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16">
          <Warehouse className="mb-2 h-10 w-10 text-gray-700" />
          <p className="text-sm font-medium text-gray-400">
            No loading docks configured
          </p>
          <p className="mt-1 text-xs text-gray-600">
            Configure dock zones to start monitoring occupancy
          </p>
        </div>
      )}

      {/* Dock Grid */}
      {(docks.length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {docks.map((dock) => {
            const percent = occupancyPercent(dock.occupied_spots, dock.total_spots);
            const fill = occupancyFill(percent);

            /* Data for RadialBarChart */
            const chartData = [
              {
                name: "occupancy",
                value: percent,
                fill,
              },
            ];

            return (
              <div
                key={dock.id}
                className={cn(
                  "rounded-xl border bg-gray-900/50 p-4 transition-shadow hover:shadow-lg hover:shadow-cyan-900/10",
                  occupancyBorderClass(percent)
                )}
              >
                {/* Zone type label */}
                <div className="mb-3 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
                    <Truck className="h-3.5 w-3.5 text-gray-600" />
                    {dock.zone_type.replace(/_/g, " ")}
                  </span>
                  <span className="flex items-center gap-1 text-[10px] text-gray-600">
                    <Clock className="h-3 w-3" />
                    Max {dock.max_dwell_minutes}m
                  </span>
                </div>

                {/* Radial occupancy gauge */}
                <div className="flex items-center justify-center">
                  <div className="relative h-28 w-28">
                    <ResponsiveContainer width="100%" height="100%">
                      <RadialBarChart
                        cx="50%"
                        cy="50%"
                        innerRadius="70%"
                        outerRadius="100%"
                        startAngle={90}
                        endAngle={-270}
                        data={chartData}
                        barSize={10}
                      >
                        <RadialBar
                          background={{ fill: "#1f2937" }}
                          dataKey="value"
                          cornerRadius={5}
                        />
                      </RadialBarChart>
                    </ResponsiveContainer>
                    {/* Center label */}
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span
                        className={cn(
                          "text-xl font-bold tabular-nums",
                          occupancyColorClass(percent)
                        )}
                      >
                        {percent}%
                      </span>
                    </div>
                  </div>
                </div>

                {/* Spots detail */}
                <div className="mt-3 flex items-center justify-between">
                  <div className="text-center">
                    <span className="block text-lg font-bold tabular-nums text-gray-200">
                      {dock.occupied_spots}
                    </span>
                    <span className="text-[10px] text-gray-600">Occupied</span>
                  </div>
                  <div className="text-center">
                    <span className="block text-lg font-bold tabular-nums text-gray-200">
                      {dock.total_spots}
                    </span>
                    <span className="text-[10px] text-gray-600">Total</span>
                  </div>
                  <div className="text-center">
                    <span className="block text-lg font-bold tabular-nums text-emerald-400">
                      {dock.total_spots - dock.occupied_spots}
                    </span>
                    <span className="text-[10px] text-gray-600">Available</span>
                  </div>
                </div>

                {/* Simple bar fallback beneath the chart */}
                <div className="mt-3">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-800">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all duration-500",
                        occupancyBgBar(percent)
                      )}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
