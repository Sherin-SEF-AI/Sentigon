"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Crown,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Shield,
  Camera,
  Clock,
  Plus,
  X,
  UserPlus,
  Radar,
  Crosshair,
  Bell,
  UserCheck,
  UserCog,
  CheckCircle2,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp, threatLevelColor } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import type { VIPProfile, Alert } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ProximityEvent {
  id: string;
  vip_id: string;
  threat_type: string;
  distance_meters: number;
  camera_id: string | null;
  severity: string;
  timestamp: string;
}

interface EscortInfo {
  escort_name: string | null;
  assigned_at: string | null;
}

/* Per-VIP escort state stored in component memory */
const _escortMap = new Map<string, EscortInfo>();

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const THREAT_LEVEL_STYLES: Record<string, string> = {
  critical: "text-red-400 bg-red-900/30 border-red-700/50",
  high: "text-orange-400 bg-orange-900/30 border-orange-700/50",
  elevated: "text-yellow-400 bg-yellow-900/30 border-yellow-700/50",
  normal: "text-green-400 bg-green-900/30 border-green-700/50",
};

const SEVERITY_STYLES: Record<string, string> = {
  critical: "text-red-400 bg-red-900/20",
  high: "text-orange-400 bg-orange-900/20",
  medium: "text-yellow-400 bg-yellow-900/20",
  low: "text-blue-400 bg-blue-900/20",
};

/* ------------------------------------------------------------------ */
/*  ProximityAlertsPanel                                               */
/* ------------------------------------------------------------------ */

function ProximityAlertsPanel({ vip }: { vip: VIPProfile }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(false);
  const [noZone, setNoZone] = useState(false);

  useEffect(() => {
    /* VIPProfile doesn't have a zone_id field directly; look it up via appearance */
    const zoneId =
      (vip.appearance as Record<string, unknown>)?.zone_id as string | undefined;

    if (!zoneId) {
      setNoZone(true);
      return;
    }

    setNoZone(false);
    setLoading(true);
    apiFetch<Alert[]>(`/api/alerts?zone=${zoneId}&limit=5`)
      .then((data) => setAlerts(Array.isArray(data) ? data : []))
      .catch(() => setAlerts([]))
      .finally(() => setLoading(false));
  }, [vip.id, vip.appearance]);

  const SEV_STYLES: Record<string, string> = {
    critical: "text-red-400 bg-red-900/20 border-red-700/50",
    high: "text-orange-400 bg-orange-900/20 border-orange-700/50",
    medium: "text-yellow-400 bg-yellow-900/20 border-yellow-700/50",
    low: "text-blue-400 bg-blue-900/20 border-blue-700/50",
  };

  if (noZone) {
    return (
      <p className="text-xs text-gray-600 py-1">No zone tracking active</p>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-1">
        <Loader2 className="h-3 w-3 animate-spin text-cyan-400" />
        <span className="text-xs text-gray-500">Loading zone alerts...</span>
      </div>
    );
  }

  if (alerts.length === 0) {
    return (
      <p className="text-xs text-gray-600 py-1">No recent alerts in this zone</p>
    );
  }

  return (
    <div className="mt-1 space-y-1.5">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
            SEV_STYLES[alert.severity] || "text-gray-400 bg-gray-800 border-gray-700"
          )}
        >
          <Bell className="mt-0.5 h-3 w-3 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-semibold truncate">{alert.title}</p>
            {alert.description && (
              <p className="text-[10px] opacity-70 truncate">{alert.description}</p>
            )}
          </div>
          <span className="shrink-0 text-[10px] opacity-60">
            {formatTimestamp(alert.created_at)}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  EscortPanel                                                        */
/* ------------------------------------------------------------------ */

