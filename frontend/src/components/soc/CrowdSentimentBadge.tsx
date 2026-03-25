"use client";

/* ── Types ─────────────────────────────────────────────────── */

interface CrowdSentimentBadgeProps {
  sentiment: "calm" | "tense" | "agitated" | "hostile" | "panic";
  stampede_risk: number; // 0-1
  density: number;
  avg_speed: number;
  cameraId?: string;
}

/* ── Sentiment style map ───────────────────────────────────── */

const SENTIMENT_STYLES: Record<
  CrowdSentimentBadgeProps["sentiment"],
  { bg: string; text: string; ring: string; label: string }
> = {
  calm: {
    bg: "bg-green-600/20",
    text: "text-green-400",
    ring: "ring-green-500/30",
    label: "Calm",
  },
  tense: {
    bg: "bg-yellow-600/20",
    text: "text-yellow-400",
    ring: "ring-yellow-500/30",
    label: "Tense",
  },
  agitated: {
    bg: "bg-orange-600/20",
    text: "text-orange-400",
    ring: "ring-orange-500/30",
    label: "Agitated",
  },
  hostile: {
    bg: "bg-red-600/20",
    text: "text-red-400",
    ring: "ring-red-500/30",
    label: "Hostile",
  },
  panic: {
    bg: "bg-red-900/30",
    text: "text-red-300",
    ring: "ring-red-600/50",
    label: "PANIC",
  },
};

/* ── Component ─────────────────────────────────────────────── */

export default function CrowdSentimentBadge({
  sentiment,
  stampede_risk,
  density,
  avg_speed,
  cameraId,
}: CrowdSentimentBadgeProps) {
  const style = SENTIMENT_STYLES[sentiment];
  const isPanic = sentiment === "panic";
  const highStampedeRisk = stampede_risk > 0.7;

  /* Progress bar color ramps with risk level */
  const progressColor =
    stampede_risk > 0.7
      ? "bg-red-500"
      : stampede_risk > 0.4
        ? "bg-orange-500"
        : "bg-green-500";

  return (
    <div
      className={`
        inline-flex flex-col gap-1.5 rounded-lg px-3 py-2
        ring-1 ${style.ring} ${style.bg}
        ${isPanic ? "animate-pulse" : ""}
        ${highStampedeRisk ? "ring-2 ring-red-500 animate-pulse" : ""}
        transition-all duration-300
      `}
    >
      {/* Top row: sentiment label + camera id */}
      <div className="flex items-center gap-2">
        {/* Sentiment dot */}
        <span
          className={`
            inline-block h-2 w-2 rounded-full
            ${sentiment === "calm" ? "bg-green-400" : ""}
            ${sentiment === "tense" ? "bg-yellow-400" : ""}
            ${sentiment === "agitated" ? "bg-orange-400" : ""}
            ${sentiment === "hostile" ? "bg-red-400" : ""}
            ${sentiment === "panic" ? "bg-red-500 animate-ping" : ""}
          `}
        />

        <span className={`text-sm font-semibold tracking-wide ${style.text}`}>
          {style.label}
        </span>

        {cameraId && (
          <span className="ml-auto text-[10px] text-slate-500 font-mono">
            {cameraId}
          </span>
        )}
      </div>

      {/* Stampede risk mini progress bar */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-slate-400 whitespace-nowrap">
          Stampede
        </span>
        <div className="flex-1 h-1.5 rounded-full bg-slate-700 overflow-hidden min-w-[60px]">
          <div
            className={`h-full rounded-full transition-all duration-500 ${progressColor}`}
            style={{ width: `${Math.min(stampede_risk * 100, 100)}%` }}
          />
        </div>
        <span className="text-[10px] font-mono text-slate-400 w-8 text-right">
          {(stampede_risk * 100).toFixed(0)}%
        </span>
      </div>

      {/* Bottom row: density + speed */}
      <div className="flex items-center gap-3 text-[11px] text-slate-400">
        {/* Density (people icon) */}
        <span className="inline-flex items-center gap-1" title="Crowd density">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-3.5 w-3.5 text-slate-500"
          >
            <path d="M7 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.5-1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.615 16.428a1.224 1.224 0 0 1-.569-1.175 6.002 6.002 0 0 1 11.908 0c.058.467-.172.92-.57 1.174A9.953 9.953 0 0 1 7 18a9.953 9.953 0 0 1-5.385-1.572ZM14.5 16h-.106c.07-.297.088-.611.048-.933a7.47 7.47 0 0 0-1.588-3.755 4.502 4.502 0 0 1 5.874 2.636.818.818 0 0 1-.36.98A7.465 7.465 0 0 1 14.5 16Z" />
          </svg>
          <span className="font-mono">{density.toFixed(1)}</span>
        </span>

        {/* Speed icon */}
        <span className="inline-flex items-center gap-1" title="Avg speed (m/s)">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-3.5 w-3.5 text-slate-500"
          >
            <path
              fillRule="evenodd"
              d="M13.5 4.938a7 7 0 1 1-9.006 1.737c.28-.042.553.098.7.326.286.44.636.84 1.04 1.185a.75.75 0 0 0 1.04-.085l.658-.78a.75.75 0 0 0 .068-.94 5.5 5.5 0 1 0 4.276-1.725.75.75 0 0 0-.687.463l-.34.886a.75.75 0 0 0 .343.91 3.5 3.5 0 1 1-4.376 1.31.75.75 0 0 0-.15-.96l-.726-.636a.75.75 0 0 0-1.066.08 5.001 5.001 0 1 0 8.226-1.771Z"
              clipRule="evenodd"
            />
            <path
              fillRule="evenodd"
              d="M10.293 2.293a1 1 0 0 1 1.414 0l3 3a1 1 0 0 1-1.414 1.414L11 4.414V11a1 1 0 1 1-2 0V4.414L6.707 6.707a1 1 0 0 1-1.414-1.414l3-3Z"
              clipRule="evenodd"
            />
          </svg>
          <span className="font-mono">{avg_speed.toFixed(1)}</span>
          <span className="text-slate-500">m/s</span>
        </span>
      </div>
    </div>
  );
}
