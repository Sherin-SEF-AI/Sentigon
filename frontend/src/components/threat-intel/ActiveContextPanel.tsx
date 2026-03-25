"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert,
  CloudLightning,
  CalendarDays,
  Megaphone,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Brain,
  Zap,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import ThresholdAdjustmentViewer from "./ThresholdAdjustmentViewer";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ThreatItem {
  id?: string;
  title: string;
  severity?: string;
  description?: string;
  source?: string;
  [key: string]: unknown;
}

interface WeatherWarning {
  id?: string;
  title: string;
  severity?: string;
  description?: string;
  [key: string]: unknown;
}

interface NearbyEvent {
  id?: string;
  title: string;
  event_type?: string;
  description?: string;
  location?: string;
  [key: string]: unknown;
}

interface CommunityBulletin {
  id?: string;
  title: string;
  severity?: string;
  description?: string;
  source?: string;
  [key: string]: unknown;
}

interface ThreatContext {
  threats: ThreatItem[];
  weather_warnings: WeatherWarning[];
  nearby_events: NearbyEvent[];
  community_bulletins: CommunityBulletin[];
  threshold_adjustments?: Record<string, Record<string, number>>;
}

interface AgentSummary {
  summary: string;
  generated_at?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CARD = "rounded-lg border border-gray-800 bg-gray-900/60 backdrop-blur p-4";

const AUTO_REFRESH_MS = 30_000;

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-blue-400",
  info: "bg-gray-400",
};

/* ------------------------------------------------------------------ */
/*  Section Header                                                     */
/* ------------------------------------------------------------------ */

