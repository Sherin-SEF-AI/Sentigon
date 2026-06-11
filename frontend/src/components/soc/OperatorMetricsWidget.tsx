"use client";

import * as React from "react";
import { Activity, CheckCircle2, Clock, ShieldAlert, XCircle } from "lucide-react";

import { Card } from "@/components/ui/card";
import { DataState } from "@/components/common/DataState";
import { apiFetch, cn } from "@/lib/utils";

interface OperatorMetrics {
  alerts_handled: number;
  dismissed: number;
  resolved: number;
  false_positive_rate: number;
  avg_response_seconds: number;
  period_days: number;
}

function fmtSeconds(s: number): string {
  if (!s) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.round(s / 60)}m`;
}

/** Operator/team performance over a window (backend: /api/workspace/operator-metrics). */
export function OperatorMetricsWidget({ days = 7, userId }: { days?: number; userId?: string }) {
  const [data, setData] = React.useState<OperatorMetrics | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = `days=${days}${userId && userId !== "default" ? `&user_id=${userId}` : ""}`;
      const d = await apiFetch<OperatorMetrics>(
        `/api/workspace/operator-metrics?${qs}`,
        { throwOnError: true }
      );
      setData(d ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load operator metrics");
    } finally {
      setLoading(false);
    }
  }, [days, userId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const tiles = data
    ? [
        { label: "Alerts handled", value: data.alerts_handled, icon: Activity, color: "text-cyan-400" },
        { label: "Resolved", value: data.resolved, icon: CheckCircle2, color: "text-green-400" },
        { label: "Dismissed", value: data.dismissed, icon: XCircle, color: "text-muted-foreground" },
        { label: "False-positive rate", value: `${data.false_positive_rate}%`, icon: ShieldAlert, color: "text-yellow-400" },
        { label: "Avg response", value: fmtSeconds(data.avg_response_seconds), icon: Clock, color: "text-blue-400" },
      ]
    : [];

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Operator Metrics</h3>
        <span className="text-[11px] text-muted-foreground">last {data?.period_days ?? days}d</span>
      </div>
      {loading || error ? (
        <DataState loading={loading} error={error} onRetry={load} />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {tiles.map((t) => {
            const Icon = t.icon;
            return (
              <div key={t.label} className="rounded-lg border border-border bg-card/40 p-3">
                <Icon className={cn("h-4 w-4", t.color)} />
                <div className="mt-2 text-lg font-semibold text-foreground">{t.value}</div>
                <div className="text-[11px] text-muted-foreground">{t.label}</div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
