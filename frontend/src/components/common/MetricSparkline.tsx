"use client";

interface MetricSparklineProps {
  /** Array of numeric values to plot */
  data: number[];
  /** Width in pixels */
  width?: number;
  /** Height in pixels */
  height?: number;
  /** Stroke color (CSS color) */
  color?: string;
  /** Show fill gradient */
  fill?: boolean;
  /** Show the current (last) value label */
  showValue?: boolean;
  /** Unit suffix */
  unit?: string;
  /** Custom class */
  className?: string;
}

export default function MetricSparkline({
  data,
  width = 120,
  height = 32,
  color = "#06b6d4",
  fill = true,
  showValue = false,
  unit = "",
  className = "",
}: MetricSparklineProps) {
  if (data.length < 2) {
    return (
      <div
        className={`flex items-center justify-center text-[9px] text-gray-600 ${className}`}
        style={{ width, height }}
      >
        No data
      </div>
    );
  }

  const padding = 2;
  const w = width - padding * 2;
  const h = height - padding * 2;
  const minVal = Math.min(...data);
  const maxVal = Math.max(...data);
  const range = maxVal - minVal || 1;

  const points = data.map((val, i) => {
    const x = padding + (i / (data.length - 1)) * w;
    const y = padding + h - ((val - minVal) / range) * h;
    return { x, y };
  });

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  const fillPath = fill
    ? `${linePath} L ${points[points.length - 1].x} ${padding + h} L ${points[0].x} ${padding + h} Z`
    : "";

  const lastValue = data[data.length - 1];
  const prevValue = data.length > 1 ? data[data.length - 2] : lastValue;
  const trend = lastValue > prevValue ? "up" : lastValue < prevValue ? "down" : "flat";
  const trendColor =
    trend === "up" ? "text-emerald-400" : trend === "down" ? "text-red-400" : "text-gray-500";

  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <linearGradient id={`sparkFill-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {fill && fillPath && (
          <path
            d={fillPath}
            fill={`url(#sparkFill-${color.replace("#", "")})`}
          />
        )}
        <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        {/* Current value dot */}
        <circle
          cx={points[points.length - 1].x}
          cy={points[points.length - 1].y}
          r={2}
          fill={color}
        />
      </svg>
      {showValue && (
        <span className={`text-xs font-mono font-bold tabular-nums ${trendColor}`}>
          {typeof lastValue === "number" ? lastValue.toFixed(1) : lastValue}
          {unit}
        </span>
      )}
    </div>
  );
}
