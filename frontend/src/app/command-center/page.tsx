"use client";

import {
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
} from "react";
import {
  ChevronRight,
  ChevronDown,
  Globe,
  Building2,
  MapPin,
  Layers,
  LayoutGrid,
  Shield,
  AlertTriangle,
  Camera,
  Activity,
  Wifi,
  WifiOff,
  RefreshCw,
  Search,
  ArrowUpRight,
  ArrowDownRight,
  X,
  GitCompareArrows,
  Network,
  CheckSquare,
  Square,
  Loader2,
  Clock,
  Bell,
  Link2,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ZoomIn,
  ZoomOut,
  Video,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type SiteStatus = "online" | "degraded" | "offline";
type NodeType = "organization" | "region" | "site" | "building" | "floor" | "zone";

interface HierarchyNode {
  id: string;
  name: string;
  type: NodeType;
  status?: SiteStatus;
  children?: HierarchyNode[];
  site_id?: string;
  camera_count?: number;
  alert_count?: number;
}

interface GlobalOverview {
  total_sites: number;
  total_alerts: number;
  sites_online: number;
  sites_degraded: number;
  sites_offline: number;
  total_cameras: number;
  cameras_online: number;
  active_incidents: number;
  threat_level: string;
  last_updated: string;
}

interface SiteStats {
  id: string;
  name: string;
  status: SiteStatus;
  address: string | null;
  camera_count: number;
  cameras_online: number;
  cameras_offline: number;
  active_alerts: number;
  active_incidents: number;
  recent_alerts: RecentAlert[];
  uptime_percent: number;
  avg_response_time_s: number;
  zone_count: number;
  last_activity: string | null;
}

interface RecentAlert {
  id: string;
  title: string;
  severity: string;
  created_at: string;
  zone: string | null;
}

interface CrossSiteCorrelation {
  id: string;
  type: string;
  description: string;
  sites: string[];
  site_names: string[];
  severity: string;
  created_at: string;
  confidence: number;
}

interface ComparisonResult {
  sites: SiteComparisonEntry[];
  generated_at: string;
}

interface SiteComparisonEntry {
  id: string;
  name: string;
  status: SiteStatus;
  camera_count: number;
  cameras_online: number;
  active_alerts: number;
  active_incidents: number;
  uptime_percent: number;
  avg_response_time_s: number;
  zone_count: number;
}

type ViewMode = "overview" | "site-detail" | "comparison";

/* ------------------------------------------------------------------ */
/*  Status helpers                                                     */
/* ------------------------------------------------------------------ */

function statusDotColor(status?: SiteStatus): string {
  const map: Record<string, string> = {
    online: "bg-green-400",
    degraded: "bg-yellow-400",
    offline: "bg-red-400",
  };
  return map[status || ""] || "bg-gray-500";
}

function statusBadgeClasses(status?: SiteStatus): string {
  const map: Record<string, string> = {
    online: "bg-green-500/10 text-green-400 border-green-500/40",
    degraded: "bg-yellow-500/10 text-yellow-400 border-yellow-500/40",
    offline: "bg-red-500/10 text-red-400 border-red-500/40",
  };
  return map[status || ""] || "bg-gray-500/10 text-gray-400 border-gray-500/40";
}

function nodeTypeIcon(type: NodeType) {
  const map: Record<NodeType, typeof Globe> = {
    organization: Globe,
    region: MapPin,
    site: Building2,
    building: Building2,
    floor: Layers,
    zone: LayoutGrid,
  };
  return map[type] || Globe;
}

function severityBadgeClasses(severity: string): string {
  const map: Record<string, string> = {
    critical: "bg-red-500/15 text-red-400 border-red-500/30",
    high: "bg-orange-500/15 text-orange-400 border-orange-500/30",
    medium: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    low: "bg-blue-400/15 text-blue-400 border-blue-400/30",
    info: "bg-gray-400/15 text-gray-400 border-gray-400/30",
  };
  return map[severity] || map.info;
}

function formatTs(iso: string | null | undefined): string {
  if (!iso) return "--";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "--";
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "--";
  }
}

/* ------------------------------------------------------------------ */
/*  TreeNode component                                                 */
/* ------------------------------------------------------------------ */

