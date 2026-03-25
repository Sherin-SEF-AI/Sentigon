"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Camera,
  Loader2,
  AlertTriangle,
  Search,
  Plus,
  Wifi,
  WifiOff,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Square,
  RefreshCw,
  Monitor,
  Info,
  Settings,
  Eye,
  Video,
  X,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ONVIFDevice {
  ip: string;
  port: number;
  name: string;
  manufacturer?: string;
  model?: string;
  hardware_id?: string;
  xaddrs?: string[];
}

interface ONVIFProfile {
  name: string;
  token: string;
  encoding?: string;
  resolution?: { width: number; height: number };
  fps?: number;
}

interface ONVIFDeviceInfo {
  manufacturer: string;
  model: string;
  firmware_version: string;
  serial_number: string;
  hardware_id: string;
}

interface ConnectedDevice {
  ip: string;
  port: number;
  device_info: ONVIFDeviceInfo;
  profiles: ONVIFProfile[];
  stream_uris: Record<string, string>;
  ptz_supported: boolean;
  presets?: { token: string; name: string }[];
}

interface PTZStatus {
  pan: number;
  tilt: number;
  zoom: number;
}

type TabKey = "cameras" | "onvif";

/* ------------------------------------------------------------------ */
/*  ONVIF Connect Form                                                 */
/* ------------------------------------------------------------------ */

