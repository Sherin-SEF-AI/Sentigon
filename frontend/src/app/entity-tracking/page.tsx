"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Eye,
  Users,
  AlertTriangle,
  Crosshair,
  ShieldAlert,
  Clock,
  Camera,
  MapPin,
  Loader2,
  RefreshCw,
  X,
  ChevronDown,
  ChevronRight,
  Activity,
  Flame,
  PersonStanding,
  TrendingUp,
  Zap,
  Volume2,
  Footprints,
  ShieldBan,
  Route,
  Timer,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface EntityStats {
  active_entities: number;
  anomalous_entities: number;
  weapon_events_24h: number;
  safety_events_24h: number;
}

interface TrackedEntity {
  entity_id: string;
  appearance: {
    colors: string[];
    build: string;
    carried_items: string[];
    clothing: string;
  };
  cameras_visited: number;
  zones_entered: string[];
  risk_score: number;
  escalation_level: "none" | "watch" | "alert" | "critical";
  first_seen: string;
  last_seen: string;
  track_ids: string[];
  camera_history: { camera_name: string; timestamp: string }[];
}

interface AnomalousEntity {
  entity_id: string;
  appearance_desc: string;
  behavioral_flags: string[];
  risk_score: number;
  cameras_visited: number;
  dwell_time_minutes: number;
  first_seen: string;
  last_seen: string;
}

interface WeaponEvent {
  id: string;
  camera_name: string;
  zone: string;
  threat_posture: "detected" | "holding" | "brandishing" | "aiming";
  object_class: string;
  pre_indicators: string[];
  acoustic_correlation: boolean;
  confidence: number;
  timestamp: string;
  track_id: string;
}

interface SafetyEvent {
  id: string;
  event_type: "person_down" | "mass_egress" | "fire" | "slip_fall";
  camera_name: string;
  zone: string;
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  person_count: number;
  timestamp: string;
  resolved: boolean;
}

interface SlipFallHotspot {
  zone: string;
  incident_count: number;
  last_incident: string;
  avg_severity: string;
  contributing_factors: string[];
}

interface ZoneInfo {
  id: string;
  name: string;
  zone_type: string; // "restricted" | "secure" | "public" | "monitored" etc.
}

/* Behavior classification */
type BehaviorLabel = "Loitering" | "Fleeing" | "Patrolling" | "Normal";

interface BehaviorClassification {
  label: BehaviorLabel;
  cn: string;
}

/* Group movement detection: entities seen at same camera within 30s */

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TABS = ["Active Entities", "Anomalous", "Weapons", "Safety"] as const;
type Tab = (typeof TABS)[number];

const ESCALATION_BADGE: Record<string, string> = {
  none: "text-gray-400 bg-gray-500/10 border-gray-500/30",
  watch: "text-yellow-400 bg-yellow-500/10 border-yellow-500/30",
  alert: "text-orange-400 bg-orange-500/10 border-orange-500/30",
  critical: "text-red-400 bg-red-500/10 border-red-500/30",
};

const POSTURE_BADGE: Record<string, string> = {
  detected: "text-yellow-400 bg-yellow-500/10 border-yellow-500/30",
  holding: "text-orange-400 bg-orange-500/10 border-orange-500/30",
  brandishing: "text-red-400 bg-red-500/10 border-red-500/30",
  aiming: "text-red-500 bg-red-600/20 border-red-600/40",
};

const SAFETY_TYPE_LABELS: Record<string, string> = {
  person_down: "Person Down",
  mass_egress: "Mass Egress",
  fire: "Fire Detected",
  slip_fall: "Slip / Fall",
};

const SAFETY_TYPE_ICONS: Record<string, React.ReactNode> = {
  person_down: <PersonStanding className="h-4 w-4" />,
  mass_egress: <Users className="h-4 w-4" />,
  fire: <Flame className="h-4 w-4" />,
  slip_fall: <Footprints className="h-4 w-4" />,
};

