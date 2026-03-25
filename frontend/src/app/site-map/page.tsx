"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import {
  Map as MapIcon,
  Layers,
  Navigation,
  Shield,
  Plus,
  RefreshCw,
  AlertTriangle,
  Crosshair,
  ChevronLeft,
  ChevronRight,
  Camera,
  Activity,
  Users,
  Thermometer,
  Eye,
  Footprints,
  Lock,
  Download,
  X,
  Clock,
  Building2,
  Wifi,
  WifiOff,
  ZapOff,
  TrendingUp,
} from "lucide-react";
import { cn, apiFetch, severityColor } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import { exportJSON } from "@/lib/export";
import type { Alert, Camera as CameraType, Zone, Severity } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Dynamically import FacilityMap (Leaflet needs browser APIs)        */
/* ------------------------------------------------------------------ */

const FacilityMap = dynamic(
  () => import("@/components/map/FacilityMap"),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full bg-slate-900 text-slate-500">
        <div className="animate-pulse text-sm">Initializing map engine...</div>
      </div>
    ),
  }
);

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface GISStatus {
  facility_center: { lat: number; lng: number };
  geofences: number;
  tracked_assets: number;
  online_assets: number;
  floor_plans: number;
  active_violations: number;
}

interface PostureScore {
  score: number;
  threat_level: "normal" | "elevated" | "high" | "critical";
  label: string;
}

interface FloorPlan {
  id: string;
  name: string;
  floor: number;
  building: string;
  device_count?: number;
  cameras?: unknown[];
  sensors?: unknown[];
  doors?: unknown[];
}

interface TrackAssetForm {
  name: string;
  type: string;
  lat: string;
  lng: string;
}

