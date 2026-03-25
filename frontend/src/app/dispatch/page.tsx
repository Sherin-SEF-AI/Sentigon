"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Siren,
  Loader2,
  AlertTriangle,
  RefreshCw,
  MapPin,
  Clock,
  Zap,
  Shield,
  Flame,
  Ambulance,
  BadgeCheck,
  Radio,
  Truck,
  Plus,
  X,
  Send,
  CheckCircle2,
  RotateCcw,
  Timer,
  TrendingUp,
  Users,
  Activity,
  Sparkles,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import type { DispatchResource } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const STATUS_COLORS: Record<string, string> = {
  available: "text-green-400 bg-green-900/30 border-green-700/50",
  dispatched: "text-yellow-400 bg-yellow-900/30 border-yellow-700/50",
  en_route: "text-orange-400 bg-orange-900/30 border-orange-700/50",
  on_scene: "text-red-400 bg-red-900/30 border-red-700/50",
};

const STATUS_DOT_COLORS: Record<string, string> = {
  available: "bg-green-400",
  dispatched: "bg-yellow-400",
  en_route: "bg-orange-400 animate-pulse",
  on_scene: "bg-red-400 animate-pulse",
};

const TYPE_CONFIG: Record<
  string,
  { icon: React.ReactNode; color: string; bgColor: string }
> = {
  police: {
    icon: <Shield className="h-4 w-4" />,
    color: "text-blue-400",
    bgColor: "bg-blue-900/30 border-blue-700/50",
  },
  fire: {
    icon: <Flame className="h-4 w-4" />,
    color: "text-orange-400",
    bgColor: "bg-orange-900/30 border-orange-700/50",
  },
  ems: {
    icon: <Ambulance className="h-4 w-4" />,
    color: "text-red-400",
    bgColor: "bg-red-900/30 border-red-700/50",
  },
  security: {
    icon: <BadgeCheck className="h-4 w-4" />,
    color: "text-cyan-400",
    bgColor: "bg-cyan-900/30 border-cyan-700/50",
  },
};

function formatLocation(loc: Record<string, unknown>): string {
  if (loc?.lat && loc?.lng) {
    return `${Number(loc.lat ?? 0).toFixed(4)}, ${Number(loc.lng ?? 0).toFixed(4)}`;
  }
  if (loc?.zone) return String(loc.zone);
  if (loc?.address) return String(loc.address);
  if (loc?.name) return String(loc.name);
  return "Unknown";
}

/**
 * Calculate response time in minutes from dispatched_at to on_scene timestamps.
 * Both are expected as ISO strings inside the resource's current_location or
 * top-level metadata fields. Returns null if insufficient data.
 */
function calcResponseMinutes(resource: DispatchResource): number | null {
  const loc = resource.current_location as Record<string, unknown>;
  const dispatchedAt =
    (loc?.dispatched_at as string | undefined) ||
    (resource as unknown as Record<string, unknown>).dispatched_at as string | undefined;
  const onSceneAt =
    (loc?.on_scene_at as string | undefined) ||
    (resource as unknown as Record<string, unknown>).on_scene_at as string | undefined;

  if (!dispatchedAt) return null;
  const end = onSceneAt ? new Date(onSceneAt).getTime() : Date.now();
  const start = new Date(dispatchedAt).getTime();
  if (isNaN(start) || isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 60_000));
}

function responseTimeBadge(minutes: number): { label: string; cls: string } {
  if (minutes < 5)
    return {
      label: `${minutes}m`,
      cls: "bg-green-900/40 text-green-400 border-green-700/50",
    };
  if (minutes <= 15)
    return {
      label: `${minutes}m`,
      cls: "bg-amber-900/40 text-amber-400 border-amber-700/50",
    };
  return {
    label: `${minutes}m`,
    cls: "bg-red-900/40 text-red-400 border-red-700/50",
  };
}