function ONVIFConnectForm({
  onConnected,
  initialIp,
}: {
  onConnected: (device: ConnectedDevice) => void;
  initialIp?: string;
}) {
  const [ip, setIp] = useState(initialIp || "");
  const [port, setPort] = useState("80");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const device = await apiFetch<ConnectedDevice>("/api/onvif/connect", {
        method: "POST",
        body: JSON.stringify({
          ip,
          port: parseInt(port, 10),
          username,
          password,
        }),
      });
      onConnected(device);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      onSubmit={handleConnect}
      className="rounded-lg border border-gray-800 bg-gray-900/60 p-4 space-y-4"
    >
      <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
        <Settings className="h-4 w-4 text-cyan-400" />
        Connect to ONVIF Camera
      </h3>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-400">
            IP Address
          </label>
          <input
            type="text"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            placeholder="192.168.1.100"
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-400">
            Port
          </label>
          <input
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            placeholder="80"
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-400">
            Username
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            placeholder="admin"
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-400">
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            placeholder="Password"
            required
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        {loading ? "Connecting..." : "Connect"}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  PTZ Control Panel                                                  */
/* ------------------------------------------------------------------ */

function PTZControlPanel({
  device,
  activeProfile,
}: {
  device: ConnectedDevice;
  activeProfile: string;
}) {
  const [moving, setMoving] = useState(false);
  const [ptzStatus, setPtzStatus] = useState<PTZStatus | null>(null);
  const [selectedPreset, setSelectedPreset] = useState("");
  const [speed, setSpeed] = useState(0.5);

  const sendPTZ = async (
    action: string,
    params?: Record<string, unknown>
  ) => {
    setMoving(true);
    try {
      await apiFetch("/api/onvif/ptz", {
        method: "POST",
        body: JSON.stringify({
          ip: device.ip,
          port: device.port,
          profile_token: activeProfile,
          action,
          speed,
          ...params,
        }),
      });
      // Fetch updated status
      const status = await apiFetch<PTZStatus>(
        `/api/onvif/ptz/status?ip=${device.ip}&port=${device.port}&profile_token=${activeProfile}`
      );
      setPtzStatus(status);
    } catch {
      // silent
    } finally {
      setMoving(false);
    }
  };

  const gotoPreset = async () => {
    if (!selectedPreset) return;
    await sendPTZ("goto_preset", { preset_token: selectedPreset });
  };

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4 space-y-4">
      <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
        <Monitor className="h-4 w-4 text-cyan-400" />
        PTZ Control
      </h3>

      {/* Speed slider */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-500 uppercase tracking-wider">
          Speed
        </span>
        <input
          type="range"
          min="0.1"
          max="1.0"
          step="0.1"
          value={speed}
          onChange={(e) => setSpeed(parseFloat(e.target.value))}
          className="flex-1 accent-cyan-500"
        />
        <span className="text-xs font-mono text-cyan-400 w-8">
          {speed.toFixed(1)}
        </span>
      </div>

      {/* Directional Pad */}
      <div className="flex flex-col items-center gap-1">
        {/* UP */}
        <button
          onClick={() => sendPTZ("move", { direction: "up" })}
          disabled={moving}
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-gray-700 bg-gray-800 text-gray-300 transition-colors hover:bg-cyan-900/40 hover:border-cyan-700 hover:text-cyan-400 disabled:opacity-50"
          title="Tilt Up"
        >
          <ChevronUp className="h-5 w-5" />
        </button>

        {/* LEFT, STOP, RIGHT */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => sendPTZ("move", { direction: "left" })}
            disabled={moving}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-gray-700 bg-gray-800 text-gray-300 transition-colors hover:bg-cyan-900/40 hover:border-cyan-700 hover:text-cyan-400 disabled:opacity-50"
            title="Pan Left"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            onClick={() => sendPTZ("stop")}
            disabled={moving}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-red-800/50 bg-red-900/20 text-red-400 transition-colors hover:bg-red-900/40 hover:border-red-700 disabled:opacity-50"
            title="Stop"
          >
            <Square className="h-4 w-4" />
          </button>
          <button
            onClick={() => sendPTZ("move", { direction: "right" })}
            disabled={moving}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-gray-700 bg-gray-800 text-gray-300 transition-colors hover:bg-cyan-900/40 hover:border-cyan-700 hover:text-cyan-400 disabled:opacity-50"
            title="Pan Right"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        {/* DOWN */}
        <button
          onClick={() => sendPTZ("move", { direction: "down" })}
          disabled={moving}
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-gray-700 bg-gray-800 text-gray-300 transition-colors hover:bg-cyan-900/40 hover:border-cyan-700 hover:text-cyan-400 disabled:opacity-50"
          title="Tilt Down"
        >
          <ChevronDown className="h-5 w-5" />
        </button>
      </div>

      {/* Zoom controls */}
      <div className="flex items-center justify-center gap-3">
        <button
          onClick={() => sendPTZ("zoom", { direction: "out" })}
          disabled={moving}
          className="flex h-10 w-20 items-center justify-center gap-1 rounded-lg border border-gray-700 bg-gray-800 text-gray-300 transition-colors hover:bg-cyan-900/40 hover:border-cyan-700 hover:text-cyan-400 disabled:opacity-50"
          title="Zoom Out"
        >
          <ZoomOut className="h-4 w-4" />
          <span className="text-xs">ZOOM-</span>
        </button>
        <button
          onClick={() => sendPTZ("zoom", { direction: "in" })}
          disabled={moving}
          className="flex h-10 w-20 items-center justify-center gap-1 rounded-lg border border-gray-700 bg-gray-800 text-gray-300 transition-colors hover:bg-cyan-900/40 hover:border-cyan-700 hover:text-cyan-400 disabled:opacity-50"
          title="Zoom In"
        >
          <ZoomIn className="h-4 w-4" />
          <span className="text-xs">ZOOM+</span>
        </button>
      </div>

      {/* Presets dropdown */}
      {device.presets && device.presets.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            value={selectedPreset}
            onChange={(e) => setSelectedPreset(e.target.value)}
            className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          >
            <option value="">Select Preset...</option>
            {device.presets.map((p) => (
              <option key={p.token} value={p.token}>
                {p.name || `Preset ${p.token}`}
              </option>
            ))}
          </select>
          <button
            onClick={gotoPreset}
            disabled={moving || !selectedPreset}
            className="rounded-lg bg-cyan-600 px-3 py-2 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Go
          </button>
        </div>
      )}

      {/* PTZ Status */}
      {ptzStatus && (
        <div className="flex items-center gap-4 text-[10px] text-gray-500 pt-2 border-t border-gray-800">
          <span>
            Pan:{" "}
            <span className="font-mono text-gray-300">
              {ptzStatus.pan.toFixed(2)}
            </span>
          </span>
          <span>
            Tilt:{" "}
            <span className="font-mono text-gray-300">
              {ptzStatus.tilt.toFixed(2)}
            </span>
          </span>
          <span>
            Zoom:{" "}
            <span className="font-mono text-gray-300">
              {ptzStatus.zoom.toFixed(2)}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Existing Cameras Tab                                               */
/* ------------------------------------------------------------------ */

interface CameraItem {
  id: string;
  name: string;
  source: string;
  status: string;
  location: string | null;
  fps: number;
  resolution: string | null;
  is_active: boolean;
}

function AddCameraModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { addToast } = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    source: "",
    location: "",
    type: "rtsp" as "rtsp" | "dvr" | "http",
  });

  const STREAM_TEMPLATES = [
    { label: "Generic RTSP", value: "rtsp://IP:554/stream1" },
    { label: "Hikvision", value: "rtsp://admin:password@IP:554/Streaming/Channels/101" },
    { label: "Dahua", value: "rtsp://admin:password@IP:554/cam/realmonitor?channel=1&subtype=0" },
    { label: "Axis", value: "rtsp://IP:554/axis-media/media.amp" },
    { label: "Reolink", value: "rtsp://admin:password@IP:554/h264Preview_01_main" },
    { label: "Uniview", value: "rtsp://admin:password@IP:554/media/video1" },
    { label: "Amcrest", value: "rtsp://admin:password@IP:554/cam/realmonitor?channel=1&subtype=0" },
    { label: "HTTP MJPEG", value: "http://IP:8080/video" },
    { label: "HLS Stream", value: "http://IP:8080/live/stream.m3u8" },
  ];

  const handleSave = async () => {
    if (!form.name.trim() || !form.source.trim()) return;
    setSaving(true);
    try {
      await apiFetch("/api/cameras", {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          source: form.source.trim(),
          location: form.location.trim() || null,
          is_active: true,
        }),
      });
      addToast("success", `Camera "${form.name}" added successfully`);
      onAdded();
      onClose();
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "Failed to add camera");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-gray-800 bg-gray-950 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <div className="flex items-center gap-2">
            <Plus className="h-5 w-5 text-cyan-400" />
            <h2 className="text-sm font-bold text-gray-100">Add Camera</h2>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          {/* Stream Type */}
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Stream Type
            </label>
            <div className="flex gap-2">
              {(["rtsp", "dvr", "http"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setForm({ ...form, type: t })}
                  className={cn(
                    "rounded-lg border px-4 py-2 text-xs font-semibold transition-colors",
                    form.type === t
                      ? "border-cyan-700 bg-cyan-900/30 text-cyan-400"
                      : "border-gray-700 bg-gray-800 text-gray-400 hover:bg-gray-700"
                  )}
                >
                  {t === "rtsp" ? "RTSP" : t === "dvr" ? "DVR/NVR" : "HTTP/HLS"}
                </button>
              ))}
            </div>
          </div>

          {/* Camera Name */}
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Camera Name *
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Front Entrance, Parking Lot A"
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            />
          </div>

          {/* Stream URL */}
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Stream URL *
            </label>
            <input
              type="text"
              value={form.source}
              onChange={(e) => setForm({ ...form, source: e.target.value })}
              placeholder={
                form.type === "rtsp"
                  ? "rtsp://192.168.1.100:554/stream1"
                  : form.type === "dvr"
                  ? "rtsp://admin:pass@dvr-ip:554/ch1/main"
                  : "http://192.168.1.100:8080/video"
              }
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 font-mono placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            />
          </div>

          {/* Quick Templates */}
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Quick Templates
            </label>
            <div className="flex flex-wrap gap-1.5">
              {STREAM_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.label}
                  onClick={() => setForm({ ...form, source: tpl.value })}
                  className="rounded-md border border-gray-700 bg-gray-800 px-2 py-1 text-[10px] text-gray-400 hover:bg-gray-700 hover:text-cyan-400 transition-colors"
                >
                  {tpl.label}
                </button>
              ))}
            </div>
          </div>

          {/* Location */}
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Location (optional)
            </label>
            <input
              type="text"
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              placeholder="e.g. Building A, Floor 2, North Wing"
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            />
          </div>

          {/* DVR Help */}
          {form.type === "dvr" && (
            <div className="rounded-lg border border-amber-800/40 bg-amber-900/10 px-3 py-2 text-[11px] text-amber-400">
              <strong>DVR/NVR Tip:</strong> Each channel has its own RTSP URL. Common formats:
              <br />Hikvision: <code className="font-mono text-amber-300">rtsp://admin:pass@IP:554/Streaming/Channels/101</code> (ch1 main)
              <br />Dahua: <code className="font-mono text-amber-300">rtsp://admin:pass@IP:554/cam/realmonitor?channel=1&subtype=0</code>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-gray-800 px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-700 px-4 py-2 text-xs text-gray-400 hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !form.name.trim() || !form.source.trim()}
            className="flex items-center gap-2 rounded-lg bg-cyan-700 px-4 py-2 text-xs font-semibold text-white hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Add Camera
          </button>
        </div>
      </div>
    </div>
  );
}

