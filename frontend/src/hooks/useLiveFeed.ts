"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useWebSocket } from "./useWebSocket";
import type { WSMessage, Detection, GeminiAnalysis } from "@/lib/types";

export interface FrameData {
  camera_id: string;
  frame: string; // base64 JPEG
  detections?: Detection;
  timestamp?: number;
}

export interface AnalysisData {
  camera_id: string;
  analysis: GeminiAnalysis;
  timestamp: number;
}

/** Max React re-render rate for frame updates (~15 FPS). */
const FLUSH_INTERVAL_MS = 66;
/** Analysis updates are less frequent — flush at ~2 FPS. */
const ANALYSIS_FLUSH_MS = 500;

export function useLiveFeed() {
  // Ref accumulates frame data without triggering re-renders
  const framesRef = useRef<Record<string, FrameData>>({});
  // State snapshot — flushed from ref at a throttled rate
  const [frames, setFrames] = useState<Record<string, FrameData>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Analysis accumulator + state
  const analysesRef = useRef<Record<string, GeminiAnalysis>>({});
  const [analyses, setAnalyses] = useState<Record<string, GeminiAnalysis>>({});
  const analysisTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleFlush = useCallback(() => {
    if (timerRef.current !== null) return; // Already scheduled
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // Shallow-copy the ref into state — one re-render per flush
      setFrames({ ...framesRef.current });
    }, FLUSH_INTERVAL_MS);
  }, []);

  const scheduleAnalysisFlush = useCallback(() => {
    if (analysisTimerRef.current !== null) return;
    analysisTimerRef.current = setTimeout(() => {
      analysisTimerRef.current = null;
      setAnalyses({ ...analysesRef.current });
    }, ANALYSIS_FLUSH_MS);
  }, []);

  const handleMessage = useCallback(
    (msg: WSMessage) => {
      if (msg.channel === "frames") {
        const data = msg.data as unknown as FrameData;
        // Mutate ref (no re-render) — batched WS messages coalesce
        framesRef.current[data.camera_id] = data;
        scheduleFlush();
      } else if (msg.channel === "analysis") {
        const data = msg.data as unknown as AnalysisData;
        if (data.camera_id && data.analysis) {
          analysesRef.current[data.camera_id] = data.analysis;
          scheduleAnalysisFlush();
        }
      }
    },
    [scheduleFlush, scheduleAnalysisFlush]
  );

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      if (analysisTimerRef.current !== null) clearTimeout(analysisTimerRef.current);
    };
  }, []);

  const { connected } = useWebSocket({
    channels: ["frames", "analysis"],
    onMessage: handleMessage,
  });

  return { frames, analyses, connected };
}
