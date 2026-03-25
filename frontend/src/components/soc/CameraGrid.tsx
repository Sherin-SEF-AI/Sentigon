"use client";

import { useState, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { LiveFeedPanel } from "./LiveFeedPanel";
import type { Detection, GeminiAnalysis } from "@/lib/types";
import type { GridLayout } from "./AgenticVideoWall";

interface FrameData {
  camera_id: string;
  frame: string;
  detections?: Detection;
  timestamp?: number;
}

interface CameraGridProps {
  frames: Record<string, FrameData>;
  analyses?: Record<string, GeminiAnalysis>;
  cameraNames?: Record<string, string>;
  selectedCameraId?: string | null;
  onSelectCamera?: (cameraId: string | null) => void;
  onToggleFullscreen?: (cameraId: string) => void;
  gridLayout?: GridLayout;
  fillHeight?: boolean;
}

function activityScore(fd?: FrameData, analysis?: GeminiAnalysis | null): number {
  let score = 0;

  if (fd?.detections) {
    score += fd.detections.total_objects * 2;
    score += fd.detections.person_count * 3;
    score += fd.detections.active_tracks;
  }

  if (analysis) {
    const risk = analysis.overall_risk?.toLowerCase();
    if (risk === "critical") score += 20;
    else if (risk === "high") score += 12;
    else if (risk === "medium") score += 6;
    else if (risk === "low") score += 2;

    if (analysis.threat_indicators) {
      score += analysis.threat_indicators.length * 5;
    }
    if (analysis.anomalies) {
      score += analysis.anomalies.length * 4;
    }
  }

  return score;
}

function getGridClasses(layout: GridLayout, cameraCount: number): string {
  switch (layout) {
    case "1x1":
      return "grid-cols-1";
    case "2x2":
      return "grid-cols-1 md:grid-cols-2";
    case "3x3":
      return "grid-cols-1 md:grid-cols-2 lg:grid-cols-3";
    case "4x4":
      return "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";
    case "auto":
    default:
      if (cameraCount <= 1) return "grid-cols-1";
      if (cameraCount === 2) return "grid-cols-1 md:grid-cols-2";
      if (cameraCount <= 4) return "grid-cols-1 md:grid-cols-2";
      if (cameraCount <= 6) return "grid-cols-1 md:grid-cols-2 lg:grid-cols-3";
      return "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";
  }
}

export function CameraGrid({
  frames,
  analyses,
  cameraNames,
  selectedCameraId: controlledSelectedId,
  onSelectCamera,
  onToggleFullscreen,
  gridLayout = "auto",
  fillHeight = false,
}: CameraGridProps) {
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);

  const selectedId = controlledSelectedId !== undefined ? controlledSelectedId : internalSelectedId;
  const setSelectedId = onSelectCamera ?? setInternalSelectedId;

  // Stabilize cameraIds — only produce a new reference when the camera list actually changes
  const prevCameraIdsRef = useRef<string[]>([]);
  const cameraIds = useMemo(() => {
    const newIds = Object.keys(frames).sort();
    const prev = prevCameraIdsRef.current;
    if (newIds.length === prev.length && newIds.every((id, i) => id === prev[i])) {
      return prev;
    }
    prevCameraIdsRef.current = newIds;
    return newIds;
  }, [frames]);

  // Sort by analyses (changes infrequently) — avoids layout thrashing from per-frame detection changes
  const sortedCameraIds = useMemo(() => {
    return [...cameraIds].sort((a, b) => {
      const scoreA = activityScore(undefined, analyses?.[a]);
      const scoreB = activityScore(undefined, analyses?.[b]);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return a.localeCompare(b); // stable tiebreaker
    });
  }, [cameraIds, analyses]);

  const cameraCount = sortedCameraIds.length;
  const gridCols = getGridClasses(gridLayout, cameraCount);

  const handleClick = (id: string) => {
    setSelectedId(selectedId === id ? null : id);
  };

  if (cameraCount === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-dashed border-gray-800 bg-gray-950/50">
        <div className="h-10 w-10 rounded-full bg-gray-900 flex items-center justify-center mb-3">
          <svg className="h-5 w-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
          </svg>
        </div>
        <p className="text-xs text-gray-500 font-medium">No camera feeds available</p>
        <p className="text-[10px] text-gray-600 mt-1">Waiting for camera connections...</p>
      </div>
    );
  }

  const shouldFill = fillHeight && cameraCount === 1;

  return (
    <div className={cn("grid gap-1", gridCols, shouldFill && "h-full")}>
      {sortedCameraIds.map((cameraId, idx) => {
        const fd = frames[cameraId];
        const isHighPriority = idx === 0 && cameraCount > 2 && gridLayout === "auto";

        return (
          <div
            key={cameraId}
            className={cn(
              isHighPriority && cameraCount >= 4 && "md:col-span-2 md:row-span-1",
              selectedId === cameraId && gridLayout === "auto" && "md:col-span-2 md:row-span-2",
              shouldFill && "h-full"
            )}
          >
            <LiveFeedPanel
              cameraId={cameraId}
              cameraName={cameraNames?.[cameraId]}
              frame={fd.frame}
              detections={fd.detections}
              analysis={analyses?.[cameraId]}
              isSelected={selectedId === cameraId}
              isOnline
              isFullscreen={shouldFill}
              onClick={handleClick}
              onToggleFullscreen={onToggleFullscreen}
            />
          </div>
        );
      })}
    </div>
  );
}
