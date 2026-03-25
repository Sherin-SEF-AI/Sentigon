"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Shield,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Camera,
  RefreshCw,
  Eye,
  ShieldAlert,
  ShieldX,
  ShieldCheck,
  ImagePlus,
  ScanEye,
  BarChart3,
  Activity,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";
import { useMemo } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CameraStatus {
  camera_id: string;
  streaming: boolean;
  has_baseline: boolean;
}

interface TamperSystemStatus {
  total_cameras: number;
  with_baseline: number;
  without_baseline: number;
  cameras: CameraStatus[];
}

interface TamperEvent {
  id: string;
  camera_id: string | null;
  title: string;
  description: string;
  severity: string;
  threat_type: string;
  confidence: number;
  status: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

interface TamperCheckResult {
  camera_id: string;
  ssim: number;
  tamper_detected: boolean;
  tamper_type: string;
  confidence: number;
  description: string;
  severity: string;
  alert_id: string | null;
  checked_at: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const STAT_CARD = "rounded-lg border px-4 py-3 flex flex-col gap-1";

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

function severityBadge(severity: string): string {
  switch (severity) {
    case "critical":
      return "bg-red-900/40 text-red-400 border-red-800/60";
    case "high":
      return "bg-orange-900/40 text-orange-400 border-orange-800/60";
    case "medium":
      return "bg-yellow-900/40 text-yellow-400 border-yellow-800/60";
    case "low":
      return "bg-blue-900/40 text-blue-400 border-blue-800/60";
    default:
      return "bg-gray-800 text-gray-400 border-gray-700";
  }
}

function tamperTypeLabel(type: string): string {
  switch (type) {
    case "camera_tamper":
      return "Camera Tamper";
    case "scene_modification":
      return "Scene Modified";
    case "lighting_change":
      return "Lighting Change";
    case "normal_activity":
      return "Normal";
    default:
      return type;
  }
}

function tamperTypeIcon(type: string) {
  switch (type) {
    case "camera_tamper":
      return ShieldX;
    case "scene_modification":
      return ShieldAlert;
    default:
      return ShieldCheck;
  }
}

/* ------------------------------------------------------------------ */
/*  Camera Health Score                                               */
/* ------------------------------------------------------------------ */

/** Returns a health label and color class based on tamper event count for a camera */
function cameraHealthInfo(eventCount: number): { label: string; colorClass: string; badgeClass: string } {
  if (eventCount === 0) {
    return { label: "Healthy", colorClass: "text-green-400", badgeClass: "bg-green-900/30 text-green-400 border-green-800/50" };
  }
  if (eventCount <= 2) {
    return { label: "Fair", colorClass: "text-amber-400", badgeClass: "bg-amber-900/30 text-amber-400 border-amber-800/50" };
  }
  if (eventCount <= 5) {
    return { label: "Degraded", colorClass: "text-orange-400", badgeClass: "bg-orange-900/30 text-orange-400 border-orange-800/50" };
  }
  return { label: "Critical", colorClass: "text-red-400", badgeClass: "bg-red-900/30 text-red-400 border-red-800/50" };
}

/* ------------------------------------------------------------------ */
/*  StatCard                                                           */
/* ------------------------------------------------------------------ */

function StatCard({
  icon: Icon,
  label,
  value,
  valueColor,
  borderColor,
  bgColor,
  iconColor,
}: {
  icon: typeof BarChart3;
  label: string;
  value: string | number;
  valueColor?: string;
  borderColor?: string;
  bgColor?: string;
  iconColor?: string;
}) {
  return (
    <div
      className={cn(
        STAT_CARD,
        borderColor || "border-gray-800",
        bgColor || "bg-gray-900/60"
      )}
    >
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <Icon className={cn("h-3.5 w-3.5", iconColor)} />
        {label}
      </div>
      <p
        className={cn(
          "text-2xl font-bold tabular-nums",
          valueColor || "text-gray-100"
        )}
      >
        {value}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  TamperDetectionPage                                                */
/* ------------------------------------------------------------------ */

export default function TamperDetectionPage() {
  /* --- State --- */
  const [systemStatus, setSystemStatus] = useState<TamperSystemStatus | null>(null);
  const [events, setEvents] = useState<TamperEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Action state
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<TamperCheckResult | null>(null);

  /* --- Fetch system status --- */
  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const data = await apiFetch<TamperSystemStatus>("/api/tamper/status");
      setSystemStatus(data);
    } catch {
      // Non-critical
    } finally {
      setStatusLoading(false);
    }
  }, []);