function CamerasTab() {
  const [cameras, setCameras] = useState<CameraItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);

  const fetchCameras = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch<CameraItem[]>("/api/cameras");
      setCameras(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load cameras");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCameras();
  }, [fetchCameras]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={fetchCameras}
          className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Add Camera Button */}
      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs text-gray-500">{cameras.length} camera{cameras.length !== 1 ? "s" : ""} registered</p>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 rounded-lg bg-cyan-700 px-4 py-2 text-xs font-semibold text-white hover:bg-cyan-600 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Camera
        </button>
      </div>

      {/* Add Camera Modal */}
      {showAddModal && (
        <AddCameraModal
          onClose={() => setShowAddModal(false)}
          onAdded={fetchCameras}
        />
      )}

    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {cameras.length === 0 && (
        <div className="col-span-full flex flex-col items-center justify-center py-20">
          <Camera className="mb-2 h-10 w-10 text-gray-700" />
          <p className="text-sm text-gray-500">No cameras registered</p>
          <button
            onClick={() => setShowAddModal(true)}
            className="mt-3 flex items-center gap-2 rounded-lg border border-cyan-700 px-4 py-2 text-xs text-cyan-400 hover:bg-cyan-900/30 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Add your first camera
          </button>
        </div>
      )}
      {cameras.map((cam) => (
        <div
          key={cam.id}
          className="rounded-lg border border-gray-800 bg-gray-900/60 p-4 transition-colors hover:border-cyan-800/50"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Video className="h-4 w-4 text-cyan-400" />
              <span className="text-sm font-semibold text-gray-200 truncate">
                {cam.name}
              </span>
            </div>
            <span
              className={cn(
                "h-2.5 w-2.5 rounded-full",
                cam.status === "online"
                  ? "bg-emerald-400"
                  : cam.status === "error"
                  ? "bg-red-400"
                  : "bg-gray-600"
              )}
              title={cam.status}
            />
          </div>
          <div className="space-y-1 text-xs text-gray-500">
            {cam.location && (
              <p>
                Location: <span className="text-gray-300">{cam.location}</span>
              </p>
            )}
            <p>
              FPS: <span className="font-mono text-gray-300">{cam.fps}</span>
            </p>
            {cam.resolution && (
              <p>
                Resolution:{" "}
                <span className="font-mono text-gray-300">
                  {cam.resolution}
                </span>
              </p>
            )}
            <p>
              Status:{" "}
              <span
                className={cn(
                  "font-semibold",
                  cam.status === "online"
                    ? "text-emerald-400"
                    : cam.status === "error"
                    ? "text-red-400"
                    : "text-gray-400"
                )}
              >
                {cam.status}
              </span>
            </p>
          </div>
        </div>
      ))}
    </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ONVIF Tab                                                          */
