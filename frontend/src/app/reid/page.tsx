"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ScanSearch,
  Search,
  Loader2,
  AlertTriangle,
  Flag,
  Camera,
  Clock,
  Eye,
  Users,
  Shield,
  Activity,
  Crosshair,
  ArrowRight,
  XCircle,
  X,
  Footprints,
  Shirt,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ReIdStats {
  total_profiles: number;
  active_tracking: number;
  cross_camera_matches: number;
  total_sightings: number;
  flagged_persons: number;
  avg_confidence: number;
}

interface ClothingDetail {
  type: string;
  color: string;
  description: string;
}

interface CameraSighting {
  camera_id: string;
  camera_name: string;
  timestamp: string;
  direction: string;
  confidence: number;
}

interface ReIdProfile {
  id: string;
  descriptor: string;
  clothing: {
    upper: ClothingDetail;
    lower: ClothingDetail;
    footwear: ClothingDetail;
  };
  accessories: string[];
  build: string;
  hair: string;
  sightings_count: number;
  camera_sightings: CameraSighting[];
  confidence: number;
  is_flagged: boolean;
  first_seen: string;
  last_seen: string;
}

interface SearchResultProfile {
  profile: ReIdProfile;
  match_score: number;
}

interface TrackingEntry {
  profile: ReIdProfile;
  camera_trail: {
    camera_name: string;
    timestamp: string;
    direction: string;
  }[];
  total_cameras: number;
  duration_minutes: number;
}

interface GaitMatch {
  source_camera: string;
  source_track_id: number;
  matched_camera: string;
  matched_track_id: number;
  match_score: number;
  gait_description: string;
  timestamp: string;
}

interface GaitBufferStats {
  cameras: number;
  tracked_persons: number;
  buffered_frames: number;
}

/* ------------------------------------------------------------------ */
/*  Color map for clothing colors                                      */
/* ------------------------------------------------------------------ */

const CLOTHING_COLOR_MAP: Record<string, string> = {
  black: "#1a1a1a",
  white: "#f5f5f5",
  red: "#ef4444",
  blue: "#3b82f6",
  navy: "#1e3a5f",
  green: "#22c55e",
  yellow: "#eab308",
  orange: "#f97316",
  purple: "#a855f7",
  pink: "#ec4899",
  brown: "#92400e",
  gray: "#6b7280",
  grey: "#6b7280",
  beige: "#d4c5a9",
  khaki: "#bdb76b",
  tan: "#d2b48c",
  maroon: "#800000",
  teal: "#14b8a6",
  cyan: "#06b6d4",
};

function getColorHex(colorName: string): string {
  const lower = colorName.toLowerCase();
  for (const [key, hex] of Object.entries(CLOTHING_COLOR_MAP)) {
    if (lower.includes(key)) return hex;
  }
  return "#6b7280";
}

/* ------------------------------------------------------------------ */
/*  Skeleton loaders                                                   */
/* ------------------------------------------------------------------ */

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded bg-gray-800/60",
        className
      )}
    />
  );
}

