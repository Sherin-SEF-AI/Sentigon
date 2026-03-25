"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Camera,
  Play,
  Square,
  Wifi,
  WifiOff,
  Grid2x2,
  Grid3x3,
  LayoutGrid,
  Maximize2,
  Minimize2,
  Loader2,
  MapPin,
  Users,
  AlertTriangle,
  Download,
  PanelLeftClose,
  PanelLeftOpen,
  BookOpen,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { useLiveFeed } from "@/hooks/useLiveFeed";
import { LiveFeedPanel } from "@/components/soc/LiveFeedPanel";
import type { Camera as CameraInfo } from "@/lib/types";

/* ── Types ─────────────────────────────────────────── */

type WallLayout = "2x2" | "3x3" | "4x4" | "5x5";

const LAYOUTS: { value: WallLayout; label: string; cols: number }[] = [
  { value: "2x2", label: "2\u00d72", cols: 2 },
  { value: "3x3", label: "3\u00d73", cols: 3 },
  { value: "4x4", label: "4\u00d74", cols: 4 },
  { value: "5x5", label: "5\u00d75", cols: 5 },
];

const GRID_CLASSES: Record<WallLayout, string> = {
  "2x2": "grid-cols-2 grid-rows-2",
  "3x3": "grid-cols-3 grid-rows-3",
  "4x4": "grid-cols-4 grid-rows-4",
  "5x5": "grid-cols-5 grid-rows-5",
};

const STATUS_DOT: Record<string, string> = {
  online: "bg-emerald-500",
  offline: "bg-gray-600",
  error: "bg-red-500",
  maintenance: "bg-yellow-500",
};

/* ── Page ──────────────────────────────────────────── */

const LAYOUT_STORAGE_KEY = "sentinel_videowall_layout";

