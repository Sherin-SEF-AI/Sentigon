"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Crosshair, RotateCcw } from "lucide-react";

import { API_BASE } from "@/lib/utils";

/** Frame-pixel coordinate pair, or an empty array when unset. */
export type Point = number[];

interface TripwireCanvasProps {
  /** Camera whose latest frame is used as the drawing background. */
  cameraId?: string;
  /** Current line endpoints, in frame-pixel coordinates. */
  pointA: Point;
  pointB: Point;
  /** Direction the tripwire watches (controls the arrow rendering). */
  direction?: string;
  onChange: (pointA: Point, pointB: Point) => void;
}

/** Fallback logical resolution when no camera frame is available. */
const FALLBACK_W = 640;
const FALLBACK_H = 480;

/**
 * Click-to-draw tripwire line editor. The first click sets point A, the second
 * sets point B; a third click starts a new line. Coordinates are emitted in the
 * camera frame's native pixel space so they submit unchanged to /api/tripwires.
 * Falls back to a neutral grid when the camera frame can't be fetched.
 */
export default function TripwireCanvas({
  cameraId,
  pointA,
  pointB,
  direction = "both",
  onChange,
}: TripwireCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgRef = useRef<HTMLImageElement | null>(null);
  const [res, setRes] = useState<{ w: number; h: number }>({
    w: FALLBACK_W,
    h: FALLBACK_H,
  });
  const [bgReady, setBgReady] = useState(false);
  // Which point the next click sets: a fresh line starts at "a".
  const [next, setNext] = useState<"a" | "b">("a");

  /* Load the camera snapshot as an authed blob → object URL background. */
  useEffect(() => {
    if (!cameraId) {
      bgRef.current = null;
      setBgReady(false);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    const token =
      typeof window !== "undefined"
        ? localStorage.getItem("sentinel_token")
        : null;

    (async () => {
      try {
        const resp = await fetch(
          `${API_BASE}/api/visual-search/snapshot/${cameraId}`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} }
        );
        if (!resp.ok) throw new Error(String(resp.status));
        const blob = await resp.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          if (cancelled) return;
          bgRef.current = img;
          if (img.naturalWidth && img.naturalHeight) {
            setRes({ w: img.naturalWidth, h: img.naturalHeight });
          }
          setBgReady(true);
        };
        img.src = objectUrl;
      } catch {
        if (!cancelled) {
          bgRef.current = null;
          setBgReady(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [cameraId]);

  const hasA = pointA.length === 2;
  const hasB = pointB.length === 2;

  const redraw = useCallback(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { w, h } = res;
    ctx.clearRect(0, 0, w, h);

    if (bgRef.current && bgReady) {
      ctx.drawImage(bgRef.current, 0, 0, w, h);
      ctx.fillStyle = "rgba(2,6,23,0.25)";
      ctx.fillRect(0, 0, w, h);
    } else {
      // Neutral grid backdrop.
      ctx.fillStyle = "#0b1220";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(148,163,184,0.12)";
      ctx.lineWidth = 1;
      const step = 40;
      for (let x = step; x < w; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = step; y < h; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }

    const a = hasA ? { x: pointA[0], y: pointA[1] } : null;
    const b = hasB ? { x: pointB[0], y: pointB[1] } : null;

    // Connecting line.
    if (a && b) {
      ctx.strokeStyle = "#06b6d4";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      // Direction arrow(s) at midpoint, perpendicular to the line.
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const drawArrow = (perpSign: 1 | -1) => {
        const pa = ang + (perpSign * Math.PI) / 2;
        const len = 26;
        const tipX = mx + len * Math.cos(pa);
        const tipY = my + len * Math.sin(pa);
        ctx.strokeStyle = "#22d3ee";
        ctx.fillStyle = "#22d3ee";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(tipX, tipY);
        ctx.stroke();
        const head = 8;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(
          tipX - head * Math.cos(pa - 0.4),
          tipY - head * Math.sin(pa - 0.4)
        );
        ctx.lineTo(
          tipX - head * Math.cos(pa + 0.4),
          tipY - head * Math.sin(pa + 0.4)
        );
        ctx.closePath();
        ctx.fill();
      };
      if (direction === "both") {
        drawArrow(1);
        drawArrow(-1);
      } else if (direction === "left_to_right") {
        drawArrow(1);
      } else {
        drawArrow(-1);
      }
    }

    // Endpoint markers.
    const marker = (p: { x: number; y: number }, label: string) => {
      ctx.fillStyle = "#06b6d4";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#04181d";
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, p.x, p.y);
    };
    if (a) marker(a, "A");
    if (b) marker(b, "B");
  }, [res, bgReady, hasA, hasB, pointA, pointB, direction]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  const handleClick = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * res.w);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * res.h);
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
    const pt: Point = [clamp(x, res.w), clamp(y, res.h)];

    if (next === "a") {
      onChange(pt, []);
      setNext("b");
    } else {
      onChange(pointA, pt);
      setNext("a");
    }
  };

  const reset = () => {
    onChange([], []);
    setNext("a");
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
          <Crosshair className="h-3.5 w-3.5 text-cyan-400" />
          {!hasA
            ? "Click to place point A"
            : !hasB
            ? "Click to place point B"
            : "Click to redraw the line"}
        </div>
        <button
          type="button"
          onClick={reset}
          className="flex items-center gap-1 rounded-md border border-gray-700 px-2 py-1 text-[11px] text-gray-400 transition-colors hover:border-gray-600 hover:text-gray-200"
        >
          <RotateCcw className="h-3 w-3" />
          Reset
        </button>
      </div>

      <canvas
        ref={canvasRef}
        width={res.w}
        height={res.h}
        onClick={handleClick}
        className="w-full cursor-crosshair rounded-lg border border-gray-800"
        style={{ aspectRatio: `${res.w} / ${res.h}` }}
      />

      <div className="flex items-center gap-4 text-[11px] text-gray-500">
        <span>
          A: {hasA ? `(${pointA[0]}, ${pointA[1]})` : "—"}
        </span>
        <span>
          B: {hasB ? `(${pointB[0]}, ${pointB[1]})` : "—"}
        </span>
        <span className="text-gray-600">
          frame {res.w}×{res.h}
          {!bgReady && cameraId ? " · no live frame (grid)" : ""}
        </span>
      </div>
    </div>
  );
}
