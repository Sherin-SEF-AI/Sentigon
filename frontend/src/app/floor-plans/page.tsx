"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Map as MapIcon,
  Camera,
  Upload,
  Plus,
  Trash2,
  Move,
  RotateCw,
  Eye,
  Save,
  Loader2,
  AlertTriangle,
  X,
  ChevronDown,
  Wifi,
  WifiOff,
  DoorOpen,
  Radio,
  Maximize2,
} from "lucide-react";
import { cn, apiFetch, API_BASE } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface FloorPlan {
  id: string;
  name: string;
  floor: number;
  building: string;
  bounds: number[][];
  cameras: number;
  sensors: number;
  doors: number;
}

interface PlacedDevice {
  id: string;
  floor_plan_id: string;
  device_type: string;
  device_id: string;
  x_percent: number;
  y_percent: number;
  rotation: number;
  icon_size: number;
  label: string;
  fov_angle: number;
  fov_range: number;
  config: Record<string, unknown>;
}

interface CameraOption {
  id: string;
  name: string;
  source: string;
  status: string;
}

type ToolMode = "select" | "place" | "move";
type DeviceType = "camera" | "sensor" | "door";

/* ------------------------------------------------------------------ */
/*  Floor Plan Canvas — drag-drop camera placement                     */
/* ------------------------------------------------------------------ */

