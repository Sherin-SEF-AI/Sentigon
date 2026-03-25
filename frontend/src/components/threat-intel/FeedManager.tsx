"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Rss,
  Plus,
  Trash2,
  RefreshCw,
  Loader2,
  ChevronDown,
  X,
  CheckCircle2,
  AlertTriangle,
  Globe,
  Webhook,
  Clock,
  ToggleLeft,
  ToggleRight,
  ExternalLink,
} from "lucide-react";
import { cn, apiFetch, severityColor } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ThreatFeed {
  id: string;
  name: string;
  feed_type: "webhook_incoming" | "api_poll" | "rss" | "manual";
  url: string;
  api_key?: string;
  poll_interval_seconds: number;
  default_severity: string;
  is_active: boolean;
  last_poll_at: string | null;
  last_poll_status: string | null;
  created_at?: string;
}

interface NewFeedForm {
  name: string;
  feed_type: "webhook_incoming" | "api_poll" | "rss" | "manual";
  url: string;
  api_key: string;
  poll_interval_seconds: number;
  default_severity: string;
  is_active: boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CARD = "rounded-lg border border-gray-800 bg-gray-900/60 backdrop-blur p-4";

const FEED_TYPE_OPTIONS: { value: NewFeedForm["feed_type"]; label: string }[] = [
  { value: "webhook_incoming", label: "Webhook (Incoming)" },
  { value: "api_poll", label: "API Poll" },
  { value: "rss", label: "RSS" },
  { value: "manual", label: "Manual" },
];

const SEVERITY_OPTIONS = ["critical", "high", "medium", "low", "info"];

const EMPTY_FORM: NewFeedForm = {
  name: "",
  feed_type: "api_poll",
  url: "",
  api_key: "",
  poll_interval_seconds: 300,
  default_severity: "medium",
  is_active: true,
};

const FEED_TYPE_ICON: Record<string, typeof Rss> = {
  webhook_incoming: Webhook,
  api_poll: Globe,
  rss: Rss,
  manual: Clock,
};

const FEED_TYPE_COLOR: Record<string, string> = {
  webhook_incoming: "text-purple-400 bg-purple-900/30 border-purple-800/50",
  api_poll: "text-cyan-400 bg-cyan-900/30 border-cyan-800/50",
  rss: "text-orange-400 bg-orange-900/30 border-orange-800/50",
  manual: "text-gray-400 bg-gray-800 border-gray-700",
};

const POLL_STATUS_STYLE: Record<string, string> = {
  success: "text-green-400",
  error: "text-red-400",
  pending: "text-yellow-400",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function truncateUrl(url: string, maxLen = 40): string {
  if (!url) return "--";
  if (url.length <= maxLen) return url;
  return url.slice(0, maxLen - 3) + "...";
}

function timeAgo(iso: string | null): string {
  if (!iso) return "Never";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/* ------------------------------------------------------------------ */
/*  Feed Type Badge                                                    */
/* ------------------------------------------------------------------ */

function FeedTypeBadge({ type }: { type: string }) {
  const Icon = FEED_TYPE_ICON[type] || Rss;
  const color = FEED_TYPE_COLOR[type] || FEED_TYPE_COLOR.manual;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        color
      )}
    >
      <Icon className="h-3 w-3" />
      {type.replace(/_/g, " ")}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Severity Badge                                                     */
/* ------------------------------------------------------------------ */

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
        severityColor(severity)
      )}
    >
      {severity}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Inline Add Feed Form                                               */
/* ------------------------------------------------------------------ */