interface MapLayers {
  heatmap: boolean;
  cameraFov: boolean;
  violations: boolean;
  assetTrails: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const SEVERITY_BADGE: Record<Severity, string> = {
  critical: "bg-red-900/60 border-red-700 text-red-300",
  high: "bg-orange-900/60 border-orange-700 text-orange-300",
  medium: "bg-yellow-900/60 border-yellow-700 text-yellow-300",
  low: "bg-blue-900/60 border-blue-700 text-blue-300",
  info: "bg-gray-800/60 border-gray-700 text-gray-400",
};

const THREAT_COLORS: Record<string, { bar: string; text: string; label: string }> = {
  critical: { bar: "bg-red-500", text: "text-red-400", label: "CRITICAL" },
  high: { bar: "bg-orange-500", text: "text-orange-400", label: "HIGH" },
  elevated: { bar: "bg-yellow-500", text: "text-yellow-400", label: "ELEVATED" },
  normal: { bar: "bg-green-500", text: "text-green-400", label: "NORMAL" },
};

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function SiteMapPage() {
  const { addToast } = useToast();

  // ── Core data state ───────────────────────────────────────────────
  const [gisStatus, setGisStatus] = useState<GISStatus | null>(null);
  const [cameras, setCameras] = useState<CameraType[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [postureScore, setPostureScore] = useState<PostureScore | null>(null);
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [selectedFloorPlan, setSelectedFloorPlan] = useState<string>("");
  const [incidentsByZone, setIncidentsByZone] = useState<Record<string, number>>({});

  // ── UI state ──────────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activePanel, setActivePanel] = useState<"stats" | "incidents" | "actions">("stats");
  const [highlightedZone, setHighlightedZone] = useState<string | null>(null);

  // ── Map layer toggles ────────────────────────────────────────────
  const [layers, setLayers] = useState<MapLayers>({
    heatmap: false,
    cameraFov: false,
    violations: true,
    assetTrails: false,
  });

  // ── Draw / Quick-action modals ────────────────────────────────────
  const [drawMode, setDrawMode] = useState(false);
  const [showTrackForm, setShowTrackForm] = useState(false);
  const [trackForm, setTrackForm] = useState<TrackAssetForm>({ name: "", type: "patrol_officer", lat: "", lng: "" });
  const [trackLoading, setTrackLoading] = useState(false);
  const [showLockdownConfirm, setShowLockdownConfirm] = useState(false);
  const [lockdownLoading, setLockdownLoading] = useState(false);

  // ── Ref for map export ────────────────────────────────────────────
  const mapDataRef = useRef<Record<string, unknown>>({});

  /* ── Fetch helpers ─────────────────────────────────────────────── */

  const fetchGISStatus = useCallback(async () => {
    try {
      const data = await apiFetch<GISStatus>("/api/gis/status");
      if (data) setGisStatus(data);
    } catch {
      // silent
    }
  }, []);

  const fetchCameras = useCallback(async () => {
    try {
      const data = await apiFetch<CameraType[]>("/api/cameras");
      if (Array.isArray(data)) setCameras(data);
    } catch {
      // silent
    }
  }, []);

  const fetchAlerts = useCallback(async () => {
    try {
      const data = await apiFetch<Alert[]>("/api/alerts?status=new&limit=100");
      if (Array.isArray(data)) {
        setAlerts(data);
        const counts: Record<string, number> = {};
        data.forEach((a) => {
          const zone = a.zone_name || "Unknown";
          counts[zone] = (counts[zone] || 0) + 1;
        });
        setIncidentsByZone(counts);
      }
    } catch {
      // silent
    }
  }, []);

  const fetchZones = useCallback(async () => {
    try {
      const data = await apiFetch<Zone[]>("/api/zones");
      if (Array.isArray(data)) setZones(data);
    } catch {
      // silent
    }
  }, []);

  const fetchPosture = useCallback(async () => {
    try {
      const data = await apiFetch<PostureScore>("/api/intelligence/posture-score");
      if (data) setPostureScore(data);
    } catch {
      // gracefully handle 404 — feature may not be enabled
    }
  }, []);

  const fetchFloorPlans = useCallback(async () => {
    try {
      const data = await apiFetch<FloorPlan[]>("/api/gis/floor-plans");
      if (Array.isArray(data)) {
        const enriched = data.map((fp) => ({
          ...fp,
          device_count:
            (fp.cameras?.length ?? 0) +
            (fp.sensors?.length ?? 0) +
            (fp.doors?.length ?? 0),
        }));
        setFloorPlans(enriched);
      }
    } catch {
      // silent
    }
  }, []);

  const refreshAll = useCallback(() => {
    fetchGISStatus();
    fetchCameras();
    fetchAlerts();
    fetchZones();
    fetchPosture();
    fetchFloorPlans();
  }, [fetchGISStatus, fetchCameras, fetchAlerts, fetchZones, fetchPosture, fetchFloorPlans]);

  useEffect(() => {
    refreshAll();
    const interval = setInterval(refreshAll, 15000);
    return () => clearInterval(interval);
  }, [refreshAll]);

  // Keep map export data in sync
  useEffect(() => {
    mapDataRef.current = {
      gis_status: gisStatus,
      cameras: cameras,
      alerts: alerts,
      zones: zones,
      floor_plans: floorPlans,
      posture: postureScore,
      exported_at: new Date().toISOString(),
    };
  }, [gisStatus, cameras, alerts, zones, floorPlans, postureScore]);

  /* ── Derived stats ─────────────────────────────────────────────── */

  const cameraOnline = cameras.filter((c) => c.status === "online").length;
  const cameraOffline = cameras.filter((c) => c.status === "offline").length;
  const totalOccupancy = zones.reduce((sum, z) => sum + (z.current_occupancy || 0), 0);
  const criticalAlerts = alerts.filter((a) => a.severity === "critical").length;
  const highAlerts = alerts.filter((a) => a.severity === "high").length;
  const medAlerts = alerts.filter((a) => a.severity === "medium").length;
  const recentAlerts = alerts.slice(0, 10);

  /* ── Quick action handlers ─────────────────────────────────────── */

  async function handleTrackAsset() {
    if (!trackForm.name.trim() || !trackForm.lat || !trackForm.lng) {
      addToast("error", "Please fill in all asset fields.");
      return;
    }
    setTrackLoading(true);
    try {
      await apiFetch("/api/gis/assets", {
        method: "POST",
        body: JSON.stringify({
          name: trackForm.name.trim(),
          type: trackForm.type,
          position: { lat: parseFloat(trackForm.lat), lng: parseFloat(trackForm.lng) },
        }),
      });
      addToast("success", `Asset "${trackForm.name}" registered successfully.`);
      setShowTrackForm(false);
      setTrackForm({ name: "", type: "patrol_officer", lat: "", lng: "" });
      fetchGISStatus();
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "Failed to register asset.");
    } finally {
      setTrackLoading(false);
    }
  }

  async function handleLockdown() {
    setLockdownLoading(true);
    try {
      await apiFetch("/api/emergency/activate", {
        method: "POST",
        body: JSON.stringify({ code: "Lockdown" }),
      });
      addToast("success", "Emergency lockdown protocol activated.");
      setShowLockdownConfirm(false);
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "Lockdown activation failed.");
    } finally {
      setLockdownLoading(false);
    }
  }

