"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Users,
  UserPlus,
  UserCheck,
  UserX,
  Search,
  Clock,
  QrCode,
  AlertTriangle,
  Shield,
  ChevronDown,
  Loader2,
  X,
  Eye,
  LogOut,
  Phone,
  Mail,
  Building2,
  MapPin,
  Calendar,
  ShieldAlert,
  Trash2,
  Plus,
  CheckCircle2,
  BarChart2,
  Bell,
  RefreshCw,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";
import FileUpload from "@/components/common/FileUpload";
import { useToast } from "@/components/common/Toaster";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface VisitorStats {
  checked_in: number;
  today_total: number;
  overstays: number;
  watchlist_matches: number;
}

interface Visitor {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company: string;
  host: string;
  purpose: string;
  visitor_type: string;
  status: "pre_registered" | "checked_in" | "checked_out" | "overstay" | "denied";
  qr_code_url: string | null;
  photo_url: string | null;
  expected_checkout: string | null;
  checked_in_at: string | null;
  checked_out_at: string | null;
  escort_required: boolean;
  zones: string[];
  watchlist_match: boolean;
  created_at: string;
}

interface WatchlistEntry {
  id: string;
  first_name: string;
  last_name: string;
  reason: string;
  added_by: string;
  created_at: string;
  photo_url: string | null;
}