function EscortPanel({ vip, addToast }: { vip: VIPProfile; addToast: (type: "success" | "error" | "info", msg: string) => void }) {
  const cached = _escortMap.get(vip.id);
  const [escort, setEscort] = useState<EscortInfo>(
    cached || { escort_name: null, assigned_at: null }
  );
  const [assigning, setAssigning] = useState(false);
  const [inputName, setInputName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleAssign = async () => {
    const name = inputName.trim();
    if (!name) return;
    setSubmitting(true);
    try {
      await apiFetch(`/api/vip/${vip.id}/escort`, {
        method: "POST",
        body: JSON.stringify({ escort_name: name }),
      });
      addToast("success", `Escort "${name}" assigned to ${vip.name}`);
    } catch {
      /* 404 or other error — store locally */
      addToast("info", `Escort assigned locally (API unavailable)`);
    } finally {
      const info: EscortInfo = { escort_name: name, assigned_at: new Date().toISOString() };
      _escortMap.set(vip.id, info);
      setEscort(info);
      setAssigning(false);
      setInputName("");
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-1">
      {escort.escort_name ? (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-green-900/40 border border-green-700/60">
              <CheckCircle2 className="h-3 w-3 text-green-400" />
            </span>
            <div>
              <p className="text-xs font-semibold text-gray-200">{escort.escort_name}</p>
              {escort.assigned_at && (
                <p className="text-[10px] text-gray-600">
                  Assigned {formatTimestamp(escort.assigned_at)}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={() => { setAssigning(true); setInputName(escort.escort_name || ""); }}
            className="text-[10px] text-cyan-500 hover:text-cyan-400 transition-colors"
          >
            Change
          </button>
        </div>
      ) : (
        <p className="text-xs text-gray-600">No escort assigned</p>
      )}

      {assigning ? (
        <div className="mt-2 flex items-center gap-2">
          <input
            autoFocus
            type="text"
            value={inputName}
            onChange={(e) => setInputName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAssign()}
            placeholder="Escort name..."
            className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          />
          <button
            onClick={handleAssign}
            disabled={submitting || !inputName.trim()}
            className="flex items-center gap-1 rounded-lg border border-cyan-700/50 bg-cyan-900/30 px-3 py-1.5 text-[11px] font-medium text-cyan-400 hover:bg-cyan-900/50 disabled:opacity-50 transition-colors"
          >
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserCheck className="h-3 w-3" />}
            Save
          </button>
          <button
            onClick={() => { setAssigning(false); setInputName(""); }}
            className="rounded-lg border border-gray-700 px-2 py-1.5 text-[11px] text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        !escort.escort_name && (
          <button
            onClick={() => setAssigning(true)}
            className="mt-1.5 flex items-center gap-1 rounded-lg border border-gray-700/50 px-3 py-1 text-[11px] text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
          >
            <UserCog className="h-3 w-3" />
            Assign Escort
          </button>
        )
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AddVIPModal                                                        */
/* ------------------------------------------------------------------ */

interface AddVIPModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (vip: VIPProfile) => void;
}

function AddVIPModal({ open, onClose, onCreated }: AddVIPModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [threatLevel, setThreatLevel] = useState("normal");
  const [geofenceRadius, setGeofenceRadius] = useState("50");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await apiFetch<VIPProfile>("/api/vip/profiles", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          threat_level: threatLevel,
          geofence_radius_meters: Number(geofenceRadius),
        }),
      });
      onCreated(result);
      // Reset form
      setName("");
      setDescription("");
      setThreatLevel("normal");
      setGeofenceRadius("50");
      onClose();
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to create VIP profile"
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-lg rounded-xl border border-gray-800 bg-gray-950 shadow-2xl shadow-black/50">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-100">
            <UserPlus className="h-4 w-4 text-cyan-400" />
            Add VIP Profile
          </h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {/* Name */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-400">
              Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Full name of the VIP"
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            />
          </div>

          {/* Description */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-400">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Role, organization, or notes..."
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700 resize-none"
            />
          </div>

          {/* Threat Level + Geofence in row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-400">
                Threat Level
              </label>
              <select
                value={threatLevel}
                onChange={(e) => setThreatLevel(e.target.value)}
                className="w-full appearance-none rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-sm text-gray-200 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
              >
                <option value="normal">Normal</option>
                <option value="elevated">Elevated</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-400">
                Geofence Radius (m)
              </label>
              <input
                type="number"
                value={geofenceRadius}
                onChange={(e) => setGeofenceRadius(e.target.value)}
                min={5}
                max={500}
                className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
              />
            </div>
          </div>

          {/* Error */}
          {submitError && (
            <p className="rounded-lg border border-red-800/50 bg-red-900/20 px-3 py-2 text-xs text-red-400">
              {submitError}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-700 px-4 py-2 text-xs font-medium text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className={cn(
                "flex items-center gap-2 rounded-lg px-5 py-2 text-xs font-semibold transition-all",
                "bg-cyan-600 text-white border border-cyan-500",
                "hover:bg-cyan-500 hover:shadow-lg hover:shadow-cyan-500/20",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Create Profile
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  VIPProtectionPage                                                  */
/* ------------------------------------------------------------------ */

export default function VIPProtectionPage() {
  const { addToast } = useToast();
  const [profiles, setProfiles] = useState<VIPProfile[]>([]);
  const [events, setEvents] = useState<ProximityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  /* Track which VIP cards have their sections expanded */
  const [expandedAlerts, setExpandedAlerts] = useState<Set<string>>(new Set());
  const [expandedEscort, setExpandedEscort] = useState<Set<string>>(new Set());

  const toggleAlerts = useCallback((id: string) => {
    setExpandedAlerts((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const toggleEscort = useCallback((id: string) => {
    setExpandedEscort((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  /* --- Fetch data --- */
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [profilesData, eventsData] = await Promise.all([
        apiFetch<VIPProfile[]>("/api/vip/profiles"),
        apiFetch<ProximityEvent[]>("/api/vip/proximity-events"),
      ]);
      setProfiles(profilesData);
      setEvents(eventsData);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch VIP data"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /* --- Modal handlers --- */
  const handleOpenModal = useCallback(() => setModalOpen(true), []);
  const handleCloseModal = useCallback(() => setModalOpen(false), []);
  const handleVIPCreated = useCallback(
    (vip: VIPProfile) => setProfiles((prev) => [vip, ...prev]),
    []
  );

  /* --- Derived --- */
  const activeVIPs = useMemo(
    () => profiles.filter((p) => p.active).length,
    [profiles]
  );
  const criticalCount = useMemo(
    () => profiles.filter((p) => p.threat_level === "critical").length,
    [profiles]
  );

  const vipNameMap = useMemo(
    () => new Map(profiles.map((p) => [p.id, p.name])),
    [profiles]
  );

  /* --- Render --- */
  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-900/30 border border-amber-800/50">
            <Crown className="h-5 w-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              VIP Protection
            </h1>
            <p className="text-xs text-gray-500">
              Monitor high-value individuals, geofences, and proximity alerts
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Quick stats */}
          <div className="hidden items-center gap-4 text-xs text-gray-500 md:flex">
            <span>
              <span className="font-semibold text-amber-400">{activeVIPs}</span>{" "}
              active VIPs
            </span>
            {criticalCount > 0 && (
              <>
                <span className="text-gray-700">|</span>
                <span>
                  <span className="font-semibold text-red-400">
                    {criticalCount}
                  </span>{" "}
                  critical
                </span>
              </>
            )}
          </div>

          {/* Add VIP button */}
          <button
            onClick={handleOpenModal}
            className={cn(
              "flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition-all",
              "bg-cyan-600 text-white border border-cyan-500",
              "hover:bg-cyan-500 hover:shadow-lg hover:shadow-cyan-500/20"
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            Add VIP
          </button>
        </div>
      </div>

      {/* ---- Loading ---- */}
      {loading && (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          <span className="ml-3 text-sm text-gray-500">
            Loading VIP profiles...
          </span>
        </div>
      )}

      {/* ---- Error ---- */}
      {!loading && error && (
        <div className="flex flex-1 flex-col items-center justify-center">
          <AlertTriangle className="mb-3 h-10 w-10 text-red-500" />
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={fetchData}
            className="mt-4 flex items-center gap-2 rounded-lg border border-gray-700 px-4 py-2 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      )}

      {/* ---- Main content ---- */}
      {!loading && !error && (
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
          {/* VIP Profile Cards Grid */}
          <div>
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-cyan-400">
              <Shield className="h-4 w-4" />
              VIP Profiles
            </h2>

            {profiles.length === 0 ? (
              <div className="flex flex-col items-center rounded-xl border border-gray-800 bg-gray-900/50 py-12">
                <Crown className="mb-2 h-10 w-10 text-gray-700" />
                <p className="text-sm font-medium text-gray-500">
                  No VIP profiles created
                </p>
                <p className="mt-1 text-xs text-gray-600">
                  Click &quot;Add VIP&quot; to create the first profile
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {profiles.map((vip) => (
                  <div
                    key={vip.id}
                    className={cn(
                      "rounded-xl border bg-gray-900/50 p-5 transition-all hover:bg-gray-900/80",
                      vip.active
                        ? "border-gray-800"
                        : "border-gray-800/50 opacity-60"
                    )}
                  >
                    {/* Top: name + status */}
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <h3 className="truncate text-sm font-semibold text-gray-200">
                          {vip.name}
                        </h3>
                        {vip.description && (
                          <p className="mt-0.5 truncate text-xs text-gray-500">
                            {vip.description}
                          </p>
                        )}
                      </div>
                      {vip.active ? (
                        <span className="ml-2 flex items-center gap-1 rounded-full bg-green-900/30 px-2 py-0.5 text-[10px] font-semibold text-green-400 border border-green-800/50">
                          <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
                          Active
                        </span>
                      ) : (
                        <span className="ml-2 rounded-full bg-gray-800 px-2 py-0.5 text-[10px] font-semibold text-gray-500 border border-gray-700/50">
                          Inactive
                        </span>
                      )}
                    </div>

                    {/* Threat level badge */}
                    <div className="mt-3">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider border",
                          THREAT_LEVEL_STYLES[vip.threat_level] ||
                            THREAT_LEVEL_STYLES.normal
                        )}
                      >
                        <Shield className="h-3 w-3" />
                        {vip.threat_level}
                      </span>
                    </div>

                    {/* Geofence + Threat indicator */}
                    <div className="mt-3 flex items-center gap-4 text-xs text-gray-500">
                      <span className="flex items-center gap-1">
                        <Radar className="h-3 w-3" />
                        {vip.geofence_radius_meters}m radius
                      </span>
                    </div>

                    {/* Threat level bar */}
                    <div className="mt-3 h-1 w-full rounded-full bg-gray-800">
                      <div
                        className="h-1 rounded-full transition-all"
                        style={{
                          backgroundColor: threatLevelColor(vip.threat_level),
                          width:
                            vip.threat_level === "critical"
                              ? "100%"
                              : vip.threat_level === "high"
                              ? "75%"
                              : vip.threat_level === "elevated"
                              ? "50%"
                              : "25%",
                        }}
                      />
                    </div>

                    {/* ---- Proximity Alerts section ---- */}
                    <div className="mt-4 border-t border-gray-800 pt-3">
                      <button
                        onClick={() => toggleAlerts(vip.id)}
                        className="flex w-full items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300 transition-colors"
                      >
                        <span className="flex items-center gap-1">
                          <Bell className="h-3 w-3" />
                          Proximity Alerts
                        </span>
                        <span>{expandedAlerts.has(vip.id) ? "▲" : "▼"}</span>
                      </button>
                      {expandedAlerts.has(vip.id) && (
                        <ProximityAlertsPanel vip={vip} />
                      )}
                    </div>

                    {/* ---- Escort section ---- */}
                    <div className="mt-3 border-t border-gray-800 pt-3">
                      <button
                        onClick={() => toggleEscort(vip.id)}
                        className="flex w-full items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300 transition-colors"
                      >
                        <span className="flex items-center gap-1">
                          <UserCog className="h-3 w-3" />
                          Escort
                        </span>
                        <span>{expandedEscort.has(vip.id) ? "▲" : "▼"}</span>
                      </button>
                      {expandedEscort.has(vip.id) && (
                        <EscortPanel vip={vip} addToast={addToast} />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Proximity Events Table */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/50">
            <div className="flex items-center justify-between border-b border-gray-800 px-5 py-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-cyan-400">
                <Crosshair className="h-4 w-4" />
                Recent Proximity Events
              </h2>
              <span className="text-xs text-gray-500">
                {events.length} events
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    <th className="px-5 py-3">VIP</th>
                    <th className="px-5 py-3">Threat Type</th>
                    <th className="px-5 py-3">Distance</th>
                    <th className="px-5 py-3">Camera</th>
                    <th className="px-5 py-3">Severity</th>
                    <th className="px-5 py-3">Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {events.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-5 py-10 text-center text-gray-600"
                      >
                        No proximity events recorded
                      </td>
                    </tr>
                  )}
                  {events.map((event) => {
                    const vipName =
                      vipNameMap.get(event.vip_id) ||
                      event.vip_id?.slice(0, 8) ||
                      "Unknown";
                    return (
                      <tr
                        key={event.id}
                        className="border-b border-gray-800/50 transition-colors hover:bg-gray-900/80"
                      >
                        {/* VIP */}
                        <td className="px-5 py-3">
                          <span className="flex items-center gap-1.5 text-xs text-gray-300">
                            <Crown className="h-3 w-3 text-amber-400" />
                            {vipName}
                          </span>
                        </td>

                        {/* Threat Type */}
                        <td className="px-5 py-3">
                          <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-300 border border-gray-700/50">
                            {event.threat_type}
                          </span>
                        </td>

                        {/* Distance */}
                        <td className="px-5 py-3">
                          <span
                            className={cn(
                              "font-mono text-xs font-semibold",
                              event.distance_meters < 10
                                ? "text-red-400"
                                : event.distance_meters < 25
                                ? "text-orange-400"
                                : "text-gray-400"
                            )}
                          >
                            {event.distance_meters.toFixed(1)}m
                          </span>
                        </td>

                        {/* Camera */}
                        <td className="px-5 py-3">
                          <span className="flex items-center gap-1 text-xs text-gray-500">
                            <Camera className="h-3 w-3" />
                            {event.camera_id
                              ? event.camera_id.slice(0, 8)
                              : "---"}
                          </span>
                        </td>

                        {/* Severity */}
                        <td className="px-5 py-3">
                          <span
                            className={cn(
                              "inline-block rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                              SEVERITY_STYLES[event.severity] ||
                                "text-gray-400 bg-gray-800"
                            )}
                          >
                            {event.severity}
                          </span>
                        </td>

                        {/* Timestamp */}
                        <td className="px-5 py-3">
                          <span className="flex items-center gap-1 text-xs text-gray-500">
                            <Clock className="h-3 w-3" />
                            {formatTimestamp(event.timestamp)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Add VIP Modal */}
      <AddVIPModal
        open={modalOpen}
        onClose={handleCloseModal}
        onCreated={handleVIPCreated}
      />
    </div>
  );
}