  function handleExportMap() {
    exportJSON(mapDataRef.current, `site-map-export-${new Date().toISOString().slice(0, 10)}.json`);
    addToast("success", "Map data exported as JSON.");
  }

  function toggleLayer(key: keyof MapLayers) {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function handleIncidentClick(alert: Alert) {
    if (alert.zone_name) {
      setHighlightedZone(alert.zone_name);
      addToast("info", `Highlighting zone: ${alert.zone_name}`);
    }
  }

  /* ── Threat level bar ──────────────────────────────────────────── */

  const threatLevel = postureScore?.threat_level || "normal";
  const threatStyle = THREAT_COLORS[threatLevel] || THREAT_COLORS.normal;
  const threatScore = postureScore?.score ?? 0;

  /* ─────────────────────────────────────────────────────────────── */
  /*  Render                                                         */
  /* ─────────────────────────────────────────────────────────────── */

  return (
    <div className="flex h-screen bg-[#030712] overflow-hidden">

      {/* ══════════════════ SIDEBAR ══════════════════ */}
      <aside
        className={cn(
          "shrink-0 flex flex-col bg-gray-950/90 border-r border-gray-800/60 transition-all duration-300 overflow-hidden",
          sidebarOpen ? "w-80" : "w-0"
        )}
      >
        {sidebarOpen && (
          <>
            {/* ── Header ── */}
            <div className="p-4 border-b border-gray-800/60 shrink-0">
              <div className="flex items-center gap-2 mb-1">
                <MapIcon className="h-5 w-5 text-cyan-400 shrink-0" />
                <h1 className="text-base font-bold text-gray-100 truncate">GIS Command Map</h1>
              </div>
              <p className="text-[11px] text-gray-500 leading-relaxed">
                Real-time facility map with geofencing, asset tracking, and spatial analytics.
              </p>
            </div>

            {/* ── Threat Level Banner ── */}
            {postureScore && (
              <div className="px-3 py-2 border-b border-gray-800/40 shrink-0">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <TrendingUp className={cn("h-3 w-3", threatStyle.text)} />
                    <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                      Threat Level
                    </span>
                  </div>
                  <span className={cn("text-[10px] font-bold tracking-widest", threatStyle.text)}>
                    {threatStyle.label}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden">
                  <div
                    className={cn("h-full rounded-full transition-all duration-700", threatStyle.bar)}
                    style={{ width: `${Math.min(threatScore, 100)}%` }}
                  />
                </div>
                <div className="mt-1 text-right text-[10px] text-gray-600">
                  Score: {threatScore.toFixed(0)}/100
                </div>
              </div>
            )}

            {/* ── Sub-nav tabs ── */}
            <div className="flex border-b border-gray-800/60 shrink-0">
              {(["stats", "incidents", "actions"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActivePanel(tab)}
                  className={cn(
                    "flex-1 py-2 text-[11px] font-medium capitalize transition-colors",
                    activePanel === tab
                      ? "text-cyan-400 border-b-2 border-cyan-400 bg-cyan-500/5"
                      : "text-gray-600 hover:text-gray-400"
                  )}
                >
                  {tab === "stats" ? "Stats" : tab === "incidents" ? "Incidents" : "Actions"}
                </button>
              ))}
            </div>

            {/* ══ STATS PANEL ══ */}
            {activePanel === "stats" && (
              <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">

                {/* Camera counts */}
                <div className="p-3 border-b border-gray-800/40">
                  <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <Camera className="h-3 w-3" />
                    Cameras
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      { label: "Online", value: cameraOnline, icon: Wifi, color: "text-green-400", bg: "bg-green-900/20 border-green-800/40" },
                      { label: "Offline", value: cameraOffline, icon: WifiOff, color: "text-red-400", bg: "bg-red-900/20 border-red-800/40" },
                      { label: "Total", value: cameras.length, icon: Camera, color: "text-cyan-400", bg: "bg-cyan-900/20 border-cyan-800/40" },
                    ].map(({ label, value, icon: Icon, color, bg }) => (
                      <div key={label} className={cn("rounded-lg border p-2 text-center", bg)}>
                        <Icon className={cn("h-3 w-3 mx-auto mb-1", color)} />
                        <div className={cn("text-sm font-bold", color)}>{value}</div>
                        <div className="text-[9px] text-gray-600">{label}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Alert severity breakdown */}
                <div className="p-3 border-b border-gray-800/40">
                  <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <AlertTriangle className="h-3 w-3 text-red-400" />
                    Active Alerts
                    <span className="ml-auto rounded-full bg-red-900/40 border border-red-800/50 px-1.5 py-0.5 text-[9px] font-bold text-red-400">
                      {alerts.length}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {[
                      { label: "Critical", count: criticalAlerts, color: "bg-red-500" },
                      { label: "High", count: highAlerts, color: "bg-orange-500" },
                      { label: "Medium", count: medAlerts, color: "bg-yellow-500" },
                      { label: "Low / Info", count: alerts.length - criticalAlerts - highAlerts - medAlerts, color: "bg-blue-500" },
                    ].map(({ label, count, color }) => (
                      <div key={label} className="flex items-center gap-2 text-[11px]">
                        <span className={cn("w-2 h-2 rounded-full shrink-0", color)} />
                        <span className="text-gray-500 flex-1">{label}</span>
                        <span className="text-gray-300 font-semibold tabular-nums">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Zone occupancy */}
                <div className="p-3 border-b border-gray-800/40">
                  <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <Users className="h-3 w-3 text-purple-400" />
                    Zone Occupancy
                    <span className="ml-auto text-[10px] text-gray-400 font-semibold">
                      {totalOccupancy} total
                    </span>
                  </div>
                  {zones.length > 0 ? (
                    <div className="space-y-1.5 max-h-40 overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
                      {zones
                        .filter((z) => z.is_active)
                        .sort((a, b) => b.current_occupancy - a.current_occupancy)
                        .slice(0, 8)
                        .map((zone) => {
                          const maxOcc = zone.max_occupancy || 50;
                          const pct = Math.min((zone.current_occupancy / maxOcc) * 100, 100);
                          const overCapacity = zone.max_occupancy && zone.current_occupancy > zone.max_occupancy;
                          return (
                            <div key={zone.id} className="text-[11px]">
                              <div className="flex justify-between mb-0.5">
                                <span className="text-gray-400 truncate max-w-[160px]">{zone.name}</span>
                                <span className={cn("font-semibold tabular-nums", overCapacity ? "text-red-400" : "text-gray-300")}>
                                  {zone.current_occupancy}
                                  {zone.max_occupancy && <span className="text-gray-600">/{zone.max_occupancy}</span>}
                                </span>
                              </div>
                              <div className="h-1 rounded-full bg-gray-800 overflow-hidden">
                                <div
                                  className={cn("h-full rounded-full transition-all", overCapacity ? "bg-red-500" : pct > 80 ? "bg-orange-500" : "bg-cyan-600")}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  ) : (
                    <p className="text-[11px] text-gray-600">No zone data available.</p>
                  )}
                </div>

                {/* GIS Status grid */}
                <div className="p-3 border-b border-gray-800/40">
                  <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
                    GIS Status
                  </div>
                  {gisStatus ? (
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { label: "Geofences", value: gisStatus.geofences, icon: Shield, color: "text-red-400" },
                        { label: "Assets", value: `${gisStatus.online_assets}/${gisStatus.tracked_assets}`, icon: Navigation, color: "text-blue-400" },
                        { label: "Floor Plans", value: gisStatus.floor_plans, icon: Layers, color: "text-purple-400" },
                        { label: "Violations", value: gisStatus.active_violations, icon: ZapOff, color: gisStatus.active_violations > 0 ? "text-red-400" : "text-green-400" },
                      ].map(({ label, value, icon: Icon, color }) => (
                        <div key={label} className="rounded-lg border border-gray-800/60 bg-gray-900/50 p-2">
                          <div className="flex items-center gap-1.5 mb-1">
                            <Icon className={cn("h-3 w-3", color)} />
                            <span className="text-[10px] text-gray-500">{label}</span>
                          </div>
                          <div className="text-sm font-bold text-gray-200">{value}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-600 animate-pulse">Loading status...</div>
                  )}
                </div>

                {/* Facility center coords */}
                {gisStatus && (
                  <div className="p-3">
                    <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
                      Facility Center
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      <Crosshair className="h-3 w-3 text-cyan-500 shrink-0" />
                      <span className="font-mono">
                        {gisStatus.facility_center.lat.toFixed(5)},{" "}
                        {gisStatus.facility_center.lng.toFixed(5)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ══ INCIDENTS PANEL ══ */}
            {activePanel === "incidents" && (
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="px-3 py-2 border-b border-gray-800/40 shrink-0">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                      <Activity className="h-3 w-3 text-red-400" />
                      Live Incidents
                    </span>
                    <span className="text-[9px] text-gray-600 flex items-center gap-1">
                      <RefreshCw className="h-2.5 w-2.5" />
                      Auto-refresh 15s
                    </span>
                  </div>
                </div>

                {/* Zone incident counts */}
                {Object.keys(incidentsByZone).length > 0 && (
                  <div className="px-3 py-2 border-b border-gray-800/40 shrink-0">
                    <div className="text-[10px] text-gray-600 mb-1.5">By Zone</div>
                    <div className="space-y-1 max-h-24 overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
                      {Object.entries(incidentsByZone)
                        .sort(([, a], [, b]) => b - a)
                        .map(([zone, count]) => (
                          <div key={zone} className="flex items-center justify-between text-[11px]">
                            <span className="text-gray-400 truncate max-w-[170px]">{zone}</span>
                            <span className={cn(
                              "rounded-full px-2 py-0.5 text-[9px] font-bold border",
                              count >= 5 ? "bg-red-900/40 border-red-800/50 text-red-400"
                                : count >= 2 ? "bg-amber-900/40 border-amber-800/50 text-amber-400"
                                : "bg-yellow-900/40 border-yellow-800/50 text-yellow-400"
                            )}>
                              {count}
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}

                {/* Alert cards */}
                <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800 p-2 space-y-1.5">
                  {recentAlerts.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-32 text-center">
                      <Shield className="h-8 w-8 text-green-500/30 mb-2" />
                      <p className="text-xs text-gray-600">No active incidents</p>
                    </div>
                  ) : (
                    recentAlerts.map((alert) => (
                      <button
                        key={alert.id}
                        onClick={() => handleIncidentClick(alert)}
                        className="w-full text-left rounded-lg border border-gray-800/60 bg-gray-900/50 hover:bg-gray-800/50 hover:border-gray-700/60 p-2.5 transition-colors group"
                      >
                        <div className="flex items-start gap-2">
                          <span className={cn(
                            "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase border",
                            SEVERITY_BADGE[alert.severity] || SEVERITY_BADGE.info
                          )}>
                            {alert.severity.slice(0, 4)}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-[11px] text-gray-300 font-medium leading-tight truncate group-hover:text-gray-100">
                              {alert.title}
                            </p>
                            <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-600">
                              {alert.zone_name && (
                                <span className="flex items-center gap-0.5 truncate max-w-[100px]">
                                  <Building2 className="h-2.5 w-2.5 shrink-0" />
                                  {alert.zone_name}
                                </span>
                              )}
                              <span className="flex items-center gap-0.5 shrink-0">
                                <Clock className="h-2.5 w-2.5" />
                                {timeAgo(alert.created_at)}
                              </span>
                            </div>
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* ══ ACTIONS PANEL ══ */}
            {activePanel === "actions" && (
              <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">

                {/* Map Layer Controls */}
                <div className="p-3 border-b border-gray-800/40">
                  <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2.5 flex items-center gap-1.5">
                    <Layers className="h-3 w-3 text-cyan-400" />
                    Map Layers
                  </div>
                  <div className="space-y-1.5">
                    {([
                      { key: "heatmap" as const, label: "Heatmap", icon: Thermometer, color: "text-orange-400" },
                      { key: "cameraFov" as const, label: "Camera FOV", icon: Eye, color: "text-cyan-400" },
                      { key: "violations" as const, label: "Violations", icon: AlertTriangle, color: "text-red-400" },
                      { key: "assetTrails" as const, label: "Asset Trails", icon: Footprints, color: "text-blue-400" },
                    ]).map(({ key, label, icon: Icon, color }) => (
                      <button
                        key={key}
                        onClick={() => toggleLayer(key)}
                        className="w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-gray-800/40"
                      >
                        <div className={cn(
                          "w-8 h-4 rounded-full border transition-all flex items-center px-0.5",
                          layers[key] ? "bg-cyan-600/30 border-cyan-600" : "bg-gray-800 border-gray-700"
                        )}>
                          <div className={cn(
                            "w-3 h-3 rounded-full transition-all",
                            layers[key] ? "bg-cyan-400 translate-x-4" : "bg-gray-600 translate-x-0"
                          )} />
                        </div>
                        <Icon className={cn("h-3.5 w-3.5 shrink-0", layers[key] ? color : "text-gray-600")} />
                        <span className={cn("text-[11px] font-medium", layers[key] ? "text-gray-200" : "text-gray-500")}>
                          {label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Floor Plan Selector */}
                {floorPlans.length > 0 && (
                  <div className="p-3 border-b border-gray-800/40">
                    <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <Building2 className="h-3 w-3 text-purple-400" />
                      Floor Plan Overlay
                    </div>
                    <select
                      value={selectedFloorPlan}
                      onChange={(e) => setSelectedFloorPlan(e.target.value)}
                      className="w-full bg-gray-900 border border-gray-700 rounded-md px-2.5 py-2 text-[11px] text-gray-300 focus:outline-none focus:border-cyan-600"
                    >
                      <option value="">None (all floors)</option>
                      {floorPlans.map((fp) => (
                        <option key={fp.id} value={fp.id}>
                          {fp.name} — Floor {fp.floor}
                          {fp.device_count !== undefined && ` (${fp.device_count} devices)`}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Quick Actions */}
                <div className="p-3">
                  <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2.5">
                    Quick Actions
                  </div>
                  <div className="space-y-1.5">

                    {/* Add Geofence */}
                    <button
                      onClick={() => {
                        setDrawMode((v) => !v);
                        addToast("info", drawMode ? "Draw mode off." : "Draw mode on — click the map to begin drawing.");
                      }}
                      className={cn(
                        "w-full flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-[11px] transition-colors border",
                        drawMode
                          ? "bg-cyan-900/30 border-cyan-700/50 text-cyan-300"
                          : "border-transparent text-gray-400 hover:bg-gray-800/50 hover:text-gray-200 hover:border-gray-700/40"
                      )}
                    >
                      <Plus className={cn("h-3.5 w-3.5 shrink-0", drawMode ? "text-cyan-400" : "text-cyan-500")} />
                      <div>
                        <div className="font-medium">{drawMode ? "Drawing Mode Active" : "Add Geofence"}</div>
                        <div className="text-[10px] text-gray-600">
                          {drawMode ? "Click map to place vertices" : "Define restricted area"}
                        </div>
                      </div>
                    </button>

                    {/* Track Asset */}
                    <button
                      onClick={() => setShowTrackForm((v) => !v)}
                      className="w-full flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-[11px] text-gray-400 hover:bg-gray-800/50 hover:text-gray-200 transition-colors border border-transparent hover:border-gray-700/40"
                    >
                      <Navigation className="h-3.5 w-3.5 text-cyan-500 shrink-0" />
                      <div>
                        <div className="font-medium">Track Asset</div>
                        <div className="text-[10px] text-gray-600">Register new asset</div>
                      </div>
                    </button>

                    {/* Track asset form */}
                    {showTrackForm && (
                      <div className="rounded-lg border border-gray-700/50 bg-gray-900/60 p-3 space-y-2">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] font-semibold text-gray-400">New Asset</span>
                          <button onClick={() => setShowTrackForm(false)} className="text-gray-600 hover:text-gray-400">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        {[
                          { key: "name" as const, label: "Name", placeholder: "e.g. Guard-01" },
                          { key: "lat" as const, label: "Latitude", placeholder: "e.g. 40.7128" },
                          { key: "lng" as const, label: "Longitude", placeholder: "e.g. -74.0060" },
                        ].map(({ key, label, placeholder }) => (
                          <div key={key}>
                            <label className="text-[10px] text-gray-600">{label}</label>
                            <input
                              value={trackForm[key]}
                              onChange={(e) => setTrackForm((f) => ({ ...f, [key]: e.target.value }))}
                              placeholder={placeholder}
                              className="w-full mt-0.5 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-cyan-600"
                            />
                          </div>
                        ))}
                        <div>
                          <label className="text-[10px] text-gray-600">Type</label>
                          <select
                            value={trackForm.type}
                            onChange={(e) => setTrackForm((f) => ({ ...f, type: e.target.value }))}
                            className="w-full mt-0.5 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 focus:outline-none focus:border-cyan-600"
                          >
                            {["patrol_officer", "vehicle", "drone", "equipment"].map((t) => (
                              <option key={t} value={t}>{t.replace("_", " ")}</option>
                            ))}
                          </select>
                        </div>
                        <button
                          onClick={handleTrackAsset}
                          disabled={trackLoading}
                          className="w-full rounded-md bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 py-1.5 text-[11px] font-medium text-white transition-colors"
                        >
                          {trackLoading ? "Registering..." : "Register Asset"}
                        </button>
                      </div>
                    )}

                    {/* Emergency Lockdown */}
                    <button
                      onClick={() => setShowLockdownConfirm(true)}
                      className="w-full flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-[11px] text-red-400 hover:bg-red-900/20 transition-colors border border-transparent hover:border-red-800/40"
                    >
                      <Lock className="h-3.5 w-3.5 text-red-500 shrink-0" />
                      <div>
                        <div className="font-medium">Emergency Lockdown</div>
                        <div className="text-[10px] text-red-600">Activate lockdown protocol</div>
                      </div>
                    </button>

                    {/* Export Map Data */}
                    <button
                      onClick={handleExportMap}
                      className="w-full flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-[11px] text-gray-400 hover:bg-gray-800/50 hover:text-gray-200 transition-colors border border-transparent hover:border-gray-700/40"
                    >
                      <Download className="h-3.5 w-3.5 text-cyan-500 shrink-0" />
                      <div>
                        <div className="font-medium">Export Map Data</div>
                        <div className="text-[10px] text-gray-600">Download as JSON</div>
                      </div>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── Sidebar footer ── */}
            <div className="border-t border-gray-800/40 p-3 shrink-0">
              <button
                onClick={refreshAll}
                className="flex items-center gap-1.5 text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
              >
                <RefreshCw className="h-3 w-3" />
                Refresh All
              </button>
            </div>
          </>
        )}
      </aside>

      {/* ══════════════════ MAP AREA ══════════════════ */}
      <div className="flex-1 relative min-w-0">

        {/* Sidebar toggle button */}
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          className="absolute top-4 left-4 z-[1001] bg-slate-800/90 backdrop-blur-sm rounded-md p-2 text-slate-400 hover:text-white border border-slate-700 transition-colors"
          title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
        >
          {sidebarOpen
            ? <ChevronLeft className="h-4 w-4" />
            : <ChevronRight className="h-4 w-4" />
          }
        </button>

        {/* Draw mode badge */}
        {drawMode && (
          <div className="absolute top-4 left-16 z-[1001] flex items-center gap-2 bg-cyan-900/90 backdrop-blur-sm border border-cyan-700 rounded-md px-3 py-1.5">
            <span className="animate-pulse h-2 w-2 rounded-full bg-cyan-400 shrink-0" />
            <span className="text-[11px] text-cyan-300 font-medium">Draw Mode Active</span>
            <button
              onClick={() => setDrawMode(false)}
              className="text-cyan-500 hover:text-cyan-300 ml-1"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Highlighted zone badge */}
        {highlightedZone && (
          <div className="absolute top-14 left-4 z-[1001] flex items-center gap-2 bg-slate-800/90 backdrop-blur-sm border border-slate-600 rounded-md px-3 py-1.5">
            <Building2 className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
            <span className="text-[11px] text-gray-300">Highlighting: <span className="text-cyan-300 font-medium">{highlightedZone}</span></span>
            <button onClick={() => setHighlightedZone(null)} className="text-gray-600 hover:text-gray-400 ml-1">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        <FacilityMap
          drawMode={drawMode}
          heatmap={layers.heatmap}
          cameraFov={layers.cameraFov}
          violations={layers.violations}
          assetTrails={layers.assetTrails}
        />
      </div>

      {/* ══════════════════ LOCKDOWN CONFIRMATION MODAL ══════════════════ */}
      {showLockdownConfirm && (
        <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-xl border border-red-800/60 bg-gray-950 shadow-2xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="rounded-full bg-red-900/40 border border-red-700/50 p-2">
                <Lock className="h-5 w-5 text-red-400" />
              </div>
              <div>
                <h2 className="text-base font-bold text-red-300">Emergency Lockdown</h2>
                <p className="text-[11px] text-gray-500">This action cannot be easily undone.</p>
              </div>
            </div>
            <p className="text-sm text-gray-400 mb-6">
              Activating Emergency Lockdown will seal all access points and alert all security personnel.
              Are you sure you want to proceed?
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowLockdownConfirm(false)}
                disabled={lockdownLoading}
                className="flex-1 rounded-lg border border-gray-700 bg-gray-900 py-2.5 text-sm text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleLockdown}
                disabled={lockdownLoading}
                className="flex-1 rounded-lg bg-red-700 hover:bg-red-600 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {lockdownLoading
                  ? <><RefreshCw className="h-4 w-4 animate-spin" /> Activating...</>
                  : <><Lock className="h-4 w-4" /> Confirm Lockdown</>
                }
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
