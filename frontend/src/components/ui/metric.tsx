import * as React from "react";
import { cn } from "@/lib/utils";

type Tone = "default" | "cyan" | "amber" | "red" | "green";

const VALUE_TONE: Record<Tone, string> = {
  default: "text-foreground",
  cyan: "text-accent",
  amber: "text-amber",
  red: "text-destructive",
  green: "text-success",
};

/**
 * Metric — a single KPI tile in the command-center language: an uppercase muted
 * label, a large MONOSPACED value (tabular numerals), an optional icon, unit,
 * and a delta with direction colour. Used across dashboards and metric bars.
 */
export function Metric({
  label, value, unit, delta, deltaUp, tone = "default", icon, className, children,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
  /** e.g. "+3" or "-12%" */
  delta?: React.ReactNode;
  /** direction for colouring the delta (up = green, down = red) */
  deltaUp?: boolean;
  tone?: Tone;
  icon?: React.ReactNode;
  className?: string;
  /** optional sparkline / extra content under the value */
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("panel elev-1 p-3 transition-colors hover:border-border-strong", className)}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </span>
        {icon && <span className="text-muted-foreground/70">{icon}</span>}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className={cn("data text-2xl font-semibold leading-none", VALUE_TONE[tone])}>{value}</span>
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
        {delta != null && (
          <span className={cn("data ml-auto text-[11px] font-semibold",
            deltaUp ? "text-success" : "text-destructive")}>
            {delta}
          </span>
        )}
      </div>
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}
