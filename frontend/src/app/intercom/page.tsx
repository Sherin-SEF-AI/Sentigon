"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Mic,
  Loader2,
  AlertTriangle,
  Phone,
  PhoneOff,
  PhoneIncoming,
  PhoneCall,
  DoorOpen,
  Volume2,
  Clock,
  Radio,
  RefreshCw,
  Users,
  MapPin,
  CheckCircle2,
  XCircle,
  ChevronDown,
  Megaphone,
  History,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface IntercomDevice {
  id: string;
  name: string;
  zone: string | null;
  ip_address: string;
  state: "idle" | "ringing" | "in_call" | "broadcasting" | "offline" | "error";
  has_door_release: boolean;
  has_camera: boolean;
  volume: number;
  last_call_time: string | null;
}

interface CallHistoryEntry {
  id: string;
  device_id: string;
  device_name: string;
  direction: "incoming" | "outgoing";
  caller_info: string | null;
  duration_seconds: number;
  result: "answered" | "missed" | "rejected" | "door_released";
  timestamp: string;
}

interface BroadcastZone {
  id: string;
  name: string;
  device_count: number;
}

type TabKey = "devices" | "history" | "broadcast";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const DEVICE_STATE_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  idle: { bg: "bg-emerald-900/30", text: "text-emerald-400", border: "border-emerald-800/50" },
  ringing: { bg: "bg-yellow-900/30", text: "text-yellow-400", border: "border-yellow-800/50" },
  in_call: { bg: "bg-cyan-900/30", text: "text-cyan-400", border: "border-cyan-800/50" },
  broadcasting: { bg: "bg-purple-900/30", text: "text-purple-400", border: "border-purple-800/50" },
  offline: { bg: "bg-gray-800", text: "text-gray-500", border: "border-gray-700" },
  error: { bg: "bg-red-900/30", text: "text-red-400", border: "border-red-800/50" },
};

const CALL_RESULT_STYLES: Record<string, string> = {
  answered: "bg-emerald-900/40 text-emerald-400 border-emerald-800",
  missed: "bg-red-900/40 text-red-400 border-red-800",
  rejected: "bg-orange-900/40 text-orange-400 border-orange-800",
  door_released: "bg-cyan-900/40 text-cyan-400 border-cyan-800",
};

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: "devices", label: "Devices", icon: <Mic className="h-4 w-4" /> },
  { key: "history", label: "Call History", icon: <History className="h-4 w-4" /> },
  { key: "broadcast", label: "Broadcast", icon: <Megaphone className="h-4 w-4" /> },
];

/* ------------------------------------------------------------------ */
/*  Broadcast Panel                                                    */
/* ------------------------------------------------------------------ */