  /* --- Fetch tamper events --- */
  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ events: TamperEvent[]; total: number }>(
        "/api/tamper/events?limit=50"
      );
      setEvents(data.events);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch tamper events"
      );
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  /* --- Initial load --- */
  useEffect(() => {
    fetchStatus();
    fetchEvents();
  }, [fetchStatus, fetchEvents]);

  /* --- Auto-refresh every 30s --- */
  useEffect(() => {
    const interval = setInterval(() => {
      fetchStatus();
      fetchEvents();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchStatus, fetchEvents]);

  /* --- Capture baseline for a camera --- */
  const handleCaptureBaseline = useCallback(
    async (cameraId: string) => {
      setActionLoading(`baseline-${cameraId}`);
      try {
        await apiFetch(`/api/tamper/baseline/${cameraId}`, {
          method: "POST",
        });
        // Refresh status after baseline capture
        await fetchStatus();
      } catch (err) {
        // Show error briefly
        setError(
          err instanceof Error ? err.message : "Failed to capture baseline"
        );
        setTimeout(() => setError(null), 5000);
      } finally {
        setActionLoading(null);
      }
    },
    [fetchStatus]
  );

  /* --- Run tamper check on a camera --- */
  const handleRunCheck = useCallback(
    async (cameraId: string) => {
      setActionLoading(`check-${cameraId}`);
      setCheckResult(null);
      try {
        const result = await apiFetch<TamperCheckResult>(
          `/api/tamper/check/${cameraId}`,
          { method: "POST" }
        );
        setCheckResult(result);
        // Refresh events if tamper was detected
        if (result.tamper_detected) {
          await fetchEvents();
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to run tamper check"
        );
        setTimeout(() => setError(null), 5000);
      } finally {
        setActionLoading(null);
      }
    },
    [fetchEvents]
  );

  /* --- Refresh all data --- */
  const handleRefresh = useCallback(() => {
    setCheckResult(null);
    fetchStatus();
    fetchEvents();
  }, [fetchStatus, fetchEvents]);

  /* --- Counts for stats --- */
  const tamperCount = events.filter(
    (e) => e.threat_type === "camera_tamper"
  ).length;
  const sceneModCount = events.filter(
    (e) => e.threat_type === "scene_modification"
  ).length;

  /* --- Camera event frequency map for health scoring --- */
  const cameraEventCounts: Record<string, number> = {};
  events.forEach((ev) => {
    if (ev.camera_id) {
      cameraEventCounts[ev.camera_id] = (cameraEventCounts[ev.camera_id] || 0) + 1;
    }
  });

  /* --- Render --- */
  return (
    <div className="flex h-full flex-col overflow-auto bg-gray-950 text-gray-100">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-900/30 border border-orange-800/50">
            <ScanEye className="h-5 w-5 text-orange-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Tamper Detection
            </h1>
            <p className="text-xs text-gray-500">
              Monitor camera integrity and scene modifications via SSIM + AI classification
            </p>
          </div>
        </div>

        <button
          onClick={handleRefresh}
          className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {/* ---- Stats Row ---- */}
      {statusLoading && !systemStatus ? (
        <div className="grid grid-cols-2 gap-3 border-b border-gray-800 px-6 py-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="animate-pulse rounded-lg border border-gray-800 bg-gray-900/60 px-4 py-3 h-[76px]"
            />
          ))}
        </div>
      ) : systemStatus ? (
        <div className="grid grid-cols-2 gap-3 border-b border-gray-800 px-6 py-4 md:grid-cols-4">
          <StatCard
            icon={Camera}
            label="Total Cameras"
            value={systemStatus.total_cameras}
          />
          <StatCard
            icon={ShieldCheck}
            label="With Baseline"
            value={systemStatus.with_baseline}
            valueColor="text-green-400"
            borderColor="border-green-900/40"
            bgColor="bg-green-950/20"
            iconColor="text-green-400/80"
          />
          <StatCard
            icon={ShieldX}
            label="Tamper Events"
            value={tamperCount}
            valueColor={tamperCount > 0 ? "text-red-400" : "text-gray-400"}
            borderColor={tamperCount > 0 ? "border-red-900/40" : "border-gray-800"}
            bgColor={tamperCount > 0 ? "bg-red-950/20" : "bg-gray-900/60"}
            iconColor={tamperCount > 0 ? "text-red-400/80" : undefined}
          />
          <StatCard
            icon={ShieldAlert}
            label="Scene Modifications"
            value={sceneModCount}
            valueColor={sceneModCount > 0 ? "text-yellow-400" : "text-gray-400"}
            borderColor={sceneModCount > 0 ? "border-yellow-900/40" : "border-gray-800"}
            bgColor={sceneModCount > 0 ? "bg-yellow-950/20" : "bg-gray-900/60"}
            iconColor={sceneModCount > 0 ? "text-yellow-400/80" : undefined}
          />
        </div>
      ) : null}

      {/* ---- Check Result Toast ---- */}
      {checkResult && (
        <div
          className={cn(
            "mx-6 mt-4 rounded-lg border p-4",
            checkResult.tamper_detected
              ? "border-red-800/60 bg-red-950/30"
              : "border-green-800/60 bg-green-950/30"
          )}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {checkResult.tamper_detected ? (
                <ShieldX className="h-5 w-5 text-red-400" />
              ) : (
                <ShieldCheck className="h-5 w-5 text-green-400" />
              )}
              <div>
                <p
                  className={cn(
                    "text-sm font-semibold",
                    checkResult.tamper_detected ? "text-red-300" : "text-green-300"
                  )}
                >
                  {checkResult.tamper_detected
                    ? `Tamper Detected: ${tamperTypeLabel(checkResult.tamper_type)}`
                    : "No Tamper Detected"}
                </p>
                <p className="text-xs text-gray-400">
                  SSIM: {checkResult.ssim.toFixed(4)} | Confidence:{" "}
                  {Math.round(checkResult.confidence * 100)}% |{" "}
                  {checkResult.description}
                </p>
              </div>
            </div>
            <button
              onClick={() => setCheckResult(null)}
              className="text-xs text-gray-500 hover:text-gray-300"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* ---- Camera Grid ---- */}
      <div className="border-b border-gray-800 px-6 py-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
          Camera Baselines & Quick Actions
        </h2>
        {systemStatus && systemStatus.cameras.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {systemStatus.cameras.map((cam) => {
              const evCount = cameraEventCounts[cam.camera_id] || 0;
              const health = cameraHealthInfo(evCount);
              return (
              <div
                key={cam.camera_id}
                className={cn(
                  "rounded-lg border p-3 transition-shadow hover:shadow-lg hover:shadow-orange-900/10",
                  cam.has_baseline
                    ? "border-gray-800 bg-gray-900/60"
                    : "border-yellow-900/40 bg-yellow-950/10"
                )}
              >
                {/* Camera header */}
                <div className="mb-2 flex items-center justify-between flex-wrap gap-1">
                  <div className="flex items-center gap-2">
                    <Camera className="h-4 w-4 text-gray-500" />
                    <span className="text-xs font-medium text-gray-300 truncate max-w-[120px]">
                      {cam.camera_id.substring(0, 8)}...
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {/* Streaming indicator */}
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        cam.streaming ? "bg-green-500" : "bg-gray-600"
                      )}
                    />
                    {/* Camera health badge */}
                    <span
                      className={cn(
                        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold border",
                        health.badgeClass
                      )}
                      title={`Health score based on ${evCount} tamper event${evCount !== 1 ? "s" : ""}`}
                    >
                      {health.label}
                    </span>
                    {/* Baseline status */}
                    {cam.has_baseline ? (
                      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-green-900/30 text-green-400 border border-green-800/50">
                        <CheckCircle2 className="h-2.5 w-2.5" />
                        Baseline
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-yellow-900/30 text-yellow-400 border border-yellow-800/50">
                        <AlertTriangle className="h-2.5 w-2.5" />
                        No Baseline
                      </span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  <button
                    onClick={() => handleCaptureBaseline(cam.camera_id)}
                    disabled={
                      !cam.streaming ||
                      actionLoading === `baseline-${cam.camera_id}`
                    }
                    className={cn(
                      "flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors",
                      "bg-blue-900/30 text-blue-400 border border-blue-800/50",
                      "hover:bg-blue-800/40 hover:text-blue-300",
                      "disabled:opacity-40 disabled:cursor-not-allowed"
                    )}
                  >
                    {actionLoading === `baseline-${cam.camera_id}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <ImagePlus className="h-3 w-3" />
                    )}
                    {cam.has_baseline ? "Recapture" : "Capture"} Baseline
                  </button>

                  <button
                    onClick={() => handleRunCheck(cam.camera_id)}
                    disabled={
                      !cam.streaming ||
                      !cam.has_baseline ||
                      actionLoading === `check-${cam.camera_id}`
                    }
                    className={cn(
                      "flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors",
                      "bg-orange-900/30 text-orange-400 border border-orange-800/50",
                      "hover:bg-orange-800/40 hover:text-orange-300",
                      "disabled:opacity-40 disabled:cursor-not-allowed"
                    )}
                  >
                    {actionLoading === `check-${cam.camera_id}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <ScanEye className="h-3 w-3" />
                    )}
                    Run Check
                  </button>
                </div>
              </div>
              );
            })}
          </div>
        ) : statusLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-orange-400" />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8">
            <Camera className="mb-2 h-8 w-8 text-gray-700" />
            <p className="text-sm text-gray-500">No cameras available</p>
          </div>
        )}
      </div>

      {/* ---- Tamper Events Table ---- */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        <div className="px-6 py-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Recent Tamper Events
            </h2>
            <span className="text-xs text-gray-600">
              {events.length} event{events.length !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Loading */}
          {loading && (
            <div className="flex flex-col items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-orange-400" />
              <p className="mt-3 text-sm text-gray-500">
                Loading tamper events...
              </p>
            </div>
          )}

          {/* Error */}
          {!loading && error && (
            <div className="flex flex-col items-center justify-center py-16">
              <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
              <p className="text-sm text-red-400">{error}</p>
              <button
                onClick={handleRefresh}
                className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {/* Empty */}
          {!loading && !error && events.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16">
              <ShieldCheck className="mb-2 h-10 w-10 text-emerald-700" />
              <p className="text-sm font-medium text-gray-400">
                No tamper events detected
              </p>
              <p className="mt-1 text-xs text-gray-600">
                All cameras appear to be operating normally
              </p>
            </div>
          )}

          {/* Table */}
          {!loading && !error && events.length > 0 && (
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="pb-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Time
                  </th>
                  <th className="pb-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Camera
                  </th>
                  <th className="pb-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Type
                  </th>
                  <th className="pb-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Severity
                  </th>
                  <th className="pb-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Description
                  </th>
                  <th className="pb-3 text-right text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Confidence
                  </th>
                  <th className="pb-3 text-right text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => {
                  const TypeIcon = tamperTypeIcon(event.threat_type);
                  return (
                    <tr
                      key={event.id}
                      className="border-b border-gray-800/50 transition-colors hover:bg-gray-800/50"
                    >
                      {/* Time */}
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-1.5">
                          <Clock className="h-3 w-3 text-gray-600" />
                          <span className="text-xs text-gray-400">
                            {event.created_at
                              ? formatTimestamp(event.created_at)
                              : "--"}
                          </span>
                        </div>
                        {event.created_at && (
                          <span className="text-[10px] text-gray-600">
                            {timeAgo(event.created_at)}
                          </span>
                        )}
                      </td>

                      {/* Camera */}
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-1.5">
                          <Camera className="h-3 w-3 text-gray-600" />
                          <span className="text-xs font-medium text-gray-300">
                            {event.camera_id
                              ? event.camera_id.substring(0, 8) + "..."
                              : "--"}
                          </span>
                        </div>
                      </td>

                      {/* Type */}
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-1.5">
                          <TypeIcon className="h-3 w-3 text-orange-400" />
                          <span className="text-xs text-gray-300">
                            {tamperTypeLabel(event.threat_type)}
                          </span>
                        </div>
                      </td>

                      {/* Severity */}
                      <td className="py-3 pr-4">
                        <span
                          className={cn(
                            "inline-flex items-center rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider border",
                            severityBadge(event.severity)
                          )}
                        >
                          {event.severity}
                        </span>
                      </td>

                      {/* Description */}
                      <td className="py-3 pr-4">
                        <span className="text-xs text-gray-400 line-clamp-2 max-w-[300px]">
                          {event.description || event.title}
                        </span>
                      </td>

                      {/* Confidence */}
                      <td className="py-3 pr-4 text-right">
                        <span className="font-mono text-xs font-semibold text-orange-400">
                          {Math.round(event.confidence * 100)}%
                        </span>
                      </td>

                      {/* Status */}
                      <td className="py-3 text-right">
                        <span
                          className={cn(
                            "inline-flex items-center rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider border",
                            event.status === "resolved"
                              ? "bg-green-900/30 text-green-400 border-green-800/50"
                              : event.status === "acknowledged"
                              ? "bg-blue-900/30 text-blue-400 border-blue-800/50"
                              : "bg-red-900/30 text-red-400 border-red-800/50"
                          )}
                        >
                          {event.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
