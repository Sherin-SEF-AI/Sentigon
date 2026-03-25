"use client";

import { useState, useEffect } from "react";
import { Clock, AlertTriangle } from "lucide-react";

interface SLACountdownProps {
  /** ISO timestamp of the SLA deadline */
  deadline: string;
  /** Severity determines urgency colors */
  severity?: "critical" | "high" | "medium" | "low";
  /** Compact mode for inline use */
  compact?: boolean;
  /** Callback when SLA is breached */
  onBreach?: () => void;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "BREACHED";
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function urgencyColor(ms: number, severity?: string): { bg: string; text: string; ring: string } {
  if (ms <= 0) return { bg: "bg-red-900/40", text: "text-red-400", ring: "ring-red-500/50" };
  const totalMin = ms / 60000;
  if (totalMin < 5 || severity === "critical") {
    return { bg: "bg-red-900/30", text: "text-red-400", ring: "ring-red-500/30" };
  }
  if (totalMin < 15 || severity === "high") {
    return { bg: "bg-amber-900/30", text: "text-amber-400", ring: "ring-amber-500/30" };
  }
  return { bg: "bg-emerald-900/30", text: "text-emerald-400", ring: "ring-emerald-500/30" };
}

export default function SLACountdown({
  deadline,
  severity,
  compact = false,
  onBreach,
}: SLACountdownProps) {
  const [remaining, setRemaining] = useState(() => new Date(deadline).getTime() - Date.now());
  const [breached, setBreached] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      const ms = new Date(deadline).getTime() - Date.now();
      setRemaining(ms);
      if (ms <= 0 && !breached) {
        setBreached(true);
        onBreach?.();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [deadline, breached, onBreach]);

  const colors = urgencyColor(remaining, severity);
  const label = formatRemaining(remaining);

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${colors.bg} ${colors.text} ring-1 ${colors.ring}`}
      >
        {remaining <= 0 ? (
          <AlertTriangle className="h-2.5 w-2.5" />
        ) : (
          <Clock className="h-2.5 w-2.5" />
        )}
        {label}
      </span>
    );
  }

  const percentage = Math.max(0, Math.min(100, (remaining / (2 * 3600000)) * 100));

  return (
    <div className={`rounded-lg border ${colors.bg} ${colors.ring} ring-1 px-3 py-2`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
          SLA {remaining <= 0 ? "Breached" : "Remaining"}
        </span>
        <span className={`text-sm font-bold ${colors.text} tabular-nums`}>
          {label}
        </span>
      </div>
      <div className="h-1 rounded-full bg-gray-800">
        <div
          className={`h-1 rounded-full transition-all duration-1000 ${
            remaining <= 0
              ? "bg-red-500 animate-pulse"
              : remaining < 300000
              ? "bg-red-500"
              : remaining < 900000
              ? "bg-amber-500"
              : "bg-emerald-500"
          }`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}
