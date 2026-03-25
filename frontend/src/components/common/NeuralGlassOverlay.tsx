"use client";

import { useMemo } from "react";

/* ── Types ─────────────────────────────────────────────────────── */

interface Detection {
  track_id: number;
  class: string;
  confidence: number;
  bbox: [number, number, number, number]; // x1, y1, x2, y2
  center: [number, number];
  dwell_time: number;
  is_stationary: boolean;
  pose_features?: Record<string, { detected: boolean; confidence: number }>;
}

interface NeuralGlassOverlayProps {
  detections: Detection[];
  width: number;
  height: number;
  videoWidth?: number;
  videoHeight?: number;
  showLabels?: boolean;
  showConfidence?: boolean;
  showDwell?: boolean;
  showThreats?: boolean;
}

/* ── Helpers ───────────────────────────────────────────────────── */

/** Map an action class string to a human-readable label. */
const ACTION_LABELS: Record<string, string> = {
  person: "Walking",
  walking: "Walking",
  running: "Running",
  loitering: "Loitering",
  blading: "Blading",
  fighting: "Fighting",
  falling: "Falling",
  crawling: "Crawling",
  crouching: "Crouching",
};

function getActionLabel(cls: string): string {
  return ACTION_LABELS[cls.toLowerCase()] ?? cls.charAt(0).toUpperCase() + cls.slice(1);
}

/** Derive a threat level from detection properties. */
type ThreatLevel = "normal" | "medium" | "high" | "critical";

function deriveThreatLevel(det: Detection): ThreatLevel {
  // Check for active pose-based threat indicators
  const activePoseThreats = det.pose_features
    ? Object.values(det.pose_features).filter((f) => f.detected && f.confidence > 0.6).length
    : 0;

  if (activePoseThreats >= 2) return "critical";
  if (activePoseThreats === 1) return "high";
  if (det.is_stationary && det.dwell_time > 30) return "high";
  if (det.is_stationary && det.dwell_time > 10) return "medium";

  const highThreatClasses = ["fighting", "blading", "weapon", "gun", "knife"];
  if (highThreatClasses.includes(det.class.toLowerCase())) return "critical";

  const mediumThreatClasses = ["running", "falling", "crawling"];
  if (mediumThreatClasses.includes(det.class.toLowerCase())) return "medium";

  return "normal";
}

const THREAT_COLORS: Record<ThreatLevel, string> = {
  normal: "#22c55e",
  medium: "#eab308",
  high: "#f97316",
  critical: "#ef4444",
};

function formatDwellTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m${s}s`;
}

/* ── Component ─────────────────────────────────────────────────── */

export function NeuralGlassOverlay({
  detections,
  width,
  height,
  videoWidth,
  videoHeight,
  showLabels = true,
  showConfidence = true,
  showDwell = true,
  showThreats = true,
}: NeuralGlassOverlayProps) {
  /** Pre-compute scale factors once. */
  const scaleX = videoWidth && videoWidth > 0 ? width / videoWidth : 1;
  const scaleY = videoHeight && videoHeight > 0 ? height / videoHeight : 1;

  /** Scale a bbox to display coordinates. */
  const scaleBbox = useMemo(
    () =>
      (bbox: [number, number, number, number]): [number, number, number, number] => [
        bbox[0] * scaleX,
        bbox[1] * scaleY,
        bbox[2] * scaleX,
        bbox[3] * scaleY,
      ],
    [scaleX, scaleY],
  );

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="pointer-events-none absolute left-0 top-0"
      style={{ width, height }}
    >
      {/* Reusable CSS animation for pulsing halo */}
      <defs>
        <style>{`
          @keyframes neural-halo-pulse {
            0%, 100% { opacity: 0.6; r: inherit; }
            50% { opacity: 0.15; }
          }
          .neural-halo {
            animation: neural-halo-pulse 1.4s ease-in-out infinite;
          }
        `}</style>
      </defs>

      {detections.map((det) => {
        const [x1, y1, x2, y2] = scaleBbox(det.bbox);
        const boxW = x2 - x1;
        const boxH = y2 - y1;
        const cx = (x1 + x2) / 2;
        const cy = (y1 + y2) / 2;

        const threat = deriveThreatLevel(det);
        const color = THREAT_COLORS[threat];
        const isHighThreat = threat === "high" || threat === "critical";

        const hasPoseThreats =
          det.pose_features &&
          Object.values(det.pose_features).some((f) => f.detected && f.confidence > 0.5);

        const confidenceHeight = boxH * det.confidence;
        const confidenceBarX = x1 - 5;
        const confidenceColor =
          det.confidence >= 0.8
            ? "#22c55e"
            : det.confidence >= 0.5
              ? "#eab308"
              : "#ef4444";

        return (
          <g key={det.track_id}>
            {/* ── Severity halo (pulsing ring for high/critical) ── */}
            {showThreats && isHighThreat && (
              <>
                <ellipse
                  cx={cx}
                  cy={cy}
                  rx={boxW / 2 + 8}
                  ry={boxH / 2 + 8}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  opacity={0.4}
                  className="neural-halo"
                />
                <ellipse
                  cx={cx}
                  cy={cy}
                  rx={boxW / 2 + 16}
                  ry={boxH / 2 + 16}
                  fill="none"
                  stroke={color}
                  strokeWidth={1}
                  opacity={0.2}
                  className="neural-halo"
                  style={{ animationDelay: "0.3s" }}
                />
              </>
            )}

            {/* ── Bounding box ── */}
            <rect
              x={x1}
              y={y1}
              width={boxW}
              height={boxH}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeOpacity={0.8}
            />

            {/* ── Corner accents ── */}
            {(() => {
              const cl = Math.min(boxW, boxH) * 0.18;
              return (
                <>
                  {/* Top-left */}
                  <polyline
                    points={`${x1},${y1 + cl} ${x1},${y1} ${x1 + cl},${y1}`}
                    fill="none"
                    stroke={color}
                    strokeWidth={2.5}
                  />
                  {/* Top-right */}
                  <polyline
                    points={`${x2 - cl},${y1} ${x2},${y1} ${x2},${y1 + cl}`}
                    fill="none"
                    stroke={color}
                    strokeWidth={2.5}
                  />
                  {/* Bottom-left */}
                  <polyline
                    points={`${x1},${y2 - cl} ${x1},${y2} ${x1 + cl},${y2}`}
                    fill="none"
                    stroke={color}
                    strokeWidth={2.5}
                  />
                  {/* Bottom-right */}
                  <polyline
                    points={`${x2 - cl},${y2} ${x2},${y2} ${x2},${y2 - cl}`}
                    fill="none"
                    stroke={color}
                    strokeWidth={2.5}
                  />
                </>
              );
            })()}

            {/* ── Confidence bar (vertical, left side) ── */}
            {showConfidence && (
              <>
                {/* Track background */}
                <rect
                  x={confidenceBarX}
                  y={y1}
                  width={3}
                  height={boxH}
                  fill="#ffffff"
                  fillOpacity={0.15}
                  rx={1}
                />
                {/* Filled portion (bottom-up) */}
                <rect
                  x={confidenceBarX}
                  y={y1 + (boxH - confidenceHeight)}
                  width={3}
                  height={confidenceHeight}
                  fill={confidenceColor}
                  fillOpacity={0.9}
                  rx={1}
                />
              </>
            )}

            {/* ── Action label (top of bbox) ── */}
            {showLabels && (
              <>
                <rect
                  x={x1}
                  y={y1 - 18}
                  width={boxW}
                  height={16}
                  fill={color}
                  fillOpacity={0.85}
                  rx={2}
                />
                <text
                  x={x1 + 4}
                  y={y1 - 5}
                  fill="#000000"
                  fontSize={10}
                  fontFamily="monospace"
                  fontWeight="bold"
                >
                  {getActionLabel(det.class)}
                  {showConfidence && ` ${Math.round(det.confidence * 100)}%`}
                </text>
              </>
            )}

            {/* ── Track ID badge (bottom-right) ── */}
            <rect
              x={x2 - 32}
              y={y2 + 2}
              width={32}
              height={14}
              fill="#000000"
              fillOpacity={0.7}
              rx={3}
            />
            <text
              x={x2 - 28}
              y={y2 + 12}
              fill={color}
              fontSize={9}
              fontFamily="monospace"
              fontWeight="bold"
            >
              #{det.track_id}
            </text>

            {/* ── Dwell time indicator (>5s) ── */}
            {showDwell && det.dwell_time > 5 && (
              <>
                <rect
                  x={x1}
                  y={y2 + 2}
                  width={50}
                  height={14}
                  fill="#000000"
                  fillOpacity={0.7}
                  rx={3}
                />
                <text
                  x={x1 + 4}
                  y={y2 + 12}
                  fill="#eab308"
                  fontSize={9}
                  fontFamily="monospace"
                >
                  {/* Clock icon (unicode) + time */}
                  {"\u23F1"} {formatDwellTime(det.dwell_time)}
                </text>
              </>
            )}

            {/* ── Threat badge for pose-detected behaviors ── */}
            {showThreats && hasPoseThreats && (
              <>
                <circle
                  cx={x2 + 6}
                  cy={y1 - 6}
                  r={8}
                  fill="#ef4444"
                  fillOpacity={0.9}
                  stroke="#ffffff"
                  strokeWidth={1}
                />
                {/* Exclamation mark icon */}
                <text
                  x={x2 + 6}
                  y={y1 - 2}
                  fill="#ffffff"
                  fontSize={11}
                  fontWeight="bold"
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  !
                </text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default NeuralGlassOverlay;
