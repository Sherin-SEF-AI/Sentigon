"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Siren,
  ShieldAlert,
  CheckSquare,
  Square,
  Clock,
  AlertTriangle,
  X,
  RefreshCw,
  History,
  Zap,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EmergencyCode {
  code: string;
  color: string;
  description: string;
  actions: string[];
  _industries?: string[];
}

interface EmergencyRecord {
  id: string;
  code: string;
  color: string;
  description: string;
  actions: string[];
  activated_by: string;
  activated_at: string;
  deactivated_at: string | null;
  site_id: string | null;
  notes: string | null;
  status: "active" | "resolved";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function elapsedSince(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const totalSec = Math.floor(diffMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m`;
}

function formatTime(isoString: string): string {
  try {
    return new Date(isoString).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return isoString;
  }
}

function formatDateTime(isoString: string): string {
  try {
    return new Date(isoString).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return isoString;
  }
}

function durationBetween(start: string, end: string | null): string {
  if (!end) return "ongoing";
  const diffMs = new Date(end).getTime() - new Date(start).getTime();
  const totalSec = Math.floor(diffMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m`;
}

// ── Elapsed ticker hook ───────────────────────────────────────────────────────

function useElapsedTick(activatedAt: string): string {
  const [elapsed, setElapsed] = useState(() => elapsedSince(activatedAt));
  useEffect(() => {
    const id = setInterval(() => setElapsed(elapsedSince(activatedAt)), 1000);
    return () => clearInterval(id);
  }, [activatedAt]);
  return elapsed;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ActiveBanner({
  record,
  onDeactivate,
  deactivating,
}: {
  record: EmergencyRecord;
  onDeactivate: (code: string) => void;
  deactivating: string | null;
}) {
  const elapsed = useElapsedTick(record.activated_at);
  return (
    <div
      className="relative flex items-center justify-between gap-4 rounded-lg border border-red-500/60 bg-red-900/30 px-5 py-3 animate-pulse-slow"
      style={{ boxShadow: `0 0 24px ${record.color}44` }}
    >
      {/* Pulsing left indicator */}
      <span className="absolute left-0 top-0 h-full w-1 rounded-l-lg animate-pulse bg-red-500" />

      <div className="flex items-center gap-3 ml-2">
        <Siren className="h-5 w-5 text-red-400 animate-pulse shrink-0" />
        <div>
          <p className="text-sm font-bold text-red-300 uppercase tracking-wider">
            {record.code} — ACTIVE
          </p>
          <p className="text-xs text-red-400/80">{record.description}</p>
        </div>
      </div>

      <div className="flex items-center gap-4 shrink-0">
        <div className="text-right hidden sm:block">
          <p className="text-xs text-red-400/60">Active for</p>
          <p className="text-sm font-mono font-bold text-red-300">{elapsed}</p>
        </div>
        <button
          onClick={() => onDeactivate(record.code)}
          disabled={deactivating === record.code}
          className="flex items-center gap-2 rounded-lg border border-red-500 bg-red-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-red-500 disabled:opacity-50 active:scale-95"
        >
          {deactivating === record.code ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <XCircle className="h-4 w-4" />
          )}
          DEACTIVATE
        </button>
      </div>
    </div>
  );
}

function CodeCard({
  code,
  activeRecord,
  onActivate,
  onDeactivate,
  activating,
  deactivating,
}: {
  code: EmergencyCode;
  activeRecord: EmergencyRecord | null;
  onActivate: (code: EmergencyCode) => void;
  onDeactivate: (codeName: string) => void;
  activating: string | null;
  deactivating: string | null;
}) {
  const elapsed = useElapsedTick(activeRecord?.activated_at ?? new Date().toISOString());
  const isActive = activeRecord !== null;
  const isActivating = activating === code.code;
  const isDeactivating = deactivating === code.code;

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-xl border-l-4 bg-gray-900 p-4 transition-all duration-200",
        isActive
          ? "border-red-500 shadow-lg shadow-red-900/30 ring-1 ring-red-500/40"
          : "border-gray-700 hover:border-gray-500 hover:bg-gray-800/60"
      )}
      style={{ borderLeftColor: isActive ? undefined : code.color }}
    >
      {/* Color swatch + name */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span
            className="h-4 w-4 rounded-full shrink-0 border border-white/20"
            style={{ backgroundColor: code.color }}
          />
          <h3 className="text-sm font-bold text-gray-100">{code.code}</h3>
        </div>

        {isActive && (
          <span className="flex items-center gap-1 rounded-full border border-red-500/60 bg-red-900/40 px-2 py-0.5 text-[10px] font-bold text-red-400 animate-pulse uppercase">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
            ACTIVE
          </span>
        )}
      </div>

      <p className="mb-2 text-xs text-gray-400 line-clamp-2">{code.description}</p>

      <div className="mb-3 text-[10px] text-gray-600">
        {code.actions.length} automated action{code.actions.length !== 1 ? "s" : ""}
      </div>

      {/* Elapsed time when active */}
      {isActive && activeRecord && (
        <div className="mb-3 flex items-center gap-1.5 text-xs text-red-400">
          <Clock className="h-3.5 w-3.5" />
          <span className="font-mono font-semibold">{elapsed}</span>
          <span className="text-red-500/60">elapsed</span>
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-auto">
        {isActive ? (
          <button
            onClick={() => onDeactivate(code.code)}
            disabled={isDeactivating}
            className="w-full flex items-center justify-center gap-2 rounded-lg border border-red-500/60 bg-red-900/30 px-3 py-2.5 text-sm font-bold text-red-400 transition hover:bg-red-900/50 disabled:opacity-50 active:scale-95"
          >
            {isDeactivating ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <XCircle className="h-4 w-4" />
            )}
            Deactivate
          </button>
        ) : (
          <button
            onClick={() => onActivate(code)}
            disabled={isActivating}
            className="w-full flex items-center justify-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm font-semibold text-gray-200 transition hover:border-red-600 hover:bg-red-900/20 hover:text-red-300 disabled:opacity-50 active:scale-95"
          >
            {isActivating ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Zap className="h-4 w-4" />
            )}
            Activate
          </button>
        )}
      </div>
    </div>
  );
}

