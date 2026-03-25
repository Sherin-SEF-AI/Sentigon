"use client";

import { useMemo } from "react";

/* ── Types ─────────────────────────────────────────────────────── */

interface PoseKeypoint {
  x: number;
  y: number;
  confidence: number;
}

interface PoseOverlayProps {
  keypoints: PoseKeypoint[]; // 17 COCO keypoints
  width: number;
  height: number;
  videoWidth?: number;
  videoHeight?: number;
  threatLevel?: "normal" | "tense" | "aggressive";
  trackId?: number;
}

/* ── COCO skeleton definition ──────────────────────────────────── */

/**
 * 17-point COCO keypoint order:
 *  0  nose
 *  1  left_eye       2  right_eye
 *  3  left_ear       4  right_ear
 *  5  left_shoulder  6  right_shoulder
 *  7  left_elbow     8  right_elbow
 *  9  left_wrist    10  right_wrist
 * 11  left_hip      12  right_hip
 * 13  left_knee     14  right_knee
 * 15  left_ankle    16  right_ankle
 */

const SKELETON: [number, number][] = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 4], // head
  [5, 6], // shoulders
  [5, 7],
  [7, 9],
  [6, 8],
  [8, 10], // arms
  [5, 11],
  [6, 12], // torso
  [11, 12], // hips
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16], // legs
];

/**
 * Keypoint radii -- slightly larger for core joints, smaller for extremities.
 * Index order matches COCO 17-point layout.
 */
const KEYPOINT_RADII: number[] = [
  4, // 0  nose
  3, 3, // 1-2  eyes
  2.5, 2.5, // 3-4  ears
  4, 4, // 5-6  shoulders
  3.5, 3.5, // 7-8  elbows
  3, 3, // 9-10 wrists
  4, 4, // 11-12 hips
  3.5, 3.5, // 13-14 knees
  3, 3, // 15-16 ankles
];

/** Minimum confidence to render a keypoint / bone. */
const MIN_CONFIDENCE = 0.15;

/* ── Helpers ───────────────────────────────────────────────────── */

const THREAT_COLORS: Record<string, string> = {
  normal: "#22c55e",
  tense: "#eab308",
  aggressive: "#ef4444",
};

function getThreatColor(level: string | undefined): string {
  return THREAT_COLORS[level ?? "normal"] ?? THREAT_COLORS.normal;
}

/* ── Component ─────────────────────────────────────────────────── */

export function PoseOverlay({
  keypoints,
  width,
  height,
  videoWidth,
  videoHeight,
  threatLevel = "normal",
  trackId,
}: PoseOverlayProps) {
  const color = getThreatColor(threatLevel);

  /** Scale factors from video coords to display coords. */
  const scaleX = videoWidth && videoWidth > 0 ? width / videoWidth : 1;
  const scaleY = videoHeight && videoHeight > 0 ? height / videoHeight : 1;

  /** Scale a single keypoint to display coordinates. */
  const scaled = useMemo(
    () =>
      keypoints.map((kp) => ({
        x: kp.x * scaleX,
        y: kp.y * scaleY,
        confidence: kp.confidence,
      })),
    [keypoints, scaleX, scaleY],
  );

  /** Check keypoint validity (confidence above threshold). */
  const isVisible = (idx: number): boolean =>
    idx < scaled.length && scaled[idx].confidence >= MIN_CONFIDENCE;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="pointer-events-none absolute left-0 top-0"
      style={{ width, height }}
    >
      {/* ── Skeleton bones ── */}
      {SKELETON.map(([a, b]) => {
        if (!isVisible(a) || !isVisible(b)) return null;
        const kpA = scaled[a];
        const kpB = scaled[b];
        // Bone opacity = minimum confidence of the two endpoints
        const boneOpacity = Math.min(kpA.confidence, kpB.confidence);

        return (
          <line
            key={`bone-${a}-${b}`}
            x1={kpA.x}
            y1={kpA.y}
            x2={kpB.x}
            y2={kpB.y}
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            opacity={boneOpacity}
          />
        );
      })}

      {/* ── Keypoints ── */}
      {scaled.map((kp, idx) => {
        if (!isVisible(idx)) return null;
        const r = KEYPOINT_RADII[idx] ?? 3;

        return (
          <circle
            key={`kp-${idx}`}
            cx={kp.x}
            cy={kp.y}
            r={r}
            fill={color}
            fillOpacity={kp.confidence}
            stroke="#ffffff"
            strokeWidth={1}
            strokeOpacity={kp.confidence * 0.6}
          />
        );
      })}

      {/* ── Track ID label (above head if nose is visible) ── */}
      {trackId !== undefined && isVisible(0) && (
        <>
          <rect
            x={scaled[0].x - 16}
            y={scaled[0].y - 24}
            width={32}
            height={14}
            fill="#000000"
            fillOpacity={0.7}
            rx={3}
          />
          <text
            x={scaled[0].x}
            y={scaled[0].y - 14}
            fill={color}
            fontSize={9}
            fontFamily="monospace"
            fontWeight="bold"
            textAnchor="middle"
            dominantBaseline="middle"
          >
            #{trackId}
          </text>
        </>
      )}
    </svg>
  );
}

export default PoseOverlay;