export default function VideoWallPage() {
  const { frames, analyses, connected } = useLiveFeed();
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  // ── Layout persistence: restore from localStorage on mount ──────────
  const [layout, setLayout] = useState<WallLayout>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(LAYOUT_STORAGE_KEY) as WallLayout | null;
      if (saved && LAYOUTS.some((l) => l.value === saved)) return saved;
    }
    return "3x3";
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const [togglingCamera, setTogglingCamera] = useState<string | null>(null);
  const [narratives, setNarratives] = useState<Record<string, { camera_id: string; narrative: string; updated_at: string; event_count: number }>>({});
  const [narrativeVisible, setNarrativeVisible] = useState<string | null>(null);

  // ── Priority Sort toggle ────────────────────────────────────────────
  const [prioritySort, setPrioritySort] = useState(false);

  // ── FPS tracker: per camera frame timestamps for real FPS calc ──────
  const fpsCounterRef = useRef<Record<string, number[]>>({});
  const [fpsMap, setFpsMap] = useState<Record<string, number>>({});

  // Fetch scene narratives
  useEffect(() => {
    const fetchNarratives = async () => {
      try {
        const data = await apiFetch<{ narratives: { camera_id: string; narrative: string; updated_at: string; event_count: number }[] }>("/api/intelligence/narratives");
        const map: Record<string, any> = {};
        for (const n of data.narratives ?? []) map[n.camera_id] = n;
        setNarratives(map);
      } catch { /* narratives endpoint may not be available */ }
    };
    fetchNarratives();
    const iv = setInterval(fetchNarratives, 60000);
    return () => clearInterval(iv);
  }, []);

  // ── Persist layout to localStorage on change ────────────────────────
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(LAYOUT_STORAGE_KEY, layout);
    }
  }, [layout]);

  // ── FPS calculation: track frame arrivals per camera over 2s window ─
  useEffect(() => {
    const now = Date.now();
    for (const camId of Object.keys(frames)) {
      if (!fpsCounterRef.current[camId]) fpsCounterRef.current[camId] = [];
      fpsCounterRef.current[camId].push(now);
    }
  }, [frames]);

  useEffect(() => {
    const iv = setInterval(() => {
      const cutoff = Date.now() - 2000; // 2-second rolling window
      const newFps: Record<string, number> = {};
      for (const [camId, timestamps] of Object.entries(fpsCounterRef.current)) {
        const recent = timestamps.filter((t) => t > cutoff);
        fpsCounterRef.current[camId] = recent;
        newFps[camId] = Math.round(recent.length / 2); // frames in 2s / 2 = fps
      }
      setFpsMap(newFps);
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  // Fetch cameras
  const fetchCameras = useCallback(() => {
    apiFetch<CameraInfo[]>("/api/cameras").then(setCameras).catch((err) => { console.warn("[video-wall] API call failed:", err); });
  }, []);

  useEffect(() => {
    fetchCameras();
    const iv = setInterval(fetchCameras, 15000);
    return () => clearInterval(iv);
  }, [fetchCameras]);

  // Camera IDs sorted: live feeds first, then by name (or priority sort)
  const sortedCameraIds = useMemo(() => {
    const liveIds = Object.keys(frames);
    const allIds = new Set(liveIds);
    for (const c of cameras) allIds.add(c.id);

    // Zone risk level ordering for priority sort
    const zoneRiskOrder: Record<string, number> = { critical: 0, high: 1, elevated: 2, medium: 3, low: 4, normal: 5 };

    return [...allIds].sort((a, b) => {
      if (prioritySort) {
        // Active alerts first: cameras with high/critical analysis risk
        const aRisk = analyses?.[a]?.overall_risk?.toLowerCase() ?? "normal";
        const bRisk = analyses?.[b]?.overall_risk?.toLowerCase() ?? "normal";
        const aRiskScore = zoneRiskOrder[aRisk] ?? 5;
        const bRiskScore = zoneRiskOrder[bRisk] ?? 5;
        if (aRiskScore !== bRiskScore) return aRiskScore - bRiskScore;
        // Then by whether the camera has threats detected
        const aThreats = (analyses?.[a]?.threat_indicators?.length ?? 0) + (analyses?.[a]?.anomalies?.length ?? 0);
        const bThreats = (analyses?.[b]?.threat_indicators?.length ?? 0) + (analyses?.[b]?.anomalies?.length ?? 0);
        if (aThreats !== bThreats) return bThreats - aThreats;
      }
      // Default: live feeds first, then alphabetical
      const aLive = liveIds.includes(a);
      const bLive = liveIds.includes(b);
      if (aLive !== bLive) return aLive ? -1 : 1;
      const aName = cameras.find((c) => c.id === a)?.name ?? a;
      const bName = cameras.find((c) => c.id === b)?.name ?? b;
      return aName.localeCompare(bName);
    });
  }, [frames, cameras, analyses, prioritySort]);

  const cameraNameMap = useMemo(
    () => Object.fromEntries(cameras.map((c) => [c.id, c.name])),
    [cameras]
  );

  const handleToggleCamera = async (cameraId: string, isActive: boolean) => {
    setTogglingCamera(cameraId);
    try {
      await apiFetch(`/api/cameras/${cameraId}/${isActive ? "stop" : "start"}`, { method: "POST" });
      fetchCameras();
    } catch { /* silent */ }
    setTogglingCamera(null);
  };

  const liveCount = Object.keys(frames).length;
  const onlineCount = cameras.filter((c) => c.status === "online").length;
  const currentLayout = LAYOUTS.find((l) => l.value === layout)!;
  const maxSlots = currentLayout.cols * currentLayout.cols;

  // Fullscreen feed
  const fullscreenFrame = fullscreenId ? frames[fullscreenId] : null;

  if (fullscreenId && fullscreenFrame) {
    return (
      <div className="h-full bg-black flex flex-col">
        <div className="flex items-center justify-between px-3 py-1 bg-gray-950 border-b border-gray-800/40 shrink-0">
          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
            {cameraNameMap[fullscreenId] ?? fullscreenId}
          </span>
          <button
            onClick={() => setFullscreenId(null)}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          >
            <Minimize2 className="h-3 w-3" /> Exit
          </button>
        </div>
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0">
            <LiveFeedPanel
              cameraId={fullscreenId}
              cameraName={cameraNameMap[fullscreenId]}
              frame={fullscreenFrame.frame}
              detections={fullscreenFrame.detections}
              analysis={analyses?.[fullscreenId]}
              isSelected
              isOnline
              isFullscreen
              onClick={() => setFullscreenId(null)}
              onToggleFullscreen={() => setFullscreenId(null)}
            />
          </div>
          {/* Scene Narrative — fullscreen sidebar */}
          {narratives[fullscreenId]?.narrative && (
            <aside className="w-64 shrink-0 border-l border-gray-800/40 bg-gray-950/90 flex flex-col overflow-hidden">
              <div className="flex items-center gap-1.5 px-3 py-2 border-b border-gray-800/30 shrink-0">
                <BookOpen className="h-3 w-3 text-purple-400" />
                <span className="text-[9px] font-bold text-purple-400 uppercase tracking-wider">Scene Narrative</span>
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                <p className="text-[10px] leading-relaxed text-gray-300/90 whitespace-pre-line">
                  {narratives[fullscreenId].narrative}
                </p>
              </div>
              <div className="px-3 py-1.5 border-t border-gray-800/30 shrink-0">
                <span className="text-[8px] text-gray-600">
                  Updated: {new Date(narratives[fullscreenId].updated_at).toLocaleTimeString()}
                  {narratives[fullscreenId].event_count > 0 && ` · ${narratives[fullscreenId].event_count} events`}
                </span>
              </div>
            </aside>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-black overflow-hidden">
      {/* ── Compact header ── */}
      <header className="flex items-center justify-between px-2 py-1 bg-gray-950/80 border-b border-gray-800/40 shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="rounded p-1 text-gray-500 hover:text-gray-300 hover:bg-gray-800/60 transition-colors"
            title={sidebarOpen ? "Hide cameras" : "Show cameras"}
          >
            {sidebarOpen ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}
          </button>
          <Camera className="h-3.5 w-3.5 text-cyan-400" />
          <span className="text-[10px] font-bold tracking-wider text-gray-400 uppercase">Wall</span>
          <span className="text-[9px] text-gray-600 font-mono tabular-nums">{liveCount} live</span>
          {Object.keys(narratives).length > 0 && (
            <span className="flex items-center gap-0.5 text-[8px] text-purple-400/70 font-mono">
              <BookOpen className="h-2.5 w-2.5" />
              {Object.keys(narratives).length} narratives
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {/* Priority Sort toggle */}
          <button
            onClick={() => setPrioritySort((s) => !s)}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-0.5 text-[9px] font-bold border transition-all",
              prioritySort
                ? "bg-amber-900/40 border-amber-700/50 text-amber-400"
                : "bg-gray-900/60 border-gray-800/50 text-gray-600 hover:text-gray-300"
            )}
            title="Sort cameras by risk: cameras with active threats and high zone risk appear first"
          >
            <AlertTriangle className="h-2.5 w-2.5" />
            Priority
          </button>

          {/* Layout tabs */}
          <div className="flex items-center rounded bg-gray-900/80 border border-gray-800/50 p-px">
            {LAYOUTS.map((l) => (
              <button
                key={l.value}
                onClick={() => setLayout(l.value)}
                className={cn(
                  "rounded px-2 py-0.5 text-[9px] font-bold transition-all",
                  layout === l.value
                    ? "bg-cyan-900/50 text-cyan-400"
                    : "text-gray-600 hover:text-gray-300"
                )}
              >
                {l.label}
              </button>
            ))}
          </div>

          {/* Connection */}
          <div className={cn(
            "flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase",
            connected
              ? "bg-emerald-900/30 text-emerald-400 border border-emerald-800/40"
              : "bg-red-900/30 text-red-400 border border-red-800/40 animate-pulse"
          )}>
            {connected ? <Wifi className="h-2.5 w-2.5" /> : <WifiOff className="h-2.5 w-2.5" />}
            {connected ? "LIVE" : "OFF"}
          </div>
        </div>
      </header>

      {/* ── Main area ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Sidebar — camera list */}
        {sidebarOpen && (
          <aside className="w-44 border-r border-gray-800/40 flex flex-col min-h-0 shrink-0 bg-gray-950/60">
            <div className="px-2 py-1 border-b border-gray-800/30 shrink-0">
              <span className="text-[8px] font-bold uppercase tracking-widest text-gray-600">
                {onlineCount}/{cameras.length} online
              </span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {cameras.map((cam) => {
                const isLive = !!frames[cam.id];
                return (
                  <div
                    key={cam.id}
                    className="flex items-center gap-1.5 px-2 py-1 border-b border-gray-800/15 hover:bg-gray-900/60 transition-colors group"
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", STATUS_DOT[cam.status] ?? "bg-gray-600")} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[9px] font-medium text-gray-400 truncate leading-tight">{cam.name}</p>
                    </div>
                    {isLive && <span className="text-[7px] font-bold text-emerald-500/70">LIVE</span>}
                    <button
                      onClick={() => handleToggleCamera(cam.id, cam.is_active)}
                      disabled={togglingCamera === cam.id}
                      className={cn(
                        "rounded p-0.5 opacity-0 group-hover:opacity-100 transition-all shrink-0",
                        cam.is_active ? "text-red-400 hover:bg-red-900/30" : "text-emerald-400 hover:bg-emerald-900/30"
                      )}
                      title={cam.is_active ? "Stop" : "Start"}
                    >
                      {togglingCamera === cam.id ? (
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      ) : cam.is_active ? (
                        <Square className="h-2.5 w-2.5" />
                      ) : (
                        <Play className="h-2.5 w-2.5" />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </aside>
        )}

        {/* ── Video Grid ── */}
        <div className={cn("flex-1 grid gap-px bg-gray-800/30 min-h-0 overflow-hidden", GRID_CLASSES[layout])}>
          {sortedCameraIds.slice(0, maxSlots).map((camId) => {
            const fd = frames[camId];
            const analysis = analyses?.[camId];
            const name = cameraNameMap[camId] ?? camId;
            return (
              <CompactFeed
                key={camId}
                cameraId={camId}
                name={name}
                frame={fd?.frame ?? null}
                personCount={fd?.detections?.person_count ?? 0}
                riskLevel={analysis?.overall_risk?.toLowerCase() ?? null}
                threatCount={(analysis?.threat_indicators?.length ?? 0) + (analysis?.anomalies?.length ?? 0)}
                narrative={narratives[camId]?.narrative ?? null}
                narrativeVisible={narrativeVisible === camId}
                fps={fpsMap[camId] ?? null}
                onToggleNarrative={() => setNarrativeVisible(narrativeVisible === camId ? null : camId)}
                onFullscreen={() => setFullscreenId(camId)}
                onSnapshot={fd?.frame ? () => {
                  const link = document.createElement("a");
                  link.href = `data:image/jpeg;base64,${fd.frame}`;
                  link.download = `${name}-${Date.now()}.jpg`;
                  link.click();
                } : undefined}
              />
            );
          })}
          {/* Fill empty slots */}
          {sortedCameraIds.length < maxSlots &&
            Array.from({ length: maxSlots - sortedCameraIds.length }).map((_, i) => (
              <div key={`empty-${i}`} className="bg-gray-950 flex items-center justify-center">
                <Camera className="h-4 w-4 text-gray-800" />
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

/* ── Compact Feed Cell ─────────────────────────────── */

function CompactFeed({
  cameraId,
  name,
  frame,
  personCount,
  riskLevel,
  threatCount,
  narrative,
  narrativeVisible,
  fps,
  onToggleNarrative,
  onFullscreen,
  onSnapshot,
}: {
  cameraId: string;
  name: string;
  frame: string | null;
  personCount: number;
  riskLevel: string | null;
  threatCount: number;
  narrative: string | null;
  narrativeVisible: boolean;
  fps: number | null;
  onToggleNarrative: () => void;
  onFullscreen: () => void;
  onSnapshot?: () => void;
}) {
  const isHighRisk = riskLevel === "high" || riskLevel === "critical";

  return (
    <div
      className={cn(
        "relative bg-black overflow-hidden cursor-pointer group",
        isHighRisk && "ring-1 ring-inset ring-red-500/50"
      )}
      onDoubleClick={onFullscreen}
    >
      {/* Frame */}
      {frame ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`data:image/jpeg;base64,${frame}`}
          alt={name}
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-950">
          <Camera className="h-5 w-5 text-gray-800" />
        </div>
      )}

      {/* Camera name — top left, always visible */}
      <div className="absolute left-1 top-1 flex items-center gap-1 z-10">
        <div className="flex items-center gap-1 rounded bg-black/70 px-1 py-px backdrop-blur-sm">
          <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", frame ? "bg-emerald-400" : "bg-gray-600")} />
          <span className="text-[8px] font-bold text-white/90 uppercase tracking-wide truncate max-w-[80px]">
            {name}
          </span>
        </div>
        {/* FPS overlay — only shown when we have a live frame */}
        {frame && fps !== null && (
          <div className="flex items-center gap-0.5 rounded bg-black/70 px-1 py-px backdrop-blur-sm">
            <span className={cn(
              "h-1.5 w-1.5 rounded-full shrink-0",
              fps > 10 ? "bg-emerald-400" : fps >= 5 ? "bg-amber-400" : "bg-red-500 animate-pulse"
            )} />
            <span className="text-[8px] font-bold text-white/80 tabular-nums">
              {fps}fps
            </span>
          </div>
        )}
      </div>

      {/* Threat badge — top right */}
      {isHighRisk && (
        <div className="absolute right-1 top-1 z-10">
          <span className="flex items-center gap-0.5 rounded bg-red-600/90 px-1 py-px text-[7px] font-bold text-white uppercase backdrop-blur-sm">
            <AlertTriangle className="h-2 w-2" />
            {riskLevel}
          </span>
        </div>
      )}

      {/* Bottom stats — minimal, always visible */}
      {frame && (
        <div className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-between px-1.5 py-0.5 bg-gradient-to-t from-black/80 to-transparent">
          <div className="flex items-center gap-1.5">
            {personCount > 0 && (
              <span className="flex items-center gap-0.5 text-[8px] text-gray-300 font-mono">
                <Users className="h-2.5 w-2.5 text-cyan-400" />
                {personCount}
              </span>
            )}
            {threatCount > 0 && (
              <span className="flex items-center gap-0.5 text-[8px] text-red-400 font-mono">
                <AlertTriangle className="h-2.5 w-2.5" />
                {threatCount}
              </span>
            )}
          </div>
          {/* REC dot */}
          <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
        </div>
      )}

      {/* Scene Narrative Overlay */}
      {narrativeVisible && narrative && (
        <div
          className="absolute inset-0 z-20 bg-black/85 backdrop-blur-sm flex flex-col p-2 overflow-hidden cursor-default"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-1 shrink-0">
            <span className="flex items-center gap-1 text-[8px] font-bold text-purple-400 uppercase tracking-wider">
              <BookOpen className="h-2.5 w-2.5" />
              Scene Narrative
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onToggleNarrative(); }}
              className="text-[8px] text-gray-500 hover:text-gray-300 transition-colors"
            >
              Close
            </button>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
            <p className="text-[9px] leading-relaxed text-gray-300/90">
              {narrative}
            </p>
          </div>
        </div>
      )}

      {/* Hover controls — expand + snapshot + narrative */}
      <div className="absolute right-1 bottom-1 z-10 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {narrative && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleNarrative(); }}
            className={cn(
              "rounded p-1 backdrop-blur-sm transition-colors",
              narrativeVisible
                ? "bg-purple-600/70 text-white"
                : "bg-black/70 text-gray-300 hover:text-white hover:bg-black/90"
            )}
            title="Scene Narrative"
          >
            <BookOpen className="h-3 w-3" />
          </button>
        )}
        {onSnapshot && (
          <button
            onClick={(e) => { e.stopPropagation(); onSnapshot(); }}
            className="rounded p-1 bg-black/70 text-gray-300 hover:text-white hover:bg-black/90 backdrop-blur-sm transition-colors"
            title="Snapshot"
          >
            <Download className="h-3 w-3" />
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onFullscreen(); }}
          className="rounded p-1 bg-black/70 text-gray-300 hover:text-white hover:bg-black/90 backdrop-blur-sm transition-colors"
          title="Fullscreen (or double-click)"
        >
          <Maximize2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
