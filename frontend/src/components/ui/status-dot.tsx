import * as React from "react";
import { cn } from "@/lib/utils";

type Tone = "live" | "warn" | "crit" | "info" | "idle";

const TONE_CLASS: Record<Tone, string> = {
  live: "led-live",
  warn: "led-warn",
  crit: "led-crit",
  info: "led-info",
  idle: "led-idle",
};

/**
 * StatusDot — a glowing LED indicator, optionally pulsing, with an optional
 * uppercase label. The standard way to show live/warn/critical state in the
 * command-center UI.
 */
export function StatusDot({
  tone = "idle", pulse, label, className,
}: {
  tone?: Tone;
  pulse?: boolean;
  label?: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className={cn("led", TONE_CLASS[tone], pulse && "led-pulse")} />
      {label && (
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      )}
    </span>
  );
}
