"use client";

import { AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";

interface BehavioralFlagBadgesProps {
  flags: string[];
  className?: string;
  /** Cap the number rendered; the remainder collapses into a "+N" chip. */
  max?: number;
}

type Severity = "critical" | "high" | "medium" | "low";

const SEVERITY_STYLE: Record<Severity, string> = {
  critical: "border-red-500/50 bg-red-500/10 text-red-400",
  high: "border-orange-500/50 bg-orange-500/10 text-orange-400",
  medium: "border-yellow-500/40 bg-yellow-500/10 text-yellow-400",
  low: "border-gray-600 bg-gray-700/30 text-gray-400",
};

/** Keyword → severity. Composite-signature flags are free-form strings, so we
 *  classify by the most alarming substring they contain. */
function flagSeverity(flag: string): Severity {
  const f = flag.toLowerCase();
  if (/weapon|breach|intrusion|tailgat|forced|attack|assault|brandish/.test(f))
    return "critical";
  if (/escalat|reconnaissance|recon|evasion|perimeter|fleeing|abandon|aggress/.test(f))
    return "high";
  if (/loiter|dwell|repeated|crowd|unusual|anomal|wander/.test(f))
    return "medium";
  return "low";
}

function labelFor(flag: string): string {
  return flag.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Renders composite-signature behavioral flags as severity-colored chips.
 * Shared by the entity-journey and entity-tracking views so flag styling
 * never drifts.
 */
export function BehavioralFlagBadges({
  flags,
  className,
  max = 4,
}: BehavioralFlagBadgesProps) {
  if (!flags || flags.length === 0) return null;
  const shown = flags.slice(0, max);
  const overflow = flags.length - shown.length;

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {shown.map((flag, i) => {
        const sev = flagSeverity(flag);
        return (
          <span
            key={`${flag}-${i}`}
            title={`Behavioral signature: ${labelFor(flag)} (${sev})`}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase",
              SEVERITY_STYLE[sev]
            )}
          >
            <AlertTriangle className="h-2.5 w-2.5" />
            {labelFor(flag)}
          </span>
        );
      })}
      {overflow > 0 && (
        <span className="rounded-md border border-gray-700 bg-gray-800/40 px-1.5 py-0.5 text-[9px] font-bold text-gray-400">
          +{overflow}
        </span>
      )}
    </div>
  );
}

export default BehavioralFlagBadges;
