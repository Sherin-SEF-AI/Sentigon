"use client";

import { memo, useMemo, useState, useCallback, useEffect, useRef } from "react";
import {
  Camera,
  Users,
  Eye,
  Activity,
  Maximize2,
  Download,
  Pause,
  Play,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
  Info,
  X,
  AlertTriangle,
  Shield,
  Brain,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Detection, GeminiAnalysis } from "@/lib/types";

type ActivityLevel = "idle" | "low" | "moderate" | "high" | "critical";

interface LiveFeedPanelProps {
  cameraId: string;
  cameraName?: string;
  frame: string;
  detections?: Detection | null;
  analysis?: GeminiAnalysis | null;
  isSelected?: boolean;
  isOnline?: boolean;
  isFullscreen?: boolean;
  onClick?: (cameraId: string) => void;
  onSnapshot?: (cameraId: string) => void;
  onToggleFullscreen?: (cameraId: string) => void;
}

const activityLevelConfig: Record<
  ActivityLevel,
  { classes: string; label: string; dot: string }
> = {
  idle: {
    classes: "bg-gray-800/90 text-gray-400",
    label: "IDLE",
    dot: "bg-gray-500",
  },
  low: {
    classes: "bg-emerald-950/90 text-emerald-400 border border-emerald-800/50",
    label: "LOW",
    dot: "bg-emerald-400",
  },
  moderate: {
    classes: "bg-yellow-950/90 text-yellow-400 border border-yellow-800/50",
    label: "MOD",
    dot: "bg-yellow-400",
  },
  high: {
    classes: "bg-orange-950/90 text-orange-400 border border-orange-800/50",
    label: "HIGH",
    dot: "bg-orange-400",
  },
  critical: {
    classes:
      "bg-red-950/90 text-red-400 border border-red-500/50",
    label: "CRIT",
    dot: "bg-red-400",
  },
};

const riskBadgeConfig: Record<string, { bg: string; text: string }> = {
  low: { bg: "bg-emerald-900/70", text: "text-emerald-400" },
  medium: { bg: "bg-yellow-900/70", text: "text-yellow-400" },
  high: { bg: "bg-orange-900/70", text: "text-orange-400" },
  critical: { bg: "bg-red-900/70", text: "text-red-400" },
};

function deriveActivityLevel(
  detections?: Detection | null,
  analysis?: GeminiAnalysis | null
): ActivityLevel {
  if (analysis?.activity_level) {
    const level = analysis.activity_level.toLowerCase();
    if (level === "critical") return "critical";
    if (level === "high") return "high";
    if (level === "moderate" || level === "medium") return "moderate";
    if (level === "low") return "low";
    return "idle";
  }

  if (!detections) return "idle";
  const total = detections.total_objects;
  if (total === 0) return "idle";
  if (total <= 2) return "low";
  if (total <= 5) return "moderate";
  if (total <= 10) return "high";
  return "critical";
}

