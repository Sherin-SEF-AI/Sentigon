"use client";

import { useMemo } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Detection {
  track_id: number;
  class: string;
  confidence: number;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] in pixel coords
}

interface DetectionOverlayProps {
  detections: Detection[];
  imageWidth: number;
  imageHeight: number;
  showLabels?: boolean;
  showConfidence?: boolean;
  showBoxes?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Color mapping                                                      */
/* ------------------------------------------------------------------ */

const CLASS_COLORS: Record<string, { stroke: string; fill: string; text: string }> = {
  person:   { stroke: "#22d3ee", fill: "rgba(34,211,238,0.08)",  text: "#22d3ee" },
  vehicle:  { stroke: "#f59e0b", fill: "rgba(245,158,11,0.08)", text: "#f59e0b" },
  car:      { stroke: "#f59e0b", fill: "rgba(245,158,11,0.08)", text: "#f59e0b" },
  truck:    { stroke: "#f59e0b", fill: "rgba(245,158,11,0.08)", text: "#f59e0b" },
  bus:      { stroke: "#f59e0b", fill: "rgba(245,158,11,0.08)", text: "#f59e0b" },
  weapon:   { stroke: "#ef4444", fill: "rgba(239,68,68,0.12)",  text: "#ef4444" },
  knife:    { stroke: "#ef4444", fill: "rgba(239,68,68,0.12)",  text: "#ef4444" },
  gun:      { stroke: "#ef4444", fill: "rgba(239,68,68,0.12)",  text: "#ef4444" },
  backpack: { stroke: "#a855f7", fill: "rgba(168,85,247,0.08)", text: "#a855f7" },
  bag:      { stroke: "#a855f7", fill: "rgba(168,85,247,0.08)", text: "#a855f7" },
  suitcase: { stroke: "#a855f7", fill: "rgba(168,85,247,0.08)", text: "#a855f7" },
};

const DEFAULT_COLOR = { stroke: "#6b7280", fill: "rgba(107,114,128,0.08)", text: "#9ca3af" };

function getColor(cls: string) {
  return CLASS_COLORS[cls.toLowerCase()] ?? DEFAULT_COLOR;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function DetectionOverlay({
  detections,
  imageWidth,
  imageHeight,
  showLabels = true,
  showConfidence = true,
  showBoxes = true,
}: DetectionOverlayProps) {
  const boxes = useMemo(() => {
    if (!showBoxes || !detections || detections.length === 0) return [];
    return detections
      .filter((d) => d.bbox && d.bbox.length === 4)
      .map((d) => {
        const [x1, y1, x2, y2] = d.bbox;
        const color = getColor(d.class);
        // Normalize to percentage for viewBox-relative rendering
        const px = (x1 / imageWidth) * 100;
        const py = (y1 / imageHeight) * 100;
        const pw = ((x2 - x1) / imageWidth) * 100;
        const ph = ((y2 - y1) / imageHeight) * 100;
        return { ...d, px, py, pw, ph, color };
      });
  }, [detections, imageWidth, imageHeight, showBoxes]);

  if (boxes.length === 0) return null;

  return (
    <svg
      className="absolute inset-0 h-full w-full pointer-events-none"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ overflow: "visible" }}
    >
      {boxes.map((box, idx) => (
        <g key={`${box.track_id}-${idx}`}>
          {/* Bounding box */}
          <rect
            x={box.px}
            y={box.py}
            width={box.pw}
            height={box.ph}
            fill={box.color.fill}
            stroke={box.color.stroke}
            strokeWidth={0.3}
            rx={0.2}
            ry={0.2}
          />

          {/* Label background + text */}
          {showLabels && (
            <>
              <rect
                x={box.px}
                y={box.py - 2.8}
                width={Math.max(box.pw, showConfidence ? 16 : 10)}
                height={2.6}
                fill={box.color.stroke}
                rx={0.15}
                ry={0.15}
                opacity={0.9}
              />
              <text
                x={box.px + 0.4}
                y={box.py - 0.8}
                fill="#000"
                fontSize={1.6}
                fontWeight="bold"
                fontFamily="monospace"
              >
                #{box.track_id} {box.class}
                {showConfidence && (
                  <tspan fill="#1a1a2e" fontWeight="normal">
                    {" "}
                    {Math.round(box.confidence * 100)}%
                  </tspan>
                )}
              </text>
            </>
          )}

          {/* Corner markers for emphasis */}
          {[
            { x: box.px, y: box.py },
            { x: box.px + box.pw, y: box.py },
            { x: box.px, y: box.py + box.ph },
            { x: box.px + box.pw, y: box.py + box.ph },
          ].map((corner, ci) => (
            <circle
              key={ci}
              cx={corner.x}
              cy={corner.y}
              r={0.4}
              fill={box.color.stroke}
              opacity={0.7}
            />
          ))}
        </g>
      ))}
    </svg>
  );
}
