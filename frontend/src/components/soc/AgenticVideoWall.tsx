"use client";

import { useState, useCallback } from "react";
import {
  Maximize2,
  Minimize2,
  Wifi,
  WifiOff,
  Grid2x2,
  Grid3x3,
  Square,
  LayoutGrid,
  Camera,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useLiveFeed } from "@/hooks/useLiveFeed";
import { CameraGrid } from "./CameraGrid";
import { LiveFeedPanel } from "./LiveFeedPanel";

export type GridLayout = "auto" | "1x1" | "2x2" | "3x3" | "4x4";

interface AgenticVideoWallProps {
  cameraNames?: Record<string, string>;
}

const LAYOUT_OPTIONS: { value: GridLayout; icon: typeof Square; label: string }[] = [
  { value: "auto", icon: LayoutGrid, label: "Auto" },
  { value: "1x1", icon: Square, label: "1x1" },
  { value: "2x2", icon: Grid2x2, label: "2x2" },
  { value: "3x3", icon: Grid3x3, label: "3x3" },
  { value: "4x4", icon: LayoutGrid, label: "4x4" },
];

export function AgenticVideoWall({
  cameraNames,
}: AgenticVideoWallProps) {
  const { frames, analyses, connected } = useLiveFeed();
  const [fullscreenCameraId, setFullscreenCameraId] = useState<string | null>(
    null
  );
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [gridLayout, setGridLayout] = useState<GridLayout>("auto");

  const handleSelectCamera = useCallback(
    (id: string | null) => {
      if (fullscreenCameraId) {
        // If in fullscreen and clicking the same camera, exit fullscreen
        if (fullscreenCameraId === id) {
          setFullscreenCameraId(null);
        } else if (id) {
          // Switch fullscreen to the clicked camera
          setFullscreenCameraId(id);
        }
      } else {
        setSelectedCameraId(id);
      }
    },
    [fullscreenCameraId]
  );

  const handleToggleFullscreen = useCallback(
    (id: string) => {
      if (fullscreenCameraId === id) {
        setFullscreenCameraId(null);
      } else {
        setFullscreenCameraId(id);
      }
    },
    [fullscreenCameraId]
  );

  const enterFullscreen = useCallback(() => {
    if (selectedCameraId) {
      setFullscreenCameraId(selectedCameraId);
    }
  }, [selectedCameraId]);

  const exitFullscreen = useCallback(() => {
    setFullscreenCameraId(null);
  }, []);

  const cameraCount = Object.keys(frames).length;
  const fullscreenFrame = fullscreenCameraId ? frames[fullscreenCameraId] : null;

  return (
    <div className="flex h-full flex-col bg-gray-950 min-h-0 overflow-hidden">
      {/* Compact header bar */}
      <header className="flex items-center justify-between border-b border-gray-800/60 bg-gray-950 px-3 py-1.5 shrink-0">
        <div className="flex items-center gap-2">
          <Camera className="h-3.5 w-3.5 text-cyan-400" />
          <span className="text-[10px] font-bold tracking-widest text-gray-400 uppercase">
            Video Wall
          </span>
          <span className="text-[10px] text-gray-600 font-mono">
            {cameraCount} feed{cameraCount !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Layout switcher */}
          <div className="flex items-center rounded-md bg-gray-900/80 border border-gray-800/50 p-0.5">
            {LAYOUT_OPTIONS.map(({ value, icon: Icon, label }) => (
              <button
                key={value}
                onClick={() => setGridLayout(value)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[9px] font-medium transition-all flex items-center gap-1",
                  gridLayout === value
                    ? "bg-cyan-900/50 text-cyan-400 shadow-sm"
                    : "text-gray-500 hover:text-gray-300 hover:bg-gray-800/60"
                )}
                title={label}
              >
                <Icon className="h-3 w-3" />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>

          {/* Connection indicator */}
          <div
            className={cn(
              "flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
              connected
                ? "bg-emerald-900/30 text-emerald-400 border border-emerald-800/50"
                : "bg-red-900/30 text-red-400 border border-red-800/50 animate-pulse"
            )}
          >
            {connected ? (
              <Wifi className="h-2.5 w-2.5" />
            ) : (
              <WifiOff className="h-2.5 w-2.5" />
            )}
            {connected ? "Live" : "Off"}
          </div>

          {/* Fullscreen toggle */}
          {selectedCameraId && !fullscreenCameraId && (
            <button
              onClick={enterFullscreen}
              className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-200"
              title="Expand selected camera"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          )}
          {fullscreenCameraId && (
            <button
              onClick={exitFullscreen}
              className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-200"
              title="Exit fullscreen"
            >
              <Minimize2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </header>

      {/* Content — camera grid pinned, fills available space */}
      <div className="flex-1 min-h-0 overflow-hidden p-2">
        {!connected && cameraCount === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <WifiOff className="mx-auto h-8 w-8 text-gray-600 mb-2" />
              <p className="text-sm text-gray-400">Connecting to camera feeds...</p>
              <p className="text-xs text-gray-600 mt-1">Waiting for WebSocket connection</p>
            </div>
          </div>
        ) : cameraCount === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <Camera className="mx-auto h-8 w-8 text-gray-600 mb-2" />
              <p className="text-sm text-gray-400">No active camera feeds</p>
              <p className="text-xs text-gray-600 mt-1">Start a camera from Settings or the Cameras page</p>
            </div>
          </div>
        ) : fullscreenCameraId && fullscreenFrame ? (
          <div className="h-full">
            <LiveFeedPanel
              cameraId={fullscreenCameraId}
              cameraName={cameraNames?.[fullscreenCameraId]}
              frame={fullscreenFrame.frame}
              detections={fullscreenFrame.detections}
              analysis={analyses?.[fullscreenCameraId]}
              isSelected
              isOnline
              isFullscreen
              onClick={() => exitFullscreen()}
              onToggleFullscreen={handleToggleFullscreen}
            />
          </div>
        ) : (
          <CameraGrid
            frames={frames}
            analyses={analyses}
            cameraNames={cameraNames}
            selectedCameraId={selectedCameraId}
            onSelectCamera={handleSelectCamera}
            onToggleFullscreen={handleToggleFullscreen}
            gridLayout={gridLayout}
            fillHeight
          />
        )}
      </div>
    </div>
  );
}
