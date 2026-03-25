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
  Loader2,
  Maximize2,
  Pause,
  Play,
  Rewind,
  Square,
  Zap,
} from "lucide-react";
import DetectionOverlay from "./DetectionOverlay";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";

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

interface ReplaySliceResponse {
  frames: ReplayFrame[];
  total_frames: number;
  start_offset: number;
  duration: number;
}

interface AgentAction {
  id: string;
  offset_seconds: number;
  action_type: string;
  agent_name: string;
  description: string;
}

interface IncidentReplayPlayerProps {
  incidentId: string;
  onOffsetChange?: (offset: number) => void;
  initialSpeed?: number;
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CARD = "rounded-lg border border-gray-800 bg-gray-900/60 backdrop-blur p-4";
const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4];
const SLICE_DURATION = 30; // seconds per slice fetch

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/*  IncidentReplayPlayer                                               */
/* ------------------------------------------------------------------ */

export default function IncidentReplayPlayer({
  incidentId,
  onOffsetChange,
  initialSpeed,
  className,
}: IncidentReplayPlayerProps) {
  /* --- State --- */
  const [meta, setMeta] = useState<IncidentMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [frames, setFrames] = useState<ReplayFrame[]>([]);
  const [currentFrameIndex, setCurrentFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(
    SPEED_OPTIONS.includes(initialSpeed as typeof SPEED_OPTIONS[number])
      ? (initialSpeed as number)
      : 1
  );
  const [currentOffset, setCurrentOffset] = useState(0);

  const [activeCamera, setActiveCamera] = useState<string>("all");
  const [agentActions, setAgentActions] = useState<AgentAction[]>([]);
  const [showOverlays, setShowOverlays] = useState(true);

  const playTimerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  /* --- Derived --- */
  const duration = meta?.duration_seconds ?? 0;

  const visibleFrames = useMemo(() => {
    if (activeCamera === "all") return frames;
    return frames.filter((f) => f.camera_id === activeCamera);
  }, [frames, activeCamera]);

  const currentFrame = visibleFrames[currentFrameIndex] ?? null;

  /* --- Fetch metadata --- */
  const fetchMeta = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<IncidentMeta>(
        `/api/incident-replay/incidents/${incidentId}`
      );
      setMeta(data);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load incident");
    } finally {
      setLoading(false);
    }
  }, [incidentId]);

  /* --- Fetch agent actions for timeline markers --- */
  const fetchActions = useCallback(async () => {
    try {
      const data = await apiFetch<AgentAction[]>(
        `/api/incident-replay/incidents/${incidentId}/agent-actions`
      );
      setAgentActions(data);
    } catch {
      // Silently handle
    }
  }, [incidentId]);

  /* --- Fetch frame slice --- */
  const fetchSlice = useCallback(
    async (startOffset: number) => {
      try {
        const data = await apiFetch<ReplaySliceResponse>(
          `/api/incident-replay/incidents/${incidentId}/replay-slice`,
          {
            method: "POST",
            body: JSON.stringify({
              start_offset: startOffset,
              duration: SLICE_DURATION,
            }),
          }
        );
        setFrames(data.frames);
        setCurrentFrameIndex(0);
      } catch {
        // Silently handle
      }
    },
    [incidentId]
  );

  useEffect(() => {
    fetchMeta();
    fetchActions();
    fetchSlice(0);
  }, [fetchMeta, fetchActions, fetchSlice]);

  /* --- Playback logic --- */
  useEffect(() => {
    if (isPlaying && visibleFrames.length > 0) {
      const intervalMs = 1000 / speed;
      playTimerRef.current = setInterval(() => {
        setCurrentFrameIndex((prev) => {
          const next = prev + 1;
          if (next >= visibleFrames.length) {
            // Attempt to load next slice
            const lastFrame = visibleFrames[visibleFrames.length - 1];
            if (lastFrame && lastFrame.offset_seconds < duration) {
              fetchSlice(lastFrame.offset_seconds);
              return 0;
            }
            // End of replay
            setIsPlaying(false);
            return prev;
          }
          return next;
        });
      }, intervalMs);
    }

    return () => {
      if (playTimerRef.current) clearInterval(playTimerRef.current);
    };
  }, [isPlaying, speed, visibleFrames, duration, fetchSlice]);

  /* --- Sync offset with current frame --- */
  useEffect(() => {
    if (currentFrame) {
      setCurrentOffset(currentFrame.offset_seconds);
      onOffsetChange?.(currentFrame.offset_seconds);
    }
  }, [currentFrame, onOffsetChange]);

  /* --- Controls --- */
  const handlePlay = () => setIsPlaying(true);
  const handlePause = () => setIsPlaying(false);
  const handleStop = () => {
    setIsPlaying(false);
    setCurrentFrameIndex(0);
    setCurrentOffset(0);
    fetchSlice(0);
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newOffset = Number(e.target.value);
    setCurrentOffset(newOffset);
    setIsPlaying(false);
    fetchSlice(newOffset);
  };

  /* --- Loading state --- */
  if (loading) {
    return (
      <div className={cn(CARD, "flex items-center justify-center py-16", className)}>
        <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
      </div>
    );
  }

  if (error || !meta) {
    return (
      <div className={cn(CARD, "text-center py-10", className)}>
        <p className="text-sm text-red-400">{error || "Incident not found"}</p>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* Header */}
      <div className={cn(CARD, "flex items-center justify-between")}>
        <div className="flex items-center gap-3">
          <Play className="h-5 w-5 text-cyan-400" />
          <div>
            <h2 className="text-sm font-bold text-gray-100">{meta.title}</h2>
            <p className="mt-0.5 text-[10px] text-gray-500 font-mono">
              {formatTimestamp(meta.start_time)}
              {meta.end_time && <> &mdash; {formatTimestamp(meta.end_time)}</>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span className="flex items-center gap-1">
            <Camera className="h-3.5 w-3.5" />
            {meta.camera_ids.length} cameras
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            {formatDuration(duration)}
          </span>
          <span className="flex items-center gap-1">
            <Zap className="h-3.5 w-3.5 text-amber-400" />
            {meta.total_agent_actions} actions
          </span>
        </div>
      </div>

      {/* Camera tabs */}
      {meta.camera_ids.length > 1 && (
        <div className="flex items-center gap-1 overflow-x-auto">
          <button
            onClick={() => setActiveCamera("all")}
            className={cn(
              "shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              activeCamera === "all"
                ? "bg-cyan-600 text-white"
                : "bg-gray-800/60 text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            )}
          >
            <Maximize2 className="mr-1 inline h-3 w-3" />
            All Cameras
          </button>
          {meta.camera_ids.map((camId) => (
            <button
              key={camId}
              onClick={() => setActiveCamera(camId)}
              className={cn(
                "shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                activeCamera === camId
                  ? "bg-cyan-600 text-white"
                  : "bg-gray-800/60 text-gray-400 hover:bg-gray-800 hover:text-gray-200"
              )}
            >
              <Camera className="mr-1 inline h-3 w-3" />
              {camId.length > 12 ? camId.slice(0, 12) + "..." : camId}
            </button>
          ))}
        </div>
      )}

      {/* Video viewport */}
      <div className={cn(CARD, "relative min-h-[300px] flex items-center justify-center overflow-hidden p-0")}>
        {currentFrame?.frame_url ? (
          <div className="relative w-full h-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={currentFrame.frame_url}
              alt={`Frame at ${formatDuration(currentFrame.offset_seconds)}`}
              className="h-full w-full object-contain"
            />

            {/* SVG bounding box overlay */}
            {showOverlays && currentFrame.detections.length > 0 && (
              <DetectionOverlay
                detections={currentFrame.detections}
                imageWidth={640}
                imageHeight={480}
              />
            )}

            {/* Detection info panel */}
            {currentFrame.detections.length > 0 && (
              <div className="absolute top-2 right-2 rounded-lg bg-gray-950/80 border border-gray-800 p-2 backdrop-blur">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400">
                    Detections
                  </p>
                  <button
                    onClick={() => setShowOverlays(!showOverlays)}
                    className="ml-2 p-0.5 rounded text-gray-500 hover:text-cyan-400 transition-colors"
                    title={showOverlays ? "Hide boxes" : "Show boxes"}
                  >
                    {showOverlays ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                  </button>
                </div>
                <div className="space-y-0.5">
                  {currentFrame.detections.map((det, idx) => (
                    <div
                      key={`${det.track_id}-${idx}`}
                      className="flex items-center gap-2 text-[10px] text-gray-300"
                    >
                      <span className="rounded bg-cyan-900/30 px-1 py-0.5 text-cyan-400 font-mono">
                        #{det.track_id}
                      </span>
                      <span>{det.class}</span>
                      <span className="text-gray-500">
                        {Math.round(det.confidence * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-gray-600 py-16">
            <Camera className="h-10 w-10" />
            <p className="text-xs">
              {visibleFrames.length === 0
                ? "No frames loaded"
                : "Frame data unavailable"}
            </p>
          </div>
        )}

        {/* Frame info overlay */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-gray-950/90 to-transparent px-4 py-3">
          <div className="flex items-center justify-between text-[10px] font-mono text-gray-400">
            <span>{formatDuration(currentOffset)} / {formatDuration(duration)}</span>
            <span>
              Frame {currentFrameIndex + 1} of {visibleFrames.length}
              {currentFrame?.camera_id && (
                <> | {currentFrame.camera_id.slice(0, 10)}</>
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Timeline scrubber with event markers */}
      <div className={cn(CARD, "px-4 py-3")}>
        <div className="relative">
          {/* Agent action markers */}
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

          {/* Range input */}
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
      <div className={cn(CARD, "flex items-center justify-between")}>
        {/* Transport controls */}
        <div className="flex items-center gap-1.5">
          {/* Skip back */}
          <button
            onClick={() => {
              const newOffset = Math.max(0, currentOffset - 10);
              setCurrentOffset(newOffset);
              fetchSlice(newOffset);
            }}
            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
            title="Back 10s"
          >
            <Rewind className="h-4 w-4" />
          </button>

          {/* Step back */}
          <button
            onClick={() => setCurrentFrameIndex((prev) => Math.max(0, prev - 1))}
            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
            title="Previous frame"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>

          {/* Play / Pause */}
          {isPlaying ? (
            <button
              onClick={handlePause}
              className="rounded-lg bg-cyan-600 p-2.5 text-white transition-colors hover:bg-cyan-500"
              title="Pause"
            >
              <Pause className="h-5 w-5" />
            </button>
          ) : (
            <button
              onClick={handlePlay}
              className="rounded-lg bg-cyan-600 p-2.5 text-white transition-colors hover:bg-cyan-500"
              title="Play"
            >
              <Play className="h-5 w-5" />
            </button>
          )}

          {/* Step forward */}
          <button
            onClick={() =>
              setCurrentFrameIndex((prev) =>
                Math.min(visibleFrames.length - 1, prev + 1)
              )
            }
            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
            title="Next frame"
          >
            <ChevronRight className="h-4 w-4" />
          </button>

          {/* Skip forward */}
          <button
            onClick={() => {
              const newOffset = Math.min(duration, currentOffset + 10);
              setCurrentOffset(newOffset);
              fetchSlice(newOffset);
            }}
            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
            title="Forward 10s"
          >
            <FastForward className="h-4 w-4" />
          </button>

          {/* Stop */}
          <button
            onClick={handleStop}
            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
            title="Stop"
          >
            <Square className="h-4 w-4" />
          </button>
        </div>

        {/* Speed controls */}
        <div className="flex items-center gap-1">
          <span className="mr-1.5 text-[10px] uppercase tracking-wider text-gray-500">
            Speed
          </span>
          {SPEED_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={cn(
                "rounded px-2 py-1 text-xs font-mono font-semibold transition-colors",
                speed === s
                  ? "bg-cyan-600 text-white"
                  : "bg-gray-800/60 text-gray-500 hover:bg-gray-800 hover:text-gray-300"
              )}
            >
              {s}x
            </button>
          ))}
        </div>

        {/* Current time */}
        <div className="text-right font-mono text-xs text-gray-400">
          <span className="text-cyan-400">{formatDuration(currentOffset)}</span>
          <span className="text-gray-600"> / </span>
          <span>{formatDuration(duration)}</span>
        </div>
      </div>
    </div>
  );
}