function BroadcastPanel() {
  const [zones, setZones] = useState<BroadcastZone[]>([]);
  const [selectedZones, setSelectedZones] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [broadcasting, setBroadcasting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchZones = async () => {
      setLoading(true);
      try {
        const data = await apiFetch<BroadcastZone[]>("/api/intercom/broadcast/zones");
        setZones(data);
      } catch {
        setZones([]);
      } finally {
        setLoading(false);
      }
    };
    fetchZones();
  }, []);

  const handleBroadcast = async () => {
    if (!message.trim() || selectedZones.length === 0) return;
    setBroadcasting(true);
    setError("");
    setSuccess(false);
    try {
      await apiFetch("/api/intercom/broadcast", {
        method: "POST",
        body: JSON.stringify({
          zone_ids: selectedZones,
          message: message.trim(),
          type: "tts",
        }),
      });
      setSuccess(true);
      setMessage("");
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Broadcast failed");
    } finally {
      setBroadcasting(false);
    }
  };

  const toggleZone = (zoneId: string) => {
    setSelectedZones((prev) =>
      prev.includes(zoneId) ? prev.filter((z) => z !== zoneId) : [...prev, zoneId]
    );
  };

  const selectAll = () => {
    if (selectedZones.length === zones.length) {
      setSelectedZones([]);
    } else {
      setSelectedZones(zones.map((z) => z.id));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Zone Selection */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-300">
            Select Broadcast Zones
          </h3>
          <button
            onClick={selectAll}
            className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
          >
            {selectedZones.length === zones.length ? "Deselect All" : "Select All"}
          </button>
        </div>
        {zones.length === 0 ? (
          <p className="text-xs text-gray-600">No broadcast zones configured</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {zones.map((zone) => {
              const isSelected = selectedZones.includes(zone.id);
              return (
                <button
                  key={zone.id}
                  onClick={() => toggleZone(zone.id)}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-all",
                    isSelected
                      ? "border-cyan-700/50 bg-cyan-950/20 ring-1 ring-cyan-700/30"
                      : "border-gray-800 bg-gray-950 hover:border-gray-700"
                  )}
                >
                  <span className={cn("text-xs font-semibold", isSelected ? "text-cyan-400" : "text-gray-300")}>
                    {zone.name}
                  </span>
                  <span className="mt-1 block text-[10px] text-gray-500">
                    {zone.device_count} device{zone.device_count !== 1 && "s"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Message Input */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-5 space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-300">
          Broadcast Message
        </h3>

        {error && (
          <div className="rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-lg border border-emerald-800 bg-emerald-900/20 px-3 py-2 text-sm text-emerald-400 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            Broadcast sent successfully
          </div>
        )}

        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          placeholder="Enter message to broadcast..."
          className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700 resize-none"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={handleBroadcast}
            disabled={broadcasting || !message.trim() || selectedZones.length === 0}
            className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {broadcasting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Megaphone className="h-4 w-4" />}
            {broadcasting ? "Broadcasting..." : "Send Broadcast"}
          </button>
          <span className="text-xs text-gray-500">
            {selectedZones.length} zone{selectedZones.length !== 1 && "s"} selected
          </span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function IntercomPage() {
  const [devices, setDevices] = useState<IntercomDevice[]>([]);
  const [callHistory, setCallHistory] = useState<CallHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("devices");
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [devicesData, historyData] = await Promise.allSettled([
        apiFetch<IntercomDevice[]>("/api/intercom/devices"),
        apiFetch<CallHistoryEntry[]>("/api/intercom/calls?limit=100"),
      ]);
      if (devicesData.status === "fulfilled") setDevices(devicesData.value);
      if (historyData.status === "fulfilled") setCallHistory(historyData.value);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load intercom data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleDial = async (deviceId: string) => {
    setActionLoading(deviceId);
    try {
      await apiFetch(`/api/intercom/devices/${deviceId}/call`, {
        method: "POST",
        body: JSON.stringify({ action: "dial" }),
      });
      await fetchData();
    } catch {
      // silent
    } finally {
      setActionLoading(null);
    }
  };

  const handleAnswer = async (deviceId: string) => {
    setActionLoading(deviceId);
    try {
      await apiFetch(`/api/intercom/devices/${deviceId}/call`, {
        method: "POST",
        body: JSON.stringify({ action: "answer" }),
      });
      await fetchData();
    } catch {
      // silent
    } finally {
      setActionLoading(null);
    }
  };

  const handleEndCall = async (deviceId: string) => {
    setActionLoading(deviceId);
    try {
      await apiFetch(`/api/intercom/devices/${deviceId}/call`, {
        method: "POST",
        body: JSON.stringify({ action: "end" }),
      });
      await fetchData();
    } catch {
      // silent
    } finally {
      setActionLoading(null);
    }
  };

  const handleDoorRelease = async (deviceId: string) => {
    setActionLoading(`door-${deviceId}`);
    try {
      await apiFetch(`/api/intercom/devices/${deviceId}/door-release`, {
        method: "POST",
      });
    } catch {
      // silent
    } finally {
      setActionLoading(null);
    }
  };

  /* Stats */
  const online = devices.filter((d) => d.state !== "offline" && d.state !== "error").length;
  const inCall = devices.filter((d) => d.state === "in_call").length;
  const ringing = devices.filter((d) => d.state === "ringing").length;

  return (
    <div className="min-h-screen bg-gray-950 p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-900/30 border border-purple-800/50">
            <Mic className="h-5 w-5 text-purple-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-purple-400 tracking-wide">
              Intercom System
            </h1>
            <p className="text-xs text-gray-500">
              Manage intercom devices, calls, door releases, and broadcasts
            </p>
          </div>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {/* Stats Row */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            <Radio className="h-3.5 w-3.5" />
            Devices
          </div>
          <p className="mt-2 text-3xl font-bold text-gray-100">
            {loading ? "--" : devices.length}
          </p>
        </div>
        <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Online
          </div>
          <p className="mt-2 text-3xl font-bold text-emerald-400">
            {loading ? "--" : online}
          </p>
        </div>
        <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            <PhoneCall className="h-3.5 w-3.5" />
            In Call
          </div>
          <p className="mt-2 text-3xl font-bold text-cyan-400">
            {loading ? "--" : inCall}
          </p>
        </div>
        <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            <PhoneIncoming className="h-3.5 w-3.5" />
            Ringing
          </div>
          <p className={cn("mt-2 text-3xl font-bold", ringing > 0 ? "text-yellow-400" : "text-gray-100")}>
            {loading ? "--" : ringing}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-1 border-b border-gray-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors",
              tab === t.key
                ? "border-cyan-400 text-cyan-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          <p className="mt-3 text-sm text-gray-500">Loading intercom data...</p>
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="flex flex-col items-center justify-center py-20">
          <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={fetchData}
            className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Devices Tab ---- */}
      {!loading && !error && tab === "devices" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {devices.length === 0 ? (
            <div className="col-span-full flex flex-col items-center justify-center py-20">
              <Mic className="mb-2 h-10 w-10 text-gray-700" />
              <p className="text-sm text-gray-500">No intercom devices registered</p>
            </div>
          ) : (
            devices.map((device) => {
              const stateStyle = DEVICE_STATE_STYLES[device.state] || DEVICE_STATE_STYLES.offline;
              const isActioning = actionLoading === device.id || actionLoading === `door-${device.id}`;
              return (
                <div
                  key={device.id}
                  className={cn(
                    "rounded-lg border bg-gray-900/60 p-4 transition-colors",
                    device.state === "ringing" && "border-l-2 border-l-yellow-500 animate-pulse",
                    device.state !== "ringing" && "border-gray-800"
                  )}
                >
                  {/* Device header */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Mic className={cn("h-4 w-4", stateStyle.text)} />
                      <span className="text-sm font-semibold text-gray-200 truncate">
                        {device.name}
                      </span>
                    </div>
                    <span className={cn(
                      "rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                      stateStyle.bg, stateStyle.text, stateStyle.border
                    )}>
                      {device.state.replace(/_/g, " ")}
                    </span>
                  </div>

                  {/* Device info */}
                  <div className="space-y-1 text-xs text-gray-500 mb-4">
                    {device.zone && (
                      <div className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        <span className="text-gray-300">{device.zone}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-1">
                      <Volume2 className="h-3 w-3" />
                      <span>Volume: <span className="text-gray-300">{device.volume}%</span></span>
                    </div>
                    {device.last_call_time && (
                      <div className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        <span>Last call: <span className="text-gray-300">{formatTimestamp(device.last_call_time)}</span></span>
                      </div>
                    )}
                  </div>

                  {/* Action buttons */}
                  <div className="flex flex-wrap gap-2 pt-3 border-t border-gray-800/60">
                    {/* Dial / Answer / End Call based on state */}
                    {device.state === "idle" && (
                      <button
                        onClick={() => handleDial(device.id)}
                        disabled={isActioning}
                        className="flex items-center gap-1.5 rounded-lg bg-emerald-900/30 border border-emerald-800/50 px-3 py-1.5 text-xs font-semibold text-emerald-400 hover:bg-emerald-900/50 transition-colors disabled:opacity-50"
                      >
                        {isActioning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Phone className="h-3 w-3" />}
                        Dial
                      </button>
                    )}
                    {device.state === "ringing" && (
                      <>
                        <button
                          onClick={() => handleAnswer(device.id)}
                          disabled={isActioning}
                          className="flex items-center gap-1.5 rounded-lg bg-emerald-900/30 border border-emerald-800/50 px-3 py-1.5 text-xs font-semibold text-emerald-400 hover:bg-emerald-900/50 transition-colors disabled:opacity-50"
                        >
                          {isActioning ? <Loader2 className="h-3 w-3 animate-spin" /> : <PhoneIncoming className="h-3 w-3" />}
                          Answer
                        </button>
                        <button
                          onClick={() => handleEndCall(device.id)}
                          disabled={isActioning}
                          className="flex items-center gap-1.5 rounded-lg bg-red-900/30 border border-red-800/50 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-900/50 transition-colors disabled:opacity-50"
                        >
                          <PhoneOff className="h-3 w-3" />
                          Reject
                        </button>
                      </>
                    )}
                    {device.state === "in_call" && (
                      <button
                        onClick={() => handleEndCall(device.id)}
                        disabled={isActioning}
                        className="flex items-center gap-1.5 rounded-lg bg-red-900/30 border border-red-800/50 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-900/50 transition-colors disabled:opacity-50"
                      >
                        {isActioning ? <Loader2 className="h-3 w-3 animate-spin" /> : <PhoneOff className="h-3 w-3" />}
                        End Call
                      </button>
                    )}

                    {/* Door release */}
                    {device.has_door_release && (
                      <button
                        onClick={() => handleDoorRelease(device.id)}
                        disabled={actionLoading === `door-${device.id}`}
                        className="flex items-center gap-1.5 rounded-lg bg-amber-900/30 border border-amber-800/50 px-3 py-1.5 text-xs font-semibold text-amber-400 hover:bg-amber-900/50 transition-colors disabled:opacity-50"
                      >
                        {actionLoading === `door-${device.id}` ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <DoorOpen className="h-3 w-3" />
                        )}
                        Door Release
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ---- Call History Tab ---- */}
      {!loading && !error && tab === "history" && (
        <div className="overflow-x-auto rounded-lg border border-gray-800 max-h-[65vh] overflow-y-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-gray-800 bg-gray-900/80">
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Direction</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Device</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Caller</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Duration</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Result</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {callHistory.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-sm text-gray-600">
                    No call history
                  </td>
                </tr>
              )}
              {callHistory.map((entry) => (
                <tr key={entry.id} className="hover:bg-gray-900/60 transition-colors">
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-1.5 text-xs">
                      {entry.direction === "incoming" ? (
                        <PhoneIncoming className="h-3.5 w-3.5 text-blue-400" />
                      ) : (
                        <PhoneCall className="h-3.5 w-3.5 text-emerald-400" />
                      )}
                      <span className={entry.direction === "incoming" ? "text-blue-400" : "text-emerald-400"}>
                        {entry.direction}
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-300">{entry.device_name}</td>
                  <td className="px-4 py-3 text-xs text-gray-400">{entry.caller_info || "---"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-300">
                    {formatDuration(entry.duration_seconds)}
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      "inline-flex rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                      CALL_RESULT_STYLES[entry.result] || "bg-gray-800 text-gray-400 border-gray-700"
                    )}>
                      {entry.result.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {formatTimestamp(entry.timestamp)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Broadcast Tab ---- */}
      {!loading && !error && tab === "broadcast" && <BroadcastPanel />}
    </div>
  );
}
