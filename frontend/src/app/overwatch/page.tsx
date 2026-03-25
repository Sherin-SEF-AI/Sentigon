"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { apiFetch, cn } from "@/lib/utils";
import type { Site, Alert } from "@/lib/types";
import {
  RefreshCw,
  ChevronDown,
  X,
  Activity,
  Wifi,
  WifiOff,
  Wrench,
  Building2,
  Clock,
  Camera,
  AlertTriangle,
  MapPin,
  Globe,
  ShieldAlert,
  Link2,
} from "lucide-react";
import MetricSparkline from "@/components/common/MetricSparkline";

/* ------------------------------------------------------------------ */
/*  Cross-site correlation type                                        */
/* ------------------------------------------------------------------ */

interface CorrelatedGroup {
  threat_type: string;
  sites: { id: string; name: string; timestamp: string }[];
}

/* ------------------------------------------------------------------ */
/*  Types for new API responses                                        */
/* ------------------------------------------------------------------ */

interface SiteOverview {
  total_sites: number;
  active: number;
  offline: number;
  maintenance: number;
  total_cameras: number;
  total_alerts: number;
}

interface SiteDetailStatus {
  id: string;
  name: string;
  status: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  timezone_str: string;
  total_cameras: number;
  cameras_online: number;
  cameras_offline: number;
  recent_alerts: number;
  last_activity: string | null;
  uptime_percent: number | null;
  alert_summary: Record<string, unknown>;
}

type StatusFilter = "all" | "active" | "offline" | "maintenance";

/* ------------------------------------------------------------------ */
/*  GlobalThreatLevelCard                                              */
/* ------------------------------------------------------------------ */

type ThreatLevel = "Normal" | "Elevated" | "High" | "Critical";

function getThreatLevel(score: number): ThreatLevel {
  if (score >= 75) return "Critical";
  if (score >= 50) return "High";
  if (score >= 25) return "Elevated";
  return "Normal";
}

const THREAT_COLORS: Record<ThreatLevel, { badge: string; ring: string; sparkline: string }> = {
  Normal: {
    badge: "text-green-400 bg-green-900/30 border-green-700/50",
    ring: "border-green-700/40",
    sparkline: "#22c55e",
  },
  Elevated: {
    badge: "text-yellow-400 bg-yellow-900/30 border-yellow-700/50",
    ring: "border-yellow-700/40",
    sparkline: "#eab308",
  },
  High: {
    badge: "text-orange-400 bg-orange-900/30 border-orange-700/50",
    ring: "border-orange-700/40",
    sparkline: "#f97316",
  },
  Critical: {
    badge: "text-red-400 bg-red-900/30 border-red-700/50",
    ring: "border-red-700/40",
    sparkline: "#ef4444",
  },
};