interface AccessLogEntry {
  id: string;
  action: string;
  zone: string;
  timestamp: string;
  details: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TABS = ["active", "all", "pre-register", "watchlist", "analytics"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  active: "Active",
  all: "All Visitors",
  "pre-register": "Pre-Register",
  watchlist: "Watchlist",
  analytics: "Analytics",
};

const STATUS_BADGE: Record<string, string> = {
  pre_registered: "text-blue-400 bg-blue-900/30",
  checked_in: "text-green-400 bg-green-900/30",
  checked_out: "text-gray-400 bg-gray-800",
  overstay: "text-red-400 bg-red-900/30",
  denied: "text-red-500 bg-red-900/40",
};

const VISITOR_TYPES = [
  "guest",
  "contractor",
  "delivery",
  "vendor",
  "interview",
  "vip",
  "other",
];

const PAGE_SIZE = 20;

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

/** Returns overstay string like "Overstay: 2h 15m" if past expected_checkout, else null */
function getOverstayLabel(visitor: Visitor): string | null {
  if (!visitor.expected_checkout || !visitor.checked_in_at) return null;
  if (visitor.status === "checked_out") return null;
  const expected = new Date(visitor.expected_checkout).getTime();
  const now = Date.now();
  if (now <= expected) return null;
  const diffMs = now - expected;
  const totalMins = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return hours > 0 ? `Overstay: ${hours}h ${mins}m` : `Overstay: ${mins}m`;
}

/* ------------------------------------------------------------------ */
/*  Analytics Tab                                                      */
/* ------------------------------------------------------------------ */

function VisitorAnalyticsTab({ visitors }: { visitors: Visitor[] }) {
  /* Visit volume by day — last 7 days */
  const visitsByDay = useMemo(() => {
    const days: { label: string; date: string; count: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      days.push({ label, date: dateStr, count: 0 });
    }
    visitors.forEach((v) => {
      const createdDate = v.created_at?.slice(0, 10) || v.checked_in_at?.slice(0, 10);
      if (!createdDate) return;
      const slot = days.find((d) => d.date === createdDate);
      if (slot) slot.count++;
    });
    return days;
  }, [visitors]);

  const maxDayCount = useMemo(() => Math.max(1, ...visitsByDay.map((d) => d.count)), [visitsByDay]);

  /* Average visit duration (for checked_out visitors with both timestamps) */
  const avgDurationMin = useMemo(() => {
    const durations: number[] = visitors
      .filter((v) => v.checked_in_at && v.checked_out_at)
      .map((v) => {
        const inMs = new Date(v.checked_in_at!).getTime();
        const outMs = new Date(v.checked_out_at!).getTime();
        return (outMs - inMs) / 60000;
      })
      .filter((d) => d > 0);
    if (durations.length === 0) return null;
    return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  }, [visitors]);

  /* Peak visiting hours histogram (0-23) */
  const visitsByHour = useMemo(() => {
    const counts = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));
    visitors.forEach((v) => {
      const ts = v.checked_in_at || v.created_at;
      if (!ts) return;
      try {
        const h = new Date(ts).getHours();
        counts[h].count++;
      } catch { /* skip */ }
    });
    return counts;
  }, [visitors]);

  const maxHourCount = useMemo(() => Math.max(1, ...visitsByHour.map((h) => h.count)), [visitsByHour]);

  /* Repeat visitors — same email appearing more than once */
  const repeatVisitorCount = useMemo(() => {
    const emailCount: Record<string, number> = {};
    visitors.forEach((v) => {
      if (v.email) emailCount[v.email.toLowerCase()] = (emailCount[v.email.toLowerCase()] || 0) + 1;
    });
    return Object.values(emailCount).filter((c) => c > 1).length;
  }, [visitors]);

  if (visitors.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <BarChart2 className="mb-2 h-10 w-10 text-gray-700" />
        <p className="text-sm text-gray-500">No visitor data to analyse yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-8">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-gray-800 bg-zinc-900/60 p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Total (loaded)</p>
          <p className="mt-1 text-2xl font-bold text-gray-100">{visitors.length}</p>
        </div>
        <div className="rounded-lg border border-gray-800 bg-zinc-900/60 p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Avg Duration</p>
          <p className="mt-1 text-2xl font-bold text-gray-100">
            {avgDurationMin === null
              ? "---"
              : avgDurationMin >= 60
              ? `${Math.floor(avgDurationMin / 60)}h ${avgDurationMin % 60}m`
              : `${avgDurationMin}m`}
          </p>
        </div>
        <div className="rounded-lg border border-blue-900/40 bg-blue-950/20 p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-blue-400/80">Repeat Visitors</p>
          <p className="mt-1 text-2xl font-bold text-blue-400">{repeatVisitorCount}</p>
        </div>
        <div className="rounded-lg border border-red-900/40 bg-red-950/20 p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-red-400/80">Overstays</p>
          <p className="mt-1 text-2xl font-bold text-red-400">
            {visitors.filter((v) => getOverstayLabel(v) !== null).length}
          </p>
        </div>
      </div>

      {/* Visit Volume — Last 7 Days */}
      <section>
        <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-300">
          <Calendar className="h-4 w-4 text-cyan-400" />
          Visit Volume — Last 7 Days
        </h3>
        <div className="rounded-lg border border-gray-800 bg-zinc-900/60 p-4 space-y-2">
          {visitsByDay.map(({ label, count }) => {
            const pct = (count / maxDayCount) * 100;
            return (
              <div key={label} className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-right text-[11px] text-gray-500">{label}</span>
                <div className="relative flex-1 h-5 rounded overflow-hidden bg-gray-800/60">
                  <div
                    className="h-full rounded bg-cyan-700/70 transition-all duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right text-[11px] font-mono text-gray-400">{count}</span>
              </div>
            );
          })}
        </div>
      </section>

      {/* Peak Visiting Hours */}
      <section>
        <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-300">
          <Clock className="h-4 w-4 text-cyan-400" />
          Peak Visiting Hours
        </h3>
        <div className="rounded-lg border border-gray-800 bg-zinc-900/60 p-4 space-y-1.5">
          {visitsByHour.map(({ hour, count }) => {
            const pct = (count / maxHourCount) * 100;
            return (
              <div key={hour} className="flex items-center gap-3">
                <span className="w-12 shrink-0 text-right text-[11px] font-mono text-gray-500">
                  {String(hour).padStart(2, "0")}:00
                </span>
                <div className="relative flex-1 h-4 rounded overflow-hidden bg-gray-800/60">
                  <div
                    className="h-full rounded bg-blue-700/70 transition-all duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right text-[11px] font-mono text-gray-400">{count}</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Visitor Detail Panel                                               */
/* ------------------------------------------------------------------ */

function VisitorDetailPanel({
  visitor,
  onClose,
  onRefresh,
}: {
  visitor: Visitor;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const { addToast } = useToast();
  const [accessLog, setAccessLog] = useState<AccessLogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [notifyLoading, setNotifyLoading] = useState(false);

  useEffect(() => {
    setLogLoading(true);
    apiFetch<{ access_log?: AccessLogEntry[] }>(`/api/visitors/${visitor.id}`)
      .then((data) => setAccessLog(data.access_log || []))
      .catch(() => {})
      .finally(() => setLogLoading(false));
  }, [visitor.id]);

  const handleCheckIn = async () => {
    setActionLoading(true);
    try {
      await apiFetch(`/api/visitors/${visitor.id}/check-in`, { method: "POST" });
      onRefresh();
    } catch {
    } finally {
      setActionLoading(false);
    }
  };

  const handleCheckOut = async () => {
    setActionLoading(true);
    try {
      await apiFetch(`/api/visitors/${visitor.id}/check-out`, { method: "POST" });
      onRefresh();
    } catch {
    } finally {
      setActionLoading(false);
    }
  };

  const handleNotifyHost = async () => {
    if (!visitor.host) {
      addToast("error", "No host assigned to this visitor.");
      return;
    }
    setNotifyLoading(true);
    try {
      await apiFetch("/api/notifications/send", {
        method: "POST",
        body: JSON.stringify({
          recipients: visitor.host,
          subject: `Visitor arrived: ${visitor.first_name} ${visitor.last_name}`,
          message: "Your visitor has checked in.",
        }),
      });
      addToast("success", `Host ${visitor.host} notified successfully.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
        addToast("error", "Notification service unavailable.");
      } else {
        addToast("error", msg || "Failed to send notification.");
      }
    } finally {
      setNotifyLoading(false);
    }
  };

  const overstayLabel = getOverstayLabel(visitor);

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-[480px] flex-col border-l border-gray-800 bg-[#030712] shadow-2xl">
      <div className="flex items-center justify-between border-b border-gray-800 px-5 py-4">
        <h2 className="text-sm font-bold text-gray-100">Visitor Details</h2>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {/* Watchlist Warning */}
        {visitor.watchlist_match && (
          <div className="flex items-center gap-2 rounded-lg border border-red-800/60 bg-red-900/20 p-3">
            <ShieldAlert className="h-5 w-5 text-red-500 shrink-0" />
            <div>
              <p className="text-xs font-bold text-red-400 uppercase">
                Watchlist Match
              </p>
              <p className="text-[11px] text-red-300/80">
                This visitor matches an entry on the security watchlist.
              </p>
            </div>
          </div>
        )}

        {/* Photo + Basic Info */}
        <div className="flex items-start gap-4">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border border-gray-700 bg-gray-900">
            {visitor.photo_url ? (
              <img
                src={visitor.photo_url}
                alt="Visitor"
                className="h-full w-full rounded-xl object-cover"
              />
            ) : (
              <Users className="h-8 w-8 text-gray-600" />
            )}
          </div>
          <div>
            <h3 className="text-lg font-bold text-gray-100">
              {visitor.first_name} {visitor.last_name}
            </h3>
            <p className="text-xs text-gray-400">{visitor.company || "No company"}</p>
            <span
              className={cn(
                "mt-1 inline-block rounded px-2 py-0.5 text-[10px] font-semibold uppercase",
                STATUS_BADGE[visitor.status] || "text-gray-400 bg-gray-800"
              )}
            >
              {visitor.status.replace("_", " ")}
            </span>
          </div>
        </div>

        {/* QR Badge */}
        {visitor.qr_code_url && (
          <div className="flex flex-col items-center rounded-lg border border-gray-800 bg-zinc-900/50 p-4">
            <img
              src={visitor.qr_code_url}
              alt="QR Badge"
              className="h-32 w-32 rounded-lg"
            />
            <p className="mt-2 text-[10px] text-gray-500 uppercase tracking-wider">
              Visitor Badge QR
            </p>
          </div>
        )}

        {/* Contact Info */}
        <div className="space-y-2">
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
            Contact
          </h4>
          <div className="flex items-center gap-2 text-xs text-gray-300">
            <Mail className="h-3.5 w-3.5 text-gray-500" />
            {visitor.email || "---"}
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-300">
            <Phone className="h-3.5 w-3.5 text-gray-500" />
            {visitor.phone || "---"}
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-300">
            <Building2 className="h-3.5 w-3.5 text-gray-500" />
            {visitor.company || "---"}
          </div>
        </div>

        {/* Visit Info */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
            <span className="text-[10px] text-gray-500 uppercase">Host</span>
            <p className="mt-0.5 text-sm font-medium text-gray-200">
              {visitor.host || "---"}
            </p>
          </div>
          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
            <span className="text-[10px] text-gray-500 uppercase">Purpose</span>
            <p className="mt-0.5 text-sm font-medium text-gray-200">
              {visitor.purpose || "---"}
            </p>
          </div>
          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
            <span className="text-[10px] text-gray-500 uppercase">Type</span>
            <p className="mt-0.5 text-sm font-medium text-gray-200 capitalize">
              {visitor.visitor_type}
            </p>
          </div>
          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
            <span className="text-[10px] text-gray-500 uppercase">Escort</span>
            <p className="mt-0.5 text-sm font-medium text-gray-200">
              {visitor.escort_required ? "Required" : "Not required"}
            </p>
          </div>
        </div>

        {/* Zones */}
        {visitor.zones.length > 0 && (
          <div>
            <h4 className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-500">
              Authorized Zones
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {visitor.zones.map((z) => (
                <span
                  key={z}
                  className="rounded-full border border-gray-700 bg-gray-800 px-2.5 py-0.5 text-[10px] text-gray-300"
                >
                  {z}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Overstay Warning */}
        {overstayLabel && (
          <div className="flex items-center gap-2 rounded-lg border border-red-800/60 bg-red-900/20 px-3 py-2">
            <Clock className="h-4 w-4 text-red-400 shrink-0" />
            <span className="text-xs font-bold text-red-400">{overstayLabel}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {visitor.status === "pre_registered" && (
            <button
              onClick={handleCheckIn}
              disabled={actionLoading}
              className="flex items-center gap-1.5 rounded-lg bg-green-900/40 border border-green-800/50 px-4 py-2 text-xs font-semibold text-green-400 hover:bg-green-800/40 disabled:opacity-50"
            >
              {actionLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <UserCheck className="h-3.5 w-3.5" />
              )}
              Check In
            </button>
          )}
          {(visitor.status === "checked_in" || visitor.status === "overstay") && (
            <button
              onClick={handleCheckOut}
              disabled={actionLoading}
              className="flex items-center gap-1.5 rounded-lg bg-orange-900/40 border border-orange-800/50 px-4 py-2 text-xs font-semibold text-orange-400 hover:bg-orange-800/40 disabled:opacity-50"
            >
              {actionLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogOut className="h-3.5 w-3.5" />
              )}
              Check Out
            </button>
          )}
          {/* Notify Host — available when visitor is checked in */}
          {(visitor.status === "checked_in" || visitor.status === "overstay") && visitor.host && (
            <button
              onClick={handleNotifyHost}
              disabled={notifyLoading}
              className="flex items-center gap-1.5 rounded-lg bg-blue-900/40 border border-blue-800/50 px-4 py-2 text-xs font-semibold text-blue-400 hover:bg-blue-800/40 disabled:opacity-50"
            >
              {notifyLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Bell className="h-3.5 w-3.5" />
              )}
              Notify Host
            </button>
          )}
        </div>

        {/* Access Log Timeline */}
        <div>
          <h4 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-500">
            Access Log
          </h4>
          {logLoading ? (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading...
            </div>
          ) : accessLog.length === 0 ? (
            <p className="text-xs text-gray-600">No access log entries.</p>
          ) : (
            <div className="space-y-2">
              {accessLog.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start gap-2 rounded-lg border border-gray-800 bg-gray-900/40 p-2.5"
                >
                  <div className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-cyan-500" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-200">
                        {entry.action}
                      </span>
                      <span className="text-[10px] text-gray-500">
                        {formatTimestamp(entry.timestamp)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-gray-400">
                      {entry.zone} &mdash; {entry.details}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Pre-Register Form                                                  */
/* ------------------------------------------------------------------ */

function PreRegisterForm({ onCreated }: { onCreated: () => void }) {
  const { addToast } = useToast();
  const [form, setForm] = useState({
    first_name: "",
    last_name: "",
    email: "",
    phone: "",
    company: "",
    host: "",
    purpose: "",
    visitor_type: "guest",
    expected_checkout: "",
    escort_required: false,
    zones: [] as string[],
    photo_url: null as string | null,
  });
  const [zoneInput, setZoneInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdVisitor, setCreatedVisitor] = useState<Visitor | null>(null);

  const updateField = (field: string, value: unknown) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const addZone = () => {
    if (zoneInput.trim() && !form.zones.includes(zoneInput.trim())) {
      updateField("zones", [...form.zones, zoneInput.trim()]);
      setZoneInput("");
    }
  };

  const removeZone = (z: string) =>
    updateField(
      "zones",
      form.zones.filter((zone) => zone !== z)
    );

  const handleSubmit = async () => {
    if (!form.first_name.trim() || !form.last_name.trim()) {
      setError("First and last name are required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const visitor = await apiFetch<Visitor>("/api/visitors", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          expected_checkout: form.expected_checkout || null,
          photo_url: form.photo_url || null,
        }),
      });
      setCreatedVisitor(visitor);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to register visitor");
    } finally {
      setSubmitting(false);
    }
  };

  if (createdVisitor) {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-4">
        <CheckCircle2 className="h-12 w-12 text-green-400" />
        <h3 className="text-lg font-bold text-gray-100">
          Visitor Pre-Registered
        </h3>
        <p className="text-sm text-gray-400">
          {createdVisitor.first_name} {createdVisitor.last_name}
        </p>
        {createdVisitor.qr_code_url && (
          <div className="rounded-lg border border-gray-800 bg-zinc-900/50 p-6">
            <img
              src={createdVisitor.qr_code_url}
              alt="QR Badge"
              className="h-48 w-48 rounded-lg"
            />
            <p className="mt-3 text-center text-[10px] text-gray-500 uppercase tracking-wider">
              Visitor Badge QR Code
            </p>
          </div>
        )}
        <button
          onClick={() => {
            setCreatedVisitor(null);
            setForm({
              first_name: "",
              last_name: "",
              email: "",
              phone: "",
              company: "",
              host: "",
              purpose: "",
              visitor_type: "guest",
              expected_checkout: "",
              escort_required: false,
              zones: [],
              photo_url: null,
            });
          }}
          className="rounded-lg border border-gray-700 px-4 py-2 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200"
        >
          Register Another Visitor
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 py-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-xs font-semibold text-gray-400">
            First Name *
          </label>
          <input
            value={form.first_name}
            onChange={(e) => updateField("first_name", e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-cyan-700 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-gray-400">
            Last Name *
          </label>
          <input
            value={form.last_name}
            onChange={(e) => updateField("last_name", e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-cyan-700 focus:outline-none"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-xs font-semibold text-gray-400">
            Email
          </label>
          <input
            type="email"
            value={form.email}
            onChange={(e) => updateField("email", e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-cyan-700 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-gray-400">
            Phone
          </label>
          <input
            type="tel"
            value={form.phone}
            onChange={(e) => updateField("phone", e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-cyan-700 focus:outline-none"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-xs font-semibold text-gray-400">
            Company
          </label>
          <input
            value={form.company}
            onChange={(e) => updateField("company", e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-cyan-700 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-gray-400">
            Host
          </label>
          <input
            value={form.host}
            onChange={(e) => updateField("host", e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-cyan-700 focus:outline-none"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-semibold text-gray-400">
          Purpose
        </label>
        <input
          value={form.purpose}
          onChange={(e) => updateField("purpose", e.target.value)}
          placeholder="Meeting, delivery, interview..."
          className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-cyan-700 focus:outline-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-xs font-semibold text-gray-400">
            Visitor Type
          </label>
          <select
            value={form.visitor_type}
            onChange={(e) => updateField("visitor_type", e.target.value)}
            className="w-full appearance-none rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-300 focus:border-cyan-700 focus:outline-none"
          >
            {VISITOR_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-gray-400">
            Expected Checkout
          </label>
          <input
            type="datetime-local"
            value={form.expected_checkout}
            onChange={(e) => updateField("expected_checkout", e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-300 focus:border-cyan-700 focus:outline-none"
          />
        </div>
      </div>

      {/* Escort Toggle */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => updateField("escort_required", !form.escort_required)}
          className={cn(
            "relative h-6 w-11 rounded-full border transition-colors",
            form.escort_required
              ? "bg-cyan-600 border-cyan-500"
              : "bg-gray-700 border-gray-600"
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform",
              form.escort_required && "translate-x-5"
            )}
          />
        </button>
        <span className="text-xs text-gray-300">Escort Required</span>
      </div>

      {/* Photo Upload */}
      <div>
        <label className="mb-1 block text-xs font-semibold text-gray-400">
          Visitor Photo
        </label>
        <div className="flex items-center gap-3">
          <FileUpload
            endpoint="/api/visitors/photo"
            accept="image/*"
            compact={true}
            label="Upload Photo"
            onUpload={(file) => {
              updateField("photo_url", file.url ?? null);
              addToast("success", "Visitor photo uploaded");
            }}
            onError={(msg) => addToast("error", `Photo upload failed: ${msg}`)}
          />
          {form.photo_url && (
            <div className="relative">
              <img
                src={form.photo_url}
                alt="Visitor preview"
                className="h-12 w-12 rounded-full object-cover border border-gray-700"
              />
              <button
                type="button"
                onClick={() => updateField("photo_url", null)}
                className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-white text-[10px] hover:bg-red-500"
              >
                ×
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Zones Multi-Select */}
      <div>
        <label className="mb-1 block text-xs font-semibold text-gray-400">
          Authorized Zones
        </label>
        <div className="flex items-center gap-2">
          <input
            value={zoneInput}
            onChange={(e) => setZoneInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addZone())}
            placeholder="Add zone..."
            className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-cyan-700 focus:outline-none"
          />
          <button
            type="button"
            onClick={addZone}
            className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-300 hover:bg-gray-700"
          >
            Add
          </button>
        </div>
        {form.zones.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {form.zones.map((z) => (
              <span
                key={z}
                className="flex items-center gap-1 rounded-full border border-gray-700 bg-gray-800 px-2.5 py-0.5 text-[10px] text-gray-300"
              >
                {z}
                <button onClick={() => removeZone(z)} className="text-gray-500 hover:text-gray-300">
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-600 py-2.5 text-sm font-bold text-white hover:bg-cyan-500 disabled:opacity-50"
      >
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <UserPlus className="h-4 w-4" />
        )}
        Pre-Register Visitor
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Watchlist Tab                                                       */
/* ------------------------------------------------------------------ */

function WatchlistTab() {
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({
    first_name: "",
    last_name: "",
    reason: "",
  });
  const [addLoading, setAddLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState<string | null>(null);

  const fetchWatchlist = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<WatchlistEntry[]>("/api/visitors/watchlist");
      setEntries(data);
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWatchlist();
  }, [fetchWatchlist]);

  const handleAdd = async () => {
    if (!addForm.first_name.trim() || !addForm.last_name.trim()) return;
    setAddLoading(true);
    try {
      await apiFetch("/api/visitors/watchlist", {
        method: "POST",
        body: JSON.stringify(addForm),
      });
      setShowAdd(false);
      setAddForm({ first_name: "", last_name: "", reason: "" });
      fetchWatchlist();
    } catch {
    } finally {
      setAddLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeleteLoading(id);
    try {
      await apiFetch(`/api/visitors/watchlist/${id}`, { method: "DELETE" });
      fetchWatchlist();
    } catch {
    } finally {
      setDeleteLoading(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-300">
          Watchlist Entries
        </h3>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1.5 rounded-lg bg-red-900/30 border border-red-800/50 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-800/40"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Entry
        </button>
      </div>

      {showAdd && (
        <div className="rounded-lg border border-gray-800 bg-zinc-900/50 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input
              value={addForm.first_name}
              onChange={(e) =>
                setAddForm((p) => ({ ...p, first_name: e.target.value }))
              }
              placeholder="First name"
              className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-cyan-700 focus:outline-none"
            />
            <input
              value={addForm.last_name}
              onChange={(e) =>
                setAddForm((p) => ({ ...p, last_name: e.target.value }))
              }
              placeholder="Last name"
              className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-cyan-700 focus:outline-none"
            />
          </div>
          <input
            value={addForm.reason}
            onChange={(e) =>
              setAddForm((p) => ({ ...p, reason: e.target.value }))
            }
            placeholder="Reason for watchlist..."
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-cyan-700 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handleAdd}
              disabled={addLoading}
              className="flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-red-500 disabled:opacity-50"
            >
              {addLoading && <Loader2 className="h-3 w-3 animate-spin" />}
              Add to Watchlist
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center py-12">
          <Shield className="mb-2 h-10 w-10 text-gray-700" />
          <p className="text-sm text-gray-500">No watchlist entries</p>
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center justify-between rounded-lg border border-gray-800 bg-zinc-900/50 p-3"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-900/30 border border-red-800/50">
                  <ShieldAlert className="h-5 w-5 text-red-400" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-200">
                    {entry.first_name} {entry.last_name}
                  </p>
                  <p className="text-[11px] text-gray-500">
                    {entry.reason} &mdash; Added by {entry.added_by},{" "}
                    {timeAgo(entry.created_at)}
                  </p>
                </div>
              </div>
              <button
                onClick={() => handleDelete(entry.id)}
                disabled={deleteLoading === entry.id}
                className="rounded-lg p-2 text-gray-500 hover:bg-gray-800 hover:text-red-400 disabled:opacity-50"
              >
                {deleteLoading === entry.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function VisitorManagementPage() {
  const { addToast } = useToast();
  const [activeTab, setActiveTab] = useState<Tab>("active");
  const [visitors, setVisitors] = useState<Visitor[]>([]);
  const [stats, setStats] = useState<VisitorStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedVisitor, setSelectedVisitor] = useState<Visitor | null>(null);
  const [checkOutLoading, setCheckOutLoading] = useState<string | null>(null);
  const [notifyLoadingId, setNotifyLoadingId] = useState<string | null>(null);

  const fetchStats = useCallback(() => {
    apiFetch<VisitorStats>("/api/visitors/stats")
      .then(setStats)
      .catch(() => {});
  }, []);

  const fetchVisitors = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (activeTab === "active") params.set("status", "checked_in");
      if (searchQuery.trim()) params.set("q", searchQuery.trim());
      // For analytics fetch more records to give meaningful stats
      params.set("limit", activeTab === "analytics" ? "500" : String(PAGE_SIZE));

      const data = await apiFetch<Visitor[]>(
        `/api/visitors?${params.toString()}`
      );
      setVisitors(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch visitors");
      setVisitors([]);
    } finally {
      setLoading(false);
    }
  }, [activeTab, searchQuery]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    if (activeTab === "active" || activeTab === "all" || activeTab === "analytics") {
      fetchVisitors();
    }
  }, [fetchVisitors, activeTab]);

  const handleCheckOut = async (id: string) => {
    setCheckOutLoading(id);
    try {
      await apiFetch(`/api/visitors/${id}/check-out`, { method: "POST" });
      fetchVisitors();
      fetchStats();
    } catch {
    } finally {
      setCheckOutLoading(null);
    }
  };

  const handleNotifyHost = async (v: Visitor, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!v.host) return;
    setNotifyLoadingId(v.id);
    try {
      await apiFetch("/api/notifications/send", {
        method: "POST",
        body: JSON.stringify({
          recipients: v.host,
          subject: `Visitor arrived: ${v.first_name} ${v.last_name}`,
          message: "Your visitor has checked in.",
        }),
      });
      addToast("success", `Host ${v.host} notified successfully.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
        addToast("error", "Notification service unavailable.");
      } else {
        addToast("error", msg || "Failed to send notification.");
      }
    } finally {
      setNotifyLoadingId(null);
    }
  };

  const handleRefresh = () => {
    fetchStats();
    fetchVisitors();
    if (selectedVisitor) {
      apiFetch<Visitor>(`/api/visitors/${selectedVisitor.id}`)
        .then(setSelectedVisitor)
        .catch(() => setSelectedVisitor(null));
    }
  };

  return (
    <div className="flex h-full flex-col bg-[#030712]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-900/30 border border-blue-800/50">
            <Users className="h-5 w-5 text-blue-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Visitor Management
            </h1>
            <p className="text-xs text-gray-500">
              Track, register, and manage facility visitors
            </p>
          </div>
        </div>
      </div>

      {/* Stats Bar */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 border-b border-gray-800 px-6 py-3">
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 p-3">
            <UserCheck className="h-5 w-5 text-green-400" />
            <div>
              <p className="text-lg font-bold text-gray-100">
                {stats.checked_in}
              </p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                Checked In
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 p-3">
            <Users className="h-5 w-5 text-cyan-400" />
            <div>
              <p className="text-lg font-bold text-gray-100">
                {stats.today_total}
              </p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                Today Total
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-red-900/50 bg-red-950/20 p-3">
            <Clock className="h-5 w-5 text-red-500" />
            <div>
              <p className="text-lg font-bold text-red-400">
                {stats.overstays}
              </p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                Overstays
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 p-3">
            <ShieldAlert className="h-5 w-5 text-orange-400" />
            <div>
              <p className="text-lg font-bold text-gray-100">
                {stats.watchlist_matches}
              </p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                Watchlist Matches
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-gray-800 px-6">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-4 py-3 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors",
              activeTab === tab
                ? "border-cyan-400 text-cyan-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            )}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {/* Active / All Visitors Table */}
        {(activeTab === "active" || activeTab === "all") && (
          <>
            {/* Search */}
            <div className="mb-4 relative max-w-sm">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search visitors..."
                className="w-full rounded-lg border border-gray-700 bg-gray-900 pl-9 pr-3 py-2 text-xs text-gray-300 placeholder:text-gray-600 focus:border-cyan-700 focus:outline-none"
              />
            </div>

            {loading ? (
              <div className="flex flex-col items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
                <p className="mt-3 text-sm text-gray-500">Loading visitors...</p>
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-20">
                <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
                <p className="text-sm text-red-400">{error}</p>
              </div>
            ) : visitors.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20">
                <Users className="mb-2 h-10 w-10 text-gray-700" />
                <p className="text-sm font-medium text-gray-400">
                  No visitors found
                </p>
              </div>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 z-10 bg-zinc-900/90 backdrop-blur">
                  <tr className="border-b border-gray-800 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                    <th className="px-4 py-3">Name</th>
                    <th className="px-3 py-3">Company</th>
                    <th className="px-3 py-3">Host</th>
                    <th className="px-3 py-3">Type</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Checked In</th>
                    <th className="px-3 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visitors.map((v) => (
                    <tr
                      key={v.id}
                      onClick={() => setSelectedVisitor(v)}
                      className="border-b border-gray-800/50 cursor-pointer transition-colors hover:bg-zinc-900/70"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {/* Visitor avatar */}
                          <div className="shrink-0">
                            {v.photo_url ? (
                              <img
                                src={v.photo_url}
                                alt={`${v.first_name} ${v.last_name}`}
                                className="h-7 w-7 rounded-full object-cover border border-gray-700"
                              />
                            ) : (
                              <div className="flex h-7 w-7 items-center justify-center rounded-full border border-gray-800 bg-gray-900">
                                <Users className="h-3.5 w-3.5 text-gray-600" />
                              </div>
                            )}
                          </div>
                          {v.watchlist_match && (
                            <ShieldAlert className="h-3.5 w-3.5 text-red-500 shrink-0" />
                          )}
                          <span className="font-medium text-gray-200">
                            {v.first_name} {v.last_name}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-400">
                        {v.company || "---"}
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-400">
                        {v.host || "---"}
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-400 capitalize">
                        {v.visitor_type}
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={cn(
                            "rounded px-2 py-0.5 text-[10px] font-semibold uppercase",
                            STATUS_BADGE[v.status] || "text-gray-400 bg-gray-800"
                          )}
                        >
                          {v.status.replace("_", " ")}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-[11px] text-gray-500">
                        {v.checked_in_at
                          ? formatTimestamp(v.checked_in_at)
                          : "---"}
                        {(() => {
                          const ol = getOverstayLabel(v);
                          return ol ? (
                            <div className="mt-1 flex items-center gap-1">
                              <Clock className="h-2.5 w-2.5 text-red-400" />
                              <span className="text-[10px] font-bold text-red-400">{ol}</span>
                            </div>
                          ) : null;
                        })()}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-col gap-1.5">
                          {(v.status === "checked_in" || v.status === "overstay") && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCheckOut(v.id);
                              }}
                              disabled={checkOutLoading === v.id}
                              className="flex items-center gap-1 rounded-lg bg-orange-900/30 border border-orange-800/50 px-2.5 py-1 text-[10px] font-semibold text-orange-400 hover:bg-orange-800/40 disabled:opacity-50"
                            >
                              {checkOutLoading === v.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <LogOut className="h-3 w-3" />
                              )}
                              Check Out
                            </button>
                          )}
                          {(v.status === "checked_in" || v.status === "overstay") && v.host && (
                            <button
                              onClick={(e) => handleNotifyHost(v, e)}
                              disabled={notifyLoadingId === v.id}
                              className="flex items-center gap-1 rounded-lg bg-blue-900/30 border border-blue-800/50 px-2.5 py-1 text-[10px] font-semibold text-blue-400 hover:bg-blue-800/40 disabled:opacity-50"
                            >
                              {notifyLoadingId === v.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Bell className="h-3 w-3" />
                              )}
                              Notify Host
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {/* Pre-Register Tab */}
        {activeTab === "pre-register" && (
          <PreRegisterForm onCreated={handleRefresh} />
        )}

        {/* Watchlist Tab */}
        {activeTab === "watchlist" && <WatchlistTab />}

        {/* Analytics Tab */}
        {activeTab === "analytics" && <VisitorAnalyticsTab visitors={visitors} />}
      </div>

      {/* Detail Panel */}
      {selectedVisitor && (
        <VisitorDetailPanel
          visitor={selectedVisitor}
          onClose={() => setSelectedVisitor(null)}
          onRefresh={handleRefresh}
        />
      )}
    </div>
  );
}
