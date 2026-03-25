"use client";

import { useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import type { DetectionItem } from "@/lib/types";

interface BoundingBoxOverlayProps {
  detections: DetectionItem[];
  width: number;
  height: number;
  className?: string;
}

/* Color palette by detected class */
const classColors: Record<string, string> = {
  person: "#22c55e",   // green
  vehicle: "#f97316",  // orange
  car: "#f97316",
  truck: "#f97316",
  bus: "#f97316",
  motorcycle: "#f97316",
  bicycle: "#f97316",
  weapon: "#ef4444",   // red
  gun: "#ef4444",
  knife: "#ef4444",
  bag: "#3b82f6",      // blue
  backpack: "#3b82f6",
  suitcase: "#3b82f6",
};

const DEFAULT_COLOR = "#8b5cf6"; // violet fallback

function getClassColor(className: string): string {
  return classColors[className.toLowerCase()] || DEFAULT_COLOR;
}

function formatDwellTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m${s}s`;
}

export function BoundingBoxOverlay({
  detections,
  width,
  height,
  className,
}: BoundingBoxOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Match canvas internal resolution to the display size
    canvas.width = width;
    canvas.height = height;

    // Clear
    ctx.clearRect(0, 0, width, height);

    for (const det of detections) {
      const [x1, y1, x2, y2] = det.bbox;
      const boxW = x2 - x1;
      const boxH = y2 - y1;
      const color = getClassColor(det.class);

      // --- Draw bounding box ---
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.strokeRect(x1, y1, boxW, boxH);

      // --- Corner accents (short lines at corners for a tactical look) ---
      const cornerLen = Math.min(boxW, boxH) * 0.15;
      ctx.lineWidth = 3;
      // Top-left
      ctx.beginPath();
      ctx.moveTo(x1, y1 + cornerLen);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x1 + cornerLen, y1);
      ctx.stroke();
      // Top-right
      ctx.beginPath();
      ctx.moveTo(x2 - cornerLen, y1);
      ctx.lineTo(x2, y1);
      ctx.lineTo(x2, y1 + cornerLen);
      ctx.stroke();
      // Bottom-left
      ctx.beginPath();
      ctx.moveTo(x1, y2 - cornerLen);
      ctx.lineTo(x1, y2);
      ctx.lineTo(x1 + cornerLen, y2);
      ctx.stroke();
      // Bottom-right
      ctx.beginPath();
      ctx.moveTo(x2 - cornerLen, y2);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x2, y2 - cornerLen);
      ctx.stroke();

      // --- Label background ---
      const label = det.class.toUpperCase();
      const trackLabel = `#${det.track_id}`;
      const dwellLabel = det.dwell_time > 0 ? formatDwellTime(det.dwell_time) : "";

      const fullLabel = [label, trackLabel, dwellLabel].filter(Boolean).join(" | ");

      ctx.font = "bold 11px monospace";
      const textMetrics = ctx.measureText(fullLabel);
      const textH = 16;
      const textPadX = 4;
      const labelY = y1 - textH - 2;

      // Background rectangle for label
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(
        x1,
        labelY < 0 ? y1 : labelY,
        textMetrics.width + textPadX * 2,
        textH
      );
      ctx.globalAlpha = 1.0;

      // Label text
      ctx.fillStyle = "#000000";
      ctx.textBaseline = "top";
      ctx.fillText(
        fullLabel,
        x1 + textPadX,
        (labelY < 0 ? y1 : labelY) + 2
      );

      // --- Stationary indicator (pulsing dot at center) ---
      if (det.is_stationary) {
        const cx = (x1 + x2) / 2;
        const cy = (y1 + y2) / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#ef4444";
        ctx.globalAlpha = 0.7;
        ctx.fill();
        ctx.globalAlpha = 1.0;

        // Outer ring
        ctx.beginPath();
        ctx.arc(cx, cy, 8, 0, Math.PI * 2);
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.4;
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }
    }
  }, [detections, width, height]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("pointer-events-none absolute left-0 top-0", className)}
      style={{ width, height }}
    />
  );
}