function GlobalThreatLevelCard({ sites }: { sites: Site[] }) {
  /* Calculate average alert count across sites as threat score proxy (0-100) */
  const [trendHistory, setTrendHistory] = useState<number[]>([]);

  const avgThreatScore = useMemo(() => {
    if (sites.length === 0) return 0;
    const totalAlerts = sites.reduce((sum, s) => {
      const alertVals = Object.values(s.alert_summary || {}).map(Number).filter(isFinite);
      return sum + (alertVals.length > 0 ? alertVals.reduce((a, b) => a + b, 0) : 0);
    }, 0);
    /* Normalise to 0-100: assume 10 alerts per site = 100 threat */
    const raw = (totalAlerts / (sites.length * 10)) * 100;
    return Math.min(Math.round(raw), 100);
  }, [sites]);

  /* Build trend history whenever avgThreatScore changes */
  useEffect(() => {
    if (sites.length === 0) return;
    setTrendHistory((prev) => [...prev.slice(-11), avgThreatScore]);
  }, [avgThreatScore, sites.length]);

  const level = getThreatLevel(avgThreatScore);
  const colors = THREAT_COLORS[level];

  return (
    <div className={cn("rounded-xl border bg-gray-900/60 p-5", colors.ring)}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg border", colors.badge)}>
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Global Threat Level
            </p>
            <p className={cn("text-2xl font-bold tracking-tight", colors.badge.split(" ")[0])}>
              {level}
            </p>
          </div>
        </div>

        <div className="text-right">
          <p className="text-[10px] uppercase tracking-wider text-gray-500">Score</p>
          <p className={cn("text-3xl font-black font-mono", colors.badge.split(" ")[0])}>
            {avgThreatScore}
          </p>
          <p className="text-[9px] text-gray-600 mt-0.5">avg across {sites.length} sites</p>
        </div>
      </div>

      {/* Gauge bar */}
      <div className="mt-4 h-2.5 w-full rounded-full bg-gray-800">
        <div
          className="h-2.5 rounded-full transition-all duration-700"
          style={{
            width: `${avgThreatScore}%`,
            background:
              level === "Critical"
                ? "#ef4444"
                : level === "High"
                ? "#f97316"
                : level === "Elevated"
                ? "#eab308"
                : "#22c55e",
          }}
        />
      </div>

      {/* Sparkline trend */}
      <div className="mt-3 flex items-center justify-between">
        <p className="text-[9px] uppercase tracking-wider text-gray-600">Trend</p>
        {trendHistory.length >= 2 ? (
          <MetricSparkline
            data={trendHistory}
            width={140}
            height={28}
            color={colors.sparkline}
            fill
            showValue
            unit=""
          />
        ) : (
          <span className="text-[9px] text-gray-600">Accumulating data…</span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  CrossSiteCorrelationsPanel                                         */
/* ------------------------------------------------------------------ */

function CrossSiteCorrelationsPanel({ sites }: { sites: Site[] }) {
  const [alerts, setAlerts] = useState<(Alert & { site_id?: string; site_name?: string })[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (sites.length < 2) return;
    setLoading(true);

    /* Fetch recent alerts from global endpoint */
    apiFetch<Alert[]>("/api/alerts?limit=100&status=new")
      .then((data) => {
        if (Array.isArray(data)) setAlerts(data);
      })
      .catch(() => setAlerts([]))
      .finally(() => setLoading(false));
  }, [sites]);

  /* Find alert groups where the same threat_type appears at different
     sites within a 1-hour window. We use zone_name as a site proxy. */
  const correlatedGroups = useMemo((): CorrelatedGroup[] => {
    if (alerts.length === 0 || sites.length < 2) return [];

    const now = Date.now();
    const ONE_HOUR_MS = 60 * 60 * 1000;

    /* Filter to last 1 hour */
    const recent = alerts.filter((a) => {
      const ts = new Date(a.created_at).getTime();
      return now - ts <= ONE_HOUR_MS;
    });

    /* Group by threat_type */
    const byType = new Map<string, typeof recent>();
    for (const alert of recent) {
      const key = alert.threat_type || alert.title;
      if (!key) continue;
      const group = byType.get(key) || [];
      group.push(alert);
      byType.set(key, group);
    }

    const groups: CorrelatedGroup[] = [];
    for (const [threat_type, group] of byType) {
      /* De-dup by zone_name (treat each unique zone_name as a different "site") */
      const uniqueZones = Array.from(
        new Map(group.map((a) => [a.zone_name || a.id, a])).values()
      );
      if (uniqueZones.length < 2) continue;

      groups.push({
        threat_type,
        sites: uniqueZones.slice(0, 5).map((a) => ({
          id: a.id,
          name: a.zone_name || a.source_camera || "Unknown",
          timestamp: a.created_at,
        })),
      });
    }

    return groups;
  }, [alerts, sites]);

  if (sites.length < 2) return null;

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50">
      <div className="flex items-center justify-between border-b border-gray-800 px-5 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-cyan-400">
          <Link2 className="h-4 w-4" />
          Cross-Site Correlations
          <span className="text-[10px] text-gray-500 font-normal">(1h window)</span>
        </h2>
        {loading && <RefreshCw className="h-3.5 w-3.5 animate-spin text-gray-500" />}
      </div>

      <div className="p-5">
        {!loading && correlatedGroups.length === 0 && (
          <p className="text-center text-xs text-gray-600 py-4">
            No correlated threats detected across sites in the last hour
          </p>
        )}

        {correlatedGroups.length > 0 && (
          <div className="space-y-3">
            {correlatedGroups.map((group) => (
              <div
                key={group.threat_type}
                className="rounded-lg border border-orange-800/40 bg-orange-950/15 p-4"
              >
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-orange-400 shrink-0" />
                  <span className="text-xs font-semibold text-orange-300 uppercase tracking-wide">
                    {group.threat_type}
                  </span>
                  <span className="ml-auto text-[10px] text-orange-600">
                    {group.sites.length} locations
                  </span>
                </div>

                {/* Location chain */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {group.sites.map((site, idx) => (
                    <span key={site.id} className="flex items-center gap-1">
                      <span className="rounded bg-gray-800 border border-gray-700 px-2 py-0.5 text-[10px] font-mono text-gray-300">
                        {site.name}
                      </span>
                      {idx < group.sites.length - 1 && (
                        <Link2 className="h-2.5 w-2.5 text-orange-600 shrink-0" />
                      )}
                    </span>
                  ))}
                </div>

                <p className="mt-2 text-[10px] text-gray-600">
                  Earliest:{" "}
                  {new Date(
                    Math.min(...group.sites.map((s) => new Date(s.timestamp).getTime()))
                  ).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function siteStatusBadge(status: string) {
  const map: Record<string, string> = {
    active: "bg-green-500/10 text-green-400 border-green-500/40",
    offline: "bg-red-500/10 text-red-400 border-red-500/40",
    maintenance: "bg-yellow-500/10 text-yellow-400 border-yellow-500/40",
  };
  return map[status] || "bg-gray-500/10 text-gray-400 border-gray-500/40";
}

function siteStatusDot(status: string) {
  const map: Record<string, string> = {
    active: "bg-green-400",
    offline: "bg-red-400",
    maintenance: "bg-yellow-400",
  };
  return map[status] || "bg-gray-400";
}

/* ------------------------------------------------------------------ */
/*  SiteCard                                                           */
/* ------------------------------------------------------------------ */

function SiteCard({
  site,
  onClick,
  isSelected,
}: {
  site: Site;
  onClick: () => void;
  isSelected: boolean;
}) {
  const summary = site.alert_summary || {};
  const summaryEntries = Object.entries(summary);

  return (
    <div
      onClick={onClick}
      className={`rounded-lg border p-4 hover:bg-gray-900/90 transition-colors cursor-pointer ${
        isSelected
          ? "border-cyan-500/60 bg-gray-900/80 ring-1 ring-cyan-500/30"
          : "border-gray-800 bg-gray-900/60"
      }`}
    >
      {/* Top row: name + status */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-gray-100 truncate">
            {site.name}
          </h3>
          {site.address && (
            <p className="text-xs text-gray-500 mt-0.5 truncate">
              {site.address}
            </p>
          )}
        </div>
        <span
          className={`inline-flex items-center gap-1.5 shrink-0 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${siteStatusBadge(site.status)}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${siteStatusDot(site.status)}`} />
          {site.status}
        </span>
      </div>

      {/* Cameras count */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex items-center gap-1.5 rounded bg-gray-800/80 px-2 py-1">
          <svg
            className="h-3.5 w-3.5 text-cyan-400"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
            />
          </svg>
          <span className="text-xs font-mono text-gray-300">
            {site.total_cameras}
          </span>
          <span className="text-[10px] text-gray-500">cameras</span>
        </div>
      </div>

      {/* Alert summary metrics */}
      {summaryEntries.length > 0 && (
        <div className="border-t border-gray-800 pt-2 mt-2">
          <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">
            Alert Summary
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {summaryEntries.map(([key, value]) => (
              <div
                key={key}
                className="flex items-center justify-between rounded bg-gray-800/50 px-2 py-1"
              >
                <span className="text-[10px] text-gray-400 capitalize truncate">
                  {key.replace(/_/g, " ")}
                </span>
                <span className="text-xs font-mono text-cyan-400 ml-1">
                  {String(value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Coordinates if available */}
      {site.lat != null && site.lng != null && (
        <div className="mt-2 text-[10px] text-gray-600 font-mono">
          {site.lat.toFixed(4)}, {site.lng.toFixed(4)}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  SiteDetailPanel                                                    */
/* ------------------------------------------------------------------ */

function SiteDetailPanel({
  siteId,
  onClose,
}: {
  siteId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<SiteDetailStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<SiteDetailStatus>(`/api/sites/${siteId}/status`)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load site detail");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/80 p-5 space-y-4 animate-in slide-in-from-right-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-100 flex items-center gap-2">
          <Building2 className="h-4 w-4 text-cyan-400" />
          Site Detail
        </h3>
        <button
          onClick={onClose}
          className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-8">
          <RefreshCw className="h-5 w-5 animate-spin text-cyan-400" />
          <span className="ml-2 text-xs text-gray-500">Loading...</span>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center py-6">
          <AlertTriangle className="h-5 w-5 text-red-500 mb-1" />
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      {!loading && !error && detail && (
        <div className="space-y-3">
          {/* Site name & status */}
          <div>
            <h4 className="text-base font-semibold text-gray-100">{detail.name}</h4>
            {detail.address && (
              <p className="text-xs text-gray-500 flex items-center gap-1 mt-0.5">
                <MapPin className="h-3 w-3" />
                {detail.address}
              </p>
            )}
            <span
              className={`mt-1.5 inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${siteStatusBadge(detail.status)}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${siteStatusDot(detail.status)}`} />
              {detail.status}
            </span>
          </div>

          {/* Metrics grid */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded bg-gray-800/60 p-2.5">
              <p className="text-[10px] uppercase tracking-wider text-gray-500">Cameras Online</p>
              <p className="text-lg font-bold font-mono text-cyan-400">
                {detail.cameras_online}
                <span className="text-xs text-gray-500 font-normal">
                  /{detail.total_cameras}
                </span>
              </p>
            </div>
            <div className="rounded bg-gray-800/60 p-2.5">
              <p className="text-[10px] uppercase tracking-wider text-gray-500">Cameras Offline</p>
              <p className="text-lg font-bold font-mono text-red-400">
                {detail.cameras_offline}
              </p>
            </div>
            <div className="rounded bg-gray-800/60 p-2.5">
              <p className="text-[10px] uppercase tracking-wider text-gray-500">Recent Alerts</p>
              <p className="text-lg font-bold font-mono text-yellow-400">
                {detail.recent_alerts}
              </p>
            </div>
            <div className="rounded bg-gray-800/60 p-2.5">
              <p className="text-[10px] uppercase tracking-wider text-gray-500">Uptime</p>
              <p className="text-lg font-bold font-mono text-green-400">
                {detail.uptime_percent != null ? `${detail.uptime_percent}%` : "N/A"}
              </p>
            </div>
          </div>

          {/* Timezone & last activity */}
          <div className="border-t border-gray-800 pt-3 space-y-1.5">
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <Globe className="h-3.5 w-3.5 text-gray-500" />
              <span>Timezone: {detail.timezone_str}</span>
            </div>
            {detail.last_activity && (
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <Clock className="h-3.5 w-3.5 text-gray-500" />
                <span>
                  Last activity:{" "}
                  {new Date(detail.last_activity).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })}
                </span>
              </div>
            )}
            {detail.lat != null && detail.lng != null && (
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <MapPin className="h-3.5 w-3.5 text-gray-500" />
                <span className="font-mono">
                  {detail.lat.toFixed(4)}, {detail.lng.toFixed(4)}
                </span>
              </div>
            )}
          </div>

          {/* Alert summary */}
          {Object.entries(detail.alert_summary || {}).length > 0 && (
            <div className="border-t border-gray-800 pt-3">
              <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
                Alert Breakdown
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {Object.entries(detail.alert_summary).map(([key, value]) => (
                  <div
                    key={key}
                    className="flex items-center justify-between rounded bg-gray-800/50 px-2 py-1"
                  >
                    <span className="text-[10px] text-gray-400 capitalize truncate">
                      {key.replace(/_/g, " ")}
                    </span>
                    <span className="text-xs font-mono text-cyan-400 ml-1">
                      {String(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  GlobalOverwatchPage                                                */
/* ------------------------------------------------------------------ */

export default function GlobalOverwatchPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // -- Overview stats from /api/sites/overview --
  const [overview, setOverview] = useState<SiteOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);

  // -- Filter state --
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);

  // -- Auto-refresh --
  const [autoRefresh, setAutoRefresh] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // -- Site detail panel --
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);

  const fetchSites = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<Site[]>("/api/sites");
      setSites(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch sites");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchOverview = useCallback(async () => {
    setOverviewLoading(true);
    try {
      const data = await apiFetch<SiteOverview>("/api/sites/overview");
      setOverview(data);
    } catch {
      // Overview is supplementary; don't block the page on failure
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchSites();
    fetchOverview();
  }, [fetchSites, fetchOverview]);

  // Auto-refresh interval
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => {
        fetchSites();
        fetchOverview();
      }, 30000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, fetchSites, fetchOverview]);

  // Close filter dropdown when clicking outside
  useEffect(() => {
    if (!filterOpen) return;
    const handler = () => setFilterOpen(false);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [filterOpen]);

  const activeSites = useMemo(
    () => sites.filter((s) => s.status === "active").length,
    [sites]
  );
  const offlineSites = useMemo(
    () => sites.filter((s) => s.status === "offline").length,
    [sites]
  );
  const maintenanceSites = useMemo(
    () => sites.filter((s) => s.status === "maintenance").length,
    [sites]
  );

  // Filtered sites
  const filteredSites = useMemo(
    () =>
      statusFilter === "all"
        ? sites
        : sites.filter((s) => s.status === statusFilter),
    [sites, statusFilter]
  );

  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
            <svg
              className="h-5 w-5 text-cyan-400"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5a17.92 17.92 0 0 1-8.716-2.247m0 0A8.966 8.966 0 0 1 3 12c0-1.264.26-2.466.732-3.558"
              />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Global Overwatch
            </h1>
            <p className="text-xs text-gray-500">
              Multi-site surveillance command view
            </p>
          </div>
        </div>

        {/* Header controls: filter + auto-refresh */}
        <div className="flex items-center gap-3">
          {/* Status filter dropdown */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setFilterOpen((v) => !v);
              }}
              className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 transition-colors"
            >
              {statusFilter === "all" && <Activity className="h-3.5 w-3.5 text-gray-400" />}
              {statusFilter === "active" && <Wifi className="h-3.5 w-3.5 text-green-400" />}
              {statusFilter === "offline" && <WifiOff className="h-3.5 w-3.5 text-red-400" />}
              {statusFilter === "maintenance" && <Wrench className="h-3.5 w-3.5 text-yellow-400" />}
              <span className="capitalize">{statusFilter === "all" ? "All Status" : statusFilter}</span>
              <ChevronDown className="h-3.5 w-3.5 text-gray-500" />
            </button>

            {filterOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 w-44 rounded-lg border border-gray-700 bg-gray-900 py-1 shadow-xl">
                {(["all", "active", "offline", "maintenance"] as StatusFilter[]).map(
                  (value) => {
                    const icons: Record<StatusFilter, typeof Activity> = {
                      all: Activity,
                      active: Wifi,
                      offline: WifiOff,
                      maintenance: Wrench,
                    };
                    const colors: Record<StatusFilter, string> = {
                      all: "text-gray-400",
                      active: "text-green-400",
                      offline: "text-red-400",
                      maintenance: "text-yellow-400",
                    };
                    const Icon = icons[value];
                    return (
                      <button
                        key={value}
                        onClick={(e) => {
                          e.stopPropagation();
                          setStatusFilter(value);
                          setFilterOpen(false);
                        }}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                          statusFilter === value
                            ? "bg-gray-800 text-gray-100"
                            : "text-gray-400 hover:bg-gray-800/60 hover:text-gray-200"
                        }`}
                      >
                        <Icon className={`h-3.5 w-3.5 ${colors[value]}`} />
                        <span className="capitalize">
                          {value === "all" ? "All Status" : value}
                        </span>
                        {statusFilter === value && (
                          <span className="ml-auto h-1.5 w-1.5 rounded-full bg-cyan-400" />
                        )}
                      </button>
                    );
                  }
                )}
              </div>
            )}
          </div>

          {/* Auto-refresh toggle */}
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
              autoRefresh
                ? "border-cyan-700/60 bg-cyan-900/20 text-cyan-400"
                : "border-gray-700 bg-gray-900 text-gray-400 hover:bg-gray-800"
            }`}
            title={autoRefresh ? "Auto-refresh ON (30s)" : "Auto-refresh OFF"}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${autoRefresh ? "animate-spin" : ""}`}
              style={autoRefresh ? { animationDuration: "3s" } : undefined}
            />
            <span>{autoRefresh ? "Live 30s" : "Auto-refresh"}</span>
          </button>
        </div>
      </div>

      {/* ---- Content ---- */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {/* ---- Overview Stats Bar (from /api/sites/overview) ---- */}
        {!overviewLoading && overview && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {[
              {
                label: "Total Sites",
                value: overview.total_sites,
                icon: Building2,
                color: "text-gray-100",
                iconColor: "text-cyan-400",
                bg: "bg-cyan-900/20 border-cyan-800/40",
              },
              {
                label: "Active",
                value: overview.active,
                icon: Wifi,
                color: "text-green-400",
                iconColor: "text-green-400",
                bg: "bg-green-900/20 border-green-800/40",
              },
              {
                label: "Offline",
                value: overview.offline,
                icon: WifiOff,
                color: "text-red-400",
                iconColor: "text-red-400",
                bg: "bg-red-900/20 border-red-800/40",
              },
              {
                label: "Maintenance",
                value: overview.maintenance,
                icon: Wrench,
                color: "text-yellow-400",
                iconColor: "text-yellow-400",
                bg: "bg-yellow-900/20 border-yellow-800/40",
              },
              {
                label: "Total Cameras",
                value: overview.total_cameras,
                icon: Camera,
                color: "text-cyan-400",
                iconColor: "text-cyan-400",
                bg: "bg-cyan-900/20 border-cyan-800/40",
              },
              {
                label: "Total Alerts",
                value: overview.total_alerts,
                icon: AlertTriangle,
                color: "text-orange-400",
                iconColor: "text-orange-400",
                bg: "bg-orange-900/20 border-orange-800/40",
              },
            ].map((stat) => (
              <div
                key={stat.label}
                className={`rounded-lg border p-3 ${stat.bg}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <stat.icon className={`h-3.5 w-3.5 ${stat.iconColor}`} />
                  <span className="text-[10px] uppercase tracking-wider text-gray-500">
                    {stat.label}
                  </span>
                </div>
                <p className={`text-xl font-bold font-mono ${stat.color}`}>
                  {stat.value}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* ---- Global Threat Level Card ---- */}
        {!loading && !error && sites.length > 0 && (
          <GlobalThreatLevelCard sites={sites} />
        )}

        {/* Loading state */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-20">
            <svg
              className="h-8 w-8 animate-spin text-cyan-400"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <p className="mt-3 text-sm text-gray-500">Loading sites...</p>
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="flex flex-col items-center justify-center py-20">
            <svg
              className="mb-2 h-8 w-8 text-red-500"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
              />
            </svg>
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={fetchSites}
              className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && (
          <>
            {/* Map placeholder */}
            <div className="rounded-lg border border-gray-800 bg-gray-900/40 flex items-center justify-center h-[200px]">
              <div className="text-center">
                <svg
                  className="mx-auto h-10 w-10 text-gray-700 mb-2"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 6.75V15m6-6v8.25m.503 3.498 4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 0 0-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0Z"
                  />
                </svg>
                <p className="text-sm font-medium text-gray-600">Map View</p>
                <p className="text-[10px] text-gray-700 mt-0.5">
                  {sites.length} sites across all regions
                </p>
              </div>
            </div>

            {/* Main content: site grid + detail panel */}
            <div className={`flex gap-4 ${selectedSiteId ? "flex-col lg:flex-row" : ""}`}>
              {/* Site cards grid */}
              <div className="flex-1 min-w-0">
                {/* Filter active indicator */}
                {statusFilter !== "all" && (
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs text-gray-500">
                      Showing {filteredSites.length} of {sites.length} sites
                    </span>
                    <button
                      onClick={() => setStatusFilter("all")}
                      className="flex items-center gap-1 rounded bg-gray-800 px-2 py-0.5 text-[10px] text-gray-400 hover:text-gray-200 transition-colors"
                    >
                      <X className="h-3 w-3" />
                      Clear filter
                    </button>
                  </div>
                )}

                {filteredSites.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12">
                    <p className="text-sm text-gray-500">
                      {sites.length === 0
                        ? "No sites configured"
                        : "No sites match the current filter"}
                    </p>
                    {statusFilter !== "all" && (
                      <button
                        onClick={() => setStatusFilter("all")}
                        className="mt-2 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                      >
                        Show all sites
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filteredSites.map((site) => (
                      <SiteCard
                        key={site.id}
                        site={site}
                        isSelected={selectedSiteId === site.id}
                        onClick={() =>
                          setSelectedSiteId((prev) =>
                            prev === site.id ? null : site.id
                          )
                        }
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Site detail panel (sidebar) */}
              {selectedSiteId && (
                <div className="w-full lg:w-80 shrink-0">
                  <SiteDetailPanel
                    siteId={selectedSiteId}
                    onClose={() => setSelectedSiteId(null)}
                  />
                </div>
              )}
            </div>

            {/* ---- Cross-Site Correlations ---- */}
            <CrossSiteCorrelationsPanel sites={sites} />

            {/* Site status summary bar */}
            <div className="rounded-lg border border-gray-800 bg-gray-900/60 px-6 py-3 flex items-center justify-between">
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">Total Sites</span>
                  <span className="text-sm font-bold text-gray-100 font-mono">
                    {sites.length}
                  </span>
                </div>
                <div className="h-4 w-px bg-gray-800" />
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-green-400" />
                  <span className="text-xs text-gray-500">Active</span>
                  <span className="text-sm font-bold text-green-400 font-mono">
                    {activeSites}
                  </span>
                </div>
                <div className="h-4 w-px bg-gray-800" />
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-red-400" />
                  <span className="text-xs text-gray-500">Offline</span>
                  <span className="text-sm font-bold text-red-400 font-mono">
                    {offlineSites}
                  </span>
                </div>
                <div className="h-4 w-px bg-gray-800" />
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-yellow-400" />
                  <span className="text-xs text-gray-500">Maintenance</span>
                  <span className="text-sm font-bold text-yellow-400 font-mono">
                    {maintenanceSites}
                  </span>
                </div>
              </div>

              {/* Auto-refresh indicator in footer */}
              {autoRefresh && (
                <div className="flex items-center gap-1.5 text-[10px] text-cyan-400/70">
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
                  Auto-refreshing every 30s
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
