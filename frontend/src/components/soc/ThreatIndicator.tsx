"use client";

import { cn, threatLevelColor } from "@/lib/utils";

type ThreatLevel = "normal" | "elevated" | "high" | "critical";

interface ThreatIndicatorProps {
  level: ThreatLevel;
  size?: number;
  compact?: boolean;
  className?: string;
}

const levelLabels: Record<ThreatLevel, string> = {
  normal: "NORMAL",
  elevated: "ELEVATED",
  high: "HIGH",
  critical: "CRITICAL",
};

export function ThreatIndicator({
  level,
  size = 100,
  compact = false,
  className,
}: ThreatIndicatorProps) {
  const color = threatLevelColor(level);
  const isUrgent = level === "high" || level === "critical";

  if (compact) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border px-3 py-2",
          isUrgent
            ? "border-red-800/40 bg-red-950/20"
            : "border-gray-800/50 bg-gray-900/40",
          isUrgent && "animate-threat-pulse",
          className
        )}
      >
        {/* Mini ring */}
        <div className="relative shrink-0" style={{ width: 32, height: 32 }}>
          <svg width={32} height={32} viewBox="0 0 32 32">
            <circle
              cx={16}
              cy={16}
              r={13}
              fill="none"
              stroke="#1f2937"
              strokeWidth={2.5}
            />
            <circle
              cx={16}
              cy={16}
              r={13}
              fill="none"
              stroke={color}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 13}
              strokeDashoffset={
                2 *
                Math.PI *
                13 *
                (1 -
                  ({ normal: 0.25, elevated: 0.5, high: 0.75, critical: 1 }[
                    level
                  ] ?? 0.25))
              }
              transform="rotate(-90 16 16)"
              className="transition-all duration-500"
              opacity={0.85}
            />
            <circle cx={16} cy={16} r={9} fill="#030712" opacity={0.9} />
          </svg>
          {isUrgent && (
            <div
              className="absolute inset-0 rounded-full"
              style={{
                boxShadow: `0 0 8px ${color}40`,
              }}
            />
          )}
        </div>
        <div>
          <p className="text-[8px] font-medium uppercase tracking-wider text-gray-500 leading-none">
            Threat Level
          </p>
          <p
            className="text-xs font-bold uppercase tracking-wider leading-tight mt-0.5"
            style={{ color }}
          >
            {levelLabels[level]}
          </p>
        </div>
      </div>
    );
  }

  // Full ring variant
  const center = size / 2;
  const strokeWidth = size * 0.06;
  const radius = center - strokeWidth;
  const circumference = 2 * Math.PI * radius;

  const fillFractions: Record<ThreatLevel, number> = {
    normal: 0.25,
    elevated: 0.5,
    high: 0.75,
    critical: 1.0,
  };
  const offset = circumference * (1 - fillFractions[level]);
  const innerRadius = radius - strokeWidth * 1.8;

  return (
    <div
      className={cn(
        "relative inline-flex items-center justify-center",
        isUrgent && "animate-threat-pulse",
        className
      )}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="drop-shadow-lg"
        style={{
          filter: isUrgent
            ? `drop-shadow(0 0 ${size * 0.08}px ${color})`
            : undefined,
        }}
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="#1f2937"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${center} ${center})`}
          className="transition-all duration-700 ease-in-out"
          opacity={0.85}
        />
        <circle
          cx={center}
          cy={center}
          r={innerRadius}
          fill="none"
          stroke={color}
          strokeWidth={1}
          opacity={0.2}
        />
        <circle
          cx={center}
          cy={center}
          r={innerRadius - 2}
          fill="#030712"
          opacity={0.9}
        />
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="font-bold tracking-widest"
          style={{
            color,
            fontSize: size * 0.1,
          }}
        >
          {levelLabels[level]}
        </span>
        <span
          className="mt-0.5 text-gray-500 font-mono"
          style={{ fontSize: size * 0.07 }}
        >
          THREAT
        </span>
      </div>
    </div>
  );
}