function FloorPlanCanvas({
  planId,
  imageUrl,
  devices,
  selectedId,
  onSelect,
  onMove,
  onPlace,
  toolMode,
  placeDeviceType,
}: {
  planId: string;
  imageUrl: string | null;
  devices: PlacedDevice[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, xPct: number, yPct: number) => void;
  onPlace: (xPct: number, yPct: number) => void;
  toolMode: ToolMode;
  placeDeviceType: DeviceType;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);

  const getPercentCoords = useCallback(
    (e: React.MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      return {
        x: Math.max(0, Math.min(100, x)),
        y: Math.max(0, Math.min(100, y)),
      };
    },
    []
  );

  const handleMouseDown = (e: React.MouseEvent, deviceId: string) => {
    e.stopPropagation();
    if (toolMode === "move" || toolMode === "select") {
      setDragging(deviceId);
      onSelect(deviceId);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    const { x, y } = getPercentCoords(e);
    onMove(dragging, x, y);
  };

  const handleMouseUp = () => {
    setDragging(null);
  };

  const handleCanvasClick = (e: React.MouseEvent) => {
    if (toolMode === "place") {
      const { x, y } = getPercentCoords(e);
      onPlace(x, y);
    } else {
      onSelect(null);
    }
  };

  const deviceIcon = (type: string) => {
    switch (type) {
      case "camera":
        return <Camera className="h-4 w-4" />;
      case "sensor":
        return <Radio className="h-4 w-4" />;
      case "door":
        return <DoorOpen className="h-4 w-4" />;
      default:
        return <Camera className="h-4 w-4" />;
    }
  };

  const deviceColor = (type: string) => {
    switch (type) {
      case "camera":
        return "bg-cyan-500 border-cyan-400 text-white";
      case "sensor":
        return "bg-amber-500 border-amber-400 text-white";
      case "door":
        return "bg-emerald-500 border-emerald-400 text-white";
      default:
        return "bg-gray-500 border-gray-400 text-white";
    }
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative w-full overflow-hidden rounded-lg border-2 border-dashed bg-gray-900/80",
        toolMode === "place"
          ? "border-cyan-600 cursor-crosshair"
          : toolMode === "move"
          ? "border-amber-600 cursor-move"
          : "border-gray-700 cursor-default",
        !imageUrl && "flex items-center justify-center"
      )}
      style={{ minHeight: 500, aspectRatio: "16/10" }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={handleCanvasClick}
    >
      {imageUrl ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt="Floor plan"
            className="h-full w-full object-contain select-none"
            draggable={false}
            onLoad={() => setImgLoaded(true)}
          />
          {!imgLoaded && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
              <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-col items-center gap-3 py-20 text-gray-600">
          <MapIcon className="h-16 w-16" />
          <p className="text-sm">No floor plan image uploaded</p>
          <p className="text-xs text-gray-700">
            Upload an image to start placing devices
          </p>
        </div>
      )}

      {/* Placed devices */}
      {devices.map((dev) => {
        const isSelected = selectedId === dev.id;
        return (
          <div
            key={dev.id}
            className={cn(
              "absolute flex items-center justify-center rounded-full border-2 shadow-lg transition-shadow",
              deviceColor(dev.device_type),
              isSelected && "ring-2 ring-white ring-offset-2 ring-offset-gray-900 shadow-xl scale-125",
              (toolMode === "move" || toolMode === "select") && "cursor-grab active:cursor-grabbing",
            )}
            style={{
              left: `${dev.x_percent}%`,
              top: `${dev.y_percent}%`,
              width: dev.icon_size || 32,
              height: dev.icon_size || 32,
              transform: `translate(-50%, -50%) rotate(${dev.rotation}deg)`,
              zIndex: isSelected ? 50 : 10,
            }}
            onMouseDown={(e) => handleMouseDown(e, dev.id)}
            title={dev.label || dev.device_id}
          >
            {deviceIcon(dev.device_type)}

            {/* FOV cone for cameras */}
            {dev.device_type === "camera" && dev.fov_angle > 0 && (
              <div
                className="absolute pointer-events-none"
                style={{
                  left: "50%",
                  top: "50%",
                  width: `${dev.fov_range || 80}px`,
                  height: `${dev.fov_range || 80}px`,
                  transform: `translate(-50%, -50%)`,
                  background: `conic-gradient(
                    from ${-dev.fov_angle / 2 - 90}deg,
                    transparent 0deg,
                    rgba(6, 182, 212, 0.15) 0deg,
                    rgba(6, 182, 212, 0.15) ${dev.fov_angle}deg,
                    transparent ${dev.fov_angle}deg
                  )`,
                  borderRadius: "50%",
                }}
              />
            )}

            {/* Label */}
            {dev.label && (
              <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 text-[9px] font-mono text-gray-300 border border-gray-700">
                {dev.label}
              </span>
            )}
          </div>
        );
      })}

      {/* Tool mode indicator */}
      <div className="absolute top-3 left-3 rounded-lg bg-black/70 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-300 border border-gray-700">
        {toolMode === "place"
          ? `Click to place ${placeDeviceType}`
          : toolMode === "move"
          ? "Drag to reposition"
          : "Select device"}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Device Properties Panel                                            */
/* ------------------------------------------------------------------ */

function DevicePropertiesPanel({
  device,
  onUpdate,
  onDelete,
  cameras,
}: {
  device: PlacedDevice;
  onUpdate: (updates: Partial<PlacedDevice>) => void;
  onDelete: () => void;
  cameras: CameraOption[];
}) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-200">Device Properties</h3>
        <button
          onClick={onDelete}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-red-400 hover:bg-red-900/30 transition-colors"
        >
          <Trash2 className="h-3 w-3" />
          Remove
        </button>
      </div>

      <div className="space-y-3">
        {/* Label */}
        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">
            Label
          </label>
          <input
            type="text"
            value={device.label}
            onChange={(e) => onUpdate({ label: e.target.value })}
            className="w-full rounded border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-100 focus:border-cyan-700 focus:outline-none"
            placeholder="Camera name..."
          />
        </div>

        {/* Link to camera */}
        {device.device_type === "camera" && (
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">
              Linked Camera
            </label>
            <select
              value={device.device_id}
              onChange={(e) => onUpdate({ device_id: e.target.value })}
              className="w-full rounded border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-100 focus:border-cyan-700 focus:outline-none"
            >
              <option value="">Unlinked</option>
              {cameras.map((cam) => (
                <option key={cam.id} value={cam.id}>
                  {cam.name} ({cam.status})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Rotation */}
        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">
            Rotation: {device.rotation}°
          </label>
          <input
            type="range"
            min="0"
            max="360"
            step="5"
            value={device.rotation}
            onChange={(e) => onUpdate({ rotation: parseInt(e.target.value) })}
            className="w-full accent-cyan-500"
          />
        </div>

        {/* FOV (cameras only) */}
        {device.device_type === "camera" && (
          <>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">
                Field of View: {device.fov_angle}°
              </label>
              <input
                type="range"
                min="10"
                max="180"
                step="5"
                value={device.fov_angle}
                onChange={(e) =>
                  onUpdate({ fov_angle: parseInt(e.target.value) })
                }
                className="w-full accent-cyan-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">
                FOV Range: {device.fov_range}px
              </label>
              <input
                type="range"
                min="30"
                max="200"
                step="10"
                value={device.fov_range}
                onChange={(e) =>
                  onUpdate({ fov_range: parseInt(e.target.value) })
                }
                className="w-full accent-cyan-500"
              />
            </div>
          </>
        )}

        {/* Icon Size */}
        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">
            Icon Size: {device.icon_size}px
          </label>
          <input
            type="range"
            min="20"
            max="56"
            step="4"
            value={device.icon_size}
            onChange={(e) =>
              onUpdate({ icon_size: parseInt(e.target.value) })
            }
            className="w-full accent-cyan-500"
          />
        </div>

        {/* Position (read-only) */}
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">
              X %
            </label>
            <span className="font-mono text-xs text-gray-300">
              {device.x_percent.toFixed(1)}
            </span>
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">
              Y %
            </label>
            <span className="font-mono text-xs text-gray-300">
              {device.y_percent.toFixed(1)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Create Floor Plan Modal                                            */
/* ------------------------------------------------------------------ */

function CreateFloorPlanModal({
  onCreated,
  onClose,
}: {
  onCreated: (plan: FloorPlan) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [building, setBuilding] = useState("");
  const [floor, setFloor] = useState("0");
  const [loading, setLoading] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await apiFetch<{ id: string; name: string }>(
        "/api/gis/floor-plans",
        {
          method: "POST",
          body: JSON.stringify({
            name,
            building,
            floor_number: parseInt(floor),
            bounds: [],
            cameras: [],
            sensors: [],
            doors: [],
          }),
        }
      );
      onCreated({
        id: result.id,
        name: result.name,
        floor: parseInt(floor),
        building,
        bounds: [],
        cameras: 0,
        sensors: 0,
        doors: 0,
      });
    } catch {
      // handled
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <form
        onSubmit={handleCreate}
        className="w-full max-w-md rounded-xl border border-gray-800 bg-gray-900 p-6 shadow-2xl space-y-4"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-100">New Floor Plan</h2>
          <button type="button" onClick={onClose}>
            <X className="h-5 w-5 text-gray-500 hover:text-gray-300" />
          </button>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-400">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 focus:border-cyan-700 focus:outline-none"
            placeholder="Ground Floor — Building A"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-400">
              Building
            </label>
            <input
              type="text"
              value={building}
              onChange={(e) => setBuilding(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 focus:border-cyan-700 focus:outline-none"
              placeholder="Building A"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-400">
              Floor Number
            </label>
            <input
              type="number"
              value={floor}
              onChange={(e) => setFloor(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 focus:border-cyan-700 focus:outline-none"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading || !name}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:opacity-50"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          Create Floor Plan
        </button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function FloorPlanEditorPage() {
  const [plans, setPlans] = useState<FloorPlan[]>([]);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [devices, setDevices] = useState<PlacedDevice[]>([]);
  const [cameras, setCameras] = useState<CameraOption[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [toolMode, setToolMode] = useState<ToolMode>("select");
  const [placeDeviceType, setPlaceDeviceType] = useState<DeviceType>("camera");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch floor plans
  const fetchPlans = useCallback(async () => {
    try {
      const data = await apiFetch<FloorPlan[]>("/api/gis/floor-plans");
      setPlans(Array.isArray(data) ? data : []);
      if (!activePlanId && data.length > 0) {
        setActivePlanId(data[0].id);
      }
    } catch {
      setError("Failed to load floor plans");
    } finally {
      setLoading(false);
    }
  }, [activePlanId]);

  // Fetch cameras for linking
  const fetchCameras = useCallback(async () => {
    try {
      const data = await apiFetch<CameraOption[]>("/api/cameras");
      setCameras(Array.isArray(data) ? data : []);
    } catch {
      // non-critical
    }
  }, []);

  // Fetch devices for active plan
  const fetchDevices = useCallback(async () => {
    if (!activePlanId) return;
    try {
      const data = await apiFetch<PlacedDevice[]>(
        `/api/floor-plans/${activePlanId}/devices`
      );
      setDevices(Array.isArray(data) ? data : []);
    } catch {
      setDevices([]);
    }
  }, [activePlanId]);

  // Check for floor plan image
  useEffect(() => {
    if (!activePlanId) {
      setImageUrl(null);
      return;
    }
    setImageUrl(`${API_BASE}/api/gis/floor-plans/${activePlanId}/image`);
  }, [activePlanId]);

  useEffect(() => {
    fetchPlans();
    fetchCameras();
  }, [fetchPlans, fetchCameras]);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  // Place new device
  const handlePlace = async (xPct: number, yPct: number) => {
    if (!activePlanId) return;
    try {
      const result = await apiFetch<PlacedDevice>("/api/floor-plans/devices", {
        method: "POST",
        body: JSON.stringify({
          floor_plan_id: activePlanId,
          device_type: placeDeviceType,
          device_id: "",
          x_percent: xPct,
          y_percent: yPct,
          rotation: 0,
          icon_size: 32,
          label: `${placeDeviceType} ${devices.length + 1}`,
          fov_angle: placeDeviceType === "camera" ? 90 : 0,
          fov_range: placeDeviceType === "camera" ? 80 : 0,
          config: {},
        }),
      });
      setDevices((prev) => [...prev, result]);
      setSelectedDeviceId(result.id);
      setToolMode("select");
    } catch {
      // handled
    }
  };

  // Move device (optimistic update)
  const handleMove = (id: string, xPct: number, yPct: number) => {
    setDevices((prev) =>
      prev.map((d) =>
        d.id === id ? { ...d, x_percent: xPct, y_percent: yPct } : d
      )
    );
  };

  // Save device position after drag
  const handleMouseUp = useCallback(async () => {
    const device = devices.find((d) => d.id === selectedDeviceId);
    if (!device) return;
    try {
      await apiFetch(`/api/floor-plans/devices/${device.id}`, {
        method: "PUT",
        body: JSON.stringify({
          x_percent: device.x_percent,
          y_percent: device.y_percent,
        }),
      });
    } catch {
      // revert on failure
      fetchDevices();
    }
  }, [devices, selectedDeviceId, fetchDevices]);

  // Update device properties
  const handleUpdateDevice = async (updates: Partial<PlacedDevice>) => {
    if (!selectedDeviceId) return;
    setSaving(true);
    setDevices((prev) =>
      prev.map((d) => (d.id === selectedDeviceId ? { ...d, ...updates } : d))
    );
    try {
      await apiFetch(`/api/floor-plans/devices/${selectedDeviceId}`, {
        method: "PUT",
        body: JSON.stringify(updates),
      });
    } catch {
      fetchDevices();
    } finally {
      setSaving(false);
    }
  };

  // Delete device
  const handleDeleteDevice = async () => {
    if (!selectedDeviceId) return;
    try {
      await apiFetch(`/api/floor-plans/devices/${selectedDeviceId}`, {
        method: "DELETE",
      });
      setDevices((prev) => prev.filter((d) => d.id !== selectedDeviceId));
      setSelectedDeviceId(null);
    } catch {
      // handled
    }
  };

  // Upload floor plan image
  const handleUploadImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activePlanId) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      await fetch(
        `${API_BASE}/api/gis/floor-plans/${activePlanId}/upload-image`,
        {
          method: "POST",
          body: formData,
          headers: {
            Authorization: `Bearer ${localStorage.getItem("sentinel_token")}`,
          },
        }
      );
      // Force reload image
      setImageUrl(
        `${API_BASE}/api/gis/floor-plans/${activePlanId}/image?t=${Date.now()}`
      );
    } catch {
      setError("Failed to upload image");
    } finally {
      setUploading(false);
    }
  };

  const activePlan = plans.find((p) => p.id === activePlanId);
  const selectedDevice = devices.find((d) => d.id === selectedDeviceId);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950">
        <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="mx-auto max-w-[1600px] space-y-5 px-6 py-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
              <MapIcon className="h-5 w-5 text-cyan-400" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-wider text-gray-100 uppercase">
                Floor Plan Editor
              </h1>
              <p className="text-xs text-gray-500">
                Upload plans, drag-drop cameras, sensors, and doors
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500"
          >
            <Plus className="h-4 w-4" />
            New Floor Plan
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
            <button onClick={() => setError("")} className="ml-auto">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Floor Plan Selector */}
        {plans.length > 0 && (
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {plans.map((plan) => (
              <button
                key={plan.id}
                onClick={() => {
                  setActivePlanId(plan.id);
                  setSelectedDeviceId(null);
                }}
                className={cn(
                  "flex items-center gap-2 whitespace-nowrap rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors",
                  activePlanId === plan.id
                    ? "border-cyan-700/60 bg-cyan-950/30 text-cyan-300"
                    : "border-gray-800 bg-gray-900/60 text-gray-400 hover:border-gray-700 hover:text-gray-200"
                )}
              >
                <MapIcon className="h-4 w-4" />
                <span>{plan.name}</span>
                {plan.building && (
                  <span className="text-[10px] text-gray-600">
                    {plan.building} F{plan.floor}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {plans.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-800 py-24">
            <MapIcon className="mb-3 h-14 w-14 text-gray-700" />
            <p className="text-sm text-gray-500">No floor plans yet</p>
            <p className="mt-1 text-xs text-gray-600">
              Create a floor plan to start placing cameras
            </p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="mt-4 flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-500"
            >
              <Plus className="h-4 w-4" />
              Create Floor Plan
            </button>
          </div>
        )}

        {/* Editor Layout */}
        {activePlan && (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_320px]">
            {/* Left: Canvas + Toolbar */}
            <div className="space-y-3">
              {/* Toolbar */}
              <div className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/60 px-4 py-2.5">
                {/* Tool Modes */}
                <div className="flex items-center gap-1 border-r border-gray-700 pr-3 mr-1">
                  <button
                    onClick={() => setToolMode("select")}
                    className={cn(
                      "flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors",
                      toolMode === "select"
                        ? "bg-cyan-900/40 text-cyan-400 border border-cyan-800/50"
                        : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
                    )}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    Select
                  </button>
                  <button
                    onClick={() => setToolMode("move")}
                    className={cn(
                      "flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors",
                      toolMode === "move"
                        ? "bg-amber-900/40 text-amber-400 border border-amber-800/50"
                        : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
                    )}
                  >
                    <Move className="h-3.5 w-3.5" />
                    Move
                  </button>
                </div>

                {/* Place device buttons */}
                <div className="flex items-center gap-1">
                  {(
                    [
                      { type: "camera" as DeviceType, icon: Camera, label: "Camera" },
                      { type: "sensor" as DeviceType, icon: Radio, label: "Sensor" },
                      { type: "door" as DeviceType, icon: DoorOpen, label: "Door" },
                    ] as const
                  ).map(({ type, icon: Icon, label }) => (
                    <button
                      key={type}
                      onClick={() => {
                        setPlaceDeviceType(type);
                        setToolMode("place");
                      }}
                      className={cn(
                        "flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors",
                        toolMode === "place" && placeDeviceType === type
                          ? "bg-emerald-900/40 text-emerald-400 border border-emerald-800/50"
                          : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
                      )}
                    >
                      <Plus className="h-3 w-3" />
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </button>
                  ))}
                </div>

                {/* Spacer */}
                <div className="flex-1" />

                {/* Upload Image */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleUploadImage}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors disabled:opacity-50"
                >
                  {uploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" />
                  )}
                  Upload Image
                </button>

                {/* Save indicator */}
                {saving && (
                  <span className="flex items-center gap-1 text-[10px] text-cyan-500">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Saving...
                  </span>
                )}
              </div>

              {/* Canvas */}
              <FloorPlanCanvas
                planId={activePlanId!}
                imageUrl={imageUrl}
                devices={devices}
                selectedId={selectedDeviceId}
                onSelect={setSelectedDeviceId}
                onMove={handleMove}
                onPlace={handlePlace}
                toolMode={toolMode}
                placeDeviceType={placeDeviceType}
              />

              {/* Stats Bar */}
              <div className="flex items-center gap-6 rounded-lg border border-gray-800 bg-gray-900/60 px-4 py-2.5 text-xs text-gray-500">
                <span className="flex items-center gap-1.5">
                  <Camera className="h-3.5 w-3.5 text-cyan-400" />
                  {devices.filter((d) => d.device_type === "camera").length}{" "}
                  Cameras
                </span>
                <span className="flex items-center gap-1.5">
                  <Radio className="h-3.5 w-3.5 text-amber-400" />
                  {devices.filter((d) => d.device_type === "sensor").length}{" "}
                  Sensors
                </span>
                <span className="flex items-center gap-1.5">
                  <DoorOpen className="h-3.5 w-3.5 text-emerald-400" />
                  {devices.filter((d) => d.device_type === "door").length} Doors
                </span>
                <span className="ml-auto text-gray-600">
                  {activePlan.name}
                  {activePlan.building && ` — ${activePlan.building}`}
                  {` — Floor ${activePlan.floor}`}
                </span>
              </div>
            </div>

            {/* Right: Properties Panel */}
            <div className="space-y-4">
              {selectedDevice ? (
                <DevicePropertiesPanel
                  device={selectedDevice}
                  onUpdate={handleUpdateDevice}
                  onDelete={handleDeleteDevice}
                  cameras={cameras}
                />
              ) : (
                <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-6 flex flex-col items-center justify-center text-center">
                  <Eye className="mb-3 h-8 w-8 text-gray-700" />
                  <p className="text-sm text-gray-500">No device selected</p>
                  <p className="mt-1 text-xs text-gray-600">
                    Click a device on the floor plan to edit its properties, or
                    use the toolbar to place new devices
                  </p>
                </div>
              )}

              {/* Device List */}
              <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4 space-y-3">
                <h3 className="text-sm font-semibold text-gray-200">
                  Devices on Plan ({devices.length})
                </h3>
                <div className="max-h-64 overflow-y-auto space-y-1">
                  {devices.length === 0 && (
                    <p className="text-xs text-gray-600 py-4 text-center">
                      No devices placed yet
                    </p>
                  )}
                  {devices.map((dev) => (
                    <button
                      key={dev.id}
                      onClick={() => setSelectedDeviceId(dev.id)}
                      className={cn(
                        "w-full flex items-center gap-2 rounded px-3 py-2 text-left text-xs transition-colors",
                        selectedDeviceId === dev.id
                          ? "bg-cyan-950/30 border border-cyan-800/50 text-cyan-300"
                          : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                      )}
                    >
                      {dev.device_type === "camera" ? (
                        <Camera className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
                      ) : dev.device_type === "sensor" ? (
                        <Radio className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                      ) : (
                        <DoorOpen className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                      )}
                      <span className="truncate">{dev.label || dev.device_id || "Unnamed"}</span>
                      <span className="ml-auto font-mono text-[9px] text-gray-600">
                        ({dev.x_percent.toFixed(0)}, {dev.y_percent.toFixed(0)})
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <CreateFloorPlanModal
          onCreated={(plan) => {
            setPlans((prev) => [...prev, plan]);
            setActivePlanId(plan.id);
            setShowCreateModal(false);
          }}
          onClose={() => setShowCreateModal(false)}
        />
      )}
    </div>
  );
}