function CardSkeleton() {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-5 space-y-3">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
      <div className="flex gap-2">
        <Skeleton className="h-6 w-16 rounded-full" />
        <Skeleton className="h-6 w-16 rounded-full" />
        <Skeleton className="h-6 w-16 rounded-full" />
      </div>
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ClothingBadge                                                      */
/* ------------------------------------------------------------------ */

function ClothingBadge({
  label,
  detail,
}: {
  label: string;
  detail: ClothingDetail;
}) {
  const hex = getColorHex(detail.color);

  return (
    <div className="flex items-center gap-2 rounded-full border border-gray-700 bg-gray-800/60 px-3 py-1">
      <span
        className="h-3 w-3 shrink-0 rounded-full border border-gray-600"
        style={{ backgroundColor: hex }}
      />
      <span className="text-[11px] text-gray-400">
        <span className="font-medium text-gray-300">{label}:</span>{" "}
        {detail.description || `${detail.color} ${detail.type}`}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ProfileCard                                                        */
/* ------------------------------------------------------------------ */

function ProfileCard({
  profile,
  matchScore,
  onFlag,
  flagLoading,
  onSelect,
}: {
  profile: ReIdProfile;
  matchScore?: number;
  onFlag: (id: string) => void;
  flagLoading: string | null;
  onSelect?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isFlagging = flagLoading === profile.id;

  return (
    <div
      className={cn(
        "rounded-lg border transition-all duration-200",
        profile.is_flagged
          ? "border-red-700/70 bg-red-950/20"
          : "border-gray-800 bg-gray-900/50 hover:bg-gray-900/80",
        onSelect && "cursor-pointer"
      )}
      onClick={() => onSelect?.(profile.id)}
    >
      {/* Header */}
      <div className="p-4 space-y-3">
        {/* Top row: descriptor + flag + score */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {profile.is_flagged && (
                <span className="shrink-0 flex items-center gap-1 rounded bg-red-900/40 border border-red-800/60 px-2 py-0.5 text-[10px] font-bold uppercase text-red-400">
                  <Flag className="h-3 w-3" />
                  Flagged
                </span>
              )}
              {matchScore !== undefined && (
                <span className="shrink-0 rounded bg-emerald-900/40 border border-emerald-800/50 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                  {(matchScore * 100).toFixed(1)}% match
                </span>
              )}
              {/* Confidence score badge */}
              {profile.confidence !== undefined && (
                <span
                  className={cn(
                    "shrink-0 rounded border px-2 py-0.5 text-[10px] font-bold font-mono",
                    profile.confidence >= 0.8
                      ? "bg-green-900/40 border-green-800/50 text-green-400"
                      : profile.confidence >= 0.5
                      ? "bg-amber-900/40 border-amber-800/50 text-amber-400"
                      : "bg-red-900/40 border-red-800/50 text-red-400"
                  )}
                  title={`Re-ID confidence: ${(profile.confidence * 100).toFixed(1)}%`}
                >
                  {(profile.confidence * 100).toFixed(0)}% conf
                </span>
              )}
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-gray-200">
              {profile.descriptor}
            </p>
          </div>

          {/* Flag button */}
          <button
            onClick={(e) => { e.stopPropagation(); onFlag(profile.id); }}
            disabled={isFlagging}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
              profile.is_flagged
                ? "bg-red-900/40 text-red-400 border border-red-800/60 hover:bg-red-800/50"
                : "bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700 hover:text-gray-200",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            {isFlagging ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Flag className="h-3.5 w-3.5" />
            )}
            {profile.is_flagged ? "Unflag" : "Flag"}
          </button>
        </div>

        {/* Clothing badges */}
        {profile.clothing && (
          <div className="flex flex-wrap gap-2">
            {profile.clothing.upper && (
              <ClothingBadge label="Upper" detail={profile.clothing.upper} />
            )}
            {profile.clothing.lower && (
              <ClothingBadge label="Lower" detail={profile.clothing.lower} />
            )}
            {profile.clothing.footwear && (
              <ClothingBadge label="Footwear" detail={profile.clothing.footwear} />
            )}
          </div>
        )}

        {/* Build, hair, accessories */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
          {profile.build && (
            <span className="flex items-center gap-1">
              <Users className="h-3 w-3 text-teal-500" />
              Build: <span className="text-gray-300">{profile.build}</span>
            </span>
          )}
          {profile.hair && (
            <span className="flex items-center gap-1">
              Hair: <span className="text-gray-300">{profile.hair}</span>
            </span>
          )}
          {profile.accessories && profile.accessories.length > 0 && (
            <span className="flex items-center gap-1">
              Accessories:{" "}
              <span className="text-gray-300">
                {profile.accessories.join(", ")}
              </span>
            </span>
          )}
        </div>

        {/* Stats row */}
        <div className="flex items-center gap-4 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <Eye className="h-3 w-3 text-teal-500" />
            <span className="font-semibold text-gray-300">
              {profile.sightings_count}
            </span>{" "}
            sightings
          </span>
          <span className="flex items-center gap-1">
            <Camera className="h-3 w-3 text-teal-500" />
            <span className="font-semibold text-gray-300">
              {profile.camera_sightings?.length || 0}
            </span>{" "}
            cameras
          </span>
          <span className="flex items-center gap-1">
            Confidence:{" "}
            <span
              className={cn(
                "font-mono font-semibold",
                profile.confidence >= 0.8
                  ? "text-emerald-400"
                  : profile.confidence >= 0.5
                  ? "text-yellow-400"
                  : "text-red-400"
              )}
            >
              {(profile.confidence * 100).toFixed(1)}%
            </span>
          </span>
          {profile.first_seen && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              First: {formatTimestamp(profile.first_seen)}
            </span>
          )}
        </div>

        {/* Expand toggle */}
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="text-[11px] font-medium text-teal-400 hover:text-teal-300 transition-colors"
        >
          {expanded ? "Hide camera timeline" : "Show camera timeline"}
        </button>
      </div>

      {/* Camera timeline (expanded) */}
      {expanded && profile.camera_sightings && profile.camera_sightings.length > 0 && (
        <div className="border-t border-gray-800 px-4 py-3 space-y-1.5">
          <div className="flex items-center gap-2 mb-2 text-xs font-medium text-gray-400">
            <Footprints className="h-3.5 w-3.5 text-teal-500" />
            Camera Timeline
          </div>
          <div className="space-y-1">
            {profile.camera_sightings.map((sighting, idx) => (
              <div
                key={`${sighting.camera_id}-${idx}`}
                className="flex items-center gap-3 rounded border border-gray-800 bg-gray-950/50 px-3 py-2"
              >
                {/* Timeline connector */}
                <div className="flex flex-col items-center">
                  <span className="h-2 w-2 rounded-full bg-teal-500" />
                  {idx < profile.camera_sightings.length - 1 && (
                    <span className="mt-0.5 h-4 w-px bg-gray-700" />
                  )}
                </div>

                <span className="flex items-center gap-1 text-xs font-medium text-gray-300">
                  <Camera className="h-3 w-3 text-gray-500" />
                  {sighting.camera_name}
                </span>

                <span className="font-mono text-[10px] text-gray-500">
                  {formatTimestamp(sighting.timestamp)}
                </span>

                {sighting.direction && (
                  <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] text-gray-400">
                    {sighting.direction}
                  </span>
                )}

                <span className="ml-auto font-mono text-[10px] text-teal-400">
                  {(sighting.confidence * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ProfileDetailPanel                                                 */
/* ------------------------------------------------------------------ */

function ProfileDetailPanel({
  profileId,
  onClose,
  onFlag,
  flagLoading,
  refreshKey,
}: {
  profileId: string;
  onClose: () => void;
  onFlag: (id: string) => void;
  flagLoading: string | null;
  refreshKey: number;
}) {
  const [detail, setDetail] = useState<ReIdProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setDetail(null);
    apiFetch<ReIdProfile>(`/api/reid/profiles/${profileId}`)
      .then(setDetail)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load profile")
      )
      .finally(() => setLoading(false));
  }, [profileId, refreshKey]);

  const isFlagging = flagLoading === profileId;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Sidebar */}
      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-gray-800 bg-gray-950 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <div className="flex items-center gap-2">
            <ScanSearch className="h-5 w-5 text-emerald-400" />
            <h2 className="text-base font-bold text-gray-100">
              Profile Detail
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
          {loading && (
            <div className="flex flex-col items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-emerald-400" />
              <p className="mt-3 text-sm text-gray-500">Loading profile...</p>
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center justify-center py-20">
              <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {!loading && !error && detail && (
            <>
              {/* ID + Flag status */}
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    {detail.is_flagged && (
                      <span className="flex items-center gap-1 rounded bg-red-900/40 border border-red-800/60 px-2 py-0.5 text-[10px] font-bold uppercase text-red-400">
                        <Flag className="h-3 w-3" />
                        Flagged
                      </span>
                    )}
                    <span className="font-mono text-xs text-gray-600">
                      ID: {detail.id}
                    </span>
                  </div>
                  <button
                    onClick={() => onFlag(detail.id)}
                    disabled={isFlagging}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                      detail.is_flagged
                        ? "bg-red-900/40 text-red-400 border border-red-800/60 hover:bg-red-800/50"
                        : "bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700 hover:text-gray-200",
                      "disabled:opacity-50 disabled:cursor-not-allowed"
                    )}
                  >
                    {isFlagging ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Flag className="h-3.5 w-3.5" />
                    )}
                    {detail.is_flagged ? "Unflag" : "Flag"}
                  </button>
                </div>

                {/* Descriptor */}
                <p className="text-sm leading-relaxed text-gray-200">
                  {detail.descriptor}
                </p>
              </div>

              {/* Clothing */}
              {detail.clothing && (
                <div className="space-y-2">
                  <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    <Shirt className="h-3.5 w-3.5 text-teal-500" />
                    Clothing
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {detail.clothing.upper && (
                      <ClothingBadge label="Upper" detail={detail.clothing.upper} />
                    )}
                    {detail.clothing.lower && (
                      <ClothingBadge label="Lower" detail={detail.clothing.lower} />
                    )}
                    {detail.clothing.footwear && (
                      <ClothingBadge label="Footwear" detail={detail.clothing.footwear} />
                    )}
                  </div>
                </div>
              )}

              {/* Physical attributes */}
              <div className="space-y-2">
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
                  <Users className="h-3.5 w-3.5 text-teal-500" />
                  Physical Attributes
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  {detail.build && (
                    <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2">
                      <span className="text-[10px] uppercase tracking-wide text-gray-600">Build</span>
                      <p className="text-sm text-gray-300">{detail.build}</p>
                    </div>
                  )}
                  {detail.hair && (
                    <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2">
                      <span className="text-[10px] uppercase tracking-wide text-gray-600">Hair</span>
                      <p className="text-sm text-gray-300">{detail.hair}</p>
                    </div>
                  )}
                </div>
                {detail.accessories && detail.accessories.length > 0 && (
                  <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2">
                    <span className="text-[10px] uppercase tracking-wide text-gray-600">Accessories</span>
                    <p className="text-sm text-gray-300">
                      {detail.accessories.join(", ")}
                    </p>
                  </div>
                )}
              </div>

              {/* Stats */}
              <div className="space-y-2">
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
                  <Activity className="h-3.5 w-3.5 text-teal-500" />
                  Statistics
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2">
                    <span className="text-[10px] uppercase tracking-wide text-gray-600">Sightings</span>
                    <p className="text-lg font-bold text-gray-200">{detail.sightings_count}</p>
                  </div>
                  <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2">
                    <span className="text-[10px] uppercase tracking-wide text-gray-600">Cameras</span>
                    <p className="text-lg font-bold text-gray-200">{detail.camera_sightings?.length || 0}</p>
                  </div>
                  <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2">
                    <span className="text-[10px] uppercase tracking-wide text-gray-600">Confidence</span>
                    <p className={cn(
                      "text-lg font-bold font-mono",
                      detail.confidence >= 0.8
                        ? "text-emerald-400"
                        : detail.confidence >= 0.5
                        ? "text-yellow-400"
                        : "text-red-400"
                    )}>
                      {(detail.confidence * 100).toFixed(1)}%
                    </p>
                  </div>
                  <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2">
                    <span className="text-[10px] uppercase tracking-wide text-gray-600">First Seen</span>
                    <p className="text-xs font-mono text-gray-300">
                      {detail.first_seen ? formatTimestamp(detail.first_seen) : "N/A"}
                    </p>
                  </div>
                </div>
                {detail.last_seen && (
                  <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2">
                    <span className="text-[10px] uppercase tracking-wide text-gray-600">Last Seen</span>
                    <p className="text-xs font-mono text-gray-300">
                      {formatTimestamp(detail.last_seen)}
                    </p>
                  </div>
                )}
              </div>

              {/* Camera timeline */}
              {detail.camera_sightings && detail.camera_sightings.length > 0 && (
                <div className="space-y-2">
                  <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    <Footprints className="h-3.5 w-3.5 text-teal-500" />
                    Camera Timeline
                  </h3>
                  <div className="space-y-1">
                    {detail.camera_sightings.map((sighting, idx) => (
                      <div
                        key={`${sighting.camera_id}-${idx}`}
                        className="flex items-center gap-3 rounded border border-gray-800 bg-gray-900/40 px-3 py-2"
                      >
                        <div className="flex flex-col items-center">
                          <span className="h-2 w-2 rounded-full bg-teal-500" />
                          {idx < detail.camera_sightings.length - 1 && (
                            <span className="mt-0.5 h-4 w-px bg-gray-700" />
                          )}
                        </div>
                        <span className="flex items-center gap-1 text-xs font-medium text-gray-300">
                          <Camera className="h-3 w-3 text-gray-500" />
                          {sighting.camera_name}
                        </span>
                        <span className="font-mono text-[10px] text-gray-500">
                          {formatTimestamp(sighting.timestamp)}
                        </span>
                        {sighting.direction && (
                          <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] text-gray-400">
                            {sighting.direction}
                          </span>
                        )}
                        <span className="ml-auto font-mono text-[10px] text-teal-400">
                          {(sighting.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  TrackingCard                                                       */
/* ------------------------------------------------------------------ */

function TrackingCard({ entry }: { entry: TrackingEntry }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-5 space-y-4">
      {/* Profile descriptor */}
      <p className="text-sm leading-relaxed text-gray-200">
        {entry.profile.descriptor}
      </p>

      {/* Stats */}
      <div className="flex items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <Camera className="h-3 w-3 text-teal-500" />
          <span className="font-semibold text-gray-300">{entry.total_cameras}</span>{" "}
          cameras
        </span>
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3 text-teal-500" />
          <span className="font-semibold text-gray-300">{entry.duration_minutes}</span>{" "}
          min tracked
        </span>
        <span className="flex items-center gap-1">
          Confidence:{" "}
          <span
            className={cn(
              "font-mono font-semibold",
              entry.profile.confidence >= 0.8
                ? "text-emerald-400"
                : entry.profile.confidence >= 0.5
                ? "text-yellow-400"
                : "text-red-400"
            )}
          >
            {(entry.profile.confidence * 100).toFixed(1)}%
          </span>
        </span>
      </div>

      {/* Visual camera trail */}
      {entry.camera_trail && entry.camera_trail.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-400">
            <Crosshair className="h-3.5 w-3.5 text-teal-500" />
            Cross-Camera Trail
          </div>

          {/* Horizontal visual trail */}
          <div className="flex items-center gap-1 overflow-x-auto pb-1">
            {entry.camera_trail.map((hop, idx) => (
              <div key={idx} className="flex items-center gap-1 shrink-0">
                <div className="flex flex-col items-center rounded-lg border border-teal-800/40 bg-teal-950/30 px-3 py-2 min-w-[120px]">
                  <span className="flex items-center gap-1 text-xs font-medium text-teal-300">
                    <Camera className="h-3 w-3" />
                    {hop.camera_name}
                  </span>
                  <span className="mt-0.5 font-mono text-[10px] text-gray-500">
                    {formatTimestamp(hop.timestamp)}
                  </span>
                  {hop.direction && (
                    <span className="mt-0.5 text-[10px] text-gray-600">
                      {hop.direction}
                    </span>
                  )}
                </div>
                {idx < entry.camera_trail.length - 1 && (
                  <ArrowRight className="h-4 w-4 shrink-0 text-teal-700" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

type TabKey = "profiles" | "tracking" | "gait";

export default function ReIdPage() {
  /* --- State --- */
  const [stats, setStats] = useState<ReIdStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  const [profiles, setProfiles] = useState<ReIdProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [profilesError, setProfilesError] = useState<string | null>(null);

  const [trackingMap, setTrackingMap] = useState<TrackingEntry[]>([]);
  const [trackingLoading, setTrackingLoading] = useState(false);
  const [trackingError, setTrackingError] = useState<string | null>(null);

  const [gaitMatches, setGaitMatches] = useState<GaitMatch[]>([]);
  const [gaitLoading, setGaitLoading] = useState(false);
  const [gaitError, setGaitError] = useState<string | null>(null);
  const [gaitBufferStats, setGaitBufferStats] = useState<GaitBufferStats | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResultProfile[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<TabKey>("profiles");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [flagLoading, setFlagLoading] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [detailRefreshKey, setDetailRefreshKey] = useState(0);

  /* --- Load stats --- */
  useEffect(() => {
    setStatsLoading(true);
    apiFetch<ReIdStats>("/api/reid/stats")
      .then(setStats)
      .catch(() => setStats(null))
      .finally(() => setStatsLoading(false));
  }, []);

  /* --- Load profiles --- */
  const fetchProfiles = useCallback(async () => {
    setProfilesLoading(true);
    setProfilesError(null);
    try {
      const data = await apiFetch<ReIdProfile[]>(
        `/api/reid/profiles?limit=50&flagged_only=${flaggedOnly}`
      );
      setProfiles(data);
    } catch (err) {
      setProfilesError(
        err instanceof Error ? err.message : "Failed to load profiles"
      );
      setProfiles([]);
    } finally {
      setProfilesLoading(false);
    }
  }, [flaggedOnly]);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  /* --- Load tracking map when tab switches --- */
  useEffect(() => {
    if (activeTab !== "tracking") return;
    setTrackingLoading(true);
    setTrackingError(null);
    apiFetch<TrackingEntry[]>("/api/reid/tracking-map")
      .then(setTrackingMap)
      .catch((err) => {
        setTrackingError(
          err instanceof Error ? err.message : "Failed to load tracking data"
        );
        setTrackingMap([]);
      })
      .finally(() => setTrackingLoading(false));
  }, [activeTab]);

  /* --- Load gait matches when tab switches --- */
  useEffect(() => {
    if (activeTab !== "gait") return;
    setGaitLoading(true);
    setGaitError(null);

    Promise.all([
      apiFetch<{ matches: GaitMatch[] }>("/api/reid/gait-matches?limit=50")
        .then((data) => setGaitMatches(data.matches || []))
        .catch((err) => {
          setGaitError(
            err instanceof Error ? err.message : "Failed to load gait matches"
          );
          setGaitMatches([]);
        }),
      apiFetch<GaitBufferStats>("/api/reid/gait-stats")
        .then(setGaitBufferStats)
        .catch(() => setGaitBufferStats(null)),
    ]).finally(() => setGaitLoading(false));
  }, [activeTab]);

  /* --- Search handler --- */
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    setSearchError(null);
    setSearchResults(null);
    try {
      const data = await apiFetch<SearchResultProfile[]>("/api/reid/search", {
        method: "POST",
        body: JSON.stringify({
          description: searchQuery.trim(),
          time_range_minutes: 120,
          max_results: 20,
        }),
      });
      setSearchResults(data);
    } catch (err) {
      setSearchError(
        err instanceof Error ? err.message : "Search failed"
      );
    } finally {
      setSearchLoading(false);
    }
  }, [searchQuery]);

  /* --- Flag/unflag handler --- */
  const handleFlag = useCallback(
    async (profileId: string) => {
      setFlagLoading(profileId);
      try {
        const updated = await apiFetch<ReIdProfile>(
          `/api/reid/profiles/${profileId}/flag`,
          { method: "POST" }
        );
        // Update in profiles list
        setProfiles((prev) =>
          prev.map((p) => (p.id === profileId ? updated : p))
        );
        // Update in search results
        setSearchResults((prev) =>
          prev
            ? prev.map((r) =>
                r.profile.id === profileId
                  ? { ...r, profile: updated }
                  : r
              )
            : null
        );
      } catch {
        // Silently handle
      } finally {
        setFlagLoading(null);
        setDetailRefreshKey((k) => k + 1);
      }
    },
    []
  );

  /* --- Clear search results --- */
  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchResults(null);
    setSearchError(null);
  }, []);

  /* --- Stat items --- */
  const statItems = stats
    ? [
        {
          label: "Total Profiles",
          value: stats.total_profiles,
          icon: Users,
          color: "text-teal-400",
        },
        {
          label: "Active Tracking",
          value: stats.active_tracking,
          icon: Activity,
          color: "text-emerald-400",
        },
        {
          label: "Cross-Camera Matches",
          value: stats.cross_camera_matches,
          icon: Crosshair,
          color: "text-cyan-400",
        },
        {
          label: "Total Sightings",
          value: stats.total_sightings,
          icon: Eye,
          color: "text-blue-400",
        },
        {
          label: "Flagged Persons",
          value: stats.flagged_persons,
          icon: Flag,
          color: "text-red-400",
        },
        {
          label: "Avg Confidence",
          value: `${(stats.avg_confidence * 100).toFixed(1)}%`,
          icon: Shield,
          color: "text-purple-400",
        },
      ]
    : [];

  /* --- Render --- */
  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ---- Header ---- */}
      <header className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-900/30 border border-emerald-800/50">
            <ScanSearch className="h-5 w-5 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Person Re-Identification
            </h1>
            <p className="text-xs text-gray-500">
              Privacy-Preserving &mdash; No Facial Recognition
            </p>
          </div>
        </div>

        {/* GDPR badge */}
        <div className="flex items-center gap-2 rounded-lg border border-emerald-800/60 bg-emerald-900/20 px-3 py-1.5">
          <Shield className="h-4 w-4 text-emerald-400" />
          <span className="text-xs font-semibold text-emerald-400">
            GDPR Compliant
          </span>
        </div>
      </header>

      {/* ---- Stats bar ---- */}
      <div className="border-b border-gray-800 px-6 py-3">
        {statsLoading ? (
          <div className="flex items-center gap-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-32" />
            ))}
          </div>
        ) : stats ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {statItems.map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.label} className="flex items-center gap-2">
                  <Icon className={cn("h-4 w-4", item.color)} />
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-sm font-bold text-gray-100">
                      {item.value}
                    </span>
                    <span className="text-[11px] text-gray-500">
                      {item.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-gray-600">
            Stats unavailable
          </p>
        )}
      </div>

      {/* ---- Search bar ---- */}
      <div className="border-b border-gray-800 px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSearch();
              }}
              placeholder="Search by appearance description... e.g. 'person in black hoodie with red backpack'"
              className="w-full rounded-lg border border-gray-700 bg-gray-900 pl-10 pr-4 py-2.5 text-sm text-gray-100 placeholder-gray-600 focus:border-emerald-700 focus:outline-none focus:ring-1 focus:ring-emerald-700"
            />
          </div>
          <button
            onClick={handleSearch}
            disabled={!searchQuery.trim() || searchLoading}
            className="flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {searchLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            Search
          </button>
          {searchResults !== null && (
            <button
              onClick={clearSearch}
              className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
            >
              <XCircle className="h-3.5 w-3.5" />
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ---- Search results overlay ---- */}
      {searchError && (
        <div className="mx-6 mt-3 flex items-center gap-2 rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400">
          <XCircle className="h-4 w-4 shrink-0" />
          {searchError}
        </div>
      )}

      {searchLoading && (
        <div className="px-6 py-4 space-y-3">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      )}

      {searchResults !== null && !searchLoading && (
        <div className="border-b border-gray-800 px-6 py-4 space-y-3 max-h-[50vh] overflow-y-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
              <ScanSearch className="h-4 w-4 text-emerald-400" />
              Search Results
              <span className="text-xs text-gray-500">
                ({searchResults.length} matches)
              </span>
            </div>
          </div>

          {searchResults.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10">
              <Shirt className="mb-2 h-8 w-8 text-gray-700" />
              <p className="text-sm text-gray-500">
                No matching profiles found
              </p>
              <p className="mt-1 text-xs text-gray-600">
                Try adjusting your description
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {searchResults.map((result) => (
                <ProfileCard
                  key={result.profile.id}
                  profile={result.profile}
                  matchScore={result.match_score}
                  onFlag={handleFlag}
                  flagLoading={flagLoading}
                  onSelect={setSelectedProfileId}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- Tab bar ---- */}
      <div className="flex items-center gap-1 border-b border-gray-800 px-6">
        <button
          onClick={() => setActiveTab("profiles")}
          className={cn(
            "relative px-4 py-3 text-sm font-medium transition-colors",
            activeTab === "profiles"
              ? "text-emerald-400"
              : "text-gray-500 hover:text-gray-300"
          )}
        >
          <span className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            Active Profiles
          </span>
          {activeTab === "profiles" && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 rounded-full" />
          )}
        </button>

        <button
          onClick={() => setActiveTab("tracking")}
          className={cn(
            "relative px-4 py-3 text-sm font-medium transition-colors",
            activeTab === "tracking"
              ? "text-emerald-400"
              : "text-gray-500 hover:text-gray-300"
          )}
        >
          <span className="flex items-center gap-2">
            <Crosshair className="h-4 w-4" />
            Cross-Camera Tracking
          </span>
          {activeTab === "tracking" && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 rounded-full" />
          )}
        </button>

        <button
          onClick={() => setActiveTab("gait")}
          className={cn(
            "relative px-4 py-3 text-sm font-medium transition-colors",
            activeTab === "gait"
              ? "text-emerald-400"
              : "text-gray-500 hover:text-gray-300"
          )}
        >
          <span className="flex items-center gap-2">
            <Footprints className="h-4 w-4" />
            Gait Analysis
          </span>
          {activeTab === "gait" && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 rounded-full" />
          )}
        </button>

        {/* Flagged only toggle (for profiles tab) */}
        {activeTab === "profiles" && (
          <label className="ml-auto flex items-center gap-2 text-xs text-gray-500 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={flaggedOnly}
              onChange={(e) => setFlaggedOnly(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-gray-600 bg-gray-800 text-emerald-500 focus:ring-emerald-700 focus:ring-offset-0"
            />
            <Flag className="h-3 w-3 text-red-500" />
            Flagged only
          </label>
        )}
      </div>

      {/* ---- Tab content ---- */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {/* ====== Profiles tab ====== */}
        {activeTab === "profiles" && (
          <>
            {/* Loading */}
            {profilesLoading && (
              <div className="space-y-3">
                <CardSkeleton />
                <CardSkeleton />
                <CardSkeleton />
              </div>
            )}

            {/* Error */}
            {!profilesLoading && profilesError && (
              <div className="flex flex-col items-center justify-center py-20">
                <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
                <p className="text-sm text-red-400">{profilesError}</p>
                <button
                  onClick={fetchProfiles}
                  className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
                >
                  Retry
                </button>
              </div>
            )}

            {/* Empty */}
            {!profilesLoading && !profilesError && profiles.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20">
                <Users className="mb-2 h-10 w-10 text-gray-700" />
                <p className="text-sm font-medium text-gray-400">
                  No active profiles
                </p>
                <p className="mt-1 text-xs text-gray-600">
                  {flaggedOnly
                    ? "No flagged profiles found. Try disabling the filter."
                    : "Re-identification profiles will appear here as persons are detected."}
                </p>
              </div>
            )}

            {/* Profile cards */}
            {!profilesLoading &&
              !profilesError &&
              profiles.map((profile) => (
                <ProfileCard
                  key={profile.id}
                  profile={profile}
                  onFlag={handleFlag}
                  flagLoading={flagLoading}
                  onSelect={setSelectedProfileId}
                />
              ))}
          </>
        )}

        {/* ====== Tracking tab ====== */}
        {activeTab === "tracking" && (
          <>
            {/* Loading */}
            {trackingLoading && (
              <div className="space-y-3">
                <CardSkeleton />
                <CardSkeleton />
                <CardSkeleton />
              </div>
            )}

            {/* Error */}
            {!trackingLoading && trackingError && (
              <div className="flex flex-col items-center justify-center py-20">
                <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
                <p className="text-sm text-red-400">{trackingError}</p>
                <button
                  onClick={() => {
                    setTrackingLoading(true);
                    setTrackingError(null);
                    apiFetch<TrackingEntry[]>("/api/reid/tracking-map")
                      .then(setTrackingMap)
                      .catch((err) =>
                        setTrackingError(
                          err instanceof Error
                            ? err.message
                            : "Failed to load tracking data"
                        )
                      )
                      .finally(() => setTrackingLoading(false));
                  }}
                  className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
                >
                  Retry
                </button>
              </div>
            )}

            {/* Empty */}
            {!trackingLoading && !trackingError && trackingMap.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20">
                <Crosshair className="mb-2 h-10 w-10 text-gray-700" />
                <p className="text-sm font-medium text-gray-400">
                  No cross-camera tracking data
                </p>
                <p className="mt-1 text-xs text-gray-600">
                  Cross-camera matches will appear here when a person is detected
                  across multiple cameras.
                </p>
              </div>
            )}

            {/* Tracking cards */}
            {!trackingLoading &&
              !trackingError &&
              trackingMap.map((entry) => (
                <TrackingCard key={entry.profile.id} entry={entry} />
              ))}
          </>
        )}

        {/* ====== Gait Analysis tab ====== */}
        {activeTab === "gait" && (
          <>
            {/* Buffer stats bar */}
            {gaitBufferStats && (
              <div className="flex items-center gap-6 rounded-lg border border-gray-800 bg-gray-900/50 px-5 py-3 mb-3">
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <Camera className="h-3.5 w-3.5 text-teal-500" />
                  <span className="font-semibold text-gray-300">{gaitBufferStats.cameras}</span> cameras tracked
                </div>
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <Users className="h-3.5 w-3.5 text-teal-500" />
                  <span className="font-semibold text-gray-300">{gaitBufferStats.tracked_persons}</span> persons buffered
                </div>
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <Activity className="h-3.5 w-3.5 text-teal-500" />
                  <span className="font-semibold text-gray-300">{gaitBufferStats.buffered_frames}</span> keypoint frames
                </div>
              </div>
            )}

            {/* Loading */}
            {gaitLoading && (
              <div className="space-y-3">
                <CardSkeleton />
                <CardSkeleton />
                <CardSkeleton />
              </div>
            )}

            {/* Error */}
            {!gaitLoading && gaitError && (
              <div className="flex flex-col items-center justify-center py-20">
                <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
                <p className="text-sm text-red-400">{gaitError}</p>
              </div>
            )}

            {/* Empty */}
            {!gaitLoading && !gaitError && gaitMatches.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20">
                <Footprints className="mb-2 h-10 w-10 text-gray-700" />
                <p className="text-sm font-medium text-gray-400">
                  No gait matches yet
                </p>
                <p className="mt-1 text-xs text-gray-600">
                  Cross-camera gait re-identification matches will appear here
                  when persons are tracked across multiple cameras.
                </p>
              </div>
            )}

            {/* Gait match cards */}
            {!gaitLoading &&
              !gaitError &&
              gaitMatches.map((match, idx) => (
                <div
                  key={`gait-${idx}`}
                  className="rounded-lg border border-teal-800/40 bg-teal-950/10 p-4 space-y-3"
                >
                  {/* Match header */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Footprints className="h-4 w-4 text-teal-400" />
                      <span className="text-sm font-semibold text-teal-300">
                        Gait Re-ID Match
                      </span>
                      <span className="rounded-full bg-teal-900/50 border border-teal-700/50 px-2 py-0.5 text-[10px] font-bold text-teal-400">
                        {(match.match_score * 100).toFixed(1)}% similarity
                      </span>
                    </div>
                    <span className="font-mono text-[10px] text-gray-500">
                      {formatTimestamp(match.timestamp)}
                    </span>
                  </div>

                  {/* Gait description */}
                  <p className="text-xs leading-relaxed text-gray-300">
                    {match.gait_description}
                  </p>

                  {/* Camera trail */}
                  <div className="flex items-center gap-2">
                    <div className="flex flex-col items-center rounded-lg border border-cyan-800/40 bg-cyan-950/30 px-4 py-2 min-w-[140px]">
                      <span className="flex items-center gap-1 text-xs font-medium text-cyan-300">
                        <Camera className="h-3 w-3" />
                        {match.source_camera}
                      </span>
                      <span className="mt-0.5 text-[10px] text-gray-500">
                        Track #{match.source_track_id}
                      </span>
                    </div>
                    <ArrowRight className="h-5 w-5 shrink-0 text-teal-600" />
                    <div className="flex flex-col items-center rounded-lg border border-emerald-800/40 bg-emerald-950/30 px-4 py-2 min-w-[140px]">
                      <span className="flex items-center gap-1 text-xs font-medium text-emerald-300">
                        <Camera className="h-3 w-3" />
                        {match.matched_camera}
                      </span>
                      <span className="mt-0.5 text-[10px] text-gray-500">
                        Track #{match.matched_track_id}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
          </>
        )}
      </div>

      {/* ---- Profile Detail Sidebar ---- */}
      {selectedProfileId && (
        <ProfileDetailPanel
          profileId={selectedProfileId}
          onClose={() => setSelectedProfileId(null)}
          onFlag={handleFlag}
          flagLoading={flagLoading}
          refreshKey={detailRefreshKey}
        />
      )}
    </div>
  );
}