/* Next valid statuses for a given current status */
const NEXT_STATUSES: Record<
  string,
  Array<{ status: string; label: string; color: string }>
> = {
  available: [
    {
      status: "dispatched",
      label: "Dispatch",
      color:
        "bg-yellow-700/30 border border-yellow-700/50 text-yellow-300 hover:bg-yellow-700/50",
    },
  ],
  dispatched: [
    {
      status: "en_route",
      label: "En Route",
      color:
        "bg-orange-700/30 border border-orange-700/50 text-orange-300 hover:bg-orange-700/50",
    },
    {
      status: "available",
      label: "Reassign",
      color:
        "bg-gray-700/40 border border-gray-600/50 text-gray-300 hover:bg-gray-600/50",
    },
  ],
  en_route: [
    {
      status: "on_scene",
      label: "On Scene",
      color:
        "bg-red-700/30 border border-red-700/50 text-red-300 hover:bg-red-700/50",
    },
    {
      status: "available",
      label: "Reassign",
      color:
        "bg-gray-700/40 border border-gray-600/50 text-gray-300 hover:bg-gray-600/50",
    },
  ],
  on_scene: [
    {
      status: "available",
      label: "Mark Complete",
      color:
        "bg-green-700/30 border border-green-700/50 text-green-300 hover:bg-green-700/50",
    },
  ],
};

/* ------------------------------------------------------------------ */
/*  Dispatch History Analytics Row                                     */
/* ------------------------------------------------------------------ */

interface DispatchAnalytics {
  totalDispatches24h: number;
  avgResponseMinutes: number | null;
  resourcesAvailable: number;
  activeDispatches: number;
}