function AddFeedForm({
  onSubmit,
  onCancel,
  submitting,
}: {
  onSubmit: (form: NewFeedForm) => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const [form, setForm] = useState<NewFeedForm>({ ...EMPTY_FORM });

  const updateField = <K extends keyof NewFeedForm>(
    key: K,
    value: NewFeedForm[K]
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = () => {
    if (!form.name.trim()) return;
    onSubmit(form);
  };

  const isValid = form.name.trim().length > 0;

  return (
    <div className={cn(CARD, "border-cyan-800/50 bg-cyan-950/10")}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-200">
          <Plus className="h-4 w-4 text-cyan-400" />
          Add New Feed
        </h3>
        <button
          onClick={onCancel}
          className="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-300"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-4">
        {/* Row 1: Name + Feed Type */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
              Feed Name *
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => updateField("name", e.target.value)}
              placeholder="e.g., AlienVault OTX"
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-sm text-gray-100 placeholder-gray-600 outline-none transition-colors focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700/50"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
              Feed Type
            </label>
            <div className="relative">
              <select
                value={form.feed_type}
                onChange={(e) =>
                  updateField("feed_type", e.target.value as NewFeedForm["feed_type"])
                }
                className="w-full appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2.5 text-sm text-gray-300 outline-none focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700/50"
              >
                {FEED_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
            </div>
          </div>
        </div>

        {/* Row 2: URL + API Key */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
              URL
            </label>
            <input
              type="text"
              value={form.url}
              onChange={(e) => updateField("url", e.target.value)}
              placeholder="https://feeds.example.com/api/v1"
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-sm text-gray-100 placeholder-gray-600 outline-none transition-colors focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700/50"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
              API Key
            </label>
            <input
              type="password"
              value={form.api_key}
              onChange={(e) => updateField("api_key", e.target.value)}
              placeholder="Optional API key"
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-sm text-gray-100 placeholder-gray-600 outline-none transition-colors focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700/50"
            />
          </div>
        </div>

        {/* Row 3: Poll Interval + Default Severity + Active */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
              Poll Interval (seconds)
            </label>
            <input
              type="number"
              min={30}
              step={30}
              value={form.poll_interval_seconds}
              onChange={(e) =>
                updateField("poll_interval_seconds", Number(e.target.value))
              }
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-sm text-gray-100 outline-none transition-colors focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700/50"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
              Default Severity
            </label>
            <div className="relative">
              <select
                value={form.default_severity}
                onChange={(e) => updateField("default_severity", e.target.value)}
                className="w-full appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2.5 text-sm text-gray-300 outline-none focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700/50"
              >
                {SEVERITY_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
            </div>
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => updateField("is_active", !form.is_active)}
              className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-sm transition-colors hover:bg-gray-800"
            >
              {form.is_active ? (
                <ToggleRight className="h-5 w-5 text-green-400" />
              ) : (
                <ToggleLeft className="h-5 w-5 text-gray-500" />
              )}
              <span
                className={cn(
                  "text-xs font-medium",
                  form.is_active ? "text-green-400" : "text-gray-500"
                )}
              >
                {form.is_active ? "Active" : "Inactive"}
              </span>
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 border-t border-gray-800 pt-4">
          <button
            onClick={onCancel}
            className="rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 text-xs font-medium text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!isValid || submitting}
            className={cn(
              "flex items-center gap-2 rounded-lg px-5 py-2 text-xs font-semibold transition-colors",
              "bg-cyan-600 text-white hover:bg-cyan-500",
              "disabled:opacity-40 disabled:cursor-not-allowed"
            )}
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            Save Feed
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

export default function FeedManager({ className }: { className?: string }) {
  const [feeds, setFeeds] = useState<ThreatFeed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  /* --- Fetch feeds --- */
  const fetchFeeds = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<ThreatFeed[]>("/api/threat-intel/feeds");
      setFeeds(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load feeds");
      setFeeds([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFeeds();
  }, [fetchFeeds]);

  /* --- Create feed --- */
  const handleCreate = useCallback(
    async (form: NewFeedForm) => {
      setSubmitting(true);
      try {
        await apiFetch<ThreatFeed>("/api/threat-intel/feeds", {
          method: "POST",
          body: JSON.stringify(form),
        });
        setShowAddForm(false);
        await fetchFeeds();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create feed");
      } finally {
        setSubmitting(false);
      }
    },
    [fetchFeeds]
  );

  /* --- Delete feed --- */
  const handleDelete = useCallback(
    async (id: string) => {
      setDeletingId(id);
      try {
        await apiFetch<void>(`/api/threat-intel/feeds/${id}`, {
          method: "DELETE",
        });
        await fetchFeeds();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete feed");
      } finally {
        setDeletingId(null);
      }
    },
    [fetchFeeds]
  );

  /* --- Render --- */
  return (
    <div className={cn("space-y-4", className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
            <Rss className="h-5 w-5 text-cyan-400" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-gray-100">Feed Manager</h2>
            <p className="text-xs text-gray-500">
              Configure and monitor threat intelligence feeds
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fetchFeeds}
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
          {!showAddForm && (
            <button
              onClick={() => setShowAddForm(true)}
              className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-cyan-500"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Feed
            </button>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-800/50 bg-red-950/20 px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
          <p className="flex-1 text-xs text-red-400">{error}</p>
          <button
            onClick={() => setError(null)}
            className="rounded p-1 text-red-500 hover:text-red-300 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Inline Add Form */}
      {showAddForm && (
        <AddFeedForm
          onSubmit={handleCreate}
          onCancel={() => setShowAddForm(false)}
          submitting={submitting}
        />
      )}

      {/* Feed Table */}
      <div className={CARD}>
        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
            <p className="mt-3 text-xs text-gray-500">Loading feeds...</p>
          </div>
        )}

        {/* Empty */}
        {!loading && feeds.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center py-12">
            <Rss className="mb-2 h-8 w-8 text-gray-700" />
            <p className="text-sm font-medium text-gray-400">
              No feeds configured
            </p>
            <p className="mt-1 text-xs text-gray-600">
              Add a feed to start ingesting threat intelligence
            </p>
          </div>
        )}

        {/* Table */}
        {!loading && feeds.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="pb-3 pr-4 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                    Name
                  </th>
                  <th className="pb-3 pr-4 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                    Type
                  </th>
                  <th className="pb-3 pr-4 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                    URL
                  </th>
                  <th className="pb-3 pr-4 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                    Severity
                  </th>
                  <th className="pb-3 pr-4 text-[10px] font-bold uppercase tracking-widest text-gray-500 text-center">
                    Active
                  </th>
                  <th className="pb-3 pr-4 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                    Last Poll
                  </th>
                  <th className="pb-3 pr-4 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                    Status
                  </th>
                  <th className="pb-3 text-[10px] font-bold uppercase tracking-widest text-gray-500 text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {feeds.map((feed) => (
                  <tr
                    key={feed.id}
                    className="group transition-colors hover:bg-gray-800/30"
                  >
                    {/* Name */}
                    <td className="py-3 pr-4">
                      <span className="text-sm font-medium text-gray-200">
                        {feed.name}
                      </span>
                    </td>

                    {/* Type */}
                    <td className="py-3 pr-4">
                      <FeedTypeBadge type={feed.feed_type} />
                    </td>

                    {/* URL */}
                    <td className="py-3 pr-4">
                      <span
                        className="flex items-center gap-1 text-xs font-mono text-gray-400"
                        title={feed.url}
                      >
                        <ExternalLink className="h-3 w-3 shrink-0 text-gray-600" />
                        {truncateUrl(feed.url)}
                      </span>
                    </td>

                    {/* Severity */}
                    <td className="py-3 pr-4">
                      <SeverityBadge severity={feed.default_severity} />
                    </td>

                    {/* Active toggle */}
                    <td className="py-3 pr-4 text-center">
                      {feed.is_active ? (
                        <span className="inline-flex items-center gap-1 text-green-400">
                          <ToggleRight className="h-5 w-5" />
                          <span className="text-[10px] font-semibold uppercase">
                            On
                          </span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-gray-500">
                          <ToggleLeft className="h-5 w-5" />
                          <span className="text-[10px] font-semibold uppercase">
                            Off
                          </span>
                        </span>
                      )}
                    </td>

                    {/* Last poll */}
                    <td className="py-3 pr-4">
                      <span className="flex items-center gap-1 text-xs text-gray-500">
                        <Clock className="h-3 w-3" />
                        {timeAgo(feed.last_poll_at)}
                      </span>
                    </td>

                    {/* Poll status */}
                    <td className="py-3 pr-4">
                      {feed.last_poll_status ? (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 text-xs font-medium capitalize",
                            POLL_STATUS_STYLE[feed.last_poll_status] ||
                              "text-gray-400"
                          )}
                        >
                          {feed.last_poll_status === "success" && (
                            <CheckCircle2 className="h-3 w-3" />
                          )}
                          {feed.last_poll_status === "error" && (
                            <AlertTriangle className="h-3 w-3" />
                          )}
                          {feed.last_poll_status}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-600">--</span>
                      )}
                    </td>

                    {/* Delete */}
                    <td className="py-3 text-right">
                      <button
                        onClick={() => handleDelete(feed.id)}
                        disabled={deletingId === feed.id}
                        className={cn(
                          "rounded-lg p-2 text-gray-600 transition-colors",
                          "hover:bg-red-900/30 hover:text-red-400",
                          "disabled:opacity-40 disabled:cursor-not-allowed"
                        )}
                        title="Delete feed"
                      >
                        {deletingId === feed.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Footer count */}
        {!loading && feeds.length > 0 && (
          <div className="mt-4 flex items-center justify-between border-t border-gray-800 pt-3">
            <span className="text-xs text-gray-600">
              {feeds.length} feed{feeds.length !== 1 ? "s" : ""} configured
            </span>
            <span className="flex items-center gap-1.5 text-xs text-gray-600">
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  feeds.some((f) => f.is_active)
                    ? "bg-green-400"
                    : "bg-gray-600"
                )}
              />
              {feeds.filter((f) => f.is_active).length} active
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
