"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";

/* ── Types ─────────────────────────────────────────────────── */

interface AudioEvent {
  id: string;
  category: string;
  confidence: number;
  timestamp: string;
  camera_id: string | null;
  severity: string;
}

interface AudioHeatmapTimelineProps {
  events?: AudioEvent[];
  timeWindowMinutes?: number;
  width?: number;
  height?: number;
}

/* ── Constants ─────────────────────────────────────────────── */

const CATEGORIES = [
  "gunshot",
  "glass_breaking",
  "scream",
  "explosion",
  "alarm",
  "voice",
  "vehicle",
  "ambient",
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  gunshot: "Gunshot",
  glass_breaking: "Glass Break",
  scream: "Scream",
  explosion: "Explosion",
  alarm: "Alarm",
  voice: "Voice",
  vehicle: "Vehicle",
  ambient: "Ambient",
};

const LABEL_AREA_WIDTH = 100;
const TIME_AXIS_HEIGHT = 28;
const LEGEND_HEIGHT = 24;
const LEGEND_TOP_MARGIN = 8;
const HEADER_HEIGHT = LEGEND_HEIGHT + LEGEND_TOP_MARGIN * 2;
const CELL_PAD = 1;

/** Return an rgba color string based on confidence level. */
function confidenceColor(confidence: number): string {
  if (confidence >= 0.8) return "rgba(239, 68, 68, 0.9)";   // red
  if (confidence >= 0.6) return "rgba(249, 115, 22, 0.85)";  // orange
  if (confidence >= 0.3) return "rgba(234, 179, 8, 0.8)";    // yellow
  return "rgba(59, 130, 246, 0.7)";                           // blue
}

/** Legend gradient stops matching the confidence thresholds. */
const LEGEND_STOPS: { offset: number; color: string; label: string }[] = [
  { offset: 0, color: "rgba(59, 130, 246, 0.7)", label: "0" },
  { offset: 0.3, color: "rgba(234, 179, 8, 0.8)", label: "0.3" },
  { offset: 0.6, color: "rgba(249, 115, 22, 0.85)", label: "0.6" },
  { offset: 0.8, color: "rgba(239, 68, 68, 0.9)", label: "0.8" },
  { offset: 1, color: "rgba(239, 68, 68, 1)", label: "1.0" },
];

/* ── Component ─────────────────────────────────────────────── */

