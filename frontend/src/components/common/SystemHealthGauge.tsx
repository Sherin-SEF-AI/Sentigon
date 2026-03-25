"use client";

interface SystemHealthGaugeProps {
  /** Label shown below the gauge */
  label: string;
  /** Current value (0-100) */
  value: number;
  /** Unit suffix (%, GB, ms) */
  unit?: string;
  /** Max value for display (default 100) */
  max?: number;
  /** Size in pixels */
  size?: number;
  /** Status override */
  status?: "healthy" | "warning" | "critical" | "offline";
}

function gaugeColor(value: number, status?: string): string {
  if (status === "offline") return "#6b7280";
  if (status === "critical" || value >= 90) return "#ef4444";
  if (status === "warning" || value >= 70) return "#f59e0b";
  return "#10b981";
}

function bgColor(value: number, status?: string): string {
  if (status === "offline") return "text-gray-600";
  if (status === "critical" || value >= 90) return "text-red-400";
  if (status === "warning" || value >= 70) return "text-amber-400";
  return "text-emerald-400";
}

export default function SystemHealthGauge({
  label,
  value,
  unit = "%",
  max = 100,
  size = 80,
  status,
}: SystemHealthGaugeProps) {
  const normalizedValue = Math.min(100, Math.max(0, (value / max) * 100));
  const color = gaugeColor(normalizedValue, status);
  const textColor = bgColor(normalizedValue, status);

  // SVG arc calculations
  const strokeWidth = 6;
  const radius = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const startAngle = 135;
  const endAngle = 405;
  const totalAngle = endAngle - startAngle;
  const filledAngle = startAngle + (totalAngle * normalizedValue) / 100;

  function polarToCartesian(angle: number): { x: number; y: number } {
    const rad = ((angle - 90) * Math.PI) / 180;
    return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
  }

  function describeArc(start: number, end: number): string {
    const s = polarToCartesian(start);
    const e = polarToCartesian(end);
    const largeArc = end - start > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${radius} ${radius} 0 ${largeArc} 1 ${e.x} ${e.y}`;
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Background arc */}
        <path
          d={describeArc(startAngle, endAngle)}
          fill="none"
          stroke="#1f2937"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
        {/* Filled arc */}
        {normalizedValue > 0 && (
          <path
            d={describeArc(startAngle, filledAngle)}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            className="transition-all duration-700"
          />
        )}
        {/* Center text */}
        <text
          x={cx}
          y={cy - 2}
          textAnchor="middle"
          dominantBaseline="central"
          fill={color}
          fontSize={size / 4.5}
          fontWeight="bold"
          fontFamily="monospace"
        >
          {status === "offline" ? "—" : Math.round(value)}
        </text>
        <text
          x={cx}
          y={cy + size / 5.5}
          textAnchor="middle"
          dominantBaseline="central"
          fill="#6b7280"
          fontSize={size / 8}
        >
          {unit}
        </text>
      </svg>
      <span className={`text-[10px] font-semibold uppercase tracking-wider ${textColor}`}>
        {label}
      </span>
    </div>
  );
}