function DispatchAnalyticsRow({ analytics }: { analytics: DispatchAnalytics }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {/* Total Dispatches 24h */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <Activity className="h-3.5 w-3.5 text-cyan-400" />
          <span className="text-[10px] uppercase tracking-wider text-gray-500">
            Dispatches (24h)
          </span>
        </div>
        <div className="text-xl font-bold text-gray-100">
          {analytics.totalDispatches24h}
        </div>
      </div>

      {/* Avg Response Time */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <Timer className="h-3.5 w-3.5 text-blue-400" />
          <span className="text-[10px] uppercase tracking-wider text-gray-500">
            Avg Response Time
          </span>
        </div>
        <div
          className={cn(
            "text-xl font-bold",
            analytics.avgResponseMinutes == null
              ? "text-gray-500"
              : analytics.avgResponseMinutes < 5
              ? "text-green-400"
              : analytics.avgResponseMinutes <= 15
              ? "text-amber-400"
              : "text-red-400"
          )}
        >
          {analytics.avgResponseMinutes != null
            ? `${analytics.avgResponseMinutes}m`
            : "---"}
        </div>
      </div>

      {/* Resources Available */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <Users className="h-3.5 w-3.5 text-green-400" />
          <span className="text-[10px] uppercase tracking-wider text-gray-500">
            Available
          </span>
        </div>
        <div className="text-xl font-bold text-green-400">
          {analytics.resourcesAvailable}
        </div>
      </div>

      {/* Active Dispatches */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <TrendingUp className="h-3.5 w-3.5 text-orange-400" />
          <span className="text-[10px] uppercase tracking-wider text-gray-500">
            Active Dispatches
          </span>
        </div>
        <div className="text-xl font-bold text-orange-400">
          {analytics.activeDispatches}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Auto-Assignment Suggestions Panel                                  */
/* ------------------------------------------------------------------ */

function SuggestedResourcesPanel({
  resources,
}: {
  resources: DispatchResource[];
}) {
  // Show available resources sorted by most recently updated (freed) first
  const suggested = useMemo(() => {
    return [...resources]
      .filter((r) => r.status === "available")
      .sort((a, b) => {
        const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        return tb - ta; // most recently freed first
      })
      .slice(0, 5);
  }, [resources]);

  if (suggested.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-700 bg-gray-900/20 px-4 py-5 text-center">
        <p className="text-xs text-gray-600">No available resources to suggest</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {suggested.map((r, idx) => {
        const typeConfig = TYPE_CONFIG[r.resource_type] || TYPE_CONFIG.security;
        return (
          <div
            key={r.id}
            className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2.5"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-800 text-[10px] font-bold text-gray-400">
              {idx + 1}
            </span>
            <span className={cn("shrink-0", typeConfig.color)}>
              {typeConfig.icon}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-gray-200 truncate">
                {r.name}
              </div>
              <div className="text-[10px] text-gray-500 capitalize">
                {r.resource_type === "ems" ? "EMS" : r.resource_type}
                {r.updated_at && (
                  <> · freed {new Date(r.updated_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}</>
                )}
              </div>
            </div>
            <span className="rounded px-2 py-0.5 text-[10px] font-bold uppercase border bg-green-900/30 text-green-400 border-green-700/50">
              Ready
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ResourceStatusBar                                                  */
/* ------------------------------------------------------------------ */

function ResourceStatusBar({
  resources,
}: {
  resources: DispatchResource[];
}) {
  const types: Array<"police" | "fire" | "ems" | "security"> = [
    "police",
    "fire",
    "ems",
    "security",
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {types.map((type) => {
        const typeResources = resources.filter(
          (r) => r.resource_type === type
        );
        const config = TYPE_CONFIG[type];
        const available = typeResources.filter(
          (r) => r.status === "available"
        ).length;
        const dispatched = typeResources.filter(
          (r) => r.status === "dispatched"
        ).length;
        const enRoute = typeResources.filter(
          (r) => r.status === "en_route"
        ).length;
        const onScene = typeResources.filter(
          (r) => r.status === "on_scene"
        ).length;

        return (
          <div
            key={type}
            className={cn(
              "rounded-xl border bg-gray-900/50 p-4 transition-all",
              config.bgColor
            )}
          >
            {/* Header */}
            <div className="flex items-center gap-2 mb-3">
              <span className={config.color}>{config.icon}</span>
              <h3 className="text-sm font-semibold capitalize text-gray-200">
                {type === "ems" ? "EMS" : type}
              </h3>
              <span className="ml-auto text-lg font-bold text-gray-300">
                {typeResources.length}
              </span>
            </div>

            {/* Status breakdown */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-green-400" />
                  <span className="text-gray-500">Available</span>
                </span>
                <span className="font-semibold text-green-400">
                  {available}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-yellow-400" />
                  <span className="text-gray-500">Dispatched</span>
                </span>
                <span className="font-semibold text-yellow-400">
                  {dispatched}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-orange-400" />
                  <span className="text-gray-500">En Route</span>
                </span>
                <span className="font-semibold text-orange-400">
                  {enRoute}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-red-400" />
                  <span className="text-gray-500">On Scene</span>
                </span>
                <span className="font-semibold text-red-400">{onScene}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  CreateResourceModal                                                */
/* ------------------------------------------------------------------ */

interface CreateResourceFormData {
  resource_type: "police" | "fire" | "ems" | "security";
  name: string;
  status: "available" | "dispatched" | "en_route" | "on_scene";
  eta_minutes: string;
}

function CreateResourceModal({
  onClose,
  onCreated,
  availableResources,
}: {
  onClose: () => void;
  onCreated: () => void;
  availableResources: DispatchResource[];
}) {
  const { addToast } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<CreateResourceFormData>({
    resource_type: "security",
    name: "",
    status: "available",
    eta_minutes: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      addToast("error", "Resource name is required");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/api/dispatch/resources", {
        method: "POST",
        body: JSON.stringify({
          resource_type: form.resource_type,
          name: form.name.trim(),
          status: form.status,
          current_location: {},
          eta_minutes: form.eta_minutes ? parseInt(form.eta_minutes, 10) : null,
        }),
      });
      addToast("success", `Resource "${form.name.trim()}" created successfully`);
      onCreated();
      onClose();
    } catch (err) {
      addToast(
        "error",
        err instanceof Error ? err.message : "Failed to create resource"
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border border-gray-700 bg-gray-900 p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-100">
            Add Dispatch Resource
          </h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">
              Resource Name *
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Unit Alpha-7"
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-600 focus:outline-none"
              required
            />
          </div>

          {/* Type */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">
              Resource Type
            </label>
            <select
              value={form.resource_type}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  resource_type: e.target.value as CreateResourceFormData["resource_type"],
                }))
              }
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-cyan-600 focus:outline-none"
            >
              <option value="security">Security</option>
              <option value="police">Police</option>
              <option value="fire">Fire</option>
              <option value="ems">EMS</option>
            </select>
          </div>

          {/* Status */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">
              Initial Status
            </label>
            <select
              value={form.status}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  status: e.target.value as CreateResourceFormData["status"],
                }))
              }
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-cyan-600 focus:outline-none"
            >
              <option value="available">Available</option>
              <option value="dispatched">Dispatched</option>
              <option value="en_route">En Route</option>
              <option value="on_scene">On Scene</option>
            </select>
          </div>

          {/* ETA */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">
              ETA (minutes, optional)
            </label>
            <input
              type="number"
              min="0"
              value={form.eta_minutes}
              onChange={(e) =>
                setForm((f) => ({ ...f, eta_minutes: e.target.value }))
              }
              placeholder="e.g. 8"
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-600 focus:outline-none"
            />
          </div>

          {/* Suggested Resources section */}
          {availableResources.length > 0 && (
            <div>
              <label className="mb-2 flex items-center gap-1.5 text-xs font-medium text-gray-400">
                <Sparkles className="h-3.5 w-3.5 text-cyan-500" />
                Suggested Available Resources
              </label>
              <SuggestedResourcesPanel resources={availableResources} />
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="flex-1 rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all",
                "bg-cyan-600 text-white border border-cyan-500",
                "hover:bg-cyan-500",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Create Resource
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  RecommendPanel                                                     */
/* ------------------------------------------------------------------ */

function RecommendPanel({ availableResources }: { availableResources: DispatchResource[] }) {
  const { addToast } = useToast();
  const [recommending, setRecommending] = useState(false);
  const [recommendation, setRecommendation] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const [alertId, setAlertId] = useState("");
  const [threatType, setThreatType] = useState("intrusion");
  const [severity, setSeverity] = useState("medium");

  const handleRecommend = async () => {
    if (!alertId.trim()) {
      addToast("error", "Alert ID is required for a recommendation");
      return;
    }
    setRecommending(true);
    setRecommendation(null);
    try {
      const result = await apiFetch<Record<string, unknown>>(
        "/api/dispatch/recommend",
        {
          method: "POST",
          body: JSON.stringify({
            alert_id: alertId.trim(),
            threat_type: threatType,
            severity,
          }),
        }
      );
      setRecommendation(result);
      addToast("success", "Dispatch recommendation generated");
    } catch (err) {
      addToast(
        "error",
        err instanceof Error ? err.message : "Failed to get dispatch recommendation"
      );
    } finally {
      setRecommending(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-200">
          AI Dispatch Recommendation
        </h3>
        <p className="mt-0.5 text-xs text-gray-500">
          Analyze current incidents and resource availability to suggest
          optimal dispatch assignments
        </p>
      </div>

      {/* Inputs */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            Alert ID *
          </label>
          <input
            type="text"
            value={alertId}
            onChange={(e) => setAlertId(e.target.value)}
            placeholder="UUID of the alert"
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-gray-100 placeholder-gray-600 focus:border-cyan-600 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            Threat Type
          </label>
          <input
            type="text"
            value={threatType}
            onChange={(e) => setThreatType(e.target.value)}
            placeholder="e.g. intrusion, weapon"
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-gray-100 placeholder-gray-600 focus:border-cyan-600 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            Severity
          </label>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-gray-100 focus:border-cyan-600 focus:outline-none"
          >
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        {/* Suggested Resources toggle */}
        <button
          onClick={() => setShowSuggestions((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
        >
          <Sparkles className="h-3.5 w-3.5 text-cyan-500" />
          {showSuggestions ? "Hide" : "Show"} Suggested Resources
          {availableResources.filter((r) => r.status === "available").length > 0 && (
            <span className="ml-1 rounded-full bg-cyan-900/50 px-1.5 py-0.5 text-[9px] font-bold text-cyan-400 border border-cyan-800/50">
              {availableResources.filter((r) => r.status === "available").length}
            </span>
          )}
        </button>

        <button
          onClick={handleRecommend}
          disabled={recommending}
          className={cn(
            "flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold transition-all",
            "bg-cyan-600 text-white border border-cyan-500",
            "hover:bg-cyan-500 hover:shadow-lg hover:shadow-cyan-500/20",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
        >
          {recommending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Zap className="h-4 w-4" />
          )}
          Recommend Dispatch
        </button>
      </div>

      {/* Suggested Resources */}
      {showSuggestions && (
        <div className="mt-4 rounded-lg border border-gray-800 bg-gray-950/40 p-4">
          <h4 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
            <Sparkles className="h-3.5 w-3.5 text-cyan-500" />
            Suggested Resources (Most Recently Available)
          </h4>
          <SuggestedResourcesPanel resources={availableResources} />
        </div>
      )}

      {/* Recommendation result */}
      {recommendation && (
        <div className="mt-4 rounded-lg border border-cyan-800/50 bg-cyan-950/20 p-4">
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-cyan-400">
            <Zap className="h-3.5 w-3.5" />
            Recommendation
          </h4>
          <pre className="overflow-x-auto text-xs text-cyan-300/80 whitespace-pre-wrap">
            {JSON.stringify(recommendation, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  DispatchPage                                                       */
/* ------------------------------------------------------------------ */

export default function DispatchPage() {
  const { addToast } = useToast();
  const [resources, setResources] = useState<DispatchResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Track which resource+action button is currently in-flight: key = `${id}-${status}`
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  /* --- Fetch data --- */
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<DispatchResource[]>(
        "/api/dispatch/resources"
      );
      setResources(data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to fetch dispatch resources"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /* --- Update resource status --- */
  const handleStatusUpdate = useCallback(
    async (resourceId: string, newStatus: string, label: string) => {
      const key = `${resourceId}-${newStatus}`;
      setActionLoading(key);
      try {
        await apiFetch(`/api/dispatch/resources/${resourceId}/status`, {
          method: "PUT",
          body: JSON.stringify({ status: newStatus }),
        });
        addToast("success", `Resource ${label} — status updated to ${newStatus.replace("_", " ")}`);
        // Optimistic update in local state
        setResources((prev) =>
          prev.map((r) =>
            r.id === resourceId ? { ...r, status: newStatus as DispatchResource["status"] } : r
          )
        );
      } catch (err) {
        addToast(
          "error",
          err instanceof Error ? err.message : `Failed to update status to ${newStatus}`
        );
      } finally {
        setActionLoading(null);
        // Re-fetch to sync server state
        fetchData();
      }
    },
    [addToast, fetchData]
  );

  /* --- Derived --- */
  const totalResources = resources.length;
  const availableCount = useMemo(
    () => resources.filter((r) => r.status === "available").length,
    [resources]
  );
  const activeCount = useMemo(
    () => resources.filter((r) => r.status !== "available").length,
    [resources]
  );

  /* --- Dispatch Analytics (calculated from resource data) --- */
  const dispatchAnalytics = useMemo<DispatchAnalytics>(() => {
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;

    // Count resources updated in last 24h that are not available (proxy for dispatched)
    const dispatched24h = resources.filter((r) => {
      if (!r.updated_at) return false;
      return new Date(r.updated_at).getTime() >= twentyFourHoursAgo &&
        r.status !== "available";
    });

    // Avg response time from resources that have response data
    const responseTimes = resources
      .map(calcResponseMinutes)
      .filter((m): m is number => m !== null);
    const avgResponseMinutes =
      responseTimes.length > 0
        ? Math.round(
            responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
          )
        : null;

    return {
      totalDispatches24h: dispatched24h.length,
      avgResponseMinutes,
      resourcesAvailable: availableCount,
      activeDispatches: activeCount,
    };
  }, [resources, availableCount, activeCount]);

  /* --- Render --- */
  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-900/30 border border-red-800/50">
            <Siren className="h-5 w-5 text-red-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Emergency Dispatch
            </h1>
            <p className="text-xs text-gray-500">
              Coordinate and deploy emergency response resources in real-time
            </p>
          </div>
        </div>

        {/* Right side: quick stats + actions */}
        <div className="flex items-center gap-4">
          <div className="hidden items-center gap-4 text-xs text-gray-500 md:flex">
            <span>
              <span className="font-semibold text-gray-300">
                {totalResources}
              </span>{" "}
              resources
            </span>
            <span className="text-gray-700">|</span>
            <span>
              <span className="font-semibold text-green-400">
                {availableCount}
              </span>{" "}
              available
            </span>
            <span className="text-gray-700">|</span>
            <span>
              <span className="font-semibold text-orange-400">
                {activeCount}
              </span>{" "}
              deployed
            </span>
          </div>

          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            Refresh
          </button>

          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 rounded-lg bg-cyan-700/30 border border-cyan-700/50 px-3 py-1.5 text-xs font-semibold text-cyan-300 hover:bg-cyan-700/50 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Resource
          </button>
        </div>
      </div>

      {/* ---- Loading ---- */}
      {loading && (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          <span className="ml-3 text-sm text-gray-500">
            Loading dispatch resources...
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

          {/* Dispatch History Analytics Row */}
          <DispatchAnalyticsRow analytics={dispatchAnalytics} />

          {/* Resource Status Bar */}
          <ResourceStatusBar resources={resources} />

          {/* Resource Table */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/50">
            <div className="flex items-center justify-between border-b border-gray-800 px-5 py-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-cyan-400">
                <Radio className="h-4 w-4" />
                All Resources
              </h2>
              <span className="text-xs text-gray-500">
                {resources.length} total
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    <th className="px-5 py-3">Name</th>
                    <th className="px-5 py-3">Type</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3">Location</th>
                    <th className="px-5 py-3">ETA</th>
                    <th className="px-5 py-3">Response</th>
                    <th className="px-5 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {resources.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-5 py-10 text-center text-gray-600"
                      >
                        No dispatch resources available
                      </td>
                    </tr>
                  )}
                  {resources.map((resource) => {
                    const typeConfig =
                      TYPE_CONFIG[resource.resource_type] ||
                      TYPE_CONFIG.security;
                    const nextActions = NEXT_STATUSES[resource.status] ?? [];
                    const responseMinutes = calcResponseMinutes(resource);
                    const isDeployed =
                      resource.status === "dispatched" ||
                      resource.status === "en_route" ||
                      resource.status === "on_scene";

                    return (
                      <tr
                        key={resource.id}
                        className="border-b border-gray-800/50 transition-colors hover:bg-gray-900/80"
                      >
                        {/* Name */}
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <Truck className="h-3.5 w-3.5 text-gray-600" />
                            <span className="text-sm font-medium text-gray-200">
                              {resource.name}
                            </span>
                          </div>
                        </td>

                        {/* Type */}
                        <td className="px-5 py-3">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider border",
                              typeConfig.bgColor
                            )}
                          >
                            <span className={typeConfig.color}>
                              {typeConfig.icon}
                            </span>
                            <span className={typeConfig.color}>
                              {resource.resource_type === "ems"
                                ? "EMS"
                                : resource.resource_type}
                            </span>
                          </span>
                        </td>

                        {/* Status */}
                        <td className="px-5 py-3">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider border",
                              STATUS_COLORS[resource.status] ||
                                STATUS_COLORS.available
                            )}
                          >
                            <span
                              className={cn(
                                "h-2 w-2 rounded-full",
                                STATUS_DOT_COLORS[resource.status] ||
                                  "bg-gray-400"
                              )}
                            />
                            {resource.status.replace("_", " ")}
                          </span>
                        </td>

                        {/* Location */}
                        <td className="px-5 py-3">
                          <span className="flex items-center gap-1 text-xs text-gray-400">
                            <MapPin className="h-3 w-3 text-gray-600" />
                            {formatLocation(resource.current_location)}
                          </span>
                        </td>

                        {/* ETA */}
                        <td className="px-5 py-3">
                          {resource.eta_minutes != null ? (
                            <span className="flex items-center gap-1 text-xs">
                              <Clock className="h-3 w-3 text-gray-600" />
                              <span
                                className={cn(
                                  "font-mono font-semibold",
                                  resource.eta_minutes <= 5
                                    ? "text-green-400"
                                    : resource.eta_minutes <= 15
                                    ? "text-yellow-400"
                                    : "text-orange-400"
                                )}
                              >
                                {resource.eta_minutes}
                              </span>
                              <span className="text-gray-600">min</span>
                            </span>
                          ) : (
                            <span className="text-xs text-gray-600">---</span>
                          )}
                        </td>

                        {/* Response Time Badge */}
                        <td className="px-5 py-3">
                          {isDeployed && responseMinutes !== null ? (
                            (() => {
                              const badge = responseTimeBadge(responseMinutes);
                              return (
                                <span
                                  className={cn(
                                    "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold border",
                                    badge.cls
                                  )}
                                >
                                  <Timer className="h-2.5 w-2.5" />
                                  Response: {badge.label}
                                </span>
                              );
                            })()
                          ) : (
                            <span className="text-xs text-gray-600">---</span>
                          )}
                        </td>

                        {/* Actions */}
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            {nextActions.map((action) => {
                              const key = `${resource.id}-${action.status}`;
                              const isLoading = actionLoading === key;
                              return (
                                <button
                                  key={action.status}
                                  onClick={() =>
                                    handleStatusUpdate(
                                      resource.id,
                                      action.status,
                                      resource.name
                                    )
                                  }
                                  disabled={isLoading || actionLoading !== null}
                                  className={cn(
                                    "inline-flex items-center gap-1 rounded px-2.5 py-1 text-[10px] font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed",
                                    action.color
                                  )}
                                >
                                  {isLoading ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : action.status === "available" &&
                                    resource.status === "on_scene" ? (
                                    <CheckCircle2 className="h-3 w-3" />
                                  ) : action.status === "available" ? (
                                    <RotateCcw className="h-3 w-3" />
                                  ) : action.status === "dispatched" ? (
                                    <Send className="h-3 w-3" />
                                  ) : null}
                                  {action.label}
                                </button>
                              );
                            })}
                            {nextActions.length === 0 && (
                              <span className="text-[10px] text-gray-700 italic">
                                —
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Recommend Dispatch */}
          <RecommendPanel availableResources={resources} />
        </div>
      )}

      {/* ---- Create Resource Modal ---- */}
      {showCreateModal && (
        <CreateResourceModal
          onClose={() => setShowCreateModal(false)}
          onCreated={fetchData}
          availableResources={resources}
        />
      )}
    </div>
  );
}
