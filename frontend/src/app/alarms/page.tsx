"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Siren,
  Loader2,
  AlertTriangle,
  Shield,
  ShieldOff,
  ShieldCheck,
  ShieldAlert,
  Zap,
  Battery,
  BatteryLow,
  Plug,
  Clock,
  Radio,
  RefreshCw,
  ChevronDown,
  CheckCircle2,
  XCircle,
  Activity,
  Hash,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AlarmPanel {
  id: string;
  name: string;
  arm_state: "armed_away" | "armed_stay" | "armed_night" | "disarmed" | "arming" | "pending";
  zones_total: number;
  zones_faulted: number;
  power_source: "ac" | "battery" | "unknown";
  battery_level: number | null;
  last_heartbeat: string | null;
  sia_connected: boolean;
  firmware_version: string | null;
}

interface AlarmZone {
  id: string;
  panel_id: string;
  zone_number: number;
  name: string;
  zone_type: "entry_exit" | "perimeter" | "interior" | "fire" | "panic" | "medical" | "tamper" | "environmental";
  state: "normal" | "faulted" | "alarm" | "trouble" | "bypassed";
  alarm_count: number;
  last_triggered: string | null;
}

interface AlarmEvent {
  id: string;
  panel_id: string;
  zone_id: string | null;
  zone_name: string | null;
  event_type: string;
  event_code: string | null;
  description: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  timestamp: string;
  acknowledged: boolean;
}

interface SIAReceiverStatus {
  connected: boolean;
  account_count: number;
  last_event_time: string | null;
  events_today: number;
  uptime_seconds: number;
}

type TabKey = "panels" | "zones" | "events";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const ARM_STATE_STYLES: Record<string, { bg: string; text: string; border: string; icon: typeof Shield }> = {
  armed_away: { bg: "bg-red-900/30", text: "text-red-400", border: "border-red-800/50", icon: ShieldAlert },
  armed_stay: { bg: "bg-orange-900/30", text: "text-orange-400", border: "border-orange-800/50", icon: ShieldCheck },
  armed_night: { bg: "bg-purple-900/30", text: "text-purple-400", border: "border-purple-800/50", icon: ShieldCheck },
  disarmed: { bg: "bg-emerald-900/30", text: "text-emerald-400", border: "border-emerald-800/50", icon: ShieldOff },
  arming: { bg: "bg-yellow-900/30", text: "text-yellow-400", border: "border-yellow-800/50", icon: Shield },
  pending: { bg: "bg-yellow-900/30", text: "text-yellow-400", border: "border-yellow-800/50", icon: Shield },
};

const ZONE_STATE_STYLES: Record<string, string> = {
  normal: "bg-emerald-900/40 text-emerald-400 border-emerald-800",
  faulted: "bg-yellow-900/40 text-yellow-400 border-yellow-800",
  alarm: "bg-red-900/40 text-red-400 border-red-800",
  trouble: "bg-orange-900/40 text-orange-400 border-orange-800",
  bypassed: "bg-gray-800 text-gray-400 border-gray-700",
};

const ZONE_TYPE_ICONS: Record<string, typeof Shield> = {
  entry_exit: Shield,
  perimeter: ShieldAlert,
  interior: ShieldCheck,
  fire: Zap,
  panic: Siren,
  medical: Activity,
  tamper: ShieldOff,
  environmental: Activity,
};

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-red-900/40 text-red-400 border-red-800",
  high: "bg-orange-900/40 text-orange-400 border-orange-800",
  medium: "bg-yellow-900/40 text-yellow-400 border-yellow-800",
  low: "bg-blue-900/40 text-blue-400 border-blue-800",
  info: "bg-gray-800 text-gray-400 border-gray-700",
};

