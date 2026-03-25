"use client";

import { useState, useCallback, useEffect } from "react";
import {
  Camera,
  AlertTriangle,
  ShieldAlert,
  FolderOpen,
  Activity,
  Radio,
  Clock,
} from "lucide-react";
import { cn, threatLevelColor, apiFetch } from "@/lib/utils";
import { useWebSocket } from "@/hooks/useWebSocket";
import type { SOCMetrics, WSMessage } from "@/lib/types";

interface MetricProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  accent: string;
  pulse?: boolean;
}

function Metric({ icon, label, value, accent, pulse }: MetricProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-gray-800/50 bg-gray-900/40 px-2.5 py-1.5 transition-colors",
        "hover:bg-gray-900/60 hover:border-gray-700/50",
        pulse && "animate-pulse"
      )}
    >
      <div
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded shrink-0",
          accent
        )}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[8px] font-medium uppercase tracking-wider text-gray-500 leading-none">
          {label}
        </p>
        <p className="text-sm font-bold tabular-nums text-gray-100 leading-tight mt-0.5">
          {value}
        </p>
      </div>
    </div>
  );
}

interface SOCMetricsBarProps {
  className?: string;
  initialMetrics?: SOCMetrics;
}

export function SOCMetricsBar({ className, initialMetrics }: SOCMetricsBarProps) {
  const [metrics, setMetrics] = useState<SOCMetrics | null>(
    initialMetrics ?? null
  );

  useEffect(() => {
    if (!initialMetrics) {
      apiFetch<SOCMetrics>("/api/analytics/soc-metrics")
        .then(setMetrics)
        .catch((err: Error) => {
          console.warn("Metrics fetch failed:", err.message);
        });
    }
  }, [initialMetrics]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.channel === "metric") {
      setMetrics(msg.data as unknown as SOCMetrics);
    }
  }, []);

  useWebSocket({
    channels: ["metrics"],
    onMessage: handleMessage,
  });

  if (!metrics) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-md border border-gray-800/50 bg-gray-950 px-3 py-2",
          className
        )}
      >
        <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
        <span className="ml-2 text-[10px] text-gray-500">Loading metrics...</span>
      </div>
    );
  }

  const threatColor = threatLevelColor(metrics.threat_level);
  const isCriticalThreat = metrics.threat_level === "critical";

  return (
    <div
      className={cn(
        "flex items-center gap-2 flex-wrap",
        className
      )}
    >
      <Metric
        icon={<Camera className="h-3 w-3" />}
        label="Cameras"
        value={`${metrics.active_cameras}/${metrics.total_cameras}`}
        accent="bg-cyan-900/50 text-cyan-400"
      />

      <Metric
        icon={<AlertTriangle className="h-3 w-3" />}
        label="Alerts"
        value={metrics.total_alerts}
        accent="bg-amber-900/50 text-amber-400"
      />

      <Metric
        icon={<ShieldAlert className="h-3 w-3" />}
        label="Critical"
        value={metrics.critical_alerts}
        accent="bg-red-900/50 text-red-400"
        pulse={metrics.critical_alerts > 0}
      />

      <Metric
        icon={<FolderOpen className="h-3 w-3" />}
        label="Cases"
        value={metrics.open_cases}
        accent="bg-violet-900/50 text-violet-400"
      />

      <Metric
        icon={<Activity className="h-3 w-3" />}
        label="Detections"
        value={metrics.total_detections_today.toLocaleString()}
        accent="bg-emerald-900/50 text-emerald-400"
      />

      {metrics.avg_response_time != null && (
        <Metric
          icon={<Clock className="h-3 w-3" />}
          label="Avg Response"
          value={`${Math.round(metrics.avg_response_time)}s`}
          accent="bg-blue-900/50 text-blue-400"
        />
      )}

      {/* Threat level - special styling */}
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors ml-auto",
          isCriticalThreat
            ? "animate-pulse border-red-800/60 bg-red-950/30"
            : "border-gray-800/50 bg-gray-900/40"
        )}
      >
        <div
          className="flex h-6 w-6 items-center justify-center rounded shrink-0"
          style={{
            backgroundColor: `${threatColor}15`,
            color: threatColor,
          }}
        >
          <Radio className="h-3 w-3" />
        </div>
        <div className="min-w-0">
          <p className="text-[8px] font-medium uppercase tracking-wider text-gray-500 leading-none">
            Threat
          </p>
          <p
            className="text-xs font-bold uppercase tracking-wider leading-tight mt-0.5"
            style={{ color: threatColor }}
          >
            {metrics.threat_level}
          </p>
        </div>
      </div>
    </div>
  );
}
