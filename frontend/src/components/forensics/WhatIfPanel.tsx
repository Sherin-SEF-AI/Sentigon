"use client";

import { useState, useMemo } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Beaker,
  Clock,
  Equal,
  Loader2,
  RotateCcw,
  SlidersHorizontal,
  Zap,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp, severityColor } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SimulatedAlert {
  type: string;
  timestamp: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  details: string;
  camera_id: string | null;
}

interface SimulationResult {
  simulated_alert_count: number;
  actual_alert_count: number;
  diff: number;
  simulated_alerts: SimulatedAlert[];
  thresholds_used: {
    anomaly_threshold: number;
    crowd_threshold: number;
    dwell_threshold: number;
  };
}

interface WhatIfPanelProps {
  incidentId: string;
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CARD = "rounded-lg border border-gray-800 bg-gray-900/60 backdrop-blur p-4";

const DEFAULT_THRESHOLDS = {
  anomaly_threshold: 0.5,
  crowd_threshold: 15,
  dwell_threshold: 180,
};

/* ------------------------------------------------------------------ */
/*  ThresholdSlider                                                    */
/* ------------------------------------------------------------------ */

function ThresholdSlider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
          {label}
        </label>
        <span className="rounded bg-gray-800 px-1.5 py-0.5 text-xs font-mono font-semibold text-cyan-400">
          {value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full cursor-pointer appearance-none bg-transparent [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-gray-700 [&::-webkit-slider-thumb]:mt-[-4px] [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-400 [&::-webkit-slider-thumb]:shadow-[0_0_6px_rgba(34,211,238,0.5)] [&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-gray-700 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-cyan-400"
      />
      <div className="mt-0.5 flex justify-between text-[9px] text-gray-600">
        <span>
          {min}
          {unit}
        </span>
        <span>
          {max}
          {unit}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  DiffIndicator                                                      */
/* ------------------------------------------------------------------ */

function DiffIndicator({ diff }: { diff: number }) {
  if (diff === 0) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg bg-gray-800/60 px-3 py-2 text-sm font-semibold text-gray-400">
        <Equal className="h-4 w-4" />
        No change
      </div>
    );
  }

  const isMore = diff > 0;
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-bold",
        isMore
          ? "bg-red-900/20 border border-red-800/40 text-red-400"
          : "bg-green-900/20 border border-green-800/40 text-green-400"
      )}
    >
      {isMore ? (
        <ArrowUp className="h-4 w-4" />
      ) : (
        <ArrowDown className="h-4 w-4" />
      )}
      {isMore ? "+" : ""}
      {diff} alerts
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  WhatIfPanel                                                        */
/* ------------------------------------------------------------------ */

export default function WhatIfPanel({ incidentId, className }: WhatIfPanelProps) {
  /* --- Threshold state --- */
  const [anomalyThreshold, setAnomalyThreshold] = useState(
    DEFAULT_THRESHOLDS.anomaly_threshold
  );
  const [crowdThreshold, setCrowdThreshold] = useState(
    DEFAULT_THRESHOLDS.crowd_threshold
  );
  const [dwellThreshold, setDwellThreshold] = useState(
    DEFAULT_THRESHOLDS.dwell_threshold
  );

  /* --- Simulation state --- */
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState("");

  /* --- Derived --- */
  const hasChangedThresholds = useMemo(
    () =>
      anomalyThreshold !== DEFAULT_THRESHOLDS.anomaly_threshold ||
      crowdThreshold !== DEFAULT_THRESHOLDS.crowd_threshold ||
      dwellThreshold !== DEFAULT_THRESHOLDS.dwell_threshold,
    [anomalyThreshold, crowdThreshold, dwellThreshold]
  );

  const severityCounts = useMemo(() => {
    if (!result) return {};
    const counts: Record<string, number> = {};
    for (const alert of result.simulated_alerts) {
      counts[alert.severity] = (counts[alert.severity] || 0) + 1;
    }
    return counts;
  }, [result]);

  /* --- Run simulation --- */
  const handleSimulate = async () => {
    setLoading(true);
    setError("");

    try {
      const data = await apiFetch<SimulationResult>(
        `/api/incident-replay/incidents/${incidentId}/simulate`,
        {
          method: "POST",
          body: JSON.stringify({
            anomaly_threshold: anomalyThreshold,
            crowd_threshold: crowdThreshold,
            dwell_threshold: dwellThreshold,
          }),
        }
      );
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed");
    } finally {
      setLoading(false);
    }
  };

  /* --- Reset --- */
  const handleReset = () => {
    setAnomalyThreshold(DEFAULT_THRESHOLDS.anomaly_threshold);
    setCrowdThreshold(DEFAULT_THRESHOLDS.crowd_threshold);
    setDwellThreshold(DEFAULT_THRESHOLDS.dwell_threshold);
    setResult(null);
    setError("");
  };

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* Header */}
      <div className={cn(CARD)}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Beaker className="h-5 w-5 text-amber-400" />
            <h3 className="text-sm font-bold text-gray-100">
              What-If Simulation
            </h3>
          </div>
          {hasChangedThresholds && (
            <button
              onClick={handleReset}
              className="flex items-center gap-1 rounded-lg border border-gray-700 px-2.5 py-1 text-[10px] font-medium text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          )}
        </div>

        {/* Threshold sliders */}
        <div className="space-y-4">
          <ThresholdSlider
            label="Anomaly Threshold"
            value={anomalyThreshold}
            min={0}
            max={1}
            step={0.05}
            unit=""
            onChange={setAnomalyThreshold}
          />

          <ThresholdSlider
            label="Crowd Threshold"
            value={crowdThreshold}
            min={1}
            max={50}
            step={1}
            unit=" people"
            onChange={setCrowdThreshold}
          />

          <ThresholdSlider
            label="Dwell Threshold"
            value={dwellThreshold}
            min={60}
            max={600}
            step={10}
            unit="s"
            onChange={setDwellThreshold}
          />
        </div>

        {/* Run button */}
        <button
          onClick={handleSimulate}
          disabled={loading}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Running Simulation...
            </>
          ) : (
            <>
              <Zap className="h-4 w-4" />
              Run Simulation
            </>
          )}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-xs text-red-400">
          <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" />
          {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <>
          {/* Summary card */}
          <div className={cn(CARD)}>
            <h4 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Simulation Results
            </h4>

            <div className="grid grid-cols-3 gap-3 mb-3">
              {/* Actual alerts */}
              <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-3 text-center">
                <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
                  Actual
                </p>
                <p className="text-2xl font-bold font-mono text-gray-200">
                  {result.actual_alert_count}
                </p>
              </div>

              {/* Simulated alerts */}
              <div
                className={cn(
                  "rounded-lg border p-3 text-center",
                  result.diff > 0
                    ? "border-red-800/40 bg-red-950/20"
                    : result.diff < 0
                    ? "border-green-800/40 bg-green-950/20"
                    : "border-gray-800 bg-gray-950/50"
                )}
              >
                <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
                  Simulated
                </p>
                <p
                  className={cn(
                    "text-2xl font-bold font-mono",
                    result.diff > 0
                      ? "text-red-400"
                      : result.diff < 0
                      ? "text-green-400"
                      : "text-gray-200"
                  )}
                >
                  {result.simulated_alert_count}
                </p>
              </div>

              {/* Diff */}
              <div className="flex items-center justify-center">
                <DiffIndicator diff={result.diff} />
              </div>
            </div>

            {/* Severity breakdown */}
            {Object.keys(severityCounts).length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-gray-500 uppercase tracking-wider">
                  Breakdown:
                </span>
                {Object.entries(severityCounts).map(([severity, count]) => (
                  <span
                    key={severity}
                    className={cn(
                      "rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                      severityColor(severity)
                    )}
                  >
                    {severity}: {count}
                  </span>
                ))}
              </div>
            )}

            {/* Thresholds used */}
            <div className="mt-3 rounded border border-gray-800 bg-gray-950/40 p-2">
              <p className="text-[9px] uppercase tracking-wider text-gray-600 mb-1">
                Thresholds Used
              </p>
              <div className="flex items-center gap-3 text-[10px] font-mono text-gray-400">
                <span>
                  <SlidersHorizontal className="mr-0.5 inline h-3 w-3 text-gray-600" />
                  anomaly: {result.thresholds_used.anomaly_threshold}
                </span>
                <span>crowd: {result.thresholds_used.crowd_threshold}</span>
                <span>dwell: {result.thresholds_used.dwell_threshold}s</span>
              </div>
            </div>
          </div>

          {/* Simulated alerts list */}
          {result.simulated_alerts.length > 0 && (
            <div className={cn(CARD)}>
              <h4 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Simulated Alerts ({result.simulated_alerts.length})
              </h4>

              <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
                {result.simulated_alerts.map((alert, idx) => (
                  <div
                    key={`${alert.timestamp}-${idx}`}
                    className={cn(
                      "rounded-lg border p-3 transition-colors",
                      result.diff > 0
                        ? "border-red-900/30 bg-red-950/10"
                        : result.diff < 0
                        ? "border-green-900/30 bg-green-950/10"
                        : "border-gray-800 bg-gray-900/40"
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {/* Severity badge */}
                        <span
                          className={cn(
                            "rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                            severityColor(alert.severity)
                          )}
                        >
                          {alert.severity}
                        </span>

                        {/* Alert type */}
                        <span className="rounded bg-gray-800/60 px-1.5 py-0.5 text-[10px] font-medium text-gray-300">
                          {alert.type}
                        </span>
                      </div>

                      {/* Timestamp */}
                      <span className="flex items-center gap-1 shrink-0 text-[10px] font-mono text-gray-500">
                        <Clock className="h-2.5 w-2.5" />
                        {formatTimestamp(alert.timestamp)}
                      </span>
                    </div>

                    {/* Details */}
                    <p className="mt-1.5 text-xs leading-relaxed text-gray-400">
                      {alert.details}
                    </p>

                    {/* Camera */}
                    {alert.camera_id && (
                      <div className="mt-1.5 flex items-center gap-1 text-[10px] text-gray-600">
                        <SlidersHorizontal className="h-2.5 w-2.5" />
                        Camera: {alert.camera_id}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* No alerts scenario */}
          {result.simulated_alerts.length === 0 && result.simulated_alert_count === 0 && (
            <div className={cn(CARD, "text-center py-8")}>
              <div className="inline-flex items-center gap-2 rounded-full bg-green-900/20 border border-green-800/40 px-4 py-2 text-sm font-semibold text-green-400">
                <ArrowDown className="h-4 w-4" />
                No alerts would have been generated
              </div>
              <p className="mt-2 text-xs text-gray-500">
                These thresholds would have suppressed all alerts during this incident
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