function SectionHeader({
  icon: Icon,
  iconColor,
  label,
  count,
  countColor,
  expanded,
  onToggle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconColor: string;
  label: string;
  count: number;
  countColor: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center gap-2.5 py-2 text-left transition-colors hover:opacity-80"
    >
      {expanded ? (
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-500" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-500" />
      )}
      <Icon className={cn("h-4 w-4 shrink-0", iconColor)} />
      <span className="flex-1 text-xs font-bold uppercase tracking-widest text-gray-400">
        {label}
      </span>
      <span
        className={cn(
          "flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold",
          count > 0 ? countColor : "bg-gray-800 text-gray-600"
        )}
      >
        {count}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Generic List Item                                                  */
/* ------------------------------------------------------------------ */

function ContextListItem({
  title,
  description,
  severity,
  meta,
}: {
  title: string;
  description?: string;
  severity?: string;
  meta?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={cn(
        "rounded-md border border-gray-800/50 transition-colors cursor-pointer",
        expanded ? "bg-gray-800/40" : "bg-gray-900/30 hover:bg-gray-800/20"
      )}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        {severity && (
          <span
            className={cn(
              "mt-1.5 h-2 w-2 shrink-0 rounded-full",
              SEVERITY_DOT[severity] || SEVERITY_DOT.info
            )}
          />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-gray-200 leading-snug">
            {title}
          </p>
          {meta && (
            <p className="mt-0.5 text-[10px] text-gray-500">{meta}</p>
          )}
          {expanded && description && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-gray-400">
              {description}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

export default function ActiveContextPanel({
  className,
}: {
  className?: string;
}) {
  const [context, setContext] = useState<ThreatContext | null>(null);
  const [agentSummary, setAgentSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* Expanded state for each section */
  const [expandedSections, setExpandedSections] = useState<
    Record<string, boolean>
  >({
    threats: true,
    weather: true,
    events: false,
    bulletins: false,
  });

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  /* --- Fetch context --- */
  const fetchContext = useCallback(async () => {
    try {
      const data = await apiFetch<ThreatContext>(
        "/api/threat-intel/context"
      );
      setContext(data);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load threat context"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  /* --- Fetch agent summary --- */
  const fetchSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const data = await apiFetch<AgentSummary>(
        "/api/threat-intel/context/agent-summary"
      );
      setAgentSummary(data.summary);
    } catch {
      setAgentSummary(null);
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  /* --- Initial + auto-refresh --- */
  useEffect(() => {
    fetchContext();
    fetchSummary();

    const interval = setInterval(() => {
      fetchContext();
      fetchSummary();
    }, AUTO_REFRESH_MS);

    return () => clearInterval(interval);
  }, [fetchContext, fetchSummary]);

  /* --- Manual refresh --- */
  const handleRefresh = useCallback(() => {
    setLoading(true);
    fetchContext();
    fetchSummary();
  }, [fetchContext, fetchSummary]);

  /* --- Render --- */
  return (
    <div className={cn("space-y-4", className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
            <Zap className="h-5 w-5 text-cyan-400" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-gray-100">
              Active Threat Context
            </h2>
            <p className="text-xs text-gray-500">
              Live situational awareness -- auto-refreshes every 30s
            </p>
          </div>
        </div>

        <button
          onClick={handleRefresh}
          disabled={loading}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs font-medium text-gray-400 transition-colors",
            "hover:bg-gray-800 hover:text-gray-200",
            "disabled:opacity-40 disabled:cursor-not-allowed"
          )}
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", loading && "animate-spin")}
          />
          Refresh
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-800/50 bg-red-950/20 px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
          <p className="flex-1 text-xs text-red-400">{error}</p>
        </div>
      )}

      {/* Loading */}
      {loading && !context && (
        <div className={cn(CARD, "flex flex-col items-center justify-center py-12")}>
          <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
          <p className="mt-3 text-xs text-gray-500">
            Loading threat context...
          </p>
        </div>
      )}

      {/* Agent Summary */}
      {(!summaryLoading || agentSummary) && (
        <div
          className={cn(
            "rounded-lg border border-cyan-800/40 bg-gradient-to-br from-cyan-950/30 to-gray-900/60 backdrop-blur p-4"
          )}
        >
          <div className="mb-2 flex items-center gap-2">
            <Brain className="h-4 w-4 text-cyan-400" />
            <h3 className="text-xs font-bold uppercase tracking-widest text-cyan-400">
              Agent Intelligence Summary
            </h3>
          </div>
          {summaryLoading && !agentSummary ? (
            <div className="flex items-center gap-2 py-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-500" />
              <span className="text-xs text-gray-500">
                Generating summary...
              </span>
            </div>
          ) : agentSummary ? (
            <p className="text-sm leading-relaxed text-gray-300">
              {agentSummary}
            </p>
          ) : (
            <p className="text-xs italic text-gray-600">
              No agent summary available at this time.
            </p>
          )}
        </div>
      )}

      {/* Context sections */}
      {context && (
        <div className={CARD}>
          <div className="space-y-1 divide-y divide-gray-800/50">
            {/* ---- Threats ---- */}
            <div>
              <SectionHeader
                icon={ShieldAlert}
                iconColor="text-red-400"
                label="Threats"
                count={context.threats.length}
                countColor="bg-red-900/40 text-red-400"
                expanded={expandedSections.threats}
                onToggle={() => toggleSection("threats")}
              />
              {expandedSections.threats && (
                <div className="space-y-1.5 pb-3 pl-6">
                  {context.threats.length === 0 ? (
                    <p className="py-2 text-xs italic text-gray-600">
                      No active threats detected.
                    </p>
                  ) : (
                    context.threats.map((item, idx) => (
                      <ContextListItem
                        key={item.id || idx}
                        title={item.title}
                        description={item.description}
                        severity={item.severity}
                        meta={item.source ? `Source: ${item.source}` : undefined}
                      />
                    ))
                  )}
                </div>
              )}
            </div>

            {/* ---- Weather Warnings ---- */}
            <div>
              <SectionHeader
                icon={CloudLightning}
                iconColor="text-yellow-400"
                label="Weather Warnings"
                count={context.weather_warnings.length}
                countColor="bg-yellow-900/40 text-yellow-400"
                expanded={expandedSections.weather}
                onToggle={() => toggleSection("weather")}
              />
              {expandedSections.weather && (
                <div className="space-y-1.5 pb-3 pl-6">
                  {context.weather_warnings.length === 0 ? (
                    <p className="py-2 text-xs italic text-gray-600">
                      No weather warnings in effect.
                    </p>
                  ) : (
                    context.weather_warnings.map((item, idx) => (
                      <ContextListItem
                        key={item.id || idx}
                        title={item.title}
                        description={item.description}
                        severity={item.severity}
                      />
                    ))
                  )}
                </div>
              )}
            </div>

            {/* ---- Nearby Events ---- */}
            <div>
              <SectionHeader
                icon={CalendarDays}
                iconColor="text-blue-400"
                label="Nearby Events"
                count={context.nearby_events.length}
                countColor="bg-blue-900/40 text-blue-400"
                expanded={expandedSections.events}
                onToggle={() => toggleSection("events")}
              />
              {expandedSections.events && (
                <div className="space-y-1.5 pb-3 pl-6">
                  {context.nearby_events.length === 0 ? (
                    <p className="py-2 text-xs italic text-gray-600">
                      No nearby events reported.
                    </p>
                  ) : (
                    context.nearby_events.map((item, idx) => (
                      <ContextListItem
                        key={item.id || idx}
                        title={item.title}
                        description={item.description}
                        meta={
                          [item.event_type, item.location]
                            .filter(Boolean)
                            .join(" -- ") || undefined
                        }
                      />
                    ))
                  )}
                </div>
              )}
            </div>

            {/* ---- Community Bulletins ---- */}
            <div>
              <SectionHeader
                icon={Megaphone}
                iconColor="text-purple-400"
                label="Community Bulletins"
                count={context.community_bulletins.length}
                countColor="bg-purple-900/40 text-purple-400"
                expanded={expandedSections.bulletins}
                onToggle={() => toggleSection("bulletins")}
              />
              {expandedSections.bulletins && (
                <div className="space-y-1.5 pb-3 pl-6">
                  {context.community_bulletins.length === 0 ? (
                    <p className="py-2 text-xs italic text-gray-600">
                      No community bulletins at this time.
                    </p>
                  ) : (
                    context.community_bulletins.map((item, idx) => (
                      <ContextListItem
                        key={item.id || idx}
                        title={item.title}
                        description={item.description}
                        severity={item.severity}
                        meta={
                          item.source ? `Source: ${item.source}` : undefined
                        }
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Threshold Adjustments */}
      {context?.threshold_adjustments &&
        Object.keys(context.threshold_adjustments).length > 0 && (
          <ThresholdAdjustmentViewer
            adjustments={context.threshold_adjustments}
          />
        )}
    </div>
  );
}
