"use client";

import { useState, useEffect, useCallback } from "react";
import {
  X,
  Car,
  Shield,
  Clock,
  Camera,
  MapPin,
  AlertTriangle,
  Loader2,
  Route,
  Eye,
} from "lucide-react";
import { cn, apiFetch, severityColor } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface VehicleInfo {
  plate_number: string;
  make: string;
  model: string;
  color: string;
  vehicle_type: string;
}

interface WatchlistInfo {
  is_watchlisted: boolean;
  reason?: string;
  severity?: string;
}

interface Sighting {
  id: string;
  camera: string;
  zone: string;
  timestamp: string;
  confidence: number;
}

interface Violation {
  id: string;
  event_type: string;
  severity: string;
  details: string;
  created_at: string;
  resolved: boolean;
}

interface Trip {
  id: string;
  entry_camera: string;
  exit_camera: string;
  entry_time: string;
  exit_time: string;
  duration_seconds: number;
}

interface VehicleFullProfile {
  vehicle: VehicleInfo;
  watchlist: WatchlistInfo;
  recent_sightings: Sighting[];
  violations: Violation[];
  trips: Trip[];
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CARD = "rounded-lg border border-gray-800 bg-gray-900/60 backdrop-blur p-4";

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
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface VehicleProfileCardProps {
  plateNumber: string;
  onClose: () => void;
}

export default function VehicleProfileCard({
  plateNumber,
  onClose,
}: VehicleProfileCardProps) {
  const [profile, setProfile] = useState<VehicleFullProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<VehicleFullProfile>(
        `/api/lpr/vehicle/${encodeURIComponent(plateNumber)}/full-profile`
      );
      setProfile(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load profile");
    } finally {
      setLoading(false);
    }
  }, [plateNumber]);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-gray-800 bg-gray-950 shadow-2xl">
        {/* ---- Header ---- */}
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
              <Car className="h-5 w-5 text-cyan-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold tracking-wide text-gray-100">
                Vehicle Profile
              </h2>
              <span className="inline-flex items-center rounded-md border border-gray-700 bg-gray-800 px-2.5 py-0.5 font-mono text-sm font-bold tracking-wider text-gray-100">
                {plateNumber}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-700 p-2 text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-300"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* ---- Body ---- */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
          {/* Loading */}
          {loading && (
            <div className="flex flex-col items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
              <p className="mt-3 text-sm text-gray-500">Loading vehicle profile...</p>
            </div>
          )}

          {/* Error */}
          {!loading && error && (
            <div className="flex flex-col items-center justify-center py-20">
              <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
              <p className="text-sm text-red-400">{error}</p>
              <button
                onClick={fetchProfile}
                className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {/* Profile Content */}
          {!loading && !error && profile && (
            <>
              {/* Vehicle Info + Photo Placeholder */}
              <div className={CARD}>
                <div className="flex gap-4">
                  {/* Photo placeholder */}
                  <div className="flex h-28 w-40 shrink-0 items-center justify-center rounded-lg border border-gray-700 bg-gray-800/50">
                    <Car className="h-12 w-12 text-gray-600" />
                  </div>

                  {/* Details */}
                  <div className="flex-1 space-y-2">
                    <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                      <div>
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                          Make
                        </span>
                        <p className="text-gray-200">{profile.vehicle.make || "Unknown"}</p>
                      </div>
                      <div>
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                          Model
                        </span>
                        <p className="text-gray-200">{profile.vehicle.model || "Unknown"}</p>
                      </div>
                      <div>
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                          Color
                        </span>
                        <p className="capitalize text-gray-200">
                          {profile.vehicle.color || "Unknown"}
                        </p>
                      </div>
                      <div>
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                          Type
                        </span>
                        <p className="capitalize text-gray-200">
                          {profile.vehicle.vehicle_type || "Unknown"}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Watchlist Status */}
              <div className={CARD}>
                <div className="flex items-center gap-3">
                  <Shield
                    className={cn(
                      "h-5 w-5",
                      profile.watchlist.is_watchlisted
                        ? "text-red-400"
                        : "text-gray-600"
                    )}
                  />
                  {profile.watchlist.is_watchlisted ? (
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-400">
                          Watchlisted
                        </span>
                        {profile.watchlist.severity && (
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                              severityColor(profile.watchlist.severity)
                            )}
                          >
                            {profile.watchlist.severity}
                          </span>
                        )}
                      </div>
                      {profile.watchlist.reason && (
                        <p className="mt-1.5 text-xs text-gray-400">
                          {profile.watchlist.reason}
                        </p>
                      )}
                    </div>
                  ) : (
                    <span className="text-sm text-gray-500">
                      Not on watchlist
                    </span>
                  )}
                </div>
              </div>

              {/* Recent Sightings */}
              <div className={CARD}>
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-300">
                  <Eye className="h-4 w-4 text-cyan-400" />
                  Recent Sightings
                  <span className="ml-auto text-xs font-normal text-gray-600">
                    Last {profile.recent_sightings.length}
                  </span>
                </h3>

                {profile.recent_sightings.length === 0 ? (
                  <p className="py-4 text-center text-xs text-gray-600">
                    No recent sightings
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto scrollbar-thin scrollbar-track-gray-900 scrollbar-thumb-gray-700">
                    {profile.recent_sightings.map((s) => (
                      <div
                        key={s.id}
                        className="flex items-center gap-3 rounded-md border border-gray-800/50 bg-gray-800/20 px-3 py-2 text-xs"
                      >
                        <Camera className="h-3.5 w-3.5 shrink-0 text-gray-600" />
                        <span className="text-gray-300">{s.camera}</span>
                        <span className="flex items-center gap-1 text-gray-500">
                          <MapPin className="h-3 w-3" />
                          {s.zone}
                        </span>
                        <span
                          className={cn(
                            "ml-auto font-mono tabular-nums",
                            s.confidence >= 0.9
                              ? "text-emerald-400"
                              : s.confidence >= 0.7
                                ? "text-yellow-400"
                                : "text-red-400"
                          )}
                        >
                          {Math.round(s.confidence * 100)}%
                        </span>
                        <span className="flex items-center gap-1 text-gray-500">
                          <Clock className="h-3 w-3" />
                          {timeAgo(s.timestamp)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Violations */}
              <div className={CARD}>
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-300">
                  <AlertTriangle className="h-4 w-4 text-amber-400" />
                  Violations
                  <span className="ml-auto text-xs font-normal text-gray-600">
                    {profile.violations.length} total
                  </span>
                </h3>

                {profile.violations.length === 0 ? (
                  <p className="py-4 text-center text-xs text-gray-600">
                    No violations recorded
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto scrollbar-thin scrollbar-track-gray-900 scrollbar-thumb-gray-700">
                    {profile.violations.map((v) => (
                      <div
                        key={v.id}
                        className="flex items-center gap-3 rounded-md border border-gray-800/50 bg-gray-800/20 px-3 py-2 text-xs"
                      >
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                            severityColor(v.severity)
                          )}
                        >
                          {v.severity}
                        </span>
                        <span className="text-gray-300">{v.event_type}</span>
                        <span className="flex-1 truncate text-gray-500">
                          {v.details}
                        </span>
                        {v.resolved ? (
                          <span className="rounded-full bg-emerald-900/30 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                            Resolved
                          </span>
                        ) : (
                          <span className="rounded-full bg-red-900/30 px-2 py-0.5 text-[10px] font-semibold text-red-400">
                            Open
                          </span>
                        )}
                        <span className="text-gray-600">
                          {timeAgo(v.created_at)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Trip History */}
              <div className={CARD}>
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-300">
                  <Route className="h-4 w-4 text-cyan-400" />
                  Trip History
                  <span className="ml-auto text-xs font-normal text-gray-600">
                    {profile.trips.length} trips
                  </span>
                </h3>

                {profile.trips.length === 0 ? (
                  <p className="py-4 text-center text-xs text-gray-600">
                    No trip records
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto scrollbar-thin scrollbar-track-gray-900 scrollbar-thumb-gray-700">
                    {profile.trips.map((t) => (
                      <div
                        key={t.id}
                        className="flex items-center gap-3 rounded-md border border-gray-800/50 bg-gray-800/20 px-3 py-2 text-xs"
                      >
                        <span className="flex items-center gap-1 text-gray-400">
                          <Camera className="h-3 w-3 text-gray-600" />
                          {t.entry_camera}
                        </span>
                        <span className="text-gray-600">-&gt;</span>
                        <span className="flex items-center gap-1 text-gray-400">
                          <Camera className="h-3 w-3 text-gray-600" />
                          {t.exit_camera}
                        </span>
                        <span className="ml-auto font-mono tabular-nums text-cyan-400">
                          {formatDuration(t.duration_seconds)}
                        </span>
                        <span className="text-gray-600">
                          {formatTimestamp(t.entry_time)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