function ResponseChecklist({
  records,
}: {
  records: EmergencyRecord[];
}) {
  // Per-action checked state keyed by `${record.id}:${action}`
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  if (records.length === 0) return null;

  const toggle = (key: string) =>
    setChecked((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="rounded-xl border border-red-900/40 bg-gray-900/60 p-5">
      <div className="mb-4 flex items-center gap-2">
        <ShieldAlert className="h-5 w-5 text-red-400" />
        <h2 className="text-sm font-bold uppercase tracking-wider text-red-300">
          Response Checklist
        </h2>
      </div>

      <div className="space-y-6">
        {records.map((rec) => (
          <div key={rec.id}>
            <div className="mb-2 flex items-center gap-2">
              <span
                className="h-3 w-3 rounded-full shrink-0"
                style={{ backgroundColor: rec.color }}
              />
              <p className="text-sm font-semibold text-gray-200">{rec.code}</p>
            </div>
            <div className="ml-5 space-y-2">
              {rec.actions.map((action, idx) => {
                const key = `${rec.id}:${action}:${idx}`;
                const done = !!checked[key];
                return (
                  <button
                    key={key}
                    onClick={() => toggle(key)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg border px-4 py-2.5 text-left text-sm transition-all active:scale-[0.99]",
                      done
                        ? "border-green-800/50 bg-green-900/20 text-green-400 line-through decoration-green-600/60"
                        : "border-gray-700/60 bg-gray-800/50 text-gray-300 hover:border-red-700/40 hover:bg-gray-800"
                    )}
                  >
                    {done ? (
                      <CheckSquare className="h-4 w-4 text-green-500 shrink-0" />
                    ) : (
                      <Square className="h-4 w-4 text-gray-500 shrink-0" />
                    )}
                    <span className="font-mono text-xs uppercase tracking-wide">
                      {action.replace(/_/g, " ")}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HistoryTimeline({ history }: { history: EmergencyRecord[] }) {
  const [expanded, setExpanded] = useState(true);

  if (history.length === 0) return null;

  return (
    <div className="rounded-xl border border-gray-800/60 bg-gray-900/60 p-5">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="mb-4 flex w-full items-center justify-between gap-2"
      >
        <div className="flex items-center gap-2">
          <History className="h-5 w-5 text-gray-400" />
          <h2 className="text-sm font-bold uppercase tracking-wider text-gray-300">
            Emergency History
          </h2>
          <span className="rounded-full bg-gray-800 px-2 py-0.5 text-[10px] text-gray-500">
            {history.length}
          </span>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-gray-500" />
        ) : (
          <ChevronDown className="h-4 w-4 text-gray-500" />
        )}
      </button>

      {expanded && (
        <div className="relative space-y-0">
          {/* Timeline spine */}
          <div className="absolute left-[19px] top-0 bottom-0 w-px bg-gray-800" />

          {history.slice(0, 20).map((rec, idx) => (
            <div key={rec.id + idx} className="relative flex gap-4 pb-4 last:pb-0">
              {/* Timeline dot */}
              <div
                className={cn(
                  "relative z-10 mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                  rec.status === "active"
                    ? "border-red-500 bg-red-900/60"
                    : "border-gray-700 bg-gray-800"
                )}
              >
                {rec.status === "active" ? (
                  <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                ) : (
                  <CheckCircle2 className="h-3 w-3 text-gray-500" />
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 rounded-lg border border-gray-800/60 bg-gray-900 px-3 py-2">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: rec.color }}
                    />
                    <span className="text-sm font-semibold text-gray-200">
                      {rec.code}
                    </span>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[9px] font-bold uppercase",
                        rec.status === "active"
                          ? "bg-red-900/40 text-red-400"
                          : "bg-gray-800 text-gray-500"
                      )}
                    >
                      {rec.status}
                    </span>
                  </div>
                  <span className="text-[10px] text-gray-600 font-mono">
                    {formatDateTime(rec.activated_at)}
                  </span>
                </div>

                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-gray-500">
                  {rec.activated_by && (
                    <span>by {rec.activated_by}</span>
                  )}
                  <span>
                    duration: {durationBetween(rec.activated_at, rec.deactivated_at)}
                  </span>
                  {rec.notes && (
                    <span className="text-gray-600 italic truncate max-w-[200px]">{rec.notes}</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Confirm Dialog ────────────────────────────────────────────────────────────

function ConfirmDialog({
  code,
  onConfirm,
  onCancel,
  loading,
}: {
  code: EmergencyCode;
  onConfirm: (notes: string) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [notes, setNotes] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border border-red-800/60 bg-gray-950 shadow-2xl shadow-red-900/30">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <div className="flex items-center gap-3">
            <span
              className="flex h-9 w-9 items-center justify-center rounded-full border-2"
              style={{ borderColor: code.color, backgroundColor: `${code.color}22` }}
            >
              <Siren className="h-4 w-4" style={{ color: code.color }} />
            </span>
            <div>
              <h3 className="text-base font-bold text-white">Activate {code.code}?</h3>
              <p className="text-xs text-gray-500">{code.description}</p>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* Actions that will trigger */}
          {code.actions.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
                This will trigger {code.actions.length} automated action{code.actions.length !== 1 ? "s" : ""}:
              </p>
              <ul className="space-y-1">
                {code.actions.map((action, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs text-gray-400">
                    <Zap className="h-3 w-3 text-amber-500 shrink-0" />
                    <span className="font-mono uppercase tracking-wide">
                      {action.replace(/_/g, " ")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-400">
              Notes (optional)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add context for the log..."
              rows={3}
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-red-600 focus:outline-none focus:ring-1 focus:ring-red-600 resize-none"
            />
          </div>

          {/* Warning */}
          <div className="flex items-start gap-2 rounded-lg border border-amber-800/40 bg-amber-900/20 px-3 py-2.5">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-400/90">
              This action will be logged in the system audit trail and may trigger
              automated responses. Confirm only in a real emergency.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 border-t border-gray-800 px-6 py-4">
          <button
            onClick={onCancel}
            disabled={loading}
            className="flex-1 rounded-lg border border-gray-700 bg-gray-800 py-2.5 text-sm font-medium text-gray-300 transition hover:bg-gray-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(notes)}
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-red-600 py-2.5 text-sm font-bold text-white transition hover:bg-red-500 active:scale-95 disabled:opacity-50"
          >
            {loading ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Siren className="h-4 w-4" />
            )}
            ACTIVATE
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function EmergencyPage() {
  const { addToast } = useToast();

  const [codes, setCodes] = useState<EmergencyCode[]>([]);
  const [active, setActive] = useState<EmergencyRecord[]>([]);
  const [history, setHistory] = useState<EmergencyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [activating, setActivating] = useState<string | null>(null);
  const [deactivating, setDeactivating] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<EmergencyCode | null>(null);
  const [now, setNow] = useState(Date.now());

  // Tick for elapsed display
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Initial load
  const loadData = useCallback(async () => {
    try {
      const [codesRes, activeRes, histRes] = await Promise.all([
        apiFetch<{ codes: EmergencyCode[] }>("/api/emergency/codes"),
        apiFetch<{ active: EmergencyRecord[] }>("/api/emergency/active"),
        apiFetch<{ history: EmergencyRecord[] }>("/api/emergency/history?limit=20"),
      ]);
      if (codesRes?.codes) setCodes(codesRes.codes);
      if (activeRes?.active) setActive(activeRes.active);
      if (histRes?.history) setHistory(histRes.history);
    } catch (err) {
      addToast("error", "Failed to load emergency data");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-refresh active emergencies every 5 seconds
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await apiFetch<{ active: EmergencyRecord[] }>("/api/emergency/active");
        if (res?.active) setActive(res.active);
      } catch {
        // silent — don't toast on refresh failures
      }
    }, 5000);
    return () => clearInterval(id);
  }, []);

  // Build a lookup map: code name -> active record
  const activeMap = Object.fromEntries(active.map((r) => [r.code, r]));

  // ── Activate ────────────────────────────────────────────────────────────────

  const handleActivateConfirm = async (notes: string) => {
    if (!confirmTarget) return;
    const codeName = confirmTarget.code;
    setActivating(codeName);
    try {
      const res = await apiFetch<{ success: boolean; record: EmergencyRecord; message: string }>(
        "/api/emergency/activate",
        {
          method: "POST",
          body: JSON.stringify({ code: codeName, notes: notes || undefined }),
        }
      );
      if (res?.success && res.record) {
        setActive((prev) => [...prev.filter((r) => r.code !== codeName), res.record]);
        setHistory((prev) => [res.record, ...prev]);
        addToast("success", `${codeName} ACTIVATED`);
      } else {
        addToast("info", res?.message ?? `${codeName} already active`);
      }
    } catch (err: unknown) {
      addToast("error", err instanceof Error ? err.message : `Failed to activate ${codeName}`);
    } finally {
      setActivating(null);
      setConfirmTarget(null);
    }
  };

  // ── Deactivate ──────────────────────────────────────────────────────────────

  const handleDeactivate = async (codeName: string) => {
    setDeactivating(codeName);
    try {
      const res = await apiFetch<{ success: boolean; record: EmergencyRecord; message: string }>(
        "/api/emergency/deactivate",
        {
          method: "POST",
          body: JSON.stringify({ code: codeName }),
        }
      );
      if (res?.success && res.record) {
        setActive((prev) => prev.filter((r) => r.code !== codeName));
        setHistory((prev) =>
          prev.map((r) => (r.id === res.record.id ? res.record : r))
        );
        addToast("success", `${codeName} resolved`);
      } else {
        addToast("info", res?.message ?? `${codeName} was not active`);
        // Refresh to sync state
        await loadData();
      }
    } catch (err: unknown) {
      addToast("error", err instanceof Error ? err.message : `Failed to deactivate ${codeName}`);
    } finally {
      setDeactivating(null);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-950">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
          <p className="text-sm text-gray-500">Loading emergency systems...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-gray-950 text-gray-100">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-30 border-b border-red-900/40 bg-gradient-to-r from-red-950/80 via-gray-950/90 to-amber-950/60 backdrop-blur-md">
        <div className="flex items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-red-700/60 bg-red-900/40">
              <Siren className="h-5 w-5 text-red-400" />
            </div>
            <div>
              <h1 className="text-sm font-bold uppercase tracking-[0.2em] text-red-300">
                Emergency Control Center
              </h1>
              <p className="text-[10px] text-gray-500">
                Hospital · Mall · Public Safety Protocols
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {active.length > 0 && (
              <span className="flex items-center gap-1.5 rounded-full border border-red-600/60 bg-red-900/40 px-3 py-1 text-xs font-bold text-red-400 animate-pulse">
                <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                {active.length} ACTIVE
              </span>
            )}
            <button
              onClick={loadData}
              className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-gray-400 transition hover:bg-gray-700 hover:text-gray-200"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">

        {/* ── Active Emergency Banners ────────────────────────────────── */}
        {active.length > 0 && (
          <div className="space-y-3">
            {active.map((rec) => (
              <ActiveBanner
                key={rec.id}
                record={rec}
                onDeactivate={handleDeactivate}
                deactivating={deactivating}
              />
            ))}
          </div>
        )}

        {/* ── Emergency Code Grid ─────────────────────────────────────── */}
        <div>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500">
              Emergency Codes — {codes.length} available
            </h2>
          </div>

          {codes.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-gray-800 bg-gray-900/50 py-12 text-center">
              <ShieldAlert className="h-10 w-10 text-gray-600" />
              <p className="text-sm text-gray-500">No emergency codes configured.</p>
              <p className="text-xs text-gray-600">Set up an industry template to load emergency codes.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {codes.map((code) => (
                <CodeCard
                  key={code.code}
                  code={code}
                  activeRecord={activeMap[code.code] ?? null}
                  onActivate={(c) => setConfirmTarget(c)}
                  onDeactivate={handleDeactivate}
                  activating={activating}
                  deactivating={deactivating}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Response Checklist ──────────────────────────────────────── */}
        {active.length > 0 && <ResponseChecklist records={active} />}

        {/* ── History Timeline ────────────────────────────────────────── */}
        <HistoryTimeline history={history} />

      </div>

      {/* ── Confirm Dialog ───────────────────────────────────────────── */}
      {confirmTarget && (
        <ConfirmDialog
          code={confirmTarget}
          onConfirm={handleActivateConfirm}
          onCancel={() => setConfirmTarget(null)}
          loading={activating === confirmTarget.code}
        />
      )}
    </div>
  );
}