function formatLiveTime(): string {
  const now = new Date();
  return now.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export const LiveFeedPanel = memo(function LiveFeedPanel({
  cameraId,
  cameraName,
  frame,
  detections,
  analysis,
  isSelected = false,
  isOnline = true,
  isFullscreen = false,
  onClick,
  onSnapshot,
  onToggleFullscreen,
}: LiveFeedPanelProps) {
  const [showControls, setShowControls] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [zoom, setZoom] = useState(1);

  // Track when analysis was last updated for "fresh" glow effect
  const [isFreshAnalysis, setIsFreshAnalysis] = useState(false);
  const prevAnalysisRef = useRef(analysis);

  useEffect(() => {
    if (analysis && analysis !== prevAnalysisRef.current) {
      setIsFreshAnalysis(true);
      prevAnalysisRef.current = analysis;
      const timer = setTimeout(() => setIsFreshAnalysis(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [analysis]);

  const activityLevel = useMemo(
    () => deriveActivityLevel(detections, analysis),
    [detections, analysis]
  );

  const config = activityLevelConfig[activityLevel];
  const personCount = detections?.person_count ?? 0;
  const vehicleCount = detections?.vehicle_count ?? 0;
  const detectionCount = detections?.total_objects ?? 0;
  const trackCount = detections?.active_tracks ?? 0;
  const displayName = cameraName || cameraId;

  const handleSnapshot = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onSnapshot) {
        onSnapshot(cameraId);
      } else {
        const link = document.createElement("a");
        link.href = `data:image/jpeg;base64,${frame}`;
        link.download = `${displayName}-${Date.now()}.jpg`;
        link.click();
      }
    },
    [cameraId, frame, displayName, onSnapshot]
  );

  const hasThreats =
    analysis?.threat_indicators && analysis.threat_indicators.length > 0;
  const hasAnomalies = analysis?.anomalies && analysis.anomalies.length > 0;
  const riskLevel = analysis?.overall_risk?.toLowerCase() ?? "low";
  const isHighRisk = riskLevel === "high" || riskLevel === "critical";
  const riskBadge = riskBadgeConfig[riskLevel] || riskBadgeConfig.low;
  const threatCount = (analysis?.threat_indicators?.length ?? 0) + (analysis?.anomalies?.length ?? 0);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onClick?.(cameraId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick?.(cameraId);
      }}
      onMouseEnter={() => setShowControls(true)}
      onMouseLeave={() => {
        setShowControls(false);
        if (!isFullscreen) setShowAnalysis(false);
      }}
      className={cn(
        "group relative cursor-pointer overflow-hidden rounded-lg border transition-all duration-200",
        "bg-gray-950",
        isSelected
          ? "ring-2 ring-cyan-400 border-cyan-500/60 shadow-lg shadow-cyan-500/10"
          : isHighRisk
            ? "border-red-800/60 shadow-md shadow-red-500/5"
            : "border-gray-800/60 hover:border-gray-700",
        isFullscreen && "rounded-none border-0 h-full"
      )}
    >
      {/* Video Frame */}
      <div
        className={cn(
          "relative w-full bg-black overflow-hidden",
          isFullscreen ? "h-full" : "aspect-[16/10]"
        )}
      >
        {frame ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`data:image/jpeg;base64,${frame}`}
            alt={`Camera feed: ${displayName}`}
            className={cn(
              "h-full w-full object-cover",
              isPaused && "opacity-70 grayscale-[30%]"
            )}
            style={{ transform: `scale(${zoom})` }}
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2">
            <Camera className="h-8 w-8 text-gray-700" />
            <span className="text-[10px] font-mono uppercase tracking-wider text-gray-600">
              No signal
            </span>
          </div>
        )}

        {/* Recording indicator + camera name (top-left) */}
        <div className="absolute left-1.5 top-1.5 flex items-center gap-1">
          <div className="flex items-center gap-1 rounded bg-black/80 px-1.5 py-0.5 backdrop-blur-sm">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full shrink-0",
                isOnline
                  ? "bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.6)]"
                  : "bg-red-500"
              )}
            />
            <span className="text-[10px] font-medium text-gray-200 tracking-wide uppercase max-w-[100px] truncate">
              {displayName}
            </span>
          </div>
          {isOnline && !isPaused && (
            <div className="flex items-center gap-1 rounded bg-red-900/80 px-1 py-0.5 backdrop-blur-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-rec-blink" />
              <span className="text-[8px] font-bold text-red-300 tracking-wider">
                REC
              </span>
            </div>
          )}
        </div>

        {/* Activity badge + Risk (top-right) */}
        <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
          {isHighRisk && (
            <span className="flex items-center gap-0.5 rounded bg-red-900/90 px-1.5 py-0.5 text-[9px] font-bold uppercase text-red-300 tracking-wider border border-red-700/50 backdrop-blur-sm">
              <AlertTriangle className="h-2.5 w-2.5" />
              {riskLevel}
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider backdrop-blur-sm",
              config.classes
            )}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", config.dot)} />
            {config.label}
          </span>
        </div>

        {/* AI Thinking Strip — always visible when analysis exists */}
        {analysis && (
          <div
            className={cn(
              "absolute inset-x-0 bottom-[26px] z-10 flex items-center gap-1.5 px-2 py-[3px] backdrop-blur-sm transition-colors duration-500",
              threatCount > 0
                ? "bg-red-950/80 border-t border-red-800/40"
                : "bg-black/70 border-t border-cyan-900/30"
            )}
          >
            {/* AI icon with glow */}
            <div className="flex items-center gap-1 shrink-0">
              {isFreshAnalysis ? (
                <Sparkles className={cn(
                  "h-2.5 w-2.5 transition-colors",
                  threatCount > 0 ? "text-red-400" : "text-cyan-400 drop-shadow-[0_0_3px_rgba(34,211,238,0.6)]"
                )} />
              ) : (
                <Brain className={cn(
                  "h-2.5 w-2.5",
                  threatCount > 0 ? "text-red-400/70" : "text-cyan-500/70"
                )} />
              )}
              <span className={cn(
                "text-[8px] font-bold uppercase tracking-widest",
                threatCount > 0 ? "text-red-400/80" : "text-cyan-500/70"
              )}>
                AI
              </span>
            </div>

            {/* Scene description — one-line truncated */}
            <span className={cn(
              "flex-1 truncate text-[9px] leading-tight",
              isFreshAnalysis ? "text-gray-200" : "text-gray-400",
              "transition-colors duration-1000"
            )}>
              {analysis.scene_description || "Analyzing..."}
            </span>

            {/* Threat count badge */}
            {threatCount > 0 && (
              <span className="shrink-0 flex items-center gap-0.5 rounded bg-red-900/80 px-1 py-px text-[8px] font-bold text-red-300 border border-red-700/40">
                <AlertTriangle className="h-2 w-2" />
                {threatCount}
              </span>
            )}

            {/* Risk badge */}
            <span className={cn(
              "shrink-0 rounded px-1 py-px text-[8px] font-bold uppercase tracking-wider",
              riskBadge.bg, riskBadge.text
            )}>
              {riskLevel}
            </span>
          </div>
        )}

        {/* No analysis — waiting indicator */}
        {!analysis && isOnline && (
          <div className="absolute inset-x-0 bottom-[26px] z-10 flex items-center gap-1.5 px-2 py-[3px] bg-black/60 backdrop-blur-sm border-t border-gray-800/30">
            <Brain className="h-2.5 w-2.5 text-gray-600 animate-pulse" />
            <span className="text-[8px] font-bold uppercase tracking-widest text-gray-600">
              AI
            </span>
            <span className="text-[9px] text-gray-600 italic">
              Waiting for analysis...
            </span>
          </div>
        )}

        {/* Bottom overlay: metrics + timestamp */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent">
          <div className="flex items-end justify-between px-2 pb-1.5 pt-5">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-0.5 text-[10px] text-gray-300">
                <Users className="h-3 w-3 text-cyan-400" />
                <span className="font-mono tabular-nums">{personCount}</span>
              </div>
              {vehicleCount > 0 && (
                <div className="flex items-center gap-0.5 text-[10px] text-gray-300">
                  <Eye className="h-3 w-3 text-purple-400" />
                  <span className="font-mono tabular-nums">
                    {vehicleCount}v
                  </span>
                </div>
              )}
              <div className="flex items-center gap-0.5 text-[10px] text-gray-400">
                <Activity className="h-3 w-3 text-amber-400" />
                <span className="font-mono tabular-nums">
                  {detectionCount}
                </span>
              </div>
              {trackCount > 0 && (
                <div className="text-[9px] text-gray-500 font-mono">
                  {trackCount}t
                </div>
              )}
            </div>
            <span className="font-mono text-[9px] text-gray-500 tabular-nums">
              {formatLiveTime()}
            </span>
          </div>
        </div>

        {/* Camera Controls Toolbar (hover) */}
        <div
          className={cn(
            "absolute bottom-12 left-1/2 -translate-x-1/2 flex items-center gap-0.5 rounded-lg bg-black/90 p-0.5 backdrop-blur-md border border-gray-700/50 shadow-xl transition-all duration-200",
            showControls
              ? "opacity-100 translate-y-0"
              : "opacity-0 translate-y-2 pointer-events-none"
          )}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsPaused(!isPaused);
            }}
            className="rounded p-1 text-gray-400 hover:bg-gray-700/60 hover:text-white transition-colors"
            title={isPaused ? "Resume" : "Pause"}
          >
            {isPaused ? (
              <Play className="h-3 w-3" />
            ) : (
              <Pause className="h-3 w-3" />
            )}
          </button>
          <div className="w-px h-3.5 bg-gray-700" />
          <button
            onClick={handleSnapshot}
            className="rounded p-1 text-gray-400 hover:bg-gray-700/60 hover:text-white transition-colors"
            title="Save snapshot"
          >
            <Download className="h-3 w-3" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsMuted(!isMuted);
            }}
            className="rounded p-1 text-gray-400 hover:bg-gray-700/60 hover:text-white transition-colors"
            title={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted ? (
              <VolumeX className="h-3 w-3" />
            ) : (
              <Volume2 className="h-3 w-3" />
            )}
          </button>
          <div className="w-px h-3.5 bg-gray-700" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              setZoom((z) => Math.max(z - 0.5, 1));
            }}
            className={cn(
              "rounded p-1 transition-colors",
              zoom <= 1
                ? "text-gray-600 cursor-not-allowed"
                : "text-gray-400 hover:bg-gray-700/60 hover:text-white"
            )}
            title="Zoom out"
          >
            <ZoomOut className="h-3 w-3" />
          </button>
          {zoom > 1 && (
            <span className="text-[8px] font-mono text-gray-400 px-0.5">
              {zoom}x
            </span>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setZoom((z) => Math.min(z + 0.5, 4));
            }}
            className={cn(
              "rounded p-1 transition-colors",
              zoom >= 4
                ? "text-gray-600 cursor-not-allowed"
                : "text-gray-400 hover:bg-gray-700/60 hover:text-white"
            )}
            title="Zoom in"
          >
            <ZoomIn className="h-3 w-3" />
          </button>
          <div className="w-px h-3.5 bg-gray-700" />
          {onToggleFullscreen && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleFullscreen(cameraId);
              }}
              className="rounded p-1 text-gray-400 hover:bg-gray-700/60 hover:text-white transition-colors"
              title="Fullscreen"
            >
              <Maximize2 className="h-3 w-3" />
            </button>
          )}
          {analysis && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowAnalysis(!showAnalysis);
              }}
              className={cn(
                "rounded p-1 transition-colors",
                showAnalysis
                  ? "bg-cyan-900/60 text-cyan-400"
                  : "text-gray-400 hover:bg-gray-700/60 hover:text-white"
              )}
              title="AI Analysis"
            >
              <Info className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* AI Analysis Overlay Panel (detailed — toggled by Info button) */}
        {showAnalysis && analysis && (
          <div className="absolute inset-x-0 top-7 bottom-14 mx-1.5 overflow-y-auto rounded-lg bg-gray-950/95 border border-gray-700/50 backdrop-blur-md p-2 shadow-2xl z-20">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-1">
                <Shield className="h-3 w-3 text-cyan-400" />
                <span className="text-[9px] font-bold uppercase tracking-widest text-gray-300">
                  AI Analysis
                </span>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAnalysis(false);
                }}
                className="rounded p-0.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300"
              >
                <X className="h-3 w-3" />
              </button>
            </div>

            <div className="space-y-1.5 text-[10px]">
              {analysis.scene_description && (
                <div>
                  <span className="font-semibold text-gray-500 uppercase tracking-wider text-[9px]">
                    Scene
                  </span>
                  <p className="text-gray-300 leading-relaxed mt-0.5">
                    {analysis.scene_description}
                  </p>
                </div>
              )}

              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 font-bold uppercase tracking-wider text-[9px]",
                    riskLevel === "critical"
                      ? "bg-red-900/60 text-red-400"
                      : riskLevel === "high"
                        ? "bg-orange-900/60 text-orange-400"
                        : riskLevel === "medium"
                          ? "bg-yellow-900/60 text-yellow-400"
                          : "bg-emerald-900/60 text-emerald-400"
                  )}
                >
                  Risk: {analysis.overall_risk}
                </span>
                <span className="text-gray-600">|</span>
                <span className="text-gray-400 text-[9px]">
                  Activity: {analysis.activity_level}
                </span>
              </div>

              {hasThreats && (
                <div>
                  <span className="font-semibold text-red-400 uppercase tracking-wider text-[9px]">
                    Threats
                  </span>
                  <div className="mt-0.5 space-y-0.5">
                    {analysis.threat_indicators!.map((t, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-1 rounded bg-red-950/40 px-1.5 py-0.5 border border-red-900/30"
                      >
                        <AlertTriangle className="h-2.5 w-2.5 text-red-400 mt-0.5 shrink-0" />
                        <div>
                          <span className="font-semibold text-red-300">
                            {t.type}
                          </span>
                          <span className="text-gray-400 ml-1">
                            ({Math.round(t.confidence * 100)}%)
                          </span>
                          {t.description && (
                            <p className="text-gray-500">{t.description}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {hasAnomalies && (
                <div>
                  <span className="font-semibold text-amber-400 uppercase tracking-wider text-[9px]">
                    Anomalies
                  </span>
                  <ul className="mt-0.5 space-y-0.5">
                    {analysis.anomalies!.map((a, i) => (
                      <li
                        key={i}
                        className="text-gray-400 flex items-start gap-1"
                      >
                        <span className="text-amber-500 mt-px">•</span>
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {analysis.persons && analysis.persons.length > 0 && (
                <div>
                  <span className="font-semibold text-cyan-400 uppercase tracking-wider text-[9px]">
                    Persons ({analysis.persons.length})
                  </span>
                  <div className="mt-0.5 space-y-0.5">
                    {analysis.persons.map((p, i) => (
                      <div key={i} className="text-gray-400">
                        <span className="text-gray-300">{p.description}</span>
                        {p.behavior && (
                          <span className="text-gray-500"> — {p.behavior}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {analysis.recommended_actions &&
                analysis.recommended_actions.length > 0 && (
                  <div>
                    <span className="font-semibold text-blue-400 uppercase tracking-wider text-[9px]">
                      Actions
                    </span>
                    <ul className="mt-0.5 space-y-0.5">
                      {analysis.recommended_actions.map((a, i) => (
                        <li
                          key={i}
                          className="text-gray-400 flex items-start gap-1"
                        >
                          <span className="text-blue-500 mt-px">→</span>
                          {a}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
            </div>
          </div>
        )}

        {/* Paused overlay */}
        {isPaused && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <div className="flex items-center gap-1 rounded-full bg-black/70 px-3 py-1 backdrop-blur-sm">
              <Pause className="h-3 w-3 text-yellow-400" />
              <span className="text-[10px] font-bold text-yellow-400 uppercase tracking-wider">
                Paused
              </span>
            </div>
          </div>
        )}

        {/* Zoom indicator */}
        {zoom > 1 && (
          <div className="absolute right-1.5 bottom-12 flex items-center gap-0.5 rounded bg-black/70 px-1.5 py-0.5 backdrop-blur-sm">
            <ZoomIn className="h-2.5 w-2.5 text-gray-400" />
            <span className="text-[9px] font-mono text-gray-400">{zoom}x</span>
          </div>
        )}
      </div>
    </div>
  );
}, (prev, next) => {
  // Skip callback comparison — only re-render when data props change
  return (
    prev.cameraId === next.cameraId &&
    prev.frame === next.frame &&
    prev.cameraName === next.cameraName &&
    prev.isSelected === next.isSelected &&
    prev.isOnline === next.isOnline &&
    prev.isFullscreen === next.isFullscreen &&
    prev.detections === next.detections &&
    prev.analysis === next.analysis
  );
});