function TreeNode({
  node,
  depth,
  expandedIds,
  toggleExpand,
  selectedId,
  onSelect,
  searchQuery,
  compareIds,
  onToggleCompare,
}: {
  node: HierarchyNode;
  depth: number;
  expandedIds: Set<string>;
  toggleExpand: (id: string) => void;
  selectedId: string | null;
  onSelect: (node: HierarchyNode) => void;
  searchQuery: string;
  compareIds: Set<string>;
  onToggleCompare: (id: string) => void;
}) {
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = expandedIds.has(node.id);
  const isSelected = selectedId === node.id;
  const isSiteNode = node.type === "site";
  const isCompareChecked = compareIds.has(node.id);
  const Icon = nodeTypeIcon(node.type);

  const matchesSearch =
    !searchQuery ||
    node.name.toLowerCase().includes(searchQuery.toLowerCase());

  const childMatchesSearch = useCallback(
    (n: HierarchyNode): boolean => {
      if (!searchQuery) return true;
      if (n.name.toLowerCase().includes(searchQuery.toLowerCase())) return true;
      return (n.children || []).some(childMatchesSearch);
    },
    [searchQuery]
  );

  if (searchQuery && !matchesSearch && !childMatchesSearch(node)) {
    return null;
  }

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1 py-1.5 px-2 rounded-md cursor-pointer group transition-colors text-sm",
          isSelected
            ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/30"
            : "hover:bg-gray-800/70 text-gray-300 border border-transparent"
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => {
          if (hasChildren) toggleExpand(node.id);
          onSelect(node);
        }}
      >
        {/* Expand / Collapse chevron */}
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleExpand(node.id);
            }}
            className="p-0.5 hover:bg-gray-700/50 rounded shrink-0"
          >
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-gray-500" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-gray-500" />
            )}
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}

        {/* Node icon */}
        <Icon className="h-3.5 w-3.5 text-gray-500 shrink-0" />

        {/* Status dot for sites */}
        {isSiteNode && node.status && (
          <span
            className={cn("h-2 w-2 rounded-full shrink-0", statusDotColor(node.status))}
          />
        )}

        {/* Name */}
        <span className="truncate flex-1 text-xs font-medium">{node.name}</span>

        {/* Camera & alert badges */}
        {node.camera_count != null && node.camera_count > 0 && (
          <span className="text-[10px] text-gray-500 font-mono shrink-0">
            {node.camera_count}
            <Camera className="inline h-2.5 w-2.5 ml-0.5" />
          </span>
        )}
        {node.alert_count != null && node.alert_count > 0 && (
          <span className="text-[10px] text-red-400 font-mono shrink-0 ml-1">
            {node.alert_count}
            <AlertTriangle className="inline h-2.5 w-2.5 ml-0.5" />
          </span>
        )}

        {/* Compare checkbox for site nodes */}
        {isSiteNode && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleCompare(node.id);
            }}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 shrink-0"
            title="Toggle site comparison"
          >
            {isCompareChecked ? (
              <CheckSquare className="h-3.5 w-3.5 text-cyan-400" />
            ) : (
              <Square className="h-3.5 w-3.5 text-gray-600" />
            )}
          </button>
        )}
      </div>

      {/* Render children */}
      {hasChildren && isExpanded && (
        <div>
          {(node.children || []).map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              expandedIds={expandedIds}
              toggleExpand={toggleExpand}
              selectedId={selectedId}
              onSelect={onSelect}
              searchQuery={searchQuery}
              compareIds={compareIds}
              onToggleCompare={onToggleCompare}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  StatCard                                                           */
/* ------------------------------------------------------------------ */

function StatCard({
  label,
  value,
  icon: Icon,
  color = "text-cyan-400",
  subValue,
}: {
  label: string;
  value: string | number;
  icon: typeof Globe;
  color?: string;
  subValue?: string;
}) {
  return (
    <div className="rounded-lg border border-gray-800 bg-zinc-900/80 p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] uppercase tracking-wider text-gray-500 font-medium">
          {label}
        </span>
        <Icon className={cn("h-4 w-4", color)} />
      </div>
      <p className={cn("text-2xl font-bold font-mono", color)}>{value}</p>
      {subValue && (
        <p className="text-[11px] text-gray-500 mt-1">{subValue}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  GlobalOverviewPanel                                                */
/* ------------------------------------------------------------------ */

function GlobalOverviewPanel({
  overview,
  correlations,
  loading,
  error,
  onRefresh,
}: {
  overview: GlobalOverview | null;
  correlations: CrossSiteCorrelation[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 text-cyan-400 animate-spin" />
        <span className="ml-2 text-sm text-gray-400">Loading global overview...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertTriangle className="h-8 w-8 text-red-400" />
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={onRefresh}
          className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
        >
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    );
  }

  if (!overview) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">
            Global Command Overview
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Cross-site operational status and intelligence
          </p>
        </div>
        <div className="flex items-center gap-3">
          {overview.last_updated && (
            <span className="text-[10px] text-gray-600 font-mono">
              Updated {formatTs(overview.last_updated)}
            </span>
          )}
          <button
            onClick={onRefresh}
            className="p-1.5 rounded-md hover:bg-gray-800 transition-colors"
            title="Refresh data"
          >
            <RefreshCw className="h-4 w-4 text-gray-400" />
          </button>
        </div>
      </div>

      {/* Stat cards grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Total Sites"
          value={overview.total_sites}
          icon={Building2}
          color="text-cyan-400"
        />
        <StatCard
          label="Sites Online"
          value={overview.sites_online || 0}
          icon={Wifi}
          color="text-green-400"
          subValue={
            (overview.sites_degraded || 0) > 0
              ? `${overview.sites_degraded} degraded`
              : undefined
          }
        />
        <StatCard
          label="Sites Offline"
          value={overview.sites_offline || 0}
          icon={WifiOff}
          color={(overview.sites_offline || 0) > 0 ? "text-red-400" : "text-gray-500"}
        />
        <StatCard
          label="Active Alerts"
          value={overview.total_alerts || 0}
          icon={AlertTriangle}
          color={(overview.total_alerts || 0) > 0 ? "text-yellow-400" : "text-gray-500"}
        />
        <StatCard
          label="Total Cameras"
          value={overview.total_cameras || 0}
          icon={Camera}
          color="text-cyan-400"
          subValue={`${overview.cameras_online || 0} online`}
        />
        <StatCard
          label="Active Incidents"
          value={overview.active_incidents || 0}
          icon={Shield}
          color={(overview.active_incidents || 0) > 0 ? "text-orange-400" : "text-gray-500"}
        />
        <StatCard
          label="Threat Level"
          value={overview.threat_level?.toUpperCase() || "NORMAL"}
          icon={Activity}
          color={
            overview.threat_level === "critical"
              ? "text-red-400"
              : overview.threat_level === "high"
              ? "text-orange-400"
              : overview.threat_level === "elevated"
              ? "text-yellow-400"
              : "text-green-400"
          }
        />
        <StatCard
          label="Sites Degraded"
          value={overview.sites_degraded || 0}
          icon={AlertTriangle}
          color={(overview.sites_degraded || 0) > 0 ? "text-yellow-400" : "text-gray-500"}
        />
      </div>

      {/* Cross-site correlations */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Link2 className="h-4 w-4 text-cyan-400" />
          <h3 className="text-sm font-semibold text-gray-200">
            Cross-Site Correlations
          </h3>
          <span className="text-[10px] bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 rounded px-1.5 py-0.5 font-mono">
            {correlations.length}
          </span>
        </div>

        {correlations.length === 0 ? (
          <div className="rounded-lg border border-gray-800 bg-zinc-900/60 p-6 text-center">
            <Network className="h-8 w-8 text-gray-700 mx-auto mb-2" />
            <p className="text-xs text-gray-500">
              No cross-site correlations detected
            </p>
          </div>
        ) : (
          <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1 custom-scrollbar">
            {correlations.map((corr) => (
              <div
                key={corr.id}
                className="rounded-lg border border-gray-800 bg-zinc-900/60 p-3 hover:border-gray-700 transition-colors"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "text-[10px] uppercase font-bold tracking-wider border rounded px-1.5 py-0.5",
                          severityBadgeClasses(corr.severity)
                        )}
                      >
                        {corr.severity}
                      </span>
                      <span className="text-[10px] uppercase text-gray-500 font-medium">
                        {corr.type.replace(/_/g, " ")}
                      </span>
                    </div>
                    <p className="text-xs text-gray-300 mt-1 leading-relaxed">
                      {corr.description}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-[10px] text-gray-600 font-mono">
                      {Math.round(corr.confidence * 100)}% conf
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {(Array.isArray(corr.site_names) ? corr.site_names : []).map((name, i) => (
                    <span
                      key={i}
                      className="text-[10px] bg-gray-800 text-gray-400 rounded px-1.5 py-0.5 font-mono"
                    >
                      {name}
                    </span>
                  ))}
                  <span className="text-[10px] text-gray-600 ml-auto font-mono">
                    {formatTs(corr.created_at)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
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
  const [stats, setStats] = useState<SiteStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCamera, setSelectedCamera] = useState<{ id: string; name: string } | null>(null);

  const fetchStats = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch<Record<string, unknown>>(`/api/multi-site/sites/${siteId}/dashboard`)
      .then((raw) => {
        if (!raw || typeof raw !== "object") {
          setStats(null);
          return;
        }
        // Map backend dashboard response to frontend SiteStats shape
        setStats({
          id: String(raw.id || siteId),
          name: String(raw.name || "Unknown Site"),
          status: (raw.status as SiteStatus) || "offline",
          address: raw.address ? String(raw.address) : null,
          camera_count: Number(raw.camera_count) || 0,
          cameras_online: Number(raw.cameras_online) || 0,
          cameras_offline: Number(raw.cameras_offline) || 0,
          active_alerts: Number(raw.alerts_today ?? raw.active_alerts) || 0,
          active_incidents: Number(raw.active_incidents) || 0,
          recent_alerts: Array.isArray(raw.recent_alerts) ? raw.recent_alerts as RecentAlert[] : [],
          uptime_percent: raw.uptime_percent != null ? Number(raw.uptime_percent) : 99.9,
          avg_response_time_s: raw.avg_response_time_s != null ? Number(raw.avg_response_time_s) : 0,
          zone_count: Number(raw.zone_count) || 0,
          last_activity: raw.last_activity ? String(raw.last_activity) : null,
        });
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [siteId]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 text-cyan-400 animate-spin" />
        <span className="ml-2 text-sm text-gray-400">Loading site details...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertTriangle className="h-8 w-8 text-red-400" />
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={fetchStats}
          className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
        >
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    );
  }

  if (!stats) return null;

  const cameraOnlinePercent =
    (stats.camera_count || 0) > 0
      ? Math.round(((stats.cameras_online || 0) / stats.camera_count) * 100)
      : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-gray-100">{stats.name}</h2>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                statusBadgeClasses(stats.status)
              )}
            >
              <span
                className={cn("h-1.5 w-1.5 rounded-full", statusDotColor(stats.status))}
              />
              {stats.status}
            </span>
          </div>
          {stats.address && (
            <p className="text-xs text-gray-500 mt-0.5">{stats.address}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchStats}
            className="p-1.5 rounded-md hover:bg-gray-800 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4 text-gray-400" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-gray-800 transition-colors"
            title="Close"
          >
            <X className="h-4 w-4 text-gray-400" />
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Cameras"
          value={`${stats.cameras_online || 0}/${stats.camera_count || 0}`}
          icon={Camera}
          color="text-cyan-400"
          subValue={`${cameraOnlinePercent}% online`}
        />
        <StatCard
          label="Active Alerts"
          value={stats.active_alerts || 0}
          icon={Bell}
          color={(stats.active_alerts || 0) > 0 ? "text-yellow-400" : "text-gray-500"}
        />
        <StatCard
          label="Active Incidents"
          value={stats.active_incidents || 0}
          icon={Shield}
          color={(stats.active_incidents || 0) > 0 ? "text-orange-400" : "text-gray-500"}
        />
        <StatCard
          label="Uptime"
          value={`${stats.uptime_percent != null ? Number(stats.uptime_percent).toFixed(1) : "--"}%`}
          icon={Activity}
          color={
            (stats.uptime_percent ?? 100) >= 99
              ? "text-green-400"
              : (stats.uptime_percent ?? 100) >= 95
              ? "text-yellow-400"
              : "text-red-400"
          }
        />
        <StatCard
          label="Zones"
          value={stats.zone_count || 0}
          icon={LayoutGrid}
          color="text-cyan-400"
        />
        <StatCard
          label="Avg Response"
          value={`${stats.avg_response_time_s != null ? Number(stats.avg_response_time_s).toFixed(1) : "--"}s`}
          icon={Clock}
          color="text-cyan-400"
        />
        <StatCard
          label="Cameras Offline"
          value={stats.cameras_offline || 0}
          icon={WifiOff}
          color={(stats.cameras_offline || 0) > 0 ? "text-red-400" : "text-gray-500"}
        />
        <StatCard
          label="Last Activity"
          value={stats.last_activity ? formatTs(stats.last_activity) : "--"}
          icon={Clock}
          color="text-gray-400"
        />
      </div>

      {/* Camera health bar */}
      <div className="rounded-lg border border-gray-800 bg-zinc-900/60 p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400 font-medium">Camera Health</span>
          <span className="text-[10px] text-gray-500 font-mono">
            {stats.cameras_online || 0} online / {stats.cameras_offline || 0} offline
          </span>
        </div>
        <div className="h-2.5 w-full rounded-full bg-gray-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-green-500 to-green-400 transition-all duration-500"
            style={{ width: `${cameraOnlinePercent}%` }}
          />
        </div>
      </div>

      {/* Recent alerts */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="h-4 w-4 text-yellow-400" />
          <h3 className="text-sm font-semibold text-gray-200">Recent Alerts</h3>
          <span className="text-[10px] bg-yellow-500/10 text-yellow-400 border border-yellow-500/30 rounded px-1.5 py-0.5 font-mono">
            {stats.recent_alerts?.length ?? 0}
          </span>
        </div>

        {(!stats.recent_alerts || stats.recent_alerts.length === 0) ? (
          <div className="rounded-lg border border-gray-800 bg-zinc-900/60 p-6 text-center">
            <Shield className="h-8 w-8 text-gray-700 mx-auto mb-2" />
            <p className="text-xs text-gray-500">No recent alerts for this site</p>
          </div>
        ) : (
          <div className="space-y-1.5 max-h-[280px] overflow-y-auto pr-1 custom-scrollbar">
            {stats.recent_alerts.map((alert) => (
              <div
                key={alert.id}
                className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 px-3 py-2.5 hover:border-gray-700 transition-colors"
              >
                <span
                  className={cn(
                    "text-[10px] uppercase font-bold tracking-wider border rounded px-1.5 py-0.5 shrink-0",
                    severityBadgeClasses(alert.severity)
                  )}
                >
                  {alert.severity}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-200 truncate">{alert.title}</p>
                  {alert.zone && (
                    <p className="text-[10px] text-gray-500 mt-0.5">{alert.zone}</p>
                  )}
                </div>
                <span className="text-[10px] text-gray-600 font-mono shrink-0">
                  {formatTs(alert.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Incident density map */}
      <IncidentDensityMap siteId={siteId} />

      {/* Camera selector for PTZ */}
      <div className="rounded-xl border border-gray-800 bg-zinc-900/50 p-4">
        <div className="flex items-center gap-2 mb-2">
          <Camera className="h-4 w-4 text-cyan-400" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-cyan-400">
            Camera PTZ Control
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Camera ID or name..."
            className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:border-cyan-700 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const val = (e.target as HTMLInputElement).value.trim();
                if (val) setSelectedCamera({ id: val, name: val });
              }
            }}
          />
          <button
            onClick={(e) => {
              const input = (e.currentTarget.previousElementSibling as HTMLInputElement);
              const val = input?.value?.trim();
              if (val) setSelectedCamera({ id: val, name: val });
            }}
            className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700 transition-colors"
          >
            Select
          </button>
          {selectedCamera && (
            <button
              onClick={() => setSelectedCamera(null)}
              className="rounded-lg p-1.5 text-gray-600 hover:text-gray-400 hover:bg-gray-800 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {selectedCamera && (
          <PTZControlPanel cameraId={selectedCamera.id} cameraName={selectedCamera.name} />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ComparisonPanel                                                    */
/* ------------------------------------------------------------------ */

function ComparisonPanel({
  siteIds,
  onClose,
}: {
  siteIds: string[];
  onClose: () => void;
}) {
  const [result, setResult] = useState<ComparisonResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchComparison = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch<Record<string, Record<string, unknown>>>("/api/multi-site/comparison", {
      method: "POST",
      body: JSON.stringify({ site_ids: siteIds }),
    })
      .then((raw) => {
        if (!raw || typeof raw !== "object") {
          setResult({ sites: [], generated_at: new Date().toISOString() });
          return;
        }
        // Backend returns {sid: {name, alerts_today, status}} — map to ComparisonResult
        const sites: SiteComparisonEntry[] = Object.entries(raw).map(([sid, data]) => ({
          id: sid,
          name: String(data?.name || "Unknown"),
          status: (data?.status as SiteStatus) || "offline",
          camera_count: Number(data?.camera_count) || 0,
          cameras_online: Number(data?.cameras_online) || 0,
          active_alerts: Number(data?.alerts_today ?? data?.active_alerts) || 0,
          active_incidents: Number(data?.active_incidents) || 0,
          uptime_percent: data?.uptime_percent != null ? Number(data.uptime_percent) : 99.9,
          avg_response_time_s: data?.avg_response_time_s != null ? Number(data.avg_response_time_s) : 0,
          zone_count: Number(data?.zone_count) || 0,
        }));
        setResult({ sites, generated_at: new Date().toISOString() });
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [siteIds]);

  useEffect(() => {
    if (siteIds.length >= 2) {
      fetchComparison();
    }
  }, [fetchComparison, siteIds.length]);

  if (siteIds.length < 2) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <GitCompareArrows className="h-10 w-10 text-gray-700" />
        <p className="text-sm text-gray-500">
          Select at least 2 sites from the tree to compare
        </p>
        <p className="text-xs text-gray-600">
          Use the checkbox on site nodes in the hierarchy
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 text-cyan-400 animate-spin" />
        <span className="ml-2 text-sm text-gray-400">Comparing sites...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertTriangle className="h-8 w-8 text-red-400" />
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={fetchComparison}
          className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
        >
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    );
  }

  if (!result || !Array.isArray(result.sites) || result.sites.length === 0) return null;

  const metrics: { key: keyof SiteComparisonEntry; label: string; format?: (v: number) => string; invertColor?: boolean }[] = [
    { key: "camera_count", label: "Total Cameras" },
    { key: "cameras_online", label: "Cameras Online" },
    { key: "active_alerts", label: "Active Alerts", invertColor: true },
    { key: "active_incidents", label: "Active Incidents", invertColor: true },
    { key: "uptime_percent", label: "Uptime %", format: (v) => `${(Number(v) || 0).toFixed(1)}%` },
    { key: "avg_response_time_s", label: "Avg Response (s)", format: (v) => `${(Number(v) || 0).toFixed(1)}s`, invertColor: true },
    { key: "zone_count", label: "Zones" },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Site Comparison</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Comparing {result.sites.length} sites across key metrics
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchComparison}
            className="p-1.5 rounded-md hover:bg-gray-800 transition-colors"
            title="Refresh comparison"
          >
            <RefreshCw className="h-4 w-4 text-gray-400" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-gray-800 transition-colors"
            title="Close comparison"
          >
            <X className="h-4 w-4 text-gray-400" />
          </button>
        </div>
      </div>

      {/* Comparison table */}
      <div className="rounded-lg border border-gray-800 bg-zinc-900/60 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="text-left px-4 py-3 text-gray-500 font-medium uppercase tracking-wider text-[10px]">
                Metric
              </th>
              {result.sites.map((site) => (
                <th
                  key={site.id}
                  className="text-center px-4 py-3 text-[10px] font-medium uppercase tracking-wider"
                >
                  <div className="flex items-center justify-center gap-1.5">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        statusDotColor(site.status)
                      )}
                    />
                    <span className="text-gray-300">{site.name}</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((metric) => {
              const values = result.sites.map(
                (s) => Number(s[metric.key]) || 0
              );
              const maxVal = Math.max(...values);
              const minVal = Math.min(...values);
              const allEqual = maxVal === minVal;

              return (
                <tr
                  key={String(metric.key)}
                  className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
                >
                  <td className="px-4 py-2.5 text-gray-400 font-medium">
                    {metric.label}
                  </td>
                  {result.sites.map((site) => {
                    const val = Number(site[metric.key]) || 0;
                    const isMax = !allEqual && val === maxVal;
                    const isMin = !allEqual && val === minVal;

                    let colorClass = "text-gray-300";
                    if (isMax) colorClass = metric.invertColor ? "text-red-400" : "text-green-400";
                    if (isMin) colorClass = metric.invertColor ? "text-green-400" : "text-red-400";

                    return (
                      <td key={site.id} className="px-4 py-2.5 text-center">
                        <span className={cn("font-mono", colorClass)}>
                          {metric.format ? metric.format(val) : val}
                        </span>
                        {isMax && (
                          <ArrowUpRight className="inline h-3 w-3 ml-1 text-current" />
                        )}
                        {isMin && (
                          <ArrowDownRight className="inline h-3 w-3 ml-1 text-current" />
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}

            {/* Status row */}
            <tr className="border-b border-gray-800/50">
              <td className="px-4 py-2.5 text-gray-400 font-medium">Status</td>
              {result.sites.map((site) => (
                <td key={site.id} className="px-4 py-2.5 text-center">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                      statusBadgeClasses(site.status)
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        statusDotColor(site.status)
                      )}
                    />
                    {site.status}
                  </span>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      {/* Visual metric bars */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          Visual Comparison
        </h3>
        {metrics.slice(0, 4).map((metric) => {
          const maxVal = Math.max(
            ...result.sites.map((s) => Number(s[metric.key]) || 0),
            1
          );

          return (
            <div
              key={String(metric.key)}
              className="rounded-lg border border-gray-800 bg-zinc-900/60 p-3"
            >
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
                {metric.label}
              </p>
              <div className="space-y-1.5">
                {result.sites.map((site) => {
                  const val = Number(site[metric.key]) || 0;
                  const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;

                  return (
                    <div key={site.id} className="flex items-center gap-2">
                      <span className="text-[10px] text-gray-400 w-24 truncate shrink-0">
                        {site.name}
                      </span>
                      <div className="flex-1 h-2 rounded-full bg-gray-800 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-cyan-400 transition-all duration-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-gray-400 font-mono w-12 text-right shrink-0">
                        {metric.format ? metric.format(val) : val}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  PTZ Control Panel                                                  */
/* ------------------------------------------------------------------ */

interface PTZPanelProps {
  cameraId: string;
  cameraName: string;
}

function PTZControlPanel({ cameraId, cameraName }: PTZPanelProps) {
  const [sending, setSending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);

  const sendPTZ = async (action: string) => {
    setSending(action);
    setFeedback(null);
    try {
      await apiFetch("/api/onvif/ptz", {
        method: "POST",
        body: JSON.stringify({ camera_id: cameraId, action }),
      });
      setFeedback({ msg: `${action} OK`, ok: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "PTZ error";
      // Treat 404 (endpoint not available) gracefully
      if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
        setFeedback({ msg: "PTZ not available", ok: false });
      } else {
        setFeedback({ msg, ok: false });
      }
    } finally {
      setSending(null);
      setTimeout(() => setFeedback(null), 3000);
    }
  };

  return (
    <div className="rounded-xl border border-gray-800 bg-zinc-900/50 p-4 mt-4">
      <div className="flex items-center gap-2 mb-3">
        <Video className="h-4 w-4 text-cyan-400" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-cyan-400">
          PTZ Control
        </h3>
        <span className="text-[10px] text-gray-500 truncate">{cameraName}</span>
      </div>

      <div className="flex items-start gap-4">
        {/* Directional pad */}
        <div className="grid grid-cols-3 gap-1 w-28 shrink-0">
          {/* Row 1: empty, up, empty */}
          <span />
          <button
            onClick={() => sendPTZ("move_up")}
            disabled={!!sending}
            className="flex items-center justify-center rounded-lg border border-gray-700 bg-gray-800 p-2 hover:bg-gray-700 hover:border-cyan-600 transition-colors disabled:opacity-50"
            title="Tilt Up"
          >
            {sending === "move_up" ? <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-400" /> : <ArrowUp className="h-3.5 w-3.5 text-gray-300" />}
          </button>
          <span />
          {/* Row 2: left, center dot, right */}
          <button
            onClick={() => sendPTZ("move_left")}
            disabled={!!sending}
            className="flex items-center justify-center rounded-lg border border-gray-700 bg-gray-800 p-2 hover:bg-gray-700 hover:border-cyan-600 transition-colors disabled:opacity-50"
            title="Pan Left"
          >
            {sending === "move_left" ? <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-400" /> : <ArrowLeft className="h-3.5 w-3.5 text-gray-300" />}
          </button>
          <span className="flex items-center justify-center">
            <span className="w-2 h-2 rounded-full bg-gray-700" />
          </span>
          <button
            onClick={() => sendPTZ("move_right")}
            disabled={!!sending}
            className="flex items-center justify-center rounded-lg border border-gray-700 bg-gray-800 p-2 hover:bg-gray-700 hover:border-cyan-600 transition-colors disabled:opacity-50"
            title="Pan Right"
          >
            {sending === "move_right" ? <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-400" /> : <ArrowRight className="h-3.5 w-3.5 text-gray-300" />}
          </button>
          {/* Row 3: empty, down, empty */}
          <span />
          <button
            onClick={() => sendPTZ("move_down")}
            disabled={!!sending}
            className="flex items-center justify-center rounded-lg border border-gray-700 bg-gray-800 p-2 hover:bg-gray-700 hover:border-cyan-600 transition-colors disabled:opacity-50"
            title="Tilt Down"
          >
            {sending === "move_down" ? <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-400" /> : <ArrowDown className="h-3.5 w-3.5 text-gray-300" />}
          </button>
          <span />
        </div>

        {/* Zoom column */}
        <div className="flex flex-col gap-1.5 shrink-0">
          <span className="text-[9px] font-bold uppercase tracking-wider text-gray-600 mb-0.5">Zoom</span>
          <button
            onClick={() => sendPTZ("zoom_in")}
            disabled={!!sending}
            className="flex items-center gap-1 rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-gray-300 hover:bg-gray-700 hover:border-cyan-600 transition-colors disabled:opacity-50"
            title="Zoom In"
          >
            {sending === "zoom_in" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ZoomIn className="h-3 w-3" />}
            In
          </button>
          <button
            onClick={() => sendPTZ("zoom_out")}
            disabled={!!sending}
            className="flex items-center gap-1 rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-gray-300 hover:bg-gray-700 hover:border-cyan-600 transition-colors disabled:opacity-50"
            title="Zoom Out"
          >
            {sending === "zoom_out" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ZoomOut className="h-3 w-3" />}
            Out
          </button>
        </div>

        {/* Feedback */}
        {feedback && (
          <div className={cn(
            "text-[11px] rounded-lg px-2.5 py-1.5 border self-start",
            feedback.ok
              ? "text-green-400 bg-green-900/20 border-green-800/50"
              : "text-amber-400 bg-amber-900/20 border-amber-800/50"
          )}>
            {feedback.msg}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Incident Density Badge                                             */
/* ------------------------------------------------------------------ */

function incidentDensityBadge(count: number): string {
  if (count === 0) return "bg-gray-700 text-gray-400";
  if (count <= 3) return "bg-amber-600 text-amber-100";
  return "bg-red-600 text-red-100";
}

interface ZoneIncidentCount {
  zone_id: string;
  zone_name: string;
  incident_count: number;
}

function IncidentDensityMap({ siteId }: { siteId: string }) {
  const [zones, setZones] = useState<ZoneIncidentCount[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    apiFetch<Record<string, unknown>>(`/api/multi-site/sites/${siteId}/dashboard`)
      .then((raw) => {
        // Try to extract zone incident data from the dashboard endpoint
        const recentAlerts = Array.isArray(raw?.recent_alerts) ? raw.recent_alerts as RecentAlert[] : [];
        const zoneMap: Record<string, ZoneIncidentCount> = {};
        recentAlerts.forEach((a) => {
          const zn = a.zone || "Unknown Zone";
          if (!zoneMap[zn]) {
            zoneMap[zn] = { zone_id: zn, zone_name: zn, incident_count: 0 };
          }
          zoneMap[zn].incident_count += 1;
        });
        setZones(Object.values(zoneMap));
      })
      .catch(() => setZones([]))
      .finally(() => setLoading(false));
  }, [siteId]);

  if (loading) return <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-cyan-400" /></div>;
  if (zones.length === 0) return null;

  return (
    <div className="mt-4 rounded-xl border border-gray-800 bg-zinc-900/50 p-4">
      <div className="flex items-center gap-2 mb-3">
        <LayoutGrid className="h-4 w-4 text-cyan-400" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-cyan-400">
          Zone Incident Density
        </h3>
      </div>
      <div className="flex flex-wrap gap-2">
        {zones.map((z) => (
          <div
            key={z.zone_id}
            className="flex items-center gap-2 rounded-lg border border-gray-800 bg-zinc-900/60 px-3 py-2"
          >
            <span className="text-xs text-gray-300 font-medium">{z.zone_name}</span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-bold font-mono",
                incidentDensityBadge(z.incident_count)
              )}
            >
              {z.incident_count}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-3 text-[10px] text-gray-600">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-700" /> 0</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-600" /> 1–3</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-600" /> 4+</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page Component                                                */
/* ------------------------------------------------------------------ */

export default function CommandCenterPage() {
  /* ---- State ---- */
  const [hierarchy, setHierarchy] = useState<HierarchyNode[]>([]);
  const [overview, setOverview] = useState<GlobalOverview | null>(null);
  const [correlations, setCorrelations] = useState<CrossSiteCorrelation[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedNode, setSelectedNode] = useState<HierarchyNode | null>(null);
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("overview");
  const [treeSearch, setTreeSearch] = useState("");
  const [loadingHierarchy, setLoadingHierarchy] = useState(true);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [errorHierarchy, setErrorHierarchy] = useState<string | null>(null);
  const [errorOverview, setErrorOverview] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);

  /* ---- Fetchers ---- */

  // Map backend hierarchy nodes (which use "level") to frontend HierarchyNode (which uses "type")
  const mapHierarchyNodes = useCallback((nodes: Record<string, unknown>[]): HierarchyNode[] => {
    return nodes.map((n) => ({
      id: String(n.id || ""),
      name: String(n.name || "Unnamed"),
      type: (n.type || n.level || "organization") as NodeType,
      status: (n.status as SiteStatus) || undefined,
      children: Array.isArray(n.children) ? mapHierarchyNodes(n.children as Record<string, unknown>[]) : [],
      site_id: n.site_id ? String(n.site_id) : n.id ? String(n.id) : undefined,
      camera_count: n.camera_count != null ? Number(n.camera_count) : undefined,
      alert_count: n.alert_count != null ? Number(n.alert_count) : undefined,
    }));
  }, []);

  const fetchHierarchy = useCallback(() => {
    setLoadingHierarchy(true);
    setErrorHierarchy(null);
    apiFetch<Record<string, unknown>[]>("/api/multi-site/hierarchy")
      .then((data) => {
        const safeData = Array.isArray(data) ? mapHierarchyNodes(data) : [];
        setHierarchy(safeData);
        // Auto-expand first level on initial load
        const firstLevelIds = new Set(safeData.map((n) => n.id));
        setExpandedIds((prev) => {
          const next = new Set(prev);
          firstLevelIds.forEach((id) => next.add(id));
          return next;
        });
      })
      .catch((e) => {
        setErrorHierarchy(e.message);
        setHierarchy([]);
      })
      .finally(() => setLoadingHierarchy(false));
  }, [mapHierarchyNodes]);

  const fetchOverview = useCallback(() => {
    setLoadingOverview(true);
    setErrorOverview(null);

    // Fetch overview — map backend field names to what the frontend expects
    const overviewPromise = apiFetch<Record<string, unknown>>("/api/multi-site/overview")
      .then((raw) => {
        if (!raw || typeof raw !== "object") return null;
        const sitesArr = Array.isArray(raw.sites) ? raw.sites : [];
        const sitesOnline = sitesArr.filter((s: Record<string, unknown>) => s.status === "online").length;
        const sitesDegraded = sitesArr.filter((s: Record<string, unknown>) => s.status === "degraded").length;
        const sitesOffline = sitesArr.filter((s: Record<string, unknown>) => s.status === "offline").length;
        return {
          total_sites: Number(raw.total_sites) || 0,
          total_alerts: Number(raw.alerts_today) || 0,
          sites_online: sitesOnline,
          sites_degraded: sitesDegraded,
          sites_offline: sitesOffline,
          total_cameras: Number(raw.total_cameras) || 0,
          cameras_online: Number(raw.online_cameras) || 0,
          active_incidents: Number(raw.active_incidents) || 0,
          threat_level: String(raw.threat_level || "normal"),
          last_updated: String(raw.last_updated || new Date().toISOString()),
        } as GlobalOverview;
      })
      .catch(() => null);

    // Fetch correlations — endpoint is /correlation (no 's'), returns different shape
    const correlationsPromise = apiFetch<Record<string, unknown>[]>("/api/multi-site/correlation")
      .then((raw) => {
        const safeRaw = Array.isArray(raw) ? raw : [];
        return safeRaw.map((item, idx) => ({
          id: String(item.id || `corr-${idx}`),
          type: String(item.threat_type || item.type || "unknown"),
          description: `${Number(item.count) || 0} related alerts of type "${String(item.threat_type || "unknown")}" detected across sites`,
          sites: [],
          site_names: Array.isArray(item.alerts)
            ? [...new Set((item.alerts as Record<string, unknown>[]).map((a) => String(a.zone_name || "Unknown")))]
            : [],
          severity: Array.isArray(item.alerts) && (item.alerts as Record<string, unknown>[]).length > 0
            ? String((item.alerts as Record<string, unknown>[])[0].severity || "medium")
            : "medium",
          created_at: Array.isArray(item.alerts) && (item.alerts as Record<string, unknown>[]).length > 0
            ? String((item.alerts as Record<string, unknown>[])[0].created_at || new Date().toISOString())
            : new Date().toISOString(),
          confidence: 0.75,
        } as CrossSiteCorrelation));
      })
      .catch(() => [] as CrossSiteCorrelation[]);

    Promise.all([overviewPromise, correlationsPromise])
      .then(([ov, corr]) => {
        setOverview(ov);
        setCorrelations(corr);
      })
      .catch((e) => setErrorOverview(e.message))
      .finally(() => setLoadingOverview(false));
  }, []);

  const refreshAll = useCallback(() => {
    fetchHierarchy();
    fetchOverview();
  }, [fetchHierarchy, fetchOverview]);

  /* ---- Initial load + auto-refresh every 30s ---- */
  useEffect(() => {
    refreshAll();

    refreshIntervalRef.current = setInterval(refreshAll, 30000);
    return () => {
      if (refreshIntervalRef.current) clearInterval(refreshIntervalRef.current);
    };
  }, [refreshAll]);

  /* ---- Handlers ---- */
  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelectNode = useCallback((node: HierarchyNode) => {
    setSelectedNode(node);
    if (node.type === "site") {
      setViewMode("site-detail");
    } else {
      setViewMode("overview");
    }
  }, []);

  const handleToggleCompare = useCallback((id: string) => {
    setCompareIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleStartComparison = useCallback(() => {
    if (compareIds.size >= 2) {
      setViewMode("comparison");
    }
  }, [compareIds.size]);

  const handleClearComparison = useCallback(() => {
    setCompareIds(new Set());
    setViewMode("overview");
  }, []);

  const handleBackToOverview = useCallback(() => {
    setSelectedNode(null);
    setViewMode("overview");
  }, []);

  /* ---- Expand / collapse all ---- */
  const collectAllIds = useCallback(
    (nodes: HierarchyNode[]): string[] => {
      const ids: string[] = [];
      const traverse = (ns: HierarchyNode[]) => {
        for (const n of ns) {
          ids.push(n.id);
          if (n.children) traverse(n.children);
        }
      };
      traverse(nodes);
      return ids;
    },
    []
  );

  const expandAll = useCallback(() => {
    setExpandedIds(new Set(collectAllIds(hierarchy)));
  }, [hierarchy, collectAllIds]);

  const collapseAll = useCallback(() => {
    setExpandedIds(new Set());
  }, []);

  /* ---- Derived values ---- */
  const selectedSiteId = useMemo(() => {
    if (!selectedNode) return null;
    if (selectedNode.type === "site") return selectedNode.site_id || selectedNode.id;
    return null;
  }, [selectedNode]);

  const compareIdArray = useMemo(() => Array.from(compareIds), [compareIds]);

  const siteCount = useMemo(() => {
    let count = 0;
    const traverse = (nodes: HierarchyNode[]) => {
      for (const n of nodes) {
        if (n.type === "site") count++;
        if (n.children) traverse(n.children);
      }
    };
    traverse(hierarchy);
    return count;
  }, [hierarchy]);

  /* ---- Render ---- */
  return (
    <div className="flex h-[calc(100vh-64px)] bg-[#030712] text-gray-100 overflow-hidden">
      {/* =============== LEFT SIDEBAR =============== */}
      <aside
        className={cn(
          "flex flex-col border-r border-gray-800 bg-zinc-900/40 transition-all duration-300 shrink-0",
          sidebarCollapsed ? "w-12" : "w-80"
        )}
      >
        {/* Sidebar header */}
        <div className="flex items-center justify-between px-3 py-3 border-b border-gray-800">
          {!sidebarCollapsed && (
            <div className="flex items-center gap-2 min-w-0">
              <Network className="h-4 w-4 text-cyan-400 shrink-0" />
              <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider truncate">
                Site Hierarchy
              </span>
              <span className="text-[10px] bg-gray-800 text-gray-400 rounded px-1.5 py-0.5 font-mono shrink-0">
                {siteCount}
              </span>
            </div>
          )}
          <button
            onClick={() => setSidebarCollapsed((p) => !p)}
            className="p-1 rounded hover:bg-gray-800 transition-colors shrink-0"
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? (
              <ChevronRight className="h-4 w-4 text-gray-500" />
            ) : (
              <ChevronDown className="h-4 w-4 text-gray-500 rotate-90" />
            )}
          </button>
        </div>

        {!sidebarCollapsed && (
          <>
            {/* Search */}
            <div className="px-3 py-2 border-b border-gray-800">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-600" />
                <input
                  type="text"
                  placeholder="Search sites..."
                  value={treeSearch}
                  onChange={(e) => setTreeSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-gray-800/60 border border-gray-700 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-cyan-500/40 focus:border-cyan-500/40"
                />
                {treeSearch && (
                  <button
                    onClick={() => setTreeSearch("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2"
                  >
                    <X className="h-3 w-3 text-gray-600 hover:text-gray-400" />
                  </button>
                )}
              </div>
            </div>

            {/* Toolbar */}
            <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-800">
              <button
                onClick={expandAll}
                className="text-[10px] text-gray-500 hover:text-gray-300 px-1.5 py-0.5 rounded hover:bg-gray-800 transition-colors"
              >
                Expand All
              </button>
              <span className="text-gray-800">|</span>
              <button
                onClick={collapseAll}
                className="text-[10px] text-gray-500 hover:text-gray-300 px-1.5 py-0.5 rounded hover:bg-gray-800 transition-colors"
              >
                Collapse All
              </button>
              <div className="flex-1" />
              {compareIds.size > 0 && (
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-cyan-400 font-mono">
                    {compareIds.size} selected
                  </span>
                  <button
                    onClick={handleStartComparison}
                    disabled={compareIds.size < 2}
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded transition-colors",
                      compareIds.size >= 2
                        ? "bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 border border-cyan-500/30"
                        : "bg-gray-800 text-gray-600 cursor-not-allowed"
                    )}
                  >
                    Compare
                  </button>
                  <button
                    onClick={handleClearComparison}
                    className="text-[10px] text-gray-600 hover:text-gray-400 px-1 py-0.5 rounded hover:bg-gray-800 transition-colors"
                    title="Clear selection"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>

            {/* Tree content */}
            <div className="flex-1 overflow-y-auto py-1 custom-scrollbar">
              {loadingHierarchy ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-5 w-5 text-cyan-400 animate-spin" />
                  <span className="ml-2 text-xs text-gray-500">Loading hierarchy...</span>
                </div>
              ) : errorHierarchy ? (
                <div className="flex flex-col items-center justify-center py-12 gap-2 px-4">
                  <AlertTriangle className="h-6 w-6 text-red-400" />
                  <p className="text-xs text-red-400 text-center">{errorHierarchy}</p>
                  <button
                    onClick={fetchHierarchy}
                    className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
                  >
                    <RefreshCw className="h-3 w-3" /> Retry
                  </button>
                </div>
              ) : hierarchy.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 gap-2 px-4">
                  <Building2 className="h-8 w-8 text-gray-700" />
                  <p className="text-xs text-gray-500 text-center">
                    No sites configured
                  </p>
                </div>
              ) : (
                hierarchy.map((node) => (
                  <TreeNode
                    key={node.id}
                    node={node}
                    depth={0}
                    expandedIds={expandedIds}
                    toggleExpand={toggleExpand}
                    selectedId={selectedNode?.id || null}
                    onSelect={handleSelectNode}
                    searchQuery={treeSearch}
                    compareIds={compareIds}
                    onToggleCompare={handleToggleCompare}
                  />
                ))
              )}
            </div>
          </>
        )}
      </aside>

      {/* =============== MAIN CONTENT =============== */}
      <main className="flex-1 overflow-y-auto">
        {/* Top bar */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-3 border-b border-gray-800 bg-[#030712]/95 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <Shield className="h-5 w-5 text-cyan-400" />
            <h1 className="text-base font-semibold text-gray-100">
              Multi-Site Command Center
            </h1>
            <div className="flex items-center gap-1 ml-2">
              <button
                onClick={handleBackToOverview}
                className={cn(
                  "text-[11px] px-2.5 py-1 rounded-md transition-colors font-medium",
                  viewMode === "overview"
                    ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30"
                    : "text-gray-500 hover:text-gray-300 hover:bg-gray-800"
                )}
              >
                Overview
              </button>
              {selectedSiteId && (
                <button
                  onClick={() => setViewMode("site-detail")}
                  className={cn(
                    "text-[11px] px-2.5 py-1 rounded-md transition-colors font-medium",
                    viewMode === "site-detail"
                      ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30"
                      : "text-gray-500 hover:text-gray-300 hover:bg-gray-800"
                  )}
                >
                  Site Detail
                </button>
              )}
              {compareIds.size >= 2 && (
                <button
                  onClick={() => setViewMode("comparison")}
                  className={cn(
                    "text-[11px] px-2.5 py-1 rounded-md transition-colors font-medium flex items-center gap-1",
                    viewMode === "comparison"
                      ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30"
                      : "text-gray-500 hover:text-gray-300 hover:bg-gray-800"
                  )}
                >
                  <GitCompareArrows className="h-3 w-3" />
                  Compare ({compareIds.size})
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={refreshAll}
              className="flex items-center gap-1.5 text-[11px] text-gray-400 hover:text-gray-200 px-2.5 py-1.5 rounded-md hover:bg-gray-800 transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
        </div>

        {/* Content area */}
        <div className="p-6">
          {viewMode === "overview" && (
            <GlobalOverviewPanel
              overview={overview}
              correlations={correlations}
              loading={loadingOverview}
              error={errorOverview}
              onRefresh={fetchOverview}
            />
          )}

          {viewMode === "site-detail" && selectedSiteId && (
            <SiteDetailPanel
              key={selectedSiteId}
              siteId={selectedSiteId}
              onClose={handleBackToOverview}
            />
          )}

          {viewMode === "site-detail" && !selectedSiteId && (
            <div className="flex flex-col items-center justify-center h-64 gap-3">
              <Building2 className="h-10 w-10 text-gray-700" />
              <p className="text-sm text-gray-500">
                Select a site from the hierarchy to view details
              </p>
            </div>
          )}

          {viewMode === "comparison" && (
            <ComparisonPanel
              key={compareIdArray.join(",")}
              siteIds={compareIdArray}
              onClose={handleClearComparison}
            />
          )}
        </div>
      </main>
    </div>
  );
}
