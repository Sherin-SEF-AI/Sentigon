"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Shield,
  AlertTriangle,
  Camera,
  Truck,
  CheckSquare,
  Monitor,
  FileText,
  Route,
  Phone,
  Lock,
  Wifi,
  WifiOff,
  Loader2,
  ChevronRight,
  X,
  Upload,
} from "lucide-react";
import { cn, apiFetch, severityColor } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import type { Alert, Camera as CameraType } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface QuickStat {
  label: string;
  value: string | number;
  badge?: number;
  color: string;
}

interface DispatchResource {
  id: string;
  name: string;
  status: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const totalSec = Math.floor(diffMs / 1000);
  if (totalSec < 60) return `${totalSec}s ago`;
  const mins = Math.floor(totalSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatClock(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/* ------------------------------------------------------------------ */
/*  Severity badge                                                      */
/* ------------------------------------------------------------------ */

function SeverityBadge({ severity }: { severity: string }) {
  const colorMap: Record<string, string> = {
    critical: "bg-red-600 text-white",
    high: "bg-orange-500 text-white",
    medium: "bg-yellow-500 text-black",
    low: "bg-blue-500 text-white",
    info: "bg-gray-600 text-gray-200",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold uppercase tracking-wider",
        colorMap[severity] ?? colorMap.info
      )}
    >
      {severity}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Panic button                                                        */
/* ------------------------------------------------------------------ */

function PanicButton() {
  const { addToast } = useToast();
  const [phase, setPhase] = useState<"idle" | "confirm" | "sending" | "done">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTap = () => {
    if (phase === "idle") {
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate(200);
      }
      setPhase("confirm");
      // Auto-dismiss confirm after 5s if no action
      timerRef.current = setTimeout(() => setPhase("idle"), 5000);
    }
  };

  const handleConfirm = async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(500);
    }
    setPhase("sending");
    try {
      // Get current GPS location for the emergency
      let locationNote = "Mobile panic button";
      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 5000 })
        );
        locationNote = `Mobile panic button — GPS: ${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)} (accuracy: ${Math.round(pos.coords.accuracy)}m)`;
      } catch { /* location unavailable, continue without it */ }
      await apiFetch("/api/emergency/activate", {
        method: "POST",
        body: JSON.stringify({ code: "Emergency", notes: locationNote }),
      });
      setPhase("done");
      addToast("error", "EMERGENCY ACTIVATED — Help is on the way");
      setTimeout(() => setPhase("idle"), 4000);
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "Failed to activate emergency");
      setPhase("idle");
    }
  };

  const handleCancel = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setPhase("idle");
  };

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return (
    <div className="flex flex-col items-center gap-3 py-2">
      {/* Main button */}
      <button
        onClick={handleTap}
        disabled={phase === "sending"}
        aria-label="Panic button — activate emergency"
        className={cn(
          "relative flex h-36 w-36 flex-col items-center justify-center rounded-full border-4 shadow-2xl transition-all duration-150 select-none active:scale-95",
          phase === "done"
            ? "border-green-500 bg-green-700 shadow-green-900/60"
            : phase === "confirm"
            ? "border-red-400 bg-red-700 animate-pulse shadow-red-900/80"
            : phase === "sending"
            ? "border-red-600 bg-red-900/50 opacity-70"
            : "border-red-600 bg-red-700 hover:bg-red-600 shadow-red-900/60"
        )}
      >
        {phase === "sending" ? (
          <Loader2 className="h-10 w-10 animate-spin text-white" />
        ) : phase === "done" ? (
          <>
            <CheckSquare className="h-10 w-10 text-white" />
            <span className="mt-1 text-[11px] font-bold uppercase tracking-widest text-white">
              SENT
            </span>
          </>
        ) : (
          <>
            <span className="text-4xl font-black leading-none text-white">!</span>
            <span className="mt-1 text-[11px] font-bold uppercase tracking-widest text-red-100">
              PANIC
            </span>
          </>
        )}
      </button>

      {/* Confirm overlay */}
      {phase === "confirm" && (
        <div className="flex w-full max-w-xs flex-col items-center gap-3 rounded-2xl border border-red-600/60 bg-red-950/90 px-5 py-4 shadow-xl">
          <p className="text-center text-base font-bold text-red-200">
            Activate Emergency?
          </p>
          <p className="text-center text-sm text-red-400/80">
            This will alert dispatch and trigger emergency protocols.
          </p>
          <div className="flex w-full gap-3">
            <button
              onClick={handleCancel}
              className="flex-1 rounded-xl border border-gray-600 bg-gray-800 py-3 text-sm font-semibold text-gray-300 active:scale-95"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              className="flex-1 rounded-xl bg-red-600 py-3 text-sm font-bold text-white active:scale-95 hover:bg-red-500"
            >
              CONFIRM
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Inline incident report form                                         */
/* ------------------------------------------------------------------ */

function IncidentReportForm({ onClose }: { onClose: () => void }) {
  const { addToast } = useToast();
  const [description, setDescription] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setPhotoFile(file);
  };

  const handleSubmit = async () => {
    if (!description.trim()) {
      addToast("error", "Please enter a description");
      return;
    }
    setSubmitting(true);
    try {
      // If a photo was selected, upload it first
      let photoUrl: string | undefined;
      if (photoFile) {
        const formData = new FormData();
        formData.append("file", photoFile);
        const token = typeof window !== "undefined" ? localStorage.getItem("sentinel_token") : null;
        const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8002"}/api/evidence/upload`, {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: formData,
        });
        if (res.ok) {
          const data = await res.json();
          photoUrl = data.url || data.file_url || data.path;
        }
      }

      await apiFetch("/api/incidents", {
        method: "POST",
        body: JSON.stringify({
          title: "Field Incident Report",
          description: description.trim(),
          severity: "medium",
          source: "mobile",
          ...(photoUrl ? { evidence_url: photoUrl } : {}),
        }),
      });

      addToast("success", "Incident reported successfully");
      onClose();
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "Failed to submit report");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-gray-700 bg-gray-900 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold text-gray-200">Report Incident</span>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Describe what you observed..."
        rows={4}
        className="w-full resize-none rounded-xl border border-gray-700 bg-gray-800 px-4 py-3 text-base text-gray-100 placeholder-gray-600 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600"
      />

      <div className="flex items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handlePhotoSelect}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-2 rounded-xl border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-300 active:scale-95"
        >
          <Upload className="h-4 w-4" />
          {photoFile ? photoFile.name.slice(0, 20) + (photoFile.name.length > 20 ? "…" : "") : "Add Photo"}
        </button>

        <button
          onClick={handleSubmit}
          disabled={submitting || !description.trim()}
          className="ml-auto flex items-center gap-2 rounded-xl bg-cyan-700 px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50 active:scale-95 hover:bg-cyan-600"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Submit
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Quick action button                                                 */
/* ------------------------------------------------------------------ */

interface QuickActionProps {
  icon: React.ReactNode;
  label: string;
  color: string;
  onClick: () => void;
  disabled?: boolean;
}

function QuickActionBtn({ icon, label, color, onClick, disabled }: QuickActionProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex min-h-[80px] flex-col items-center justify-center gap-2 rounded-2xl border p-4 text-center transition-all duration-150 active:scale-95 disabled:opacity-50",
        color
      )}
    >
      <div className="flex h-8 w-8 items-center justify-center">{icon}</div>
      <span className="text-xs font-bold uppercase leading-tight tracking-wide">{label}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Main mobile dashboard page                                          */
/* ------------------------------------------------------------------ */

export default function MobilePage() {
  const router = useRouter();
  const { addToast } = useToast();

  const [connected, setConnected] = useState(true);
  const [now, setNow] = useState(new Date());
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [cameras, setCameras] = useState<CameraType[]>([]);
  const [dispatchCount, setDispatchCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showReportForm, setShowReportForm] = useState(false);
  const [lockdownConfirm, setLockdownConfirm] = useState(false);
  const [lockdownSending, setLockdownSending] = useState(false);

  /* Clock tick */
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  /* Data fetch */
  const fetchData = useCallback(async () => {
    try {
      const [alertsRes, camerasRes, dispatchRes] = await Promise.all([
        apiFetch<{ alerts: Alert[] } | Alert[]>("/api/alerts?status=new&limit=5"),
        apiFetch<{ cameras: CameraType[] } | CameraType[]>("/api/cameras"),
        apiFetch<{ resources: DispatchResource[] } | DispatchResource[]>("/api/dispatch/resources"),
      ]);

      // Normalise alerts response (array or wrapped object)
      const alertList: Alert[] = Array.isArray(alertsRes)
        ? alertsRes
        : (alertsRes as { alerts: Alert[] })?.alerts ?? [];
      setAlerts(alertList.slice(0, 5));

      // Normalise cameras response
      const cameraList: CameraType[] = Array.isArray(camerasRes)
        ? camerasRes
        : (camerasRes as { cameras: CameraType[] })?.cameras ?? [];
      setCameras(cameraList);

      // Dispatch count
      const resources: DispatchResource[] = Array.isArray(dispatchRes)
        ? dispatchRes
        : (dispatchRes as { resources: DispatchResource[] })?.resources ?? [];
      setDispatchCount(resources.filter((r) => r.status === "dispatched" || r.status === "active").length);

      setConnected(true);
    } catch {
      setConnected(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 10000);
    return () => clearInterval(id);
  }, [fetchData]);

  /* Lockdown handler */
  const handleLockdown = async () => {
    setLockdownSending(true);
    try {
      await apiFetch("/api/emergency/activate", {
        method: "POST",
        body: JSON.stringify({ code: "Lockdown", notes: "Initiated via mobile dashboard" }),
      });
      addToast("error", "LOCKDOWN ACTIVATED");
      setLockdownConfirm(false);
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "Failed to activate lockdown");
    } finally {
      setLockdownSending(false);
    }
  };

  /* Stats derived from data */
  const onlineCameras = cameras.filter((c) => c.status === "online").length;
  const newAlertCount = alerts.length;

  const stats: QuickStat[] = [
    {
      label: "Active Alerts",
      value: newAlertCount,
      badge: newAlertCount > 0 ? newAlertCount : undefined,
      color: newAlertCount > 0 ? "text-red-400" : "text-gray-300",
    },
    {
      label: "Cameras Online",
      value: `${onlineCameras}/${cameras.length}`,
      color: onlineCameras === cameras.length ? "text-green-400" : "text-yellow-400",
    },
    {
      label: "Dispatched",
      value: dispatchCount,
      color: dispatchCount > 0 ? "text-cyan-400" : "text-gray-300",
    },
  ];

  /* ---------------------------------------------------------------- */
  /*  Render                                                            */
  /* ---------------------------------------------------------------- */

  return (
    <div
      className="min-h-screen bg-gray-950 text-gray-100 select-none"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
    >
      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-gray-800/60 bg-gray-950/95 px-4 py-3 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <Shield className="h-6 w-6 text-cyan-400 shrink-0" />
          <span className="text-sm font-black uppercase tracking-[0.2em] text-gray-100">
            SENTINEL AI
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Connection status */}
          <div className="flex items-center gap-1.5">
            {connected ? (
              <>
                <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                <Wifi className="h-3.5 w-3.5 text-green-500" />
              </>
            ) : (
              <>
                <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                <WifiOff className="h-3.5 w-3.5 text-red-500" />
              </>
            )}
          </div>

          {/* Clock */}
          <span className="font-mono text-sm font-semibold text-gray-300">
            {formatClock(now)}
          </span>
        </div>
      </header>

      <div className="space-y-5 px-4 pb-10 pt-4">

        {/* ── Quick Stats Row ─────────────────────────────────────────── */}
        <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-none">
          {loading
            ? [0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="flex min-w-[120px] flex-col rounded-2xl border border-gray-800 bg-gray-900 p-4 animate-pulse"
                >
                  <div className="h-3 w-16 rounded bg-gray-800 mb-2" />
                  <div className="h-7 w-10 rounded bg-gray-800" />
                </div>
              ))
            : stats.map((stat) => (
                <div
                  key={stat.label}
                  className="flex min-w-[120px] flex-col rounded-2xl border border-gray-800/60 bg-gray-900 p-4"
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-500 leading-snug">
                      {stat.label}
                    </span>
                    {stat.badge !== undefined && (
                      <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-600 px-1.5 text-[10px] font-bold text-white">
                        {stat.badge}
                      </span>
                    )}
                  </div>
                  <span className={cn("text-2xl font-black tabular-nums", stat.color)}>
                    {stat.value}
                  </span>
                </div>
              ))}
        </div>

        {/* ── Panic Button ────────────────────────────────────────────── */}
        <section className="rounded-2xl border border-red-900/40 bg-gray-900/60 px-4 py-5">
          <h2 className="mb-4 text-center text-xs font-bold uppercase tracking-widest text-red-400">
            Emergency Panic
          </h2>
          <PanicButton />
        </section>

        {/* ── Quick Actions Grid ──────────────────────────────────────── */}
        <section>
          <h2 className="mb-3 text-xs font-bold uppercase tracking-widest text-gray-500">
            Quick Actions
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <QuickActionBtn
              icon={<CheckSquare className="h-7 w-7 text-yellow-400" />}
              label="Acknowledge Alert"
              color="border-yellow-800/40 bg-yellow-900/10 text-yellow-300 hover:bg-yellow-900/20"
              onClick={() => router.push("/alerts")}
            />
            <QuickActionBtn
              icon={<Monitor className="h-7 w-7 text-cyan-400" />}
              label="View Cameras"
              color="border-cyan-800/40 bg-cyan-900/10 text-cyan-300 hover:bg-cyan-900/20"
              onClick={() => router.push("/video-wall")}
            />
            <QuickActionBtn
              icon={<FileText className="h-7 w-7 text-green-400" />}
              label="Report Incident"
              color={cn(
                "border-green-800/40 bg-green-900/10 text-green-300 hover:bg-green-900/20",
                showReportForm && "ring-1 ring-green-600"
              )}
              onClick={() => setShowReportForm((v) => !v)}
            />
            <QuickActionBtn
              icon={<Route className="h-7 w-7 text-blue-400" />}
              label="Start Patrol"
              color="border-blue-800/40 bg-blue-900/10 text-blue-300 hover:bg-blue-900/20"
              onClick={() => router.push("/patrol")}
            />
            <QuickActionBtn
              icon={<Phone className="h-7 w-7 text-purple-400" />}
              label="Call Dispatch"
              color="border-purple-800/40 bg-purple-900/10 text-purple-300 hover:bg-purple-900/20"
              onClick={() => {
                // Try tel link first; fall back to dispatch page
                if (typeof window !== "undefined") {
                  const tel = document.createElement("a");
                  tel.href = "tel:911";
                  tel.click();
                }
                router.push("/dispatch");
              }}
            />
            <QuickActionBtn
              icon={<Lock className="h-7 w-7 text-red-400" />}
              label="Lockdown"
              color={cn(
                "border-red-800/40 bg-red-900/10 text-red-300 hover:bg-red-900/20",
                lockdownConfirm && "ring-1 ring-red-500 animate-pulse"
              )}
              onClick={() => setLockdownConfirm(true)}
              disabled={lockdownSending}
            />
          </div>
        </section>

        {/* ── Inline Incident Form ──────────────────────────────────── */}
        {showReportForm && (
          <IncidentReportForm onClose={() => setShowReportForm(false)} />
        )}

        {/* ── Lockdown confirmation dialog ─────────────────────────── */}
        {lockdownConfirm && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center">
            <div className="w-full max-w-sm rounded-2xl border border-red-700/60 bg-gray-950 p-6 shadow-2xl shadow-red-900/30">
              <div className="mb-4 flex items-center gap-3">
                <Lock className="h-6 w-6 text-red-400 shrink-0" />
                <div>
                  <p className="text-base font-bold text-red-300">Activate Lockdown?</p>
                  <p className="text-xs text-gray-500">
                    All access points will be secured immediately.
                  </p>
                </div>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setLockdownConfirm(false)}
                  disabled={lockdownSending}
                  className="flex-1 rounded-xl border border-gray-700 bg-gray-800 py-3 text-sm font-semibold text-gray-300 active:scale-95 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleLockdown}
                  disabled={lockdownSending}
                  className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-red-700 py-3 text-sm font-bold text-white active:scale-95 disabled:opacity-50 hover:bg-red-600"
                >
                  {lockdownSending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Lock className="h-4 w-4" />
                  )}
                  LOCKDOWN
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Recent Alerts Feed ──────────────────────────────────────── */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-widest text-gray-500">
              Recent Alerts
            </h2>
            <button
              onClick={() => router.push("/alerts")}
              className="flex items-center gap-1 text-xs font-medium text-cyan-500 hover:text-cyan-400"
            >
              View All
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {loading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-16 rounded-xl border border-gray-800 bg-gray-900 animate-pulse"
                />
              ))}
            </div>
          ) : alerts.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-gray-800 bg-gray-900/50 py-8">
              <AlertTriangle className="h-8 w-8 text-gray-700" />
              <p className="text-sm text-gray-600">No new alerts</p>
            </div>
          ) : (
            <div className="space-y-2">
              {alerts.map((alert) => (
                <button
                  key={alert.id}
                  onClick={() => router.push("/alerts")}
                  className="flex w-full items-center gap-3 rounded-2xl border border-gray-800/60 bg-gray-900 px-4 py-3 text-left transition-colors hover:border-gray-700 active:scale-[0.99]"
                >
                  <AlertTriangle
                    className={cn(
                      "h-5 w-5 shrink-0",
                      alert.severity === "critical"
                        ? "text-red-500"
                        : alert.severity === "high"
                        ? "text-orange-500"
                        : alert.severity === "medium"
                        ? "text-yellow-500"
                        : "text-blue-400"
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-semibold text-gray-200">
                      {alert.title}
                    </p>
                    <p className="text-xs text-gray-500">{timeAgo(alert.created_at)}</p>
                  </div>
                  <SeverityBadge severity={alert.severity} />
                </button>
              ))}
            </div>
          )}
        </section>

        {/* ── Camera status summary ─────────────────────────────────── */}
        {!loading && cameras.length > 0 && (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-widest text-gray-500">
                Camera Status
              </h2>
              <button
                onClick={() => router.push("/cameras")}
                className="flex items-center gap-1 text-xs font-medium text-cyan-500 hover:text-cyan-400"
              >
                Manage
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="flex items-center gap-4 rounded-2xl border border-gray-800/60 bg-gray-900 px-5 py-4">
              <Camera className="h-6 w-6 text-gray-500 shrink-0" />
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-lg font-bold text-gray-100">
                    {onlineCameras}{" "}
                    <span className="text-sm font-normal text-gray-500">
                      / {cameras.length} online
                    </span>
                  </span>
                  <span
                    className={cn(
                      "text-xs font-bold",
                      onlineCameras === cameras.length
                        ? "text-green-400"
                        : onlineCameras > cameras.length / 2
                        ? "text-yellow-400"
                        : "text-red-400"
                    )}
                  >
                    {cameras.length > 0
                      ? Math.round((onlineCameras / cameras.length) * 100)
                      : 0}
                    %
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-gray-800">
                  <div
                    className={cn(
                      "h-2 rounded-full transition-all duration-700",
                      onlineCameras === cameras.length
                        ? "bg-green-500"
                        : onlineCameras > cameras.length / 2
                        ? "bg-yellow-500"
                        : "bg-red-500"
                    )}
                    style={{
                      width: cameras.length
                        ? `${(onlineCameras / cameras.length) * 100}%`
                        : "0%",
                    }}
                  />
                </div>
              </div>
            </div>
          </section>
        )}

      </div>
    </div>
  );
}