const SEVERITY_BADGE: Record<string, string> = {
  critical: "text-red-500 bg-red-500/10 border-red-500/50",
  high: "text-orange-500 bg-orange-500/10 border-orange-500/50",
  medium: "text-yellow-500 bg-yellow-500/10 border-yellow-500/50",
  low: "text-blue-400 bg-blue-400/10 border-blue-400/50",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function riskColor(score: number): string {
  if (score >= 0.8) return "text-red-400";
  if (score >= 0.5) return "text-yellow-400";
  return "text-green-400";
}

function riskBadgeCn(score: number): string {
  if (score >= 0.8) return "text-red-400 bg-red-900/30";
  if (score >= 0.5) return "text-yellow-400 bg-yellow-900/30";
  return "text-green-400 bg-green-900/30";
}

/* ---- Behavior classification ---- */
const BEHAVIOR_BADGE_CN: Record<BehaviorLabel, string> = {
  Loitering: "text-amber-400 bg-amber-500/10 border-amber-500/40",
  Fleeing: "text-red-400 bg-red-500/10 border-red-500/40",
  Patrolling: "text-green-400 bg-green-500/10 border-green-500/40",
  Normal: "text-gray-400 bg-gray-500/10 border-gray-500/30",
};

const BEHAVIOR_ICONS: Record<BehaviorLabel, React.ReactNode> = {
  Loitering: <Timer className="h-2.5 w-2.5" />,
  Fleeing: <Zap className="h-2.5 w-2.5" />,
  Patrolling: <Route className="h-2.5 w-2.5" />,
  Normal: <Activity className="h-2.5 w-2.5" />,
};

/**
 * Classify an entity's behavior from available entity data.
 *
 * Rules (applied in priority order):
 *  1. risk_score >= 0.8 AND cameras_visited > 3  → Fleeing (high-speed escape heuristic)
 *  2. dwell implied by first_seen/last_seen > 120 min with ≤ 2 cameras  → Loitering
 *  3. zones_entered >= 3 AND cameras_visited >= 3  → Patrolling
 *  4. Default → Normal
 */
function classifyBehavior(entity: TrackedEntity): BehaviorClassification {
  const dwellMinutes =
    (new Date(entity.last_seen).getTime() - new Date(entity.first_seen).getTime()) / 60000;

  if (entity.risk_score >= 0.8 && entity.cameras_visited > 3) {
    return { label: "Fleeing", cn: BEHAVIOR_BADGE_CN["Fleeing"] };
  }
  if (dwellMinutes > 120 && entity.cameras_visited <= 2) {
    return { label: "Loitering", cn: BEHAVIOR_BADGE_CN["Loitering"] };
  }
  if (entity.zones_entered.length >= 3 && entity.cameras_visited >= 3) {
    return { label: "Patrolling", cn: BEHAVIOR_BADGE_CN["Patrolling"] };
  }
  return { label: "Normal", cn: BEHAVIOR_BADGE_CN["Normal"] };
}

/** Check whether an entity's zones overlap with restricted/secure zones */
function isInRestrictedZone(entity: TrackedEntity, restrictedZoneNames: Set<string>): boolean {
  return entity.zones_entered.some((z) => restrictedZoneNames.has(z.toLowerCase()));
}

/**
 * Detect group movement: entities sharing the same camera within a 30-second window.
 * Returns a map from entity_id → group size (or undefined if ungrouped).
 */
function detectMovementGroups(entities: TrackedEntity[]): Map<string, number> {
  const groupSizes = new Map<string, number>();

  // Build a flat list of (camera, timestamp, entity_id) from camera_history
  const sightings: { camera: string; ts: number; entityId: string }[] = [];
  for (const entity of entities) {
    for (const ch of entity.camera_history) {
      sightings.push({
        camera: ch.camera_name,
        ts: new Date(ch.timestamp).getTime(),
        entityId: entity.entity_id,
      });
    }
  }

  // For each sighting, find other entities at the same camera within ±30s
  const entityGroupCount = new Map<string, Set<string>>(); // entityId → set of co-present entity IDs
  for (const s of sightings) {
    for (const other of sightings) {
      if (other.entityId === s.entityId) continue;
      if (other.camera !== s.camera) continue;
      if (Math.abs(other.ts - s.ts) <= 30_000) {
        if (!entityGroupCount.has(s.entityId)) {
          entityGroupCount.set(s.entityId, new Set());
        }
        entityGroupCount.get(s.entityId)!.add(other.entityId);
      }
    }
  }

  for (const [entityId, peers] of entityGroupCount) {
    // +1 for the entity itself
    groupSizes.set(entityId, peers.size + 1);
  }
  return groupSizes;
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function EntityTrackingPage() {
  const { addToast } = useToast();

  const [activeTab, setActiveTab] = useState<Tab>("Active Entities");
  const [stats, setStats] = useState<EntityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Active entities
  const [entities, setEntities] = useState<TrackedEntity[]>([]);
  const [entitiesLoading, setEntitiesLoading] = useState(false);
  const [expandedEntity, setExpandedEntity] = useState<string | null>(null);

  // Zones (for geofencing restricted-zone detection)
  const [zones, setZones] = useState<ZoneInfo[]>([]);

  // Anomalous
  const [anomalous, setAnomalous] = useState<AnomalousEntity[]>([]);
  const [anomalousLoading, setAnomalousLoading] = useState(false);

  // Weapons
  const [weaponEvents, setWeaponEvents] = useState<WeaponEvent[]>([]);
  const [weaponsLoading, setWeaponsLoading] = useState(false);

  // Safety
  const [safetyEvents, setSafetyEvents] = useState<SafetyEvent[]>([]);
  const [hotspots, setHotspots] = useState<SlipFallHotspot[]>([]);
  const [safetyLoading, setSafetyLoading] = useState(false);

  /* ---- Derived: restricted zone name set ---- */
  const restrictedZoneNames = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    for (const z of zones) {
      if (z.zone_type === "restricted" || z.zone_type === "secure") {
        s.add(z.name.toLowerCase());
      }
    }
    return s;
  }, [zones]);

  /* ---- Derived: group sizes per entity ---- */
  const movementGroupSizes = useMemo<Map<string, number>>(
    () => detectMovementGroups(entities),
    [entities]
  );

  /* ---- Initial load ---- */
  const fetchAll = useCallback(async () => {
    try {
      const [entData, statsData, zonesData] = await Promise.all([
        apiFetch<TrackedEntity[]>("/api/entity-tracking/active"),
        apiFetch<EntityStats>("/api/entity-tracking/stats"),
        apiFetch<ZoneInfo[]>("/api/zones").catch(() => [] as ZoneInfo[]),
      ]);
      setEntities(entData);
      setZones(zonesData);
      setStats({
        anomalous_entities: statsData.flagged_entities ?? 0,
        weapon_events_24h: 0,
        safety_events_24h: 0,
        ...statsData,
      });
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load entity data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  /* ---- Tab data fetchers ---- */
  const fetchEntities = async () => {
    setEntitiesLoading(true);
    try {
      const [data, zonesData] = await Promise.all([
        apiFetch<TrackedEntity[]>("/api/entity-tracking/active"),
        apiFetch<ZoneInfo[]>("/api/zones").catch(() => [] as ZoneInfo[]),
      ]);
      setEntities(data);
      setZones(zonesData);
    } catch {
    } finally {
      setEntitiesLoading(false);
    }
  };

  const fetchAnomalous = async () => {
    setAnomalousLoading(true);
    try {
      const data = await apiFetch<AnomalousEntity[]>("/api/entity-tracking/anomalous");
      setAnomalous(data);
    } catch {
      setAnomalous([]);
    } finally {
      setAnomalousLoading(false);
    }
  };

  const fetchWeapons = async () => {
    setWeaponsLoading(true);
    try {
      const data = await apiFetch<WeaponEvent[]>("/api/weapon-detection/events");
      setWeaponEvents(data);
    } catch {
      setWeaponEvents([]);
    } finally {
      setWeaponsLoading(false);
    }
  };

  const fetchSafety = async () => {
    setSafetyLoading(true);
    try {
      const [events, spots] = await Promise.all([
        apiFetch<SafetyEvent[]>("/api/safety/events"),
        apiFetch<SlipFallHotspot[]>("/api/safety/slip-fall-hotspots"),
      ]);
      setSafetyEvents(events);
      setHotspots(spots);
    } catch {
      setSafetyEvents([]);
      setHotspots([]);
    } finally {
      setSafetyLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "Anomalous") fetchAnomalous();
    if (activeTab === "Weapons") fetchWeapons();
    if (activeTab === "Safety") fetchSafety();
  }, [activeTab]);

  /* ---- Loading ---- */
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[#030712]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-10 w-10 animate-spin text-cyan-400" />
          <p className="text-sm text-gray-500">Loading entity intelligence...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#030712]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-900/30 border border-emerald-800/50">
            <Eye className="h-5 w-5 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Entity Intelligence
            </h1>
            <p className="text-xs text-gray-500">
              Advanced entity tracking, weapon detection, and safety monitoring
            </p>
          </div>
        </div>
        <button
          onClick={() => { setLoading(true); fetchAll(); }}
          className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-6 mt-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto"><X className="h-3 w-3" /></button>
        </div>
      )}

      {/* Stat Cards */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 border-b border-gray-800 px-6 py-3">
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 p-3">
            <Users className="h-5 w-5 text-cyan-400" />
            <div>
              <p className="text-lg font-bold text-gray-100">{stats.active_entities}</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">Active Entities</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-orange-900/50 bg-orange-950/20 p-3">
            <AlertTriangle className="h-5 w-5 text-orange-400" />
            <div>
              <p className="text-lg font-bold text-orange-400">{stats.anomalous_entities}</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">Anomalous Entities</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-red-900/50 bg-red-950/20 p-3">
            <Crosshair className="h-5 w-5 text-red-400" />
            <div>
              <p className="text-lg font-bold text-red-400">{stats.weapon_events_24h}</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">Weapon Events (24h)</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-yellow-900/50 bg-yellow-950/20 p-3">
            <ShieldAlert className="h-5 w-5 text-yellow-400" />
            <div>
              <p className="text-lg font-bold text-yellow-400">{stats.safety_events_24h}</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">Safety Events (24h)</p>
            </div>
          </div>
        </div>
      )}

      {/* Tab navigation */}
      <div className="flex items-center gap-1 border-b border-gray-800 px-6">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-4 py-2.5 text-xs font-medium border-b-2 transition-colors",
              activeTab === tab
                ? "border-cyan-400 text-cyan-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {/* ============ ACTIVE ENTITIES TAB ============ */}
        {activeTab === "Active Entities" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                <Users className="h-4 w-4 text-cyan-400" />
                Tracked Entities ({entities.length})
              </h2>
              <button
                onClick={fetchEntities}
                disabled={entitiesLoading}
                className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 transition-colors disabled:opacity-50"
              >
                {entitiesLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              </button>
            </div>

            {entities.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <Eye className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">No active entities being tracked</p>
              </div>
            ) : (
              <div className="space-y-2">
                {entities.map((entity) => {
                  const isExpanded = expandedEntity === entity.entity_id;
                  const behavior = classifyBehavior(entity);
                  const inRestricted = isInRestrictedZone(entity, restrictedZoneNames);
                  const groupSize = movementGroupSizes.get(entity.entity_id);
                  return (
                    <div key={entity.entity_id} className="rounded-xl border border-gray-800 bg-zinc-900/30 overflow-hidden">
                      <button
                        onClick={() => setExpandedEntity(isExpanded ? null : entity.entity_id)}
                        className="flex items-center justify-between w-full px-4 py-3 hover:bg-gray-800/30 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-gray-500" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-500" />}
                          <div className="text-left">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-medium text-gray-200">{entity.appearance.clothing || "Unknown appearance"}</span>
                              <span className={cn(
                                "rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase",
                                ESCALATION_BADGE[entity.escalation_level]
                              )}>
                                {entity.escalation_level}
                              </span>

                              {/* Feature 1: Behavior classification badge */}
                              <span className={cn(
                                "flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase",
                                behavior.cn
                              )}>
                                {BEHAVIOR_ICONS[behavior.label]}
                                {behavior.label}
                              </span>

                              {/* Feature 2: Restricted zone warning icon */}
                              {inRestricted && (
                                <span
                                  title="Entity in restricted/secure zone"
                                  className="flex items-center gap-1 rounded-md border border-red-500/50 bg-red-500/10 px-1.5 py-0.5 text-[9px] font-bold text-red-400"
                                >
                                  <ShieldBan className="h-2.5 w-2.5" />
                                  Restricted Zone
                                </span>
                              )}

                              {/* Feature 3: Group movement badge */}
                              {groupSize && groupSize > 1 && (
                                <span
                                  title="Group movement detected — multiple entities on same camera within 30s"
                                  className="flex items-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5 text-[9px] font-bold text-cyan-400"
                                >
                                  <Users className="h-2.5 w-2.5" />
                                  Group: {groupSize}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 mt-0.5">
                              {entity.appearance.colors.length > 0 && (
                                <div className="flex items-center gap-1">
                                  {entity.appearance.colors.slice(0, 4).map((c, i) => (
                                    <span key={i} className="rounded bg-gray-800/60 px-1.5 py-0.5 text-[9px] text-gray-500">{c}</span>
                                  ))}
                                </div>
                              )}
                              {entity.appearance.build && (
                                <span className="text-[9px] text-gray-600">{entity.appearance.build} build</span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="text-right">
                            <span className="text-[10px] text-gray-600 flex items-center gap-1">
                              <Camera className="h-2.5 w-2.5" /> {entity.cameras_visited} cameras
                            </span>
                            <span className="text-[10px] text-gray-600 flex items-center gap-1">
                              <MapPin className="h-2.5 w-2.5" /> {entity.zones_entered.length} zones
                            </span>
                          </div>
                          <span className={cn(
                            "rounded px-2 py-1 text-xs font-bold font-mono",
                            riskBadgeCn(entity.risk_score)
                          )}>
                            {(entity.risk_score * 100).toFixed(0)}
                          </span>
                        </div>
                      </button>

                      {/* Expanded details */}
                      {isExpanded && (
                        <div className="border-t border-gray-800/40 px-4 py-3 space-y-3">
                          <div className="grid grid-cols-2 gap-4">
                            {/* Appearance details */}
                            <div className="rounded-lg border border-gray-800 bg-zinc-900/50 p-3">
                              <h4 className="text-[10px] text-gray-500 uppercase tracking-wider font-bold mb-2">Appearance</h4>
                              <div className="space-y-1">
                                <p className="text-[11px] text-gray-400">
                                  <span className="text-gray-600">Clothing:</span> {entity.appearance.clothing || "N/A"}
                                </p>
                                <p className="text-[11px] text-gray-400">
                                  <span className="text-gray-600">Build:</span> {entity.appearance.build || "N/A"}
                                </p>
                                <p className="text-[11px] text-gray-400">
                                  <span className="text-gray-600">Colors:</span> {entity.appearance.colors.join(", ") || "N/A"}
                                </p>
                                <p className="text-[11px] text-gray-400">
                                  <span className="text-gray-600">Items:</span> {entity.appearance.carried_items.join(", ") || "None"}
                                </p>
                              </div>
                            </div>

                            {/* Zones visited */}
                            <div className="rounded-lg border border-gray-800 bg-zinc-900/50 p-3">
                              <h4 className="text-[10px] text-gray-500 uppercase tracking-wider font-bold mb-2">Zones Entered</h4>
                              <div className="flex flex-wrap gap-1">
                                {entity.zones_entered.map((z, i) => (
                                  <span key={i} className="rounded-md bg-cyan-500/10 border border-cyan-500/30 px-1.5 py-0.5 text-[9px] text-cyan-400">
                                    {z}
                                  </span>
                                ))}
                              </div>
                            </div>
                          </div>

                          {/* Camera history timeline */}
                          <div className="rounded-lg border border-gray-800 bg-zinc-900/50 p-3">
                            <h4 className="text-[10px] text-gray-500 uppercase tracking-wider font-bold mb-2">Camera History</h4>
                            <div className="space-y-1.5 max-h-[200px] overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
                              {entity.camera_history.map((ch, i) => (
                                <div key={i} className="flex items-center gap-3 border-l-2 border-gray-700 pl-3">
                                  <span className="text-[9px] text-gray-600 font-mono w-16 shrink-0">
                                    {new Date(ch.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
                                  </span>
                                  <span className="flex items-center gap-1 text-[10px] text-gray-400">
                                    <Camera className="h-2.5 w-2.5 text-gray-500" /> {ch.camera_name}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="flex items-center gap-4 text-[10px] text-gray-600">
                            <span>First seen: {timeAgo(entity.first_seen)}</span>
                            <span>Last seen: {timeAgo(entity.last_seen)}</span>
                            <span>Track IDs: {entity.track_ids.join(", ")}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ============ ANOMALOUS TAB ============ */}
        {activeTab === "Anomalous" && (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-orange-400" />
              Anomalous Entities
            </h2>

            {anomalousLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
              </div>
            ) : anomalous.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <Activity className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">No anomalous entities detected</p>
              </div>
            ) : (
              <div className="space-y-2">
                {anomalous.map((ent) => (
                  <div key={ent.entity_id} className={cn(
                    "rounded-xl border p-4 transition-colors",
                    ent.risk_score >= 0.8 ? "border-red-800/60 bg-red-950/20" :
                    ent.risk_score >= 0.5 ? "border-orange-800/50 bg-orange-950/10" :
                    "border-yellow-800/40 bg-yellow-950/10"
                  )}>
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-gray-200">{ent.appearance_desc}</p>
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {ent.behavioral_flags.map((flag, i) => (
                            <span key={i} className="rounded-md bg-orange-500/10 border border-orange-500/30 px-2 py-0.5 text-[10px] text-orange-400 font-medium">
                              {flag}
                            </span>
                          ))}
                        </div>
                        <div className="flex items-center gap-4 mt-2 text-[10px] text-gray-500">
                          <span className="flex items-center gap-1">
                            <Camera className="h-2.5 w-2.5" /> {ent.cameras_visited} cameras
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-2.5 w-2.5" /> {ent.dwell_time_minutes}m dwell
                          </span>
                          <span>First: {timeAgo(ent.first_seen)}</span>
                          <span>Last: {timeAgo(ent.last_seen)}</span>
                        </div>
                      </div>
                      <span className={cn(
                        "rounded px-2 py-1 text-sm font-bold font-mono shrink-0 ml-3",
                        riskBadgeCn(ent.risk_score)
                      )}>
                        {(ent.risk_score * 100).toFixed(0)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ============ WEAPONS TAB ============ */}
        {activeTab === "Weapons" && (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
              <Crosshair className="h-4 w-4 text-red-400" />
              Weapon Detection Events
            </h2>

            {weaponsLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
              </div>
            ) : weaponEvents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <Crosshair className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">No weapon events detected</p>
              </div>
            ) : (
              <div className="space-y-2">
                {weaponEvents.map((evt) => (
                  <div key={evt.id} className={cn(
                    "rounded-xl border p-4",
                    evt.threat_posture === "aiming" || evt.threat_posture === "brandishing"
                      ? "border-red-800/60 bg-red-950/20"
                      : evt.threat_posture === "holding"
                      ? "border-orange-800/50 bg-orange-950/10"
                      : "border-yellow-800/40 bg-yellow-950/10"
                  )}>
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <Crosshair className={cn(
                            "h-4 w-4",
                            evt.threat_posture === "aiming" ? "text-red-500" :
                            evt.threat_posture === "brandishing" ? "text-red-400" :
                            evt.threat_posture === "holding" ? "text-orange-400" : "text-yellow-400"
                          )} />
                          <span className="text-xs font-semibold text-gray-200">{evt.object_class}</span>
                          <span className={cn(
                            "rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase",
                            POSTURE_BADGE[evt.threat_posture]
                          )}>
                            {evt.threat_posture}
                          </span>
                          {evt.acoustic_correlation && (
                            <span className="flex items-center gap-1 rounded-md border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 text-[9px] text-purple-400">
                              <Volume2 className="h-2.5 w-2.5" /> Acoustic
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-[10px] text-gray-500 mt-1">
                          <span className="flex items-center gap-1">
                            <Camera className="h-2.5 w-2.5" /> {evt.camera_name}
                          </span>
                          <span className="flex items-center gap-1">
                            <MapPin className="h-2.5 w-2.5" /> {evt.zone}
                          </span>
                          <span className="font-mono">Conf: {(evt.confidence * 100).toFixed(0)}%</span>
                          <span className="font-mono">Track: {evt.track_id}</span>
                          <span>{timeAgo(evt.timestamp)}</span>
                        </div>
                        {evt.pre_indicators.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            <span className="text-[9px] text-gray-600 mr-1">Pre-indicators:</span>
                            {evt.pre_indicators.map((p, i) => (
                              <span key={i} className="rounded bg-gray-800/60 px-1.5 py-0.5 text-[9px] text-gray-500">{p}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ============ SAFETY TAB ============ */}
        {activeTab === "Safety" && (
          <div className="space-y-6">
            <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-yellow-400" />
              Safety Events
            </h2>

            {safetyLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
              </div>
            ) : (
              <>
                {/* Safety events list */}
                {safetyEvents.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-gray-600">
                    <ShieldAlert className="h-10 w-10 mb-3 opacity-30" />
                    <p className="text-sm">No safety events detected</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {safetyEvents.map((evt) => (
                      <div key={evt.id} className={cn(
                        "flex items-start gap-3 rounded-lg border p-3",
                        evt.resolved ? "border-gray-800/50 bg-gray-900/30 opacity-60" :
                        evt.severity === "critical" ? "border-red-800/60 bg-red-950/20" :
                        evt.severity === "high" ? "border-orange-800/50 bg-orange-950/10" :
                        "border-gray-800 bg-zinc-900/50"
                      )}>
                        <div className={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                          evt.event_type === "fire" ? "bg-red-900/30 text-red-400" :
                          evt.event_type === "person_down" ? "bg-orange-900/30 text-orange-400" :
                          evt.event_type === "mass_egress" ? "bg-yellow-900/30 text-yellow-400" :
                          "bg-blue-900/30 text-blue-400"
                        )}>
                          {SAFETY_TYPE_ICONS[evt.event_type] || <Activity className="h-4 w-4" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-gray-200">
                              {SAFETY_TYPE_LABELS[evt.event_type] || evt.event_type}
                            </span>
                            <span className={cn(
                              "rounded px-1.5 py-0.5 text-[9px] font-bold uppercase border",
                              SEVERITY_BADGE[evt.severity]
                            )}>
                              {evt.severity}
                            </span>
                            {evt.resolved && (
                              <span className="text-[9px] text-green-400">Resolved</span>
                            )}
                          </div>
                          <p className="mt-0.5 text-[11px] text-gray-400">{evt.description}</p>
                          <div className="mt-1 flex items-center gap-3 text-[10px] text-gray-500">
                            <span className="flex items-center gap-1">
                              <Camera className="h-2.5 w-2.5" /> {evt.camera_name}
                            </span>
                            <span className="flex items-center gap-1">
                              <MapPin className="h-2.5 w-2.5" /> {evt.zone}
                            </span>
                            {evt.person_count > 0 && (
                              <span className="flex items-center gap-1">
                                <Users className="h-2.5 w-2.5" /> {evt.person_count} persons
                              </span>
                            )}
                            <span className="flex items-center gap-1">
                              <Clock className="h-2.5 w-2.5" /> {timeAgo(evt.timestamp)}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Slip/Fall hotspots */}
                <div className="rounded-xl border border-gray-800 bg-zinc-900/30 p-4">
                  <h3 className="text-xs font-bold text-gray-300 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <Footprints className="h-3.5 w-3.5 text-yellow-400" />
                    Slip/Fall Hotspot Zones
                  </h3>
                  {hotspots.length === 0 ? (
                    <p className="text-xs text-gray-600 py-6 text-center">No hotspot data available</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="border-b border-gray-800 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                            <th className="pb-2 pr-4">Zone</th>
                            <th className="pb-2 pr-4">Incidents</th>
                            <th className="pb-2 pr-4">Last Incident</th>
                            <th className="pb-2 pr-4">Avg Severity</th>
                            <th className="pb-2">Contributing Factors</th>
                          </tr>
                        </thead>
                        <tbody>
                          {hotspots.map((spot) => (
                            <tr key={spot.zone} className="border-b border-gray-800/30">
                              <td className="py-2 pr-4">
                                <span className="flex items-center gap-1 text-xs text-gray-300">
                                  <MapPin className="h-3 w-3 text-gray-500" /> {spot.zone}
                                </span>
                              </td>
                              <td className="py-2 pr-4">
                                <span className={cn(
                                  "text-xs font-bold font-mono",
                                  spot.incident_count >= 10 ? "text-red-400" :
                                  spot.incident_count >= 5 ? "text-yellow-400" : "text-gray-300"
                                )}>
                                  {spot.incident_count}
                                </span>
                              </td>
                              <td className="py-2 pr-4 text-[11px] text-gray-500">{timeAgo(spot.last_incident)}</td>
                              <td className="py-2 pr-4">
                                <span className={cn(
                                  "rounded px-1.5 py-0.5 text-[9px] font-bold uppercase border",
                                  SEVERITY_BADGE[spot.avg_severity] || "text-gray-400 bg-gray-500/10 border-gray-500/30"
                                )}>
                                  {spot.avg_severity}
                                </span>
                              </td>
                              <td className="py-2">
                                <div className="flex flex-wrap gap-1">
                                  {spot.contributing_factors.map((f, i) => (
                                    <span key={i} className="rounded bg-gray-800/60 px-1.5 py-0.5 text-[9px] text-gray-500">{f}</span>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