/* ------------------------------------------------------------------ */

function ONVIFTab() {
  const [discovered, setDiscovered] = useState<ONVIFDevice[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [connectedDevices, setConnectedDevices] = useState<ConnectedDevice[]>(
    []
  );
  const [selectedDevice, setSelectedDevice] = useState<ConnectedDevice | null>(
    null
  );
  const [showConnectForm, setShowConnectForm] = useState(false);
  const [connectIp, setConnectIp] = useState("");
  const [activeProfile, setActiveProfile] = useState("");
  const [error, setError] = useState("");

  const handleDiscover = async () => {
    setDiscovering(true);
    setError("");
    try {
      const devices = await apiFetch<ONVIFDevice[]>("/api/onvif/discover", {
        method: "POST",
      });
      setDiscovered(devices);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Discovery failed"
      );
    } finally {
      setDiscovering(false);
    }
  };

  const handleConnected = (device: ConnectedDevice) => {
    setConnectedDevices((prev) => {
      const filtered = prev.filter((d) => d.ip !== device.ip);
      return [...filtered, device];
    });
    setSelectedDevice(device);
    setShowConnectForm(false);
    if (device.profiles.length > 0) {
      setActiveProfile(device.profiles[0].token);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Discovery Section */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-300">
            Network Discovery
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setShowConnectForm(!showConnectForm);
                setConnectIp("");
              }}
              className="flex items-center gap-2 rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              Manual Connect
            </button>
            <button
              onClick={handleDiscover}
              disabled={discovering}
              className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {discovering ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              {discovering ? "Discovering..." : "Discover Cameras"}
            </button>
          </div>
        </div>

        {/* Manual connect form */}
        {showConnectForm && (
          <ONVIFConnectForm
            onConnected={handleConnected}
            initialIp={connectIp}
          />
        )}

        {/* Discovered devices */}
        {discovered.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">
              {discovered.length} device{discovered.length !== 1 && "s"} found
              on network
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {discovered.map((device) => {
                const isConnected = connectedDevices.some(
                  (d) => d.ip === device.ip
                );
                return (
                  <div
                    key={`${device.ip}:${device.port}`}
                    className={cn(
                      "rounded-lg border bg-gray-950 p-4 space-y-2 transition-colors",
                      isConnected
                        ? "border-emerald-800/50 bg-emerald-950/20"
                        : "border-gray-800 hover:border-gray-700"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {isConnected ? (
                          <Wifi className="h-4 w-4 text-emerald-400" />
                        ) : (
                          <WifiOff className="h-4 w-4 text-gray-500" />
                        )}
                        <span className="font-mono text-sm font-semibold text-gray-200">
                          {device.ip}:{device.port}
                        </span>
                      </div>
                      {isConnected && (
                        <span className="rounded-full bg-emerald-900/40 px-2 py-0.5 text-[10px] font-bold text-emerald-400 border border-emerald-800/50">
                          CONNECTED
                        </span>
                      )}
                    </div>
                    {device.name && (
                      <p className="text-xs text-gray-400">{device.name}</p>
                    )}
                    {device.manufacturer && (
                      <p className="text-xs text-gray-500">
                        {device.manufacturer} {device.model || ""}
                      </p>
                    )}
                    {!isConnected && (
                      <button
                        onClick={() => {
                          setConnectIp(device.ip);
                          setShowConnectForm(true);
                        }}
                        className="flex items-center gap-1.5 rounded-lg bg-cyan-900/30 border border-cyan-800/50 px-3 py-1.5 text-xs font-medium text-cyan-400 hover:bg-cyan-900/50 transition-colors"
                      >
                        <Plus className="h-3 w-3" />
                        Connect
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!discovering && discovered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Search className="mb-3 h-10 w-10 text-gray-700" />
            <p className="text-sm text-gray-500">
              No devices discovered yet
            </p>
            <p className="mt-1 text-xs text-gray-600">
              Click &quot;Discover Cameras&quot; to scan your network for ONVIF
              devices
            </p>
          </div>
        )}
      </div>

      {/* Connected Devices */}
      {connectedDevices.length > 0 && (
        <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-5 space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-300">
            Connected Devices ({connectedDevices.length})
          </h3>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {connectedDevices.map((device) => {
              const isSelected = selectedDevice?.ip === device.ip;
              return (
                <button
                  key={device.ip}
                  onClick={() => {
                    setSelectedDevice(device);
                    if (device.profiles.length > 0) {
                      setActiveProfile(device.profiles[0].token);
                    }
                  }}
                  className={cn(
                    "w-full text-left rounded-lg border p-4 transition-all",
                    isSelected
                      ? "border-cyan-700/60 bg-cyan-950/20"
                      : "border-gray-800 hover:border-gray-700 bg-gray-950"
                  )}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Wifi className="h-4 w-4 text-emerald-400" />
                    <span className="font-mono text-sm font-semibold text-gray-200">
                      {device.ip}:{device.port}
                    </span>
                  </div>
                  <div className="space-y-1 text-xs text-gray-500">
                    <p>
                      Manufacturer:{" "}
                      <span className="text-gray-300">
                        {device.device_info.manufacturer}
                      </span>
                    </p>
                    <p>
                      Model:{" "}
                      <span className="text-gray-300">
                        {device.device_info.model}
                      </span>
                    </p>
                    <p>
                      Firmware:{" "}
                      <span className="text-gray-300">
                        {device.device_info.firmware_version}
                      </span>
                    </p>
                    <p>
                      Profiles:{" "}
                      <span className="text-cyan-400">
                        {device.profiles.length}
                      </span>
                    </p>
                    <p>
                      PTZ:{" "}
                      <span
                        className={
                          device.ptz_supported
                            ? "text-emerald-400"
                            : "text-gray-600"
                        }
                      >
                        {device.ptz_supported ? "Supported" : "Not Supported"}
                      </span>
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Selected Device Details + PTZ */}
      {selectedDevice && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Device Details */}
          <div className="space-y-4">
            {/* Profiles */}
            <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                <Eye className="h-4 w-4 text-cyan-400" />
                Media Profiles
              </h3>
              <div className="space-y-2">
                {selectedDevice.profiles.map((profile) => (
                  <div
                    key={profile.token}
                    className={cn(
                      "rounded-lg border p-3 cursor-pointer transition-colors",
                      activeProfile === profile.token
                        ? "border-cyan-700/50 bg-cyan-950/20"
                        : "border-gray-800 bg-gray-950 hover:border-gray-700"
                    )}
                    onClick={() => setActiveProfile(profile.token)}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold text-gray-200">
                        {profile.name}
                      </span>
                      <span className="font-mono text-[10px] text-gray-600">
                        {profile.token}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-3 text-[10px] text-gray-500">
                      {profile.encoding && (
                        <span>Encoding: {profile.encoding}</span>
                      )}
                      {profile.resolution && (
                        <span>
                          {profile.resolution.width}x
                          {profile.resolution.height}
                        </span>
                      )}
                      {profile.fps && <span>{profile.fps} fps</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Stream URIs */}
            <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                <Video className="h-4 w-4 text-cyan-400" />
                Stream URIs
              </h3>
              {Object.entries(selectedDevice.stream_uris).length === 0 ? (
                <p className="text-xs text-gray-600">
                  No stream URIs available
                </p>
              ) : (
                <div className="space-y-2">
                  {Object.entries(selectedDevice.stream_uris).map(
                    ([profile, uri]) => (
                      <div
                        key={profile}
                        className="rounded-lg border border-gray-800 bg-gray-950 p-3"
                      >
                        <span className="text-xs font-medium text-gray-400">
                          {profile}
                        </span>
                        <p className="mt-1 font-mono text-[11px] text-gray-300 break-all">
                          {uri}
                        </p>
                      </div>
                    )
                  )}
                </div>
              )}
            </div>

            {/* Device Info */}
            <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                <Info className="h-4 w-4 text-cyan-400" />
                Device Information
              </h3>
              <div className="space-y-2 text-xs">
                {Object.entries(selectedDevice.device_info).map(
                  ([key, value]) => (
                    <div
                      key={key}
                      className="flex justify-between border-b border-gray-800/50 pb-1"
                    >
                      <span className="text-gray-500 capitalize">
                        {key.replace(/_/g, " ")}
                      </span>
                      <span className="text-gray-300 font-mono">
                        {value}
                      </span>
                    </div>
                  )
                )}
              </div>
            </div>
          </div>

          {/* PTZ Panel */}
          <div>
            {selectedDevice.ptz_supported ? (
              <PTZControlPanel
                device={selectedDevice}
                activeProfile={activeProfile}
              />
            ) : (
              <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-8 flex flex-col items-center justify-center text-center">
                <Monitor className="mb-3 h-10 w-10 text-gray-700" />
                <p className="text-sm text-gray-500">PTZ Not Supported</p>
                <p className="mt-1 text-xs text-gray-600">
                  This camera does not support Pan-Tilt-Zoom controls
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: "cameras", label: "Cameras", icon: <Camera className="h-4 w-4" /> },
  { key: "onvif", label: "ONVIF Management", icon: <Wifi className="h-4 w-4" /> },
];

export default function CameraManagementPage() {
  const [tab, setTab] = useState<TabKey>("cameras");

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
            <Camera className="h-5 w-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wider text-gray-100 uppercase">
              Camera Management
            </h1>
            <p className="text-xs text-gray-500">
              View cameras, discover ONVIF devices, and control PTZ
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-800">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors",
                tab === t.key
                  ? "border-cyan-400 text-cyan-400"
                  : "border-transparent text-gray-500 hover:border-gray-700 hover:text-gray-300"
              )}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div>
          {tab === "cameras" && <CamerasTab />}
          {tab === "onvif" && <ONVIFTab />}
        </div>
      </div>
    </div>
  );
}
