"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  EyeOff,
  FastForward,
  Grid3x3,
  Loader2,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Rewind,
  Square,
  Zap,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";
import DetectionOverlay from "./DetectionOverlay";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface IncidentMeta {
  id: string;
  title: string;
  status: "recording" | "complete" | "archived";
  start_time: string;
  end_time: string | null;
  total_frames: number;
  total_agent_actions: number;
  camera_ids: string[];
  duration_seconds: number;
}

interface FrameDetection {
  track_id: number;
  class: string;
  confidence: number;
  bbox: [number, number, number, number];
}

interface ReplayFrame {
  frame_index: number;
  timestamp: string;
  camera_id: string;
  frame_url: string | null;
  detections: FrameDetection[];
  offset_seconds: number;
}

interface AgentAction {
  id: string;
  offset_seconds: number;
  action_type: string;
  agent_name: string;
  description: string;
}

interface MultiCameraReplayGridProps {
  incidentId: string;
  onOffsetChange?: (offset: number) => void;
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CARD = "rounded-lg border border-gray-800 bg-gray-900/60 backdrop-blur";
const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4];
const SLICE_DURATION = 30;
const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 480;

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/*  MultiCameraReplayGrid                                              */
/* ------------------------------------------------------------------ */

export default function MultiCameraReplayGrid({
  incidentId,
  onOffsetChange,
  className,
}: MultiCameraReplayGridProps) {
  const [meta, setMeta] = useState<IncidentMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Frames grouped by camera
  const [cameraFrames, setCameraFrames] = useState<Record<string, ReplayFrame[]>>({});
  const [currentOffset, setCurrentOffset] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [showOverlays, setShowOverlays] = useState(true);
  const [expandedCamera, setExpandedCamera] = useState<string | null>(null);
  const [agentActions, setAgentActions] = useState<AgentAction[]>([]);

  const playTimerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const duration = meta?.duration_seconds ?? 0;

  /* --- Fetch metadata --- */
  useEffect(() => {
    setLoading(true);
    apiFetch<IncidentMeta>(`/api/incident-replay/incidents/${incidentId}`)
      .then((data) => { setMeta(data); setError(""); })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));

    apiFetch<AgentAction[]>(`/api/incident-replay/incidents/${incidentId}/agent-actions`)
      .then(setAgentActions)
      .catch(() => {});
  }, [incidentId]);

  /* --- Fetch multicam slice --- */
  const fetchSlice = useCallback(async (startOffset: number) => {
    try {
      const data = await apiFetch<{
        incident_id: string;
        cameras: Record<string, ReplayFrame[]>;
      }>(`/api/incident-replay/incidents/${incidentId}/multicam-slice`, {
        method: "POST",
        body: JSON.stringify({ start_offset: startOffset, duration: SLICE_DURATION }),
      });
      setCameraFrames(data.cameras || {});
    } catch {
      // Fallback to regular slice and group manually
      try {
        const fallback = await apiFetch<{ frames: ReplayFrame[] }>(
          `/api/incident-replay/incidents/${incidentId}/replay-slice`,
          {
            method: "POST",
            body: JSON.stringify({ start_offset: startOffset, duration: SLICE_DURATION }),
          }
        );
        const grouped: Record<string, ReplayFrame[]> = {};
        for (const f of fallback.frames || []) {
          if (!grouped[f.camera_id]) grouped[f.camera_id] = [];
          grouped[f.camera_id].push(f);
        }
        setCameraFrames(grouped);
      } catch {
        // silently handle
      }
    }
  }, [incidentId]);

  useEffect(() => { fetchSlice(0); }, [fetchSlice]);

  /* --- Find current frame for each camera --- */
  const currentFramePerCamera = useMemo(() => {
    const result: Record<string, ReplayFrame | null> = {};
    for (const [camId, frames] of Object.entries(cameraFrames)) {
      // Find frame closest to currentOffset
      let best: ReplayFrame | null = null;
      let bestDist = Infinity;
      for (const f of frames) {
        const dist = Math.abs(f.offset_seconds - currentOffset);
        if (dist < bestDist) { bestDist = dist; best = f; }
      }
      result[camId] = best;
    }
    return result;
  }, [cameraFrames, currentOffset]);

  /* --- Playback --- */
  useEffect(() => {
    if (isPlaying) {
      playTimerRef.current = setInterval(() => {
        setCurrentOffset((prev) => {
          const next = prev + (1 / speed);
          if (next >= duration) {
            setIsPlaying(false);
            return duration;
          }
          // Load next slice if needed
          const maxOffset = Math.max(
            ...Object.values(cameraFrames).flat().map((f) => f.offset_seconds),
            0
          );
          if (next > maxOffset - 2 && next < duration) {
            fetchSlice(next);
          }
          return next;
        });
      }, 1000 / speed);
    }
    return () => { if (playTimerRef.current) clearInterval(playTimerRef.current); };
  }, [isPlaying, speed, duration, cameraFrames, fetchSlice]);

  /* --- Sync offset callback --- */
  useEffect(() => { onOffsetChange?.(currentOffset); }, [currentOffset, onOffsetChange]);

  /* --- Controls --- */
  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setCurrentOffset(v);
    setIsPlaying(false);
    fetchSlice(v);
  };

  const handleStop = () => { setIsPlaying(false); setCurrentOffset(0); fetchSlice(0); };

  /* --- Grid layout --- */
  const cameraIds = meta?.camera_ids ?? Object.keys(cameraFrames);
  const gridCols = cameraIds.length <= 2 ? 2 : cameraIds.length <= 4 ? 2 : 3;

  if (loading) {
    return (
      <div className={cn(CARD, "flex items-center justify-center py-16 p-4", className)}>
        <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
      </div>
    );
  }

  if (error || !meta) {
    return (
      <div className={cn(CARD, "text-center py-10 p-4", className)}>
        <p className="text-sm text-red-400">{error || "Incident not found"}</p>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* Header */}
      <div className={cn(CARD, "flex items-center justify-between p-4")}>
        <div className="flex items-center gap-3">
          <Grid3x3 className="h-5 w-5 text-cyan-400" />
          <div>
            <h2 className="text-sm font-bold text-gray-100">{meta.title}</h2>
            <p className="mt-0.5 text-[10px] text-gray-500 font-mono">
              Multi-Camera View &middot; {formatTimestamp(meta.start_time)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span className="flex items-center gap-1">
            <Camera className="h-3.5 w-3.5" /> {cameraIds.length} cameras
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" /> {formatDuration(duration)}
          </span>
          <span className="flex items-center gap-1">
            <Zap className="h-3.5 w-3.5 text-amber-400" /> {meta.total_agent_actions} actions
          </span>
          <button
            onClick={() => setShowOverlays(!showOverlays)}
            className={cn(
              "rounded-lg p-1.5 transition-colors",
              showOverlays ? "bg-cyan-900/30 text-cyan-400" : "bg-gray-800 text-gray-500"
            )}
            title={showOverlays ? "Hide detection overlays" : "Show detection overlays"}
          >
            {showOverlays ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Camera Grid */}
      {expandedCamera ? (
        /* Expanded single camera view */
        <div className={cn(CARD, "relative overflow-hidden p-0")}>
          <button
            onClick={() => setExpandedCamera(null)}
            className="absolute top-2 right-2 z-10 rounded-lg bg-gray-950/80 p-1.5 text-gray-400 hover:text-gray-200 transition-colors border border-gray-700"
            title="Back to grid"
          >
            <Minimize2 className="h-4 w-4" />
          </button>
          <div className="absolute top-2 left-2 z-10 rounded bg-gray-950/80 px-2 py-1 text-[10px] font-mono text-cyan-400 border border-gray-700">
            {expandedCamera.length > 16 ? expandedCamera.slice(0, 16) + "..." : expandedCamera}
          </div>
          {(() => {
            const frame = currentFramePerCamera[expandedCamera];
            return frame?.frame_url ? (
              <div className="relative min-h-[350px]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={frame.frame_url} alt="Camera frame" className="h-full w-full object-contain" />
                {showOverlays && frame.detections.length > 0 && (
                  <DetectionOverlay
                    detections={frame.detections}
                    imageWidth={FRAME_WIDTH}
                    imageHeight={FRAME_HEIGHT}
                  />
                )}
              </div>
            ) : (
              <div className="flex items-center justify-center py-20 text-gray-600">
                <Camera className="h-8 w-8" />
              </div>
            );
          })()}
        </div>
      ) : (
        /* Grid view */
        <div
          className={cn("grid gap-2")}
          style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)` }}
        >
          {cameraIds.map((camId) => {
            const frame = currentFramePerCamera[camId];
            const detCount = frame?.detections?.length ?? 0;
            return (
              <div
                key={camId}
                className={cn(
                  CARD,
                  "relative overflow-hidden p-0 cursor-pointer group hover:border-cyan-700/50 transition-colors"
                )}
                onClick={() => setExpandedCamera(camId)}
              >
                {/* Camera label */}
                <div className="absolute top-1.5 left-1.5 z-10 flex items-center gap-1.5">
                  <span className="rounded bg-gray-950/80 px-1.5 py-0.5 text-[9px] font-mono text-cyan-400 border border-gray-700">
                    {camId.length > 12 ? camId.slice(0, 12) + "..." : camId}
                  </span>
                  {detCount > 0 && (
                    <span className="rounded-full bg-cyan-600/80 px-1.5 py-0.5 text-[8px] font-bold text-white">
                      {detCount}
                    </span>
                  )}
                </div>

                {/* Expand icon on hover */}
                <div className="absolute top-1.5 right-1.5 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Maximize2 className="h-3.5 w-3.5 text-gray-400" />
                </div>

                {frame?.frame_url ? (
                  <div className="relative aspect-video">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={frame.frame_url}
                      alt={`Camera ${camId}`}
                      className="h-full w-full object-cover"
                    />
                    {showOverlays && detCount > 0 && (
                      <DetectionOverlay
                        detections={frame.detections}
                        imageWidth={FRAME_WIDTH}
                        imageHeight={FRAME_HEIGHT}
                      />
                    )}
                  </div>
                ) : (
                  <div className="flex aspect-video items-center justify-center bg-gray-950">
                    <Camera className="h-6 w-6 text-gray-700" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Timeline scrubber */}
      <div className={cn(CARD, "px-4 py-3")}>
        <div className="relative">
          <div className="absolute top-0 left-0 right-0 h-2 pointer-events-none">
            {agentActions.map((action) => {
              const pct = duration > 0 ? (action.offset_seconds / duration) * 100 : 0;
              return (
                <div
                  key={action.id}
                  className="absolute top-0 h-2 w-1 rounded-full bg-amber-400/80"
                  style={{ left: `${pct}%` }}
                  title={`${action.agent_name}: ${action.description}`}
                />
              );
            })}
          </div>
          <input
            type="range"
            min={0}
            max={duration}
            step={0.5}
            value={currentOffset}
            onChange={handleScrub}
            className="mt-3 w-full cursor-pointer appearance-none bg-transparent [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-gray-700 [&::-webkit-slider-thumb]:mt-[-4px] [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-400 [&::-webkit-slider-thumb]:shadow-[0_0_6px_rgba(34,211,238,0.5)] [&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-gray-700 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-cyan-400"
          />
        </div>
      </div>

      {/* Playback controls */}
      <div className={cn(CARD, "flex items-center justify-between p-4")}>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => { const v = Math.max(0, currentOffset - 10); setCurrentOffset(v); fetchSlice(v); }}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
            title="Back 10s"
          >
            <Rewind className="h-4 w-4" />
          </button>
          <button
            onClick={() => setCurrentOffset((v) => Math.max(0, v - 1))}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
            title="Back 1s"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          {isPlaying ? (
            <button onClick={() => setIsPlaying(false)} className="rounded-lg bg-cyan-600 p-2.5 text-white hover:bg-cyan-500 transition-colors" title="Pause">
              <Pause className="h-5 w-5" />
            </button>
          ) : (
            <button onClick={() => setIsPlaying(true)} className="rounded-lg bg-cyan-600 p-2.5 text-white hover:bg-cyan-500 transition-colors" title="Play">
              <Play className="h-5 w-5" />
            </button>
          )}
          <button
            onClick={() => setCurrentOffset((v) => Math.min(duration, v + 1))}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
            title="Forward 1s"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            onClick={() => { const v = Math.min(duration, currentOffset + 10); setCurrentOffset(v); fetchSlice(v); }}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
            title="Forward 10s"
          >
            <FastForward className="h-4 w-4" />
          </button>
          <button onClick={handleStop} className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors" title="Stop">
            <Square className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-1">
          <span className="mr-1.5 text-[10px] uppercase tracking-wider text-gray-500">Speed</span>
          {SPEED_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={cn(
                "rounded px-2 py-1 text-xs font-mono font-semibold transition-colors",
                speed === s ? "bg-cyan-600 text-white" : "bg-gray-800/60 text-gray-500 hover:bg-gray-800 hover:text-gray-300"
              )}
            >
              {s}x
            </button>
          ))}
        </div>

        <div className="text-right font-mono text-xs text-gray-400">
          <span className="text-cyan-400">{formatDuration(currentOffset)}</span>
          <span className="text-gray-600"> / </span>
          <span>{formatDuration(duration)}</span>
        </div>
      </div>
    </div>
  );
}
