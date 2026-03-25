"use client";

import React from "react";
import { cn } from "@/lib/utils";

interface ZonePolygon {
  id: string;
  name: string;
  points: number[][]; // [[x,y], ...] normalized 0-1
  type: string;
  occupancy?: number;
  maxOccupancy?: number;
  alertOnBreach?: boolean;
}

interface ZoneOverlayProps {
  zones: ZonePolygon[];
  width: number;
  height: number;
  selectedZone?: string | null;
  onZoneClick?: (zoneId: string) => void;
}

const ZONE_COLORS: Record<string, string> = {
  restricted: "rgba(239, 68, 68, 0.25)",
  entry: "rgba(34, 197, 94, 0.2)",
  exit: "rgba(59, 130, 246, 0.2)",
  parking: "rgba(168, 85, 247, 0.2)",
  general: "rgba(156, 163, 175, 0.15)",
};

const ZONE_BORDER_COLORS: Record<string, string> = {
  restricted: "#ef4444",
  entry: "#22c55e",
  exit: "#3b82f6",
  parking: "#a855f7",
  general: "#6b7280",
};

export default function ZoneOverlay({
  zones,
  width,
  height,
  selectedZone,
  onZoneClick,
}: ZoneOverlayProps) {
  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      {zones.map((zone) => {
        const points = zone.points
          .map(([x, y]) => `${x * width},${y * height}`)
          .join(" ");
        const isSelected = selectedZone === zone.id;
        const isOverCapacity =
          zone.maxOccupancy != null &&
          zone.occupancy != null &&
          zone.occupancy > zone.maxOccupancy;
        const fill = isOverCapacity
          ? "rgba(239, 68, 68, 0.35)"
          : ZONE_COLORS[zone.type] || ZONE_COLORS.general;
        const stroke =
          ZONE_BORDER_COLORS[zone.type] || ZONE_BORDER_COLORS.general;

        // Centroid for label
        const cx =
          zone.points.reduce((s, [x]) => s + x, 0) / zone.points.length;
        const cy =
          zone.points.reduce((s, [, y]) => s + y, 0) / zone.points.length;

        return (
          <g key={zone.id}>
            <polygon
              points={points}
              fill={fill}
              stroke={stroke}
              strokeWidth={isSelected ? 3 : 1.5}
              strokeDasharray={zone.type === "restricted" ? "6,3" : undefined}
              className="pointer-events-auto cursor-pointer transition-all"
              onClick={() => onZoneClick?.(zone.id)}
              opacity={isSelected ? 1 : 0.8}
            />
            <text
              x={cx * width}
              y={cy * height}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="white"
              fontSize={11}
              fontWeight="600"
              className="pointer-events-none select-none"
              style={{ textShadow: "0 1px 3px rgba(0,0,0,0.8)" }}
            >
              {zone.name}
            </text>
            {zone.occupancy != null && (
              <text
                x={cx * width}
                y={cy * height + 14}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={isOverCapacity ? "#ef4444" : "#9ca3af"}
                fontSize={10}
                className="pointer-events-none select-none"
              >
                {zone.occupancy}
                {zone.maxOccupancy ? `/${zone.maxOccupancy}` : ""}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
