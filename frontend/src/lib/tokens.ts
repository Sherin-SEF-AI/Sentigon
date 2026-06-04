/**
 * Centralized design tokens: severity/status/threat colour maps and the shared
 * recharts palette. The helpers in lib/utils.ts (severityColor/statusColor/
 * threatLevelColor) delegate here so the ~45 existing call sites are unchanged
 * while new code (and charts) can import the maps directly.
 */

// Tailwind class strings for severity badges/cards (text + subtle bg + border).
export const SEVERITY_CLASSES: Record<string, string> = {
  critical: "text-red-500 bg-red-500/10 border-red-500",
  high: "text-orange-500 bg-orange-500/10 border-orange-500",
  medium: "text-yellow-500 bg-yellow-500/10 border-yellow-500",
  low: "text-blue-400 bg-blue-400/10 border-blue-400",
  info: "text-gray-400 bg-gray-400/10 border-gray-400",
};

export const STATUS_CLASSES: Record<string, string> = {
  new: "text-red-400",
  acknowledged: "text-yellow-400",
  investigating: "text-blue-400",
  resolved: "text-green-400",
  dismissed: "text-gray-500",
  escalated: "text-red-600",
};

// Hex values for canvas/SVG/recharts (where Tailwind classes can't be used).
export const SEVERITY_HEX: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#3b82f6",
  info: "#9ca3af",
};

export const THREAT_LEVEL_HEX: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  elevated: "#eab308",
  normal: "#22c55e",
};

// Shared recharts theme — cyan-forward to match the brand accent.
export const CHART_PALETTE: string[] = [
  "#06b6d4", // cyan (accent)
  "#22c55e", // green
  "#eab308", // yellow
  "#f97316", // orange
  "#ef4444", // red
  "#a855f7", // purple
  "#3b82f6", // blue
];

export const CHART_AXIS_STYLE = { fill: "#9ca3af", fontSize: 12 } as const;
export const CHART_GRID_COLOR = "#1f2937";

export function severityHex(severity: string): string {
  return SEVERITY_HEX[severity] ?? SEVERITY_HEX.info;
}