export default function AudioHeatmapTimeline({
  events: eventsProp,
  timeWindowMinutes = 30,
  width: widthProp,
  height: heightProp,
}: AudioHeatmapTimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [fetchedEvents, setFetchedEvents] = useState<AudioEvent[] | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(800);

  const events = eventsProp ?? fetchedEvents ?? [];

  /* ── Fetch events from API when no prop provided ─────────── */
  useEffect(() => {
    if (eventsProp) return;

    let cancelled = false;

    async function load() {
      try {
        const data = await apiFetch<AudioEvent[]>(
          `/api/audio/heatmap?minutes=${timeWindowMinutes}`
        );
        if (!cancelled) setFetchedEvents(data);
      } catch (err) {
        console.error("[AudioHeatmapTimeline] fetch failed:", err);
      }
    }

    load();
    const interval = setInterval(load, 15_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [eventsProp, timeWindowMinutes]);

  /* ── Observe container width for responsive sizing ───────── */
  useEffect(() => {
    if (widthProp) return;
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [widthProp]);

  /* ── Canvas drawing ──────────────────────────────────────── */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = widthProp ?? containerWidth;
    const H =
      heightProp ??
      HEADER_HEIGHT +
        CATEGORIES.length * 36 +
        TIME_AXIS_HEIGHT +
        12;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.scale(dpr, dpr);

    /* clear */
    ctx.fillStyle = "#0f172a"; // slate-900
    ctx.fillRect(0, 0, W, H);

    /* ── Legend bar (top right) ─────────────────────────────── */
    const legendW = 180;
    const legendBarH = 10;
    const legendX = W - legendW - 16;
    const legendY = LEGEND_TOP_MARGIN;

    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#94a3b8"; // slate-400
    ctx.textAlign = "left";
    ctx.fillText("Confidence", legendX - 72, legendY + legendBarH - 1);

    const grad = ctx.createLinearGradient(legendX, 0, legendX + legendW, 0);
    for (const stop of LEGEND_STOPS) {
      grad.addColorStop(stop.offset, stop.color);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(legendX, legendY, legendW, legendBarH);

    /* legend tick labels */
    ctx.fillStyle = "#94a3b8";
    ctx.textAlign = "center";
    ctx.font = "9px Inter, system-ui, sans-serif";
    for (const stop of LEGEND_STOPS) {
      const tx = legendX + stop.offset * legendW;
      ctx.fillText(stop.label, tx, legendY + legendBarH + 11);
    }

    /* ── Compute grid metrics ──────────────────────────────── */
    const gridLeft = LABEL_AREA_WIDTH;
    const gridWidth = W - gridLeft - 12;
    const gridTop = HEADER_HEIGHT;
    const cellH = Math.max(
      24,
      (H - HEADER_HEIGHT - TIME_AXIS_HEIGHT - 12) / CATEGORIES.length
    );
    const gridHeight = cellH * CATEGORIES.length;

    const now = new Date();
    const windowMs = timeWindowMinutes * 60 * 1000;
    const timeStart = new Date(now.getTime() - windowMs);

    /* number of columns = one per minute */
    const numCols = timeWindowMinutes;
    const cellW = gridWidth / numCols;

    /* ── Draw grid background ──────────────────────────────── */
    ctx.fillStyle = "#1e293b"; // slate-800
    ctx.fillRect(gridLeft, gridTop, gridWidth, gridHeight);

    /* grid lines (horizontal) */
    ctx.strokeStyle = "#334155"; // slate-700
    ctx.lineWidth = 0.5;
    for (let r = 0; r <= CATEGORIES.length; r++) {
      const y = gridTop + r * cellH;
      ctx.beginPath();
      ctx.moveTo(gridLeft, y);
      ctx.lineTo(gridLeft + gridWidth, y);
      ctx.stroke();
    }

    /* grid lines (vertical every 5 min) */
    for (let m = 0; m <= timeWindowMinutes; m += 5) {
      const x = gridLeft + (m / timeWindowMinutes) * gridWidth;
      ctx.beginPath();
      ctx.moveTo(x, gridTop);
      ctx.lineTo(x, gridTop + gridHeight);
      ctx.stroke();
    }

    /* ── Category labels (Y axis) ──────────────────────────── */
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#e2e8f0"; // slate-200
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let i = 0; i < CATEGORIES.length; i++) {
      const y = gridTop + i * cellH + cellH / 2;
      ctx.fillText(
        CATEGORY_LABELS[CATEGORIES[i]] ?? CATEGORIES[i],
        gridLeft - 8,
        y
      );
    }

    /* ── Aggregate events into grid buckets ────────────────── */
    // bucket[row][col] = max confidence in that cell
    const bucket: number[][] = Array.from({ length: CATEGORIES.length }, () =>
      new Array(numCols).fill(0)
    );

    for (const ev of events) {
      const row = CATEGORIES.indexOf(ev.category as (typeof CATEGORIES)[number]);
      if (row === -1) continue;

      const t = new Date(ev.timestamp).getTime();
      if (t < timeStart.getTime() || t > now.getTime()) continue;

      const col = Math.min(
        numCols - 1,
        Math.floor(((t - timeStart.getTime()) / windowMs) * numCols)
      );
      bucket[row][col] = Math.max(bucket[row][col], ev.confidence);
    }

    /* ── Draw heatmap cells ────────────────────────────────── */
    for (let r = 0; r < CATEGORIES.length; r++) {
      for (let c = 0; c < numCols; c++) {
        const val = bucket[r][c];
        if (val <= 0) continue;

        const x = gridLeft + c * cellW + CELL_PAD;
        const y = gridTop + r * cellH + CELL_PAD;
        const w = cellW - CELL_PAD * 2;
        const h = cellH - CELL_PAD * 2;

        ctx.fillStyle = confidenceColor(val);
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 2);
        ctx.fill();
      }
    }

    /* ── Time labels (X axis) ──────────────────────────────── */
    ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#94a3b8";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (let m = 0; m <= timeWindowMinutes; m += 5) {
      const t = new Date(timeStart.getTime() + m * 60_000);
      const label = t.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const x = gridLeft + (m / timeWindowMinutes) * gridWidth;
      ctx.fillText(label, x, gridTop + gridHeight + 6);
    }
  }, [events, timeWindowMinutes, widthProp, heightProp, containerWidth]);

  useEffect(() => {
    draw();
  }, [draw]);

  /* ── Render ──────────────────────────────────────────────── */
  const resolvedHeight =
    heightProp ??
    HEADER_HEIGHT +
      CATEGORIES.length * 36 +
      TIME_AXIS_HEIGHT +
      12;

  return (
    <div
      ref={containerRef}
      className="w-full overflow-hidden rounded-lg border border-slate-700 bg-slate-900"
    >
      <canvas
        ref={canvasRef}
        style={{
          width: widthProp ?? "100%",
          height: resolvedHeight,
          display: "block",
        }}
      />
    </div>
  );
}
