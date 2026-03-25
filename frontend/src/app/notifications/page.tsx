"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Bell,
  Send,
  Clock,
  AlertTriangle,
  Shield,
  ShieldAlert,
  Lock,
  Unlock,
  Loader2,
  X,
  Plus,
  Trash2,
  CheckCircle2,
  Mail,
  Smartphone,
  BellRing,
  Users,
  MapPin,
  FileText,
  Megaphone,
  Siren,
  Volume2,
  Activity,
  Radio,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface NotifStats {
  sent_today: number;
  active_channels: number;
  active_lockdowns: number;
}

interface MassNotification {
  id: string;
  title: string;
  message: string;
  severity: string;
  channels: string[];
  recipient_count: number;
  status: string;
  sent_at: string;
  sent_by: string;
  delivery_status?: "sent" | "delivered" | "acknowledged";
}

interface NotifTemplate {
  id: string;
  name: string;
  channel: string;
  body: string;
  severity: string;
  created_at: string;
}

interface LockdownStatus {
  active: boolean;
  activated_at: string | null;
  activated_by: string | null;
  steps: LockdownStep[];
  reason: string | null;
}

interface LockdownStep {
  name: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  completed_at: string | null;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TABS = ["send", "history", "templates", "lockdown"] as const;
type Tab = (typeof TABS)[number];

const TAB_META: Record<Tab, { label: string; icon: React.ReactNode }> = {
  send: { label: "Send", icon: <Send className="h-3.5 w-3.5" /> },
  history: { label: "History", icon: <Clock className="h-3.5 w-3.5" /> },
  templates: { label: "Templates", icon: <FileText className="h-3.5 w-3.5" /> },
  lockdown: { label: "Lockdown", icon: <Lock className="h-3.5 w-3.5" /> },
};

const SEVERITY_OPTIONS = ["info", "low", "medium", "high", "critical"] as const;

const CHANNEL_OPTIONS = [
  { key: "email", label: "Email", icon: <Mail className="h-4 w-4" /> },
  { key: "sms", label: "SMS", icon: <Smartphone className="h-4 w-4" /> },
  { key: "push", label: "Push", icon: <BellRing className="h-4 w-4" /> },
  { key: "pa_system", label: "PA System", icon: <Volume2 className="h-4 w-4" /> },
];

const SEV_BADGE: Record<string, string> = {
  critical: "text-red-500 bg-red-500/10 border-red-500/50",
  high: "text-orange-500 bg-orange-500/10 border-orange-500/50",
  medium: "text-yellow-500 bg-yellow-500/10 border-yellow-500/50",
  low: "text-blue-400 bg-blue-400/10 border-blue-400/50",
  info: "text-gray-400 bg-gray-400/10 border-gray-600",
};

const TEMPLATE_VARIABLES = [
  { label: "{{zone}}", desc: "Zone name" },
  { label: "{{alert_id}}", desc: "Alert identifier" },
  { label: "{{officer}}", desc: "Officer name" },
  { label: "{{timestamp}}", desc: "Event timestamp" },
] as const;

const DELIVERY_STATUS_BADGE: Record<string, string> = {
  sent: "text-gray-400 bg-gray-800 border-gray-700",
  delivered: "text-blue-400 bg-blue-900/30 border-blue-700/50",
  acknowledged: "text-green-400 bg-green-900/30 border-green-700/50",
};

const RECIPIENT_GROUPS = [
  "All Personnel",
  "Security Team",
  "Management",
  "Facilities",
  "Visitors",
  "Emergency Response",
] as const;

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/* ------------------------------------------------------------------ */
/*  Send Tab                                                           */
/* ------------------------------------------------------------------ */

function SendTab({ onSent }: { onSent: () => void }) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [severity, setSeverity] = useState("medium");
  const [channels, setChannels] = useState<string[]>(["push"]);
  const [recipients, setRecipients] = useState<string[]>(["All Personnel"]);
  const [sending, setSending] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const toggleChannel = (ch: string) =>
    setChannels((prev) =>
      prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch]
    );

  const toggleRecipient = (group: string) =>
    setRecipients((prev) =>
      prev.includes(group) ? prev.filter((r) => r !== group) : [...prev, group]
    );

  const handleSend = async () => {
    if (!title.trim() || !message.trim()) {
      setError("Title and message are required.");
      return;
    }
    if (channels.length === 0) {
      setError("Select at least one channel.");
      return;
    }
    if (recipients.length === 0) {
      setError("Select at least one recipient group.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      await apiFetch("/api/notifications/mass/send", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          message: message.trim(),
          severity,
          channels,
          recipients,
        }),
      });
      setSuccess(true);
      setShowConfirm(false);
      setTitle("");
      setMessage("");
      onSent();
      setTimeout(() => setSuccess(false), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send notification");
    } finally {
      setSending(false);
      setShowConfirm(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5 py-4">
      {/* Title */}
      <div>
        <label className="mb-1 block text-xs font-semibold text-gray-400">
          Title *
        </label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Alert title..."
          className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-cyan-700 focus:outline-none"
        />
      </div>

      {/* Message Body */}
      <div>
        <label className="mb-1 block text-xs font-semibold text-gray-400">
          Message Body *
        </label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          placeholder="Notification message body..."
          className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-cyan-700 focus:outline-none resize-none"
        />
      </div>

      {/* Severity */}
      <div>
        <label className="mb-2 block text-xs font-semibold text-gray-400">
          Severity
        </label>
        <div className="flex items-center gap-2 flex-wrap">
          {SEVERITY_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setSeverity(s)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-semibold uppercase border transition-colors",
                severity === s
                  ? SEV_BADGE[s]
                  : "border-gray-700 bg-gray-900 text-gray-500 hover:text-gray-300"
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Channels */}
      <div>
        <label className="mb-2 block text-xs font-semibold text-gray-400">
          Channels *
        </label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {CHANNEL_OPTIONS.map((ch) => (
            <button
              key={ch.key}
              onClick={() => toggleChannel(ch.key)}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-4 py-2.5 text-xs font-semibold transition-colors",
                channels.includes(ch.key)
                  ? "border-cyan-600 bg-cyan-900/30 text-cyan-400"
                  : "border-gray-700 bg-gray-900 text-gray-500 hover:text-gray-300"
              )}
            >
              {ch.icon}
              {ch.label}
            </button>
          ))}
        </div>
      </div>

      {/* Recipient Selection */}
      <div>
        <label className="mb-2 block text-xs font-semibold text-gray-400">
          Recipients *
        </label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {RECIPIENT_GROUPS.map((group) => (
            <button
              key={group}
              onClick={() => toggleRecipient(group)}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors",
                recipients.includes(group)
                  ? "border-cyan-600 bg-cyan-900/30 text-cyan-400"
                  : "border-gray-700 bg-gray-900 text-gray-500 hover:text-gray-300"
              )}
            >
              <Users className="h-3.5 w-3.5" />
              {group}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {success && (
        <div className="flex items-center gap-2 rounded-lg border border-green-800/50 bg-green-900/20 p-3">
          <CheckCircle2 className="h-4 w-4 text-green-400" />
          <span className="text-sm text-green-400 font-medium">
            Notification sent successfully!
          </span>
        </div>
      )}

      {/* Send Button */}
      <button
        onClick={() => setShowConfirm(true)}
        disabled={!title.trim() || !message.trim() || channels.length === 0}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-red-600 py-4 text-lg font-black uppercase tracking-wider text-white shadow-lg shadow-red-600/20 hover:bg-red-500 transition-all hover:shadow-red-500/30 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Siren className="h-6 w-6" />
        SEND NOTIFICATION
      </button>

      {/* Confirmation Modal */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-gray-800 bg-[#030712] p-6 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-900/30">
                <AlertTriangle className="h-5 w-5 text-red-500" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-gray-100">
                  Confirm Notification
                </h3>
                <p className="text-xs text-gray-500">
                  This will broadcast to all selected recipients
                </p>
              </div>
            </div>

            <div className="mb-4 space-y-2 rounded-lg border border-gray-800 bg-zinc-900/50 p-3">
              <p className="text-xs text-gray-400">
                <span className="font-semibold text-gray-300">Title:</span> {title}
              </p>
              <p className="text-xs text-gray-400">
                <span className="font-semibold text-gray-300">Severity:</span>{" "}
                <span className="uppercase">{severity}</span>
              </p>
              <p className="text-xs text-gray-400">
                <span className="font-semibold text-gray-300">Channels:</span>{" "}
                {channels.join(", ")}
              </p>
              <p className="text-xs text-gray-400">
                <span className="font-semibold text-gray-300">Recipients:</span>{" "}
                {recipients.join(", ")}
              </p>
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setShowConfirm(false)}
                className="rounded-lg border border-gray-700 px-4 py-2 text-xs text-gray-400 hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={handleSend}
                disabled={sending}
                className="flex items-center gap-1.5 rounded-lg bg-red-600 px-6 py-2 text-xs font-bold text-white hover:bg-red-500 disabled:opacity-50"
              >
                {sending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                Confirm Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  History Tab                                                        */
/* ------------------------------------------------------------------ */

function HistoryTab() {
  const [history, setHistory] = useState<MassNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiFetch<MassNotification[]>("/api/notifications/mass/history")
      .then(setHistory)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load history"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center py-20">
        <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="flex flex-col items-center py-20">
        <Bell className="mb-2 h-10 w-10 text-gray-700" />
        <p className="text-sm text-gray-500">No notifications sent yet</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-zinc-900/50 overflow-hidden">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 z-10 bg-zinc-900/90 backdrop-blur">
          <tr className="border-b border-gray-800 text-[10px] font-bold uppercase tracking-wider text-gray-500">
            <th className="px-4 py-3">Timestamp</th>
            <th className="px-3 py-3">Title</th>
            <th className="px-3 py-3">Severity</th>
            <th className="px-3 py-3">Channels</th>
            <th className="px-3 py-3">Recipients</th>
            <th className="px-3 py-3">Status</th>
            <th className="px-3 py-3">Delivery</th>
          </tr>
        </thead>
        <tbody>
          {history.map((n) => (
            <tr
              key={n.id}
              className="border-b border-gray-800/50 hover:bg-zinc-900/70 transition-colors"
            >
              <td className="px-4 py-3 text-[11px] text-gray-500 font-mono whitespace-nowrap">
                {fmtTime(n.sent_at)}
              </td>
              <td className="px-3 py-3">
                <span className="font-medium text-gray-200 truncate max-w-[220px] block">
                  {n.title}
                </span>
              </td>
              <td className="px-3 py-3">
                <span
                  className={cn(
                    "rounded px-2 py-0.5 text-[10px] font-bold uppercase border",
                    SEV_BADGE[n.severity] || "text-gray-400 bg-gray-800 border-gray-700"
                  )}
                >
                  {n.severity}
                </span>
              </td>
              <td className="px-3 py-3">
                <div className="flex items-center gap-1 flex-wrap">
                  {n.channels.map((ch) => (
                    <span
                      key={ch}
                      className="rounded bg-gray-800 px-1.5 py-0.5 text-[9px] text-gray-400 uppercase"
                    >
                      {ch}
                    </span>
                  ))}
                </div>
              </td>
              <td className="px-3 py-3 text-xs text-gray-400 font-mono">
                {n.recipient_count}
              </td>
              <td className="px-3 py-3">
                <span
                  className={cn(
                    "rounded px-2 py-0.5 text-[10px] font-semibold uppercase",
                    n.status === "delivered"
                      ? "text-green-400 bg-green-900/30"
                      : n.status === "sending"
                      ? "text-yellow-400 bg-yellow-900/30"
                      : n.status === "failed"
                      ? "text-red-400 bg-red-900/30"
                      : "text-gray-400 bg-gray-800"
                  )}
                >
                  {n.status}
                </span>
              </td>
              <td className="px-3 py-3">
                {n.delivery_status ? (
                  <span
                    className={cn(
                      "rounded border px-2 py-0.5 text-[10px] font-semibold uppercase",
                      DELIVERY_STATUS_BADGE[n.delivery_status] || "text-gray-400 bg-gray-800 border-gray-700"
                    )}
                  >
                    {n.delivery_status}
                  </span>
                ) : (
                  <span className="text-[10px] text-gray-700">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Templates Tab                                                      */
/* ------------------------------------------------------------------ */

function TemplatesTab() {
  const [templates, setTemplates] = useState<NotifTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", channel: "email", body: "", severity: "medium" });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const insertVariable = (variable: string) => {
    const el = bodyRef.current;
    if (!el) {
      setForm((p) => ({ ...p, body: p.body + variable }));
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const newBody = el.value.slice(0, start) + variable + el.value.slice(end);
    setForm((p) => ({ ...p, body: newBody }));
    // Restore cursor position after React re-render
    requestAnimationFrame(() => {
      el.selectionStart = start + variable.length;
      el.selectionEnd = start + variable.length;
      el.focus();
    });
  };

  const fetchTemplates = useCallback(() => {
    setLoading(true);
    apiFetch<NotifTemplate[]>("/api/notifications/mass/templates")
      .then(setTemplates)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const handleCreate = async () => {
    if (!form.name.trim() || !form.body.trim()) {
      setError("Name and body are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiFetch("/api/notifications/mass/templates", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setShowForm(false);
      setForm({ name: "", channel: "email", body: "", severity: "medium" });
      fetchTemplates();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create template");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      await apiFetch(`/api/notifications/mass/templates/${id}`, {
        method: "DELETE",
      });
      fetchTemplates();
    } catch {
      // silently handle
    } finally {
      setDeleting(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-300">
          Notification Templates
        </h3>
        <button
          onClick={() => { setShowForm(!showForm); setError(null); }}
          className="flex items-center gap-1.5 rounded-lg bg-cyan-900/30 border border-cyan-800/50 px-3 py-1.5 text-xs font-semibold text-cyan-400 hover:bg-cyan-800/40 transition-colors"
        >
          {showForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          {showForm ? "Cancel" : "New Template"}
        </button>
      </div>

      {/* Create Form */}
      {showForm && (
        <div className="rounded-lg border border-gray-800 bg-zinc-900/50 p-4 space-y-3">
          <input
            value={form.name}
            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            placeholder="Template name"
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-cyan-700 focus:outline-none"
          />
          <textarea
            ref={bodyRef}
            value={form.body}
            onChange={(e) => setForm((p) => ({ ...p, body: e.target.value }))}
            rows={3}
            placeholder="Notification body text..."
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-cyan-700 focus:outline-none resize-none"
          />
          {/* Variable helper chips */}
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">
              Variables — click to insert
            </p>
            <div className="flex flex-wrap gap-1.5">
              {TEMPLATE_VARIABLES.map((v) => (
                <button
                  key={v.label}
                  type="button"
                  onClick={() => insertVariable(v.label)}
                  title={v.desc}
                  className="rounded-md border border-cyan-800/60 bg-cyan-900/20 px-2 py-0.5 text-[11px] font-mono text-cyan-400 hover:bg-cyan-800/40 hover:border-cyan-600/70 transition-colors"
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={form.channel}
              onChange={(e) => setForm((p) => ({ ...p, channel: e.target.value }))}
              className="appearance-none rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none"
            >
              {CHANNEL_OPTIONS.map((ch) => (
                <option key={ch.key} value={ch.key}>{ch.label}</option>
              ))}
            </select>
            <select
              value={form.severity}
              onChange={(e) => setForm((p) => ({ ...p, severity: e.target.value }))}
              className="appearance-none rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none"
            >
              {SEVERITY_OPTIONS.map((s) => (
                <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
              ))}
            </select>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            onClick={handleCreate}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-cyan-500 disabled:opacity-50 transition-colors"
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            Create Template
          </button>
        </div>
      )}

      {/* Template List */}
      {templates.length === 0 ? (
        <div className="flex flex-col items-center py-12">
          <FileText className="mb-2 h-10 w-10 text-gray-700" />
          <p className="text-sm text-gray-500">No templates yet</p>
        </div>
      ) : (
        <div className="space-y-2">
          {templates.map((tpl) => (
            <div
              key={tpl.id}
              className="flex items-start justify-between rounded-lg border border-gray-800 bg-zinc-900/50 p-4 transition-colors hover:border-gray-700"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-sm font-semibold text-gray-200">{tpl.name}</p>
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[9px] font-bold uppercase border",
                      SEV_BADGE[tpl.severity] || "text-gray-400 bg-gray-800 border-gray-700"
                    )}
                  >
                    {tpl.severity}
                  </span>
                  <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[9px] text-gray-400 uppercase">
                    {tpl.channel}
                  </span>
                </div>
                <p className="text-xs text-gray-500 line-clamp-2">{tpl.body}</p>
                <p className="mt-1 text-[10px] text-gray-600">
                  Created {fmtTime(tpl.created_at)}
                </p>
              </div>
              <button
                onClick={() => handleDelete(tpl.id)}
                disabled={deleting === tpl.id}
                className="ml-3 rounded-lg p-2 text-gray-600 hover:bg-red-900/20 hover:text-red-400 transition-colors disabled:opacity-50"
              >
                {deleting === tpl.id ? (
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
/*  Lockdown Tab                                                       */
/* ------------------------------------------------------------------ */

function LockdownTab() {
  const [lockdown, setLockdown] = useState<LockdownStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState<"activate" | "deactivate" | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<LockdownStatus>(
        "/api/notifications/mass/lockdown/status"
      );
      setLockdown(data);
    } catch {
      // status unavailable
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleActivate = async () => {
    setActionLoading(true);
    try {
      await apiFetch("/api/notifications/mass/lockdown/activate", {
        method: "POST",
      });
      await fetchStatus();
    } catch {
      // handle silently
    } finally {
      setActionLoading(false);
      setShowConfirm(null);
    }
  };

  const handleDeactivate = async () => {
    setActionLoading(true);
    try {
      await apiFetch("/api/notifications/mass/lockdown/deactivate", {
        method: "POST",
      });
      await fetchStatus();
    } catch {
      // handle silently
    } finally {
      setActionLoading(false);
      setShowConfirm(null);
    }
  };

  const stepStatusIcon = (status: LockdownStep["status"]) => {
    switch (status) {
      case "completed":
        return <CheckCircle2 className="h-4 w-4 text-green-400" />;
      case "in_progress":
        return <Loader2 className="h-4 w-4 animate-spin text-yellow-400" />;
      case "failed":
        return <AlertTriangle className="h-4 w-4 text-red-500" />;
      default:
        return <Clock className="h-4 w-4 text-gray-600" />;
    }
  };

  const stepStatusColor = (status: LockdownStep["status"]) => {
    switch (status) {
      case "completed": return "border-green-800/50 bg-green-950/20";
      case "in_progress": return "border-yellow-800/50 bg-yellow-950/20";
      case "failed": return "border-red-800/50 bg-red-950/20";
      default: return "border-gray-800 bg-gray-900/50";
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-6 py-4">
      {/* Status Indicator */}
      <div
        className={cn(
          "flex flex-col items-center justify-center rounded-2xl border-2 p-8 transition-colors",
          lockdown?.active
            ? "border-red-600 bg-red-950/30"
            : "border-green-800 bg-green-950/10"
        )}
      >
        <div
          className={cn(
            "flex h-20 w-20 items-center justify-center rounded-full mb-4",
            lockdown?.active ? "bg-red-900/50 animate-pulse" : "bg-green-900/30"
          )}
        >
          {lockdown?.active ? (
            <Lock className="h-10 w-10 text-red-500" />
          ) : (
            <Unlock className="h-10 w-10 text-green-400" />
          )}
        </div>
        <h2
          className={cn(
            "text-2xl font-black uppercase tracking-wider",
            lockdown?.active ? "text-red-500" : "text-green-400"
          )}
        >
          {lockdown?.active ? "LOCKDOWN ACTIVE" : "NORMAL OPERATIONS"}
        </h2>
        {lockdown?.active && lockdown.activated_at && (
          <p className="mt-2 text-xs text-gray-400">
            Activated at {fmtTime(lockdown.activated_at)} by{" "}
            {lockdown.activated_by || "system"}
          </p>
        )}
        {lockdown?.active && lockdown.reason && (
          <p className="mt-1 text-sm text-red-300">{lockdown.reason}</p>
        )}
      </div>

      {/* Step Status Display */}
      {lockdown?.steps && lockdown.steps.length > 0 && (
        <div className="rounded-xl border border-gray-800 bg-zinc-900/50 overflow-hidden">
          <div className="flex items-center gap-2 border-b border-gray-800 px-4 py-3">
            <Activity className="h-4 w-4 text-cyan-400" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-cyan-400">
              Lockdown Sequence Steps
            </h3>
          </div>
          <div className="divide-y divide-gray-800/50">
            {lockdown.steps.map((step, idx) => (
              <div
                key={idx}
                className={cn(
                  "flex items-center justify-between px-4 py-3 transition-colors",
                  stepStatusColor(step.status)
                )}
              >
                <div className="flex items-center gap-3">
                  {stepStatusIcon(step.status)}
                  <span className="text-sm font-medium text-gray-200">
                    {step.name}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "rounded px-2 py-0.5 text-[10px] font-bold uppercase",
                      step.status === "completed"
                        ? "text-green-400 bg-green-900/30"
                        : step.status === "in_progress"
                        ? "text-yellow-400 bg-yellow-900/30"
                        : step.status === "failed"
                        ? "text-red-400 bg-red-900/30"
                        : "text-gray-500 bg-gray-800"
                    )}
                  >
                    {step.status.replace("_", " ")}
                  </span>
                  {step.completed_at && (
                    <span className="text-[10px] text-gray-600 font-mono">
                      {fmtTime(step.completed_at)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action Buttons */}
      <div className="grid grid-cols-2 gap-4">
        <button
          onClick={() => setShowConfirm("activate")}
          disabled={lockdown?.active}
          className={cn(
            "flex flex-col items-center justify-center rounded-xl border-2 p-6 transition-all",
            lockdown?.active
              ? "border-gray-800 bg-gray-900/50 opacity-40 cursor-not-allowed"
              : "border-red-800/50 bg-red-950/20 hover:bg-red-900/30 hover:border-red-700 cursor-pointer"
          )}
        >
          <Lock className="h-8 w-8 text-red-500 mb-2" />
          <span className="text-sm font-black uppercase tracking-wider text-red-400">
            Activate Lockdown
          </span>
        </button>

        <button
          onClick={() => setShowConfirm("deactivate")}
          disabled={!lockdown?.active}
          className={cn(
            "flex flex-col items-center justify-center rounded-xl border-2 p-6 transition-all",
            !lockdown?.active
              ? "border-gray-800 bg-gray-900/50 opacity-40 cursor-not-allowed"
              : "border-green-800/50 bg-green-950/20 hover:bg-green-900/30 hover:border-green-700 cursor-pointer"
          )}
        >
          <Unlock className="h-8 w-8 text-green-400 mb-2" />
          <span className="text-sm font-black uppercase tracking-wider text-green-400">
            Deactivate Lockdown
          </span>
        </button>
      </div>

      {/* Confirmation Dialog */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-gray-800 bg-[#030712] p-6 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-full",
                  showConfirm === "activate" ? "bg-red-900/30" : "bg-green-900/30"
                )}
              >
                {showConfirm === "activate" ? (
                  <ShieldAlert className="h-5 w-5 text-red-500" />
                ) : (
                  <Shield className="h-5 w-5 text-green-400" />
                )}
              </div>
              <div>
                <h3 className="text-sm font-bold text-gray-100">
                  {showConfirm === "activate"
                    ? "Confirm Lockdown Activation"
                    : "Confirm Lockdown Deactivation"}
                </h3>
                <p className="text-xs text-gray-500">
                  {showConfirm === "activate"
                    ? "This will initiate the full lockdown sequence for the facility."
                    : "This will restore normal operations across all zones."}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setShowConfirm(null)}
                className="rounded-lg border border-gray-700 px-4 py-2 text-xs text-gray-400 hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={showConfirm === "activate" ? handleActivate : handleDeactivate}
                disabled={actionLoading}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-6 py-2 text-xs font-bold text-white disabled:opacity-50 transition-colors",
                  showConfirm === "activate"
                    ? "bg-red-600 hover:bg-red-500"
                    : "bg-green-600 hover:bg-green-500"
                )}
              >
                {actionLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function NotificationsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("send");
  const [stats, setStats] = useState<NotifStats | null>(null);

  const fetchStats = useCallback(() => {
    apiFetch<NotifStats>("/api/notifications/mass/history")
      .then((data) => {
        if (Array.isArray(data)) {
          setStats({
            sent_today: data.length,
            active_channels: new Set(data.flatMap((n: MassNotification) => n.channels)).size,
            active_lockdowns: 0,
          });
        } else {
          setStats(data as unknown as NotifStats);
        }
      })
      .catch(() => {});

    apiFetch<LockdownStatus>("/api/notifications/mass/lockdown/status")
      .then((ld) => {
        setStats((prev) =>
          prev ? { ...prev, active_lockdowns: ld.active ? 1 : 0 } : prev
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return (
    <div className="flex h-full flex-col bg-[#030712]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-900/30 border border-orange-800/50">
            <Megaphone className="h-5 w-5 text-orange-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Mass Notification & Emergency Response
            </h1>
            <p className="text-xs text-gray-500">
              Send multi-channel alerts, manage templates, and control facility lockdowns
            </p>
          </div>
        </div>
      </div>

      {/* Stats Bar */}
      {stats && (
        <div className="grid grid-cols-3 gap-4 border-b border-gray-800 px-6 py-3">
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 p-3">
            <Send className="h-5 w-5 text-cyan-400" />
            <div>
              <p className="text-lg font-bold text-gray-100">{stats.sent_today}</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                Sent Today
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-zinc-900/60 p-3">
            <Radio className="h-5 w-5 text-green-400" />
            <div>
              <p className="text-lg font-bold text-gray-100">{stats.active_channels}</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                Active Channels
              </p>
            </div>
          </div>
          <div
            className={cn(
              "flex items-center gap-3 rounded-lg border p-3",
              stats.active_lockdowns > 0
                ? "border-red-800/60 bg-red-950/30"
                : "border-gray-800 bg-zinc-900/60"
            )}
          >
            <Lock
              className={cn(
                "h-5 w-5",
                stats.active_lockdowns > 0
                  ? "text-red-500 animate-pulse"
                  : "text-gray-500"
              )}
            />
            <div>
              <p
                className={cn(
                  "text-lg font-bold",
                  stats.active_lockdowns > 0 ? "text-red-400" : "text-gray-100"
                )}
              >
                {stats.active_lockdowns}
              </p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                Active Lockdowns
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
              "flex items-center gap-1.5 px-4 py-3 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors",
              activeTab === tab
                ? tab === "lockdown"
                  ? "border-red-500 text-red-400"
                  : "border-cyan-400 text-cyan-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            )}
          >
            {TAB_META[tab].icon}
            {TAB_META[tab].label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {activeTab === "send" && <SendTab onSent={fetchStats} />}
        {activeTab === "history" && <HistoryTab />}
        {activeTab === "templates" && <TemplatesTab />}
        {activeTab === "lockdown" && <LockdownTab />}
      </div>
    </div>
  );
}