const TABS: { key: TabKey; label: string }[] = [
  { key: "panels", label: "Panels" },
  { key: "zones", label: "Zones" },
  { key: "events", label: "Event Log" },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function AlarmPanelPage() {
  const [panels, setPanels] = useState<AlarmPanel[]>([]);
  const [zones, setZones] = useState<AlarmZone[]>([]);
  const [events, setEvents] = useState<AlarmEvent[]>([]);
  const [siaStatus, setSiaStatus] = useState<SIAReceiverStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("panels");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [filterSeverity, setFilterSeverity] = useState("all");
  const [filterAcknowledged, setFilterAcknowledged] = useState("all");
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [panelsData, zonesData, eventsData, siaData] = await Promise.allSettled([
        apiFetch<AlarmPanel[]>("/api/alarm/panels"),
        apiFetch<AlarmZone[]>("/api/alarm/zones"),
        apiFetch<AlarmEvent[]>("/api/alarm/events?limit=100"),
        apiFetch<SIAReceiverStatus>("/api/alarm/sia/status"),
      ]);
      if (panelsData.status === "fulfilled") setPanels(panelsData.value);
      if (zonesData.status === "fulfilled") setZones(zonesData.value);
      if (eventsData.status === "fulfilled") setEvents(eventsData.value);
      if (siaData.status === "fulfilled") setSiaStatus(siaData.value);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load alarm data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleArmDisarm = async (panelId: string, action: "arm_away" | "arm_stay" | "arm_night" | "disarm") => {
    setActionLoading(panelId);
    try {
      await apiFetch(`/api/alarm/panels/${panelId}/arm`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      await fetchData();
    } catch {
      // silent
    } finally {
      setActionLoading(null);
    }
  };

  const handleAcknowledgeEvent = async (eventId: string) => {
    setActionLoading(eventId);
    try {
      await apiFetch(`/api/alarm/events/${eventId}/acknowledge`, {
        method: "POST",
      });
      setEvents((prev) =>
        prev.map((e) => (e.id === eventId ? { ...e, acknowledged: true } : e))
      );
    } catch {
      // silent
    } finally {
      setActionLoading(null);
    }
  };

  /* Stats */
  const totalZones = zones.length;
  const faultedZones = zones.filter((z) => z.state === "faulted" || z.state === "alarm").length;
  const totalAlarms = events.filter((e) => e.severity === "critical" || e.severity === "high").length;
  const unacknowledged = events.filter((e) => !e.acknowledged).length;

  /* Filtered events */
  const filteredEvents = events.filter((e) => {
    if (filterSeverity !== "all" && e.severity !== filterSeverity) return false;
    if (filterAcknowledged === "unacknowledged" && e.acknowledged) return false;
    if (filterAcknowledged === "acknowledged" && !e.acknowledged) return false;
    if (selectedPanelId && e.panel_id !== selectedPanelId) return false;
    return true;
  });

  /* Filtered zones */
  const filteredZones = selectedPanelId
    ? zones.filter((z) => z.panel_id === selectedPanelId)
    : zones;

  return (
    <div className="min-h-screen bg-gray-950 p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-900/30 border border-red-800/50">
            <Siren className="h-5 w-5 text-red-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-red-400 tracking-wide">
              Alarm Panel Management
            </h1>
            <p className="text-xs text-gray-500">
              Monitor panels, zones, arm states, and alarm events
            </p>
          </div>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {/* Stats Row */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            <Shield className="h-3.5 w-3.5" />
            Panels
          </div>
          <p className="mt-2 text-3xl font-bold text-gray-100">
            {loading ? "--" : panels.length}
          </p>
        </div>
        <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            <Hash className="h-3.5 w-3.5" />
            Zones
          </div>
          <p className="mt-2 text-3xl font-bold text-gray-100">
            {loading ? "--" : `${faultedZones}/${totalZones}`}
          </p>
          <p className="text-[10px] text-gray-600">faulted / total</p>
        </div>
        <div className="rounded-lg border border-red-900/40 bg-red-950/20 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-red-400/80">
            <AlertTriangle className="h-3.5 w-3.5" />
            Active Alarms
          </div>
          <p className={cn("mt-2 text-3xl font-bold", totalAlarms > 0 ? "text-red-400" : "text-gray-100")}>
            {loading ? "--" : totalAlarms}
          </p>
        </div>
        <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            <Clock className="h-3.5 w-3.5" />
            Unacknowledged
          </div>
          <p className={cn("mt-2 text-3xl font-bold", unacknowledged > 0 ? "text-yellow-400" : "text-gray-100")}>
            {loading ? "--" : unacknowledged}
          </p>
        </div>
      </div>

      {/* SIA Receiver Status */}
      {siaStatus && (
        <div className="mb-6 rounded-lg border border-gray-800 bg-gray-900/60 p-4">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Radio className={cn("h-4 w-4", siaStatus.connected ? "text-emerald-400" : "text-red-400")} />
              <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                SIA Receiver
              </span>
              <span className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-bold border",
                siaStatus.connected
                  ? "bg-emerald-900/40 text-emerald-400 border-emerald-800"
                  : "bg-red-900/40 text-red-400 border-red-800"
              )}>
                {siaStatus.connected ? "CONNECTED" : "DISCONNECTED"}
              </span>
            </div>
            <span className="text-xs text-gray-500">
              Accounts: <span className="text-gray-300">{siaStatus.account_count}</span>
            </span>
            <span className="text-xs text-gray-500">
              Events Today: <span className="text-gray-300">{siaStatus.events_today}</span>
            </span>
            {siaStatus.last_event_time && (
              <span className="text-xs text-gray-500">
                Last Event: <span className="text-gray-300">{formatTimestamp(siaStatus.last_event_time)}</span>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-4 flex gap-1 border-b border-gray-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px",
              tab === t.key
                ? "border-cyan-400 text-cyan-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          <p className="mt-3 text-sm text-gray-500">Loading alarm data...</p>
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="flex flex-col items-center justify-center py-20">
          <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={fetchData}
            className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Panels Tab ---- */}
      {!loading && !error && tab === "panels" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {panels.length === 0 ? (
            <div className="col-span-full flex flex-col items-center justify-center py-20">
              <Siren className="mb-2 h-10 w-10 text-gray-700" />
              <p className="text-sm text-gray-500">No alarm panels registered</p>
            </div>
          ) : (
            panels.map((panel) => {
              const armStyle = ARM_STATE_STYLES[panel.arm_state] || ARM_STATE_STYLES.disarmed;
              const ArmIcon = armStyle.icon;
              const isActioning = actionLoading === panel.id;
              return (
                <div
                  key={panel.id}
                  className={cn(
                    "rounded-lg border bg-gray-900/60 p-5 transition-colors",
                    armStyle.border
                  )}
                >
                  {/* Panel header */}
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <div className={cn("flex h-8 w-8 items-center justify-center rounded-lg border", armStyle.bg, armStyle.border)}>
                        <ArmIcon className={cn("h-4 w-4", armStyle.text)} />
                      </div>
                      <div>
                        <span className="text-sm font-semibold text-gray-200">{panel.name}</span>
                        <span className={cn("ml-2 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border", armStyle.bg, armStyle.text, armStyle.border)}>
                          {panel.arm_state.replace(/_/g, " ")}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Panel details */}
                  <div className="space-y-2 text-xs text-gray-500 mb-4">
                    <div className="flex justify-between">
                      <span>Zones</span>
                      <span className="text-gray-300">
                        {panel.zones_faulted > 0 && (
                          <span className="text-red-400 mr-1">{panel.zones_faulted} faulted /</span>
                        )}
                        {panel.zones_total} total
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="flex items-center gap-1">
                        {panel.power_source === "ac" ? <Plug className="h-3 w-3" /> : <Battery className="h-3 w-3" />}
                        Power
                      </span>
                      <span className="text-gray-300 capitalize">{panel.power_source}</span>
                    </div>
                    {panel.battery_level !== null && (
                      <div className="flex justify-between">
                        <span className="flex items-center gap-1">
                          {panel.battery_level < 20 ? <BatteryLow className="h-3 w-3 text-red-400" /> : <Battery className="h-3 w-3" />}
                          Battery
                        </span>
                        <span className={cn("font-mono", panel.battery_level < 20 ? "text-red-400" : "text-gray-300")}>
                          {panel.battery_level}%
                        </span>
                      </div>
                    )}
                    {panel.last_heartbeat && (
                      <div className="flex justify-between">
                        <span>Last Heartbeat</span>
                        <span className="text-gray-300">{formatTimestamp(panel.last_heartbeat)}</span>
                      </div>
                    )}
                    {panel.firmware_version && (
                      <div className="flex justify-between">
                        <span>Firmware</span>
                        <span className="font-mono text-gray-300">{panel.firmware_version}</span>
                      </div>
                    )}
                  </div>

                  {/* Arm/Disarm controls */}
                  <div className="flex flex-wrap gap-2 pt-3 border-t border-gray-800/60">
                    {panel.arm_state === "disarmed" ? (
                      <>
                        <button
                          onClick={() => handleArmDisarm(panel.id, "arm_away")}
                          disabled={isActioning}
                          className="flex items-center gap-1.5 rounded-lg bg-red-900/30 border border-red-800/50 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-900/50 transition-colors disabled:opacity-50"
                        >
                          {isActioning ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldAlert className="h-3 w-3" />}
                          Arm Away
                        </button>
                        <button
                          onClick={() => handleArmDisarm(panel.id, "arm_stay")}
                          disabled={isActioning}
                          className="flex items-center gap-1.5 rounded-lg bg-orange-900/30 border border-orange-800/50 px-3 py-1.5 text-xs font-semibold text-orange-400 hover:bg-orange-900/50 transition-colors disabled:opacity-50"
                        >
                          {isActioning ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
                          Arm Stay
                        </button>
                        <button
                          onClick={() => handleArmDisarm(panel.id, "arm_night")}
                          disabled={isActioning}
                          className="flex items-center gap-1.5 rounded-lg bg-purple-900/30 border border-purple-800/50 px-3 py-1.5 text-xs font-semibold text-purple-400 hover:bg-purple-900/50 transition-colors disabled:opacity-50"
                        >
                          {isActioning ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
                          Arm Night
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => handleArmDisarm(panel.id, "disarm")}
                        disabled={isActioning}
                        className="flex items-center gap-1.5 rounded-lg bg-emerald-900/30 border border-emerald-800/50 px-3 py-1.5 text-xs font-semibold text-emerald-400 hover:bg-emerald-900/50 transition-colors disabled:opacity-50"
                      >
                        {isActioning ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldOff className="h-3 w-3" />}
                        Disarm
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ---- Zones Tab ---- */}
      {!loading && !error && tab === "zones" && (
        <div>
          {/* Panel filter */}
          {panels.length > 1 && (
            <div className="mb-4 flex items-center gap-2">
              <span className="text-xs text-gray-500">Panel:</span>
              <select
                value={selectedPanelId || "all"}
                onChange={(e) => setSelectedPanelId(e.target.value === "all" ? null : e.target.value)}
                className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none"
              >
                <option value="all">All Panels</option>
                {panels.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filteredZones.length === 0 ? (
              <div className="col-span-full flex flex-col items-center justify-center py-20">
                <Shield className="mb-2 h-10 w-10 text-gray-700" />
                <p className="text-sm text-gray-500">No zones configured</p>
              </div>
            ) : (
              filteredZones.map((zone) => {
                const ZoneIcon = ZONE_TYPE_ICONS[zone.zone_type] || Shield;
                return (
                  <div
                    key={zone.id}
                    className={cn(
                      "rounded-lg border bg-gray-900/60 p-4 transition-colors",
                      zone.state === "alarm" && "border-l-2 border-l-red-500",
                      zone.state !== "alarm" && "border-gray-800"
                    )}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <ZoneIcon className="h-4 w-4 text-cyan-400" />
                        <span className="text-sm font-semibold text-gray-200">
                          {zone.name}
                        </span>
                      </div>
                      <span className={cn(
                        "rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                        ZONE_STATE_STYLES[zone.state] || "bg-gray-800 text-gray-400 border-gray-700"
                      )}>
                        {zone.state}
                      </span>
                    </div>
                    <div className="space-y-1 text-xs text-gray-500">
                      <div className="flex justify-between">
                        <span>Zone #</span>
                        <span className="font-mono text-gray-300">{zone.zone_number}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Type</span>
                        <span className="text-gray-300 capitalize">{zone.zone_type.replace(/_/g, " ")}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Alarm Count</span>
                        <span className={cn("font-mono", zone.alarm_count > 0 ? "text-red-400" : "text-gray-300")}>
                          {zone.alarm_count}
                        </span>
                      </div>
                      {zone.last_triggered && (
                        <div className="flex justify-between">
                          <span>Last Triggered</span>
                          <span className="text-gray-300">{formatTimestamp(zone.last_triggered)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* ---- Events Tab ---- */}
      {!loading && !error && tab === "events" && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <select
                value={filterSeverity}
                onChange={(e) => setFilterSeverity(e.target.value)}
                className="appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none"
              >
                <option value="all">All Severities</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
                <option value="info">Info</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
            </div>
            <div className="relative">
              <select
                value={filterAcknowledged}
                onChange={(e) => setFilterAcknowledged(e.target.value)}
                className="appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none"
              >
                <option value="all">All Events</option>
                <option value="unacknowledged">Unacknowledged</option>
                <option value="acknowledged">Acknowledged</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
            </div>
            <span className="text-xs text-gray-500">
              Showing {filteredEvents.length} event{filteredEvents.length !== 1 && "s"}
            </span>
          </div>

          {/* Events table */}
          <div className="overflow-x-auto rounded-lg border border-gray-800 max-h-[60vh] overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-gray-800 bg-gray-900/80">
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Severity</th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Type</th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Zone</th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Description</th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Code</th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Time</th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {filteredEvents.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-sm text-gray-600">
                      No alarm events found
                    </td>
                  </tr>
                )}
                {filteredEvents.map((ev) => (
                  <tr key={ev.id} className="hover:bg-gray-900/60 transition-colors">
                    <td className="px-4 py-3">
                      <span className={cn(
                        "inline-flex rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                        SEVERITY_STYLES[ev.severity] || SEVERITY_STYLES.info
                      )}>
                        {ev.severity}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-300">{ev.event_type}</td>
                    <td className="px-4 py-3 text-xs text-gray-300">{ev.zone_name || "---"}</td>
                    <td className="px-4 py-3 text-xs text-gray-400 max-w-xs truncate">{ev.description}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{ev.event_code || "---"}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{formatTimestamp(ev.timestamp)}</td>
                    <td className="px-4 py-3">
                      {ev.acknowledged ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-400">
                          <CheckCircle2 className="h-3 w-3" />
                          ACK
                        </span>
                      ) : (
                        <button
                          onClick={() => handleAcknowledgeEvent(ev.id)}
                          disabled={actionLoading === ev.id}
                          className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-yellow-400 bg-yellow-900/20 border border-yellow-800/50 hover:bg-yellow-900/40 transition-colors disabled:opacity-50"
                        >
                          {actionLoading === ev.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                          ACK
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
