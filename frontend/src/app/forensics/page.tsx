"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  Microscope,
  Camera,
  Play,
  Clock,
  GitBranch,
  AlertTriangle,
  Shield,
  Users,
  Car,
  Eye,
  Target,
  CheckCircle2,
  Loader2,
  ChevronDown,
  FileText,
  Crosshair,
  Upload,
  XCircle,
  Copy,
  FileSearch,
  Grid3x3,
  Monitor,
  Film,
  ListOrdered,
  Gauge,
} from "lucide-react";
import { cn, apiFetch, severityColor, formatTimestamp } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import type { Camera as CameraType, SecurityEvent } from "@/lib/types";
import IncidentList from "@/components/forensics/IncidentList";
import IncidentReplayPlayer from "@/components/forensics/IncidentReplayPlayer";
import MultiCameraReplayGrid from "@/components/forensics/MultiCameraReplayGrid";
import AgentDecisionTimeline from "@/components/forensics/AgentDecisionTimeline";
import WhatIfPanel from "@/components/forensics/WhatIfPanel";
import ReconstructionPanel from "@/components/forensics/ReconstructionPanel";
import SimilarFramesPanel from "@/components/forensics/SimilarFramesPanel";
import InvestigationPanel from "@/components/forensics/InvestigationPanel";

/* ------------------------------------------------------------------ */
/*  Types for API responses                                            */
/* ------------------------------------------------------------------ */

interface FrameAnalysisResult {
  event_id: string;
  frame_url: string | null;
  detections: Record<string, unknown> | null;
  gemini_analysis: {
    scene_description?: string;
    activity_level?: string;
    overall_risk?: string;
    persons?: { description: string; behavior: string }[];
    vehicles?: { type: string; behavior: string }[];
    anomalies?: string[];
    threat_indicators?: { type: string; confidence: number; description: string }[];
    recommended_actions?: string[];
    analysis_source?: string;
  } | null;
  analysis: Record<string, unknown>;
  context_events: Record<string, unknown>[];
}

interface TimelineEntry {
  timestamp: string;
  type: string;
  id: string;
  event_type: string | null;
  description: string | null;
  severity: string;
  confidence: number | null;
  camera_id: string | null;
  zone_id: string | null;
  metadata: Record<string, unknown> | null;
}

interface TimelineResponse {
  start_time: string;
  end_time: string;
  total_entries: number;
  entries: TimelineEntry[];
  summary: Record<string, unknown>;
}

interface CorrelationResult {
  anchor_event: Record<string, unknown>;
  correlated_events: (Record<string, unknown> & { correlation_score?: number })[];
  correlation_score: number;
  cameras_involved: string[];
  summary: string;
}

interface ChainOfCustodyEntry {
  timestamp: string;
  action: string;
  actor: string;
}

const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
type ReplaySpeed = typeof REPLAY_SPEEDS[number];

/* ------------------------------------------------------------------ */
/*  Skeleton loader                                                    */
/* ------------------------------------------------------------------ */

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded bg-gray-800/60",
        className
      )}
    />
  );
}

function CardSkeleton() {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 space-y-3">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main page                                                          */
/* ------------------------------------------------------------------ */

type ForensicTab = "analysis" | "replay" | "investigation";

export default function ForensicsPage() {
  const { addToast } = useToast();

  const [forensicTab, setForensicTab] = useState<ForensicTab>("analysis");
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [multiCameraView, setMultiCameraView] = useState(false);
  const [replayOffset, setReplayOffset] = useState(0);

  // --- playback speed ---
  const [replaySpeed, setReplaySpeed] = useState<ReplaySpeed>(1);

  // --- chain of custody ---
  const [chainOfCustody, setChainOfCustody] = useState<ChainOfCustodyEntry[] | null>(null);
  const [chainOfCustodyLoading, setChainOfCustodyLoading] = useState(false);
  const [chainOfCustodyUnavailable, setChainOfCustodyUnavailable] = useState(false);

  // --- export clip ---
  const [exportClipLoading, setExportClipLoading] = useState(false);

  // --- cameras ---
  const [cameras, setCameras] = useState<CameraType[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState("");
  const [cameraDropdownOpen, setCameraDropdownOpen] = useState(false);

  // --- events for selected camera ---
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState("");

  // --- analysis ---
  const [analysisResult, setAnalysisResult] = useState<FrameAnalysisResult | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState("");

  // --- timeline ---
  const [timelineStart, setTimelineStart] = useState("");
  const [timelineEnd, setTimelineEnd] = useState("");
  const [timelineResult, setTimelineResult] = useState<TimelineResponse | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState("");

  // --- correlation ---
  const [correlationEventId, setCorrelationEventId] = useState("");
  const [correlationResult, setCorrelationResult] = useState<CorrelationResult | null>(null);
  const [correlationLoading, setCorrelationLoading] = useState(false);
  const [correlationError, setCorrelationError] = useState("");

  // --- subject search ---
  const [subjectQuery, setSubjectQuery] = useState("");
  const [subjectTimeRange, setSubjectTimeRange] = useState(24);
  const [subjectResults, setSubjectResults] = useState<Record<string, unknown> | null>(null);
  const [subjectLoading, setSubjectLoading] = useState(false);
  const [subjectError, setSubjectError] = useState("");

  // --- movement trail ---
  const [trailSubject, setTrailSubject] = useState("");
  const [trailResult, setTrailResult] = useState<Record<string, unknown> | null>(null);
  const [trailLoading, setTrailLoading] = useState(false);
  const [trailError, setTrailError] = useState("");

  // --- copy results ---
  const [copied, setCopied] = useState(false);

  // --- event clusters ---
  const [clusterTimeWindow, setClusterTimeWindow] = useState(300);
  const [clusterMinCameras, setClusterMinCameras] = useState(2);
  const [clusterResults, setClusterResults] = useState<Record<string, unknown> | null>(null);
  const [clusterLoading, setClusterLoading] = useState(false);
  const [clusterError, setClusterError] = useState("");

  // --- evidence timeline (NL) ---
  const [evidenceTimelineQuery, setEvidenceTimelineQuery] = useState("");
  const [evidenceTimelineResult, setEvidenceTimelineResult] = useState<any>(null);
  const [evidenceTimelineLoading, setEvidenceTimelineLoading] = useState(false);

  // Load cameras on mount
  useEffect(() => {
    apiFetch<CameraType[]>("/api/cameras")
      .then(setCameras)
      .catch((err: Error) => { console.warn("Cameras fetch failed:", err.message); });
  }, []);

  // Load recent events when camera changes
  useEffect(() => {
    if (!selectedCameraId) {
      setEvents([]);
      setSelectedEventId("");
      return;
    }
    apiFetch<SecurityEvent[]>(`/api/cameras/${selectedCameraId}/events?limit=20`)
      .then((evts) => {
        setEvents(evts);
        if (evts.length > 0) setSelectedEventId(evts[0].id);
      })
      .catch(() => setEvents([]));
  }, [selectedCameraId]);

  // --- handlers ---

  const handleAnalyze = useCallback(async () => {
    if (!selectedEventId) return;
    setAnalysisLoading(true);
    setAnalysisError("");
    setAnalysisResult(null);
    try {
      const res = await apiFetch<FrameAnalysisResult>("/api/forensics/analyze-frame", {
        method: "POST",
        body: JSON.stringify({
          event_id: selectedEventId,
          analysis_types: ["objects", "faces", "text", "anomalies"],
          include_context: true,
          context_window_seconds: 60,
        }),
      });
      setAnalysisResult(res);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setAnalysisLoading(false);
    }
  }, [selectedEventId]);

  const handleBuildTimeline = useCallback(async () => {
    if (!timelineStart || !timelineEnd) return;
    setTimelineLoading(true);
    setTimelineError("");
    setTimelineResult(null);
    try {
      const res = await apiFetch<TimelineResponse>("/api/forensics/timeline", {
        method: "POST",
        body: JSON.stringify({
          start_time: new Date(timelineStart).toISOString(),
          end_time: new Date(timelineEnd).toISOString(),
          camera_ids: selectedCameraId ? [selectedCameraId] : undefined,
          include_alerts: true,
        }),
      });
      setTimelineResult(res);
    } catch (err) {
      setTimelineError(err instanceof Error ? err.message : "Timeline build failed");
    } finally {
      setTimelineLoading(false);
    }
  }, [timelineStart, timelineEnd, selectedCameraId]);

  const handleCorrelate = useCallback(async () => {
    const eventId = correlationEventId || selectedEventId;
    if (!eventId) return;
    setCorrelationLoading(true);
    setCorrelationError("");
    setCorrelationResult(null);
    try {
      const res = await apiFetch<CorrelationResult>("/api/forensics/correlate", {
        method: "POST",
        body: JSON.stringify({
          anchor_event_id: eventId,
          time_window_seconds: 300,
          max_results: 50,
          min_confidence: 0.0,
        }),
      });
      setCorrelationResult(res);
    } catch (err) {
      setCorrelationError(err instanceof Error ? err.message : "Correlation failed");
    } finally {
      setCorrelationLoading(false);
    }
  }, [correlationEventId, selectedEventId]);

  const handleSubjectSearch = useCallback(async () => {
    if (!subjectQuery.trim()) return;
    setSubjectLoading(true);
    setSubjectError("");
    setSubjectResults(null);
    try {
      const res = await apiFetch<Record<string, unknown>>("/api/forensics/subject-search", {
        method: "POST",
        body: JSON.stringify({
          description: subjectQuery,
          time_range_hours: subjectTimeRange,
          max_results: 20,
        }),
      });
      setSubjectResults(res);
    } catch (err) {
      setSubjectError(err instanceof Error ? err.message : "Subject search failed");
    } finally {
      setSubjectLoading(false);
    }
  }, [subjectQuery, subjectTimeRange]);

  const handleMovementTrail = useCallback(async () => {
    if (!trailSubject.trim()) return;
    setTrailLoading(true);
    setTrailError("");
    setTrailResult(null);
    try {
      const res = await apiFetch<Record<string, unknown>>("/api/forensics/movement-trail", {
        method: "POST",
        body: JSON.stringify({
          subject_description: trailSubject,
          max_results: 30,
        }),
      });
      setTrailResult(res);
    } catch (err) {
      setTrailError(err instanceof Error ? err.message : "Movement trail failed");
    } finally {
      setTrailLoading(false);
    }
  }, [trailSubject]);

  const handleEventClusters = useCallback(async () => {
    setClusterLoading(true);
    setClusterError("");
    setClusterResults(null);
    try {
      const res = await apiFetch<Record<string, unknown>>("/api/forensics/event-clusters", {
        method: "POST",
        body: JSON.stringify({
          time_window_seconds: clusterTimeWindow,
          min_cameras: clusterMinCameras,
        }),
      });
      setClusterResults(res);
    } catch (err) {
      setClusterError(err instanceof Error ? err.message : "Event clustering failed");
    } finally {
      setClusterLoading(false);
    }
  }, [clusterTimeWindow, clusterMinCameras]);

  const handleBuildEvidenceTimeline = useCallback(async () => {
    if (!evidenceTimelineQuery.trim() || evidenceTimelineLoading) return;
    setEvidenceTimelineLoading(true);
    setEvidenceTimelineResult(null);
    try {
      const result = await apiFetch("/api/intelligence/evidence-timeline", {
        method: "POST",
        body: JSON.stringify({ query: evidenceTimelineQuery, hours_back: 24 }),
      });
      setEvidenceTimelineResult(result);
    } catch (err) {
      console.error("Timeline build failed:", err);
    } finally {
      setEvidenceTimelineLoading(false);
    }
  }, [evidenceTimelineQuery, evidenceTimelineLoading]);

  const handleSelectIncident = useCallback((id: string) => {
    setSelectedIncidentId(id);
    // Reset chain-of-custody state for new incident
    setChainOfCustody(null);
    setChainOfCustodyUnavailable(false);
    // Auto-fetch chain of custody
    setChainOfCustodyLoading(true);
    apiFetch<{ entries: ChainOfCustodyEntry[] }>(`/api/forensics/chain-of-custody/${id}`)
      .then((data) => {
        setChainOfCustody(data.entries ?? []);
        setChainOfCustodyUnavailable(false);
      })
      .catch((err: Error) => {
        if (err.message.includes("404") || err.message.includes("not found")) {
          setChainOfCustodyUnavailable(true);
        } else {
          setChainOfCustodyUnavailable(true);
        }
        setChainOfCustody(null);
      })
      .finally(() => setChainOfCustodyLoading(false));
  }, []);

  const handleClearIncident = useCallback(() => {
    setSelectedIncidentId(null);
    setChainOfCustody(null);
    setChainOfCustodyUnavailable(false);
  }, []);

  const handleExportClip = useCallback(async () => {
    if (!selectedIncidentId) return;
    setExportClipLoading(true);
    try {
      await apiFetch("/api/forensics/export-clip", {
        method: "POST",
        body: JSON.stringify({
          incident_id: selectedIncidentId,
          start_time: replayOffset,
          end_time: replayOffset + 30,
        }),
      });
      addToast("success", "Clip export started successfully");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Export failed";
      if (msg.includes("404") || msg.includes("not found")) {
        addToast("error", "Export endpoint not available");
      } else {
        addToast("error", `Export failed: ${msg}`);
      }
    } finally {
      setExportClipLoading(false);
    }
  }, [selectedIncidentId, replayOffset, addToast]);

  const selectedCamera = useMemo(
    () => cameras.find((c) => c.id === selectedCameraId),
    [cameras, selectedCameraId]
  );

  const ga = useMemo(
    () => analysisResult?.gemini_analysis ?? null,
    [analysisResult]
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="flex items-center gap-3 border-b border-gray-800 bg-gray-950 px-6 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
          <Microscope className="h-5 w-5 text-cyan-400" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Forensic Analysis</h1>
          <p className="text-xs text-gray-500">Deep-dive frame analysis, timelines &amp; cross-camera correlation</p>
        </div>
      </header>

      {/* ── Tabs ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 border-b border-gray-800 px-6 bg-gray-950">
        {([
          { key: "analysis" as const, label: "Frame Analysis", icon: Microscope },
          { key: "replay" as const, label: "Incident Replay", icon: Play },
          { key: "investigation" as const, label: "AI Investigation", icon: FileSearch },
        ]).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setForensicTab(tab.key)}
            className={cn(
              "flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors",
              forensicTab === tab.key
                ? "border-cyan-500 text-cyan-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Incident Replay Tab ──────────────────────────────── */}
      {forensicTab === "replay" && (
        <div className="flex flex-1 overflow-hidden">
          {/* Left: incident list + replay player */}
          <div className="flex w-2/3 flex-col overflow-y-auto border-r border-gray-800 p-6 space-y-6">
            {!selectedIncidentId ? (
              <IncidentList onSelect={handleSelectIncident} />
            ) : (
              <>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <button
                    onClick={handleClearIncident}
                    className="flex items-center gap-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    &larr; Back to incidents
                  </button>

                  <div className="flex items-center gap-2 flex-wrap">
                    {/* Playback speed control */}
                    <div className="flex items-center gap-1 rounded-lg border border-gray-700 bg-gray-800/50 p-0.5">
                      <Gauge className="h-3 w-3 text-gray-500 ml-1.5" />
                      {REPLAY_SPEEDS.map((s) => (
                        <button
                          key={s}
                          onClick={() => setReplaySpeed(s)}
                          className={cn(
                            "rounded-md px-2 py-1 text-[10px] font-medium transition-colors tabular-nums",
                            replaySpeed === s ? "bg-cyan-600 text-white" : "text-gray-400 hover:text-gray-200"
                          )}
                        >
                          {s}x
                        </button>
                      ))}
                    </div>

                    {/* Export Clip button */}
                    <button
                      onClick={handleExportClip}
                      disabled={exportClipLoading}
                      className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-1.5 text-[10px] font-medium text-gray-300 hover:border-gray-600 hover:text-white transition-colors disabled:opacity-50"
                    >
                      {exportClipLoading ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Film className="h-3 w-3" />
                      )}
                      Export Clip
                    </button>

                    {/* View toggle: Single vs Multi-Camera */}
                    <div className="flex items-center gap-1 rounded-lg border border-gray-700 bg-gray-800/50 p-0.5">
                      <button
                        onClick={() => setMultiCameraView(false)}
                        className={cn(
                          "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[10px] font-medium transition-colors",
                          !multiCameraView ? "bg-cyan-600 text-white" : "text-gray-400 hover:text-gray-200"
                        )}
                      >
                        <Monitor className="h-3 w-3" /> Single Camera
                      </button>
                      <button
                        onClick={() => setMultiCameraView(true)}
                        className={cn(
                          "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[10px] font-medium transition-colors",
                          multiCameraView ? "bg-cyan-600 text-white" : "text-gray-400 hover:text-gray-200"
                        )}
                      >
                        <Grid3x3 className="h-3 w-3" /> Multi-Camera
                      </button>
                    </div>
                  </div>
                </div>

                {multiCameraView ? (
                  <MultiCameraReplayGrid
                    incidentId={selectedIncidentId}
                    onOffsetChange={setReplayOffset}
                  />
                ) : (
                  <IncidentReplayPlayer
                    incidentId={selectedIncidentId}
                    onOffsetChange={setReplayOffset}
                    initialSpeed={replaySpeed}
                  />
                )}
              </>
            )}
          </div>
          {/* Right: chain-of-custody + agent timeline + reconstruction + what-if */}
          <div className="flex w-1/3 flex-col overflow-y-auto p-6 space-y-6">
            {selectedIncidentId ? (
              <>
                {/* ── Chain of Custody ─────────────────────── */}
                <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
                    <ListOrdered className="h-4 w-4 text-cyan-400" />
                    Chain of Custody
                  </div>
                  {chainOfCustodyLoading && (
                    <div className="flex items-center gap-2 py-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-500" />
                      <span className="text-xs text-gray-500">Loading...</span>
                    </div>
                  )}
                  {!chainOfCustodyLoading && chainOfCustodyUnavailable && (
                    <p className="text-xs text-gray-500 italic">
                      Chain of custody tracking not available
                    </p>
                  )}
                  {!chainOfCustodyLoading && chainOfCustody && chainOfCustody.length === 0 && (
                    <p className="text-xs text-gray-600">No custody entries recorded</p>
                  )}
                  {!chainOfCustodyLoading && chainOfCustody && chainOfCustody.length > 0 && (
                    <div className="max-h-48 overflow-y-auto space-y-1.5">
                      {chainOfCustody.map((entry, i) => (
                        <div
                          key={i}
                          className="rounded border border-gray-800 bg-gray-950/60 px-3 py-2 text-xs"
                        >
                          <div className="flex items-center justify-between gap-2 mb-0.5">
                            <span className="font-mono text-[10px] text-gray-500">
                              {formatTimestamp(entry.timestamp)}
                            </span>
                            <span className="text-[10px] text-cyan-400 font-medium">{entry.actor}</span>
                          </div>
                          <p className="text-gray-300">{entry.action}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <ReconstructionPanel
                  incidentId={selectedIncidentId}
                  onSeekToOffset={(offset) => setReplayOffset(offset)}
                />
                <AgentDecisionTimeline
                  incidentId={selectedIncidentId}
                  currentOffset={replayOffset}
                />
                <WhatIfPanel incidentId={selectedIncidentId} />
              </>
            ) : (
              <div className="flex flex-col items-center justify-center py-20">
                <Play className="h-10 w-10 text-gray-700 mb-3" />
                <p className="text-sm text-gray-500">Select an incident to view AI reconstruction, agent decisions, and run simulations</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── AI Investigation Tab ──────────────────────────────── */}
      {forensicTab === "investigation" && (
        <div className="flex flex-1 overflow-hidden p-6">
          <InvestigationPanel className="w-full" />
        </div>
      )}

      {/* ── Analysis Tab Body ────────────────────────────────── */}
      {forensicTab === "analysis" && <div className="flex flex-1 overflow-hidden">
        {/* ============ LEFT PANEL (2/3) ======================== */}
        <div className="flex w-2/3 flex-col overflow-y-auto border-r border-gray-800 p-6 space-y-6">
          {/* Camera / Event selector */}
          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
              <Camera className="h-4 w-4 text-cyan-400" />
              Select Camera &amp; Event
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Camera dropdown */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setCameraDropdownOpen(!cameraDropdownOpen)}
                  className="flex w-full items-center justify-between rounded-lg border border-gray-700 bg-gray-900 px-4 py-2.5 text-sm text-gray-100 hover:border-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
                >
                  <span className={selectedCamera ? "text-gray-100" : "text-gray-500"}>
                    {selectedCamera ? selectedCamera.name : "Choose a camera..."}
                  </span>
                  <ChevronDown className="h-4 w-4 text-gray-500" />
                </button>
                {cameraDropdownOpen && (
                  <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
                    {cameras.length === 0 && (
                      <div className="px-4 py-3 text-xs text-gray-500">No cameras available</div>
                    )}
                    {cameras.map((cam) => (
                      <button
                        key={cam.id}
                        type="button"
                        onClick={() => {
                          setSelectedCameraId(cam.id);
                          setCameraDropdownOpen(false);
                        }}
                        className={cn(
                          "flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors hover:bg-gray-800",
                          cam.id === selectedCameraId ? "bg-cyan-900/20 text-cyan-400" : "text-gray-300"
                        )}
                      >
                        <span
                          className={cn(
                            "h-2 w-2 rounded-full",
                            cam.status === "online" ? "bg-green-500" : "bg-gray-600"
                          )}
                        />
                        {cam.name}
                        {cam.location && (
                          <span className="ml-auto text-xs text-gray-600">{cam.location}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Event selector */}
              <div>
                <select
                  value={selectedEventId}
                  onChange={(e) => setSelectedEventId(e.target.value)}
                  disabled={events.length === 0}
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-2.5 text-sm text-gray-100 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700 disabled:opacity-50"
                >
                  <option value="">Select event...</option>
                  {events.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.event_type} - {formatTimestamp(ev.timestamp)} ({ev.severity})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Analyze + Copy buttons */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleAnalyze}
                disabled={!selectedEventId || analysisLoading}
                className="flex items-center gap-2 rounded-lg bg-cyan-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {analysisLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {analysisLoading ? "Analyzing..." : "Analyze Frame"}
              </button>
              {analysisResult && (
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(JSON.stringify(analysisResult, null, 2));
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-gray-300 transition-colors hover:bg-gray-700"
                >
                  {copied ? <CheckCircle2 className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
                  {copied ? "Copied!" : "Copy Results"}
                </button>
              )}
            </div>
          </div>

          {/* Error */}
          {analysisError && (
            <div className="flex items-center gap-2 rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400">
              <XCircle className="h-4 w-4 shrink-0" />
              {analysisError}
            </div>
          )}

          {/* Loading skeletons */}
          {analysisLoading && (
            <div className="space-y-4">
              <CardSkeleton />
              <div className="grid grid-cols-2 gap-4">
                <CardSkeleton />
                <CardSkeleton />
              </div>
              <CardSkeleton />
            </div>
          )}

          {/* ── Analysis Results ─────────────────────────────── */}
          {analysisResult && !analysisLoading && (
            <div className="space-y-4">
              {/* Scene Description */}
              {ga?.scene_description && (
                <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-5 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
                    <Eye className="h-4 w-4 text-cyan-400" />
                    Scene Description
                  </div>
                  <p className="text-sm leading-relaxed text-gray-400">
                    {ga.scene_description}
                  </p>
                </div>
              )}

              {/* Risk Assessment */}
              {ga?.overall_risk && (
                <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-5 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
                    <Shield className="h-4 w-4 text-cyan-400" />
                    Risk Assessment
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase",
                        severityColor(ga.overall_risk)
                      )}
                    >
                      {ga.overall_risk}
                    </span>
                    {ga.activity_level && (
                      <span className="text-xs text-gray-500">
                        Activity: <span className="text-gray-300">{ga.activity_level}</span>
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Persons & Vehicles (side by side) */}
              <div className="grid grid-cols-2 gap-4">
                {/* Persons */}
                <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-5 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
                    <Users className="h-4 w-4 text-cyan-400" />
                    Person Descriptions
                    {ga?.persons && (
                      <span className="ml-auto text-xs text-gray-600">{ga.persons.length} detected</span>
                    )}
                  </div>
                  {ga?.persons && ga.persons.length > 0 ? (
                    <ul className="space-y-2">
                      {ga.persons.map((p, i) => (
                        <li key={i} className="rounded border border-gray-800 bg-gray-950/50 px-3 py-2">
                          <p className="text-xs font-medium text-gray-300">{p.description}</p>
                          <p className="mt-0.5 text-xs text-gray-500">Behavior: {p.behavior}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-gray-600">No persons detected</p>
                  )}
                </div>

                {/* Vehicles */}
                <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-5 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
                    <Car className="h-4 w-4 text-cyan-400" />
                    Vehicle Descriptions
                    {ga?.vehicles && (
                      <span className="ml-auto text-xs text-gray-600">{ga.vehicles.length} detected</span>
                    )}
                  </div>
                  {ga?.vehicles && ga.vehicles.length > 0 ? (
                    <ul className="space-y-2">
                      {ga.vehicles.map((v, i) => (
                        <li key={i} className="rounded border border-gray-800 bg-gray-950/50 px-3 py-2">
                          <p className="text-xs font-medium text-gray-300">{v.type}</p>
                          <p className="mt-0.5 text-xs text-gray-500">Behavior: {v.behavior}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-gray-600">No vehicles detected</p>
                  )}
                </div>
              </div>

              {/* Anomalies */}
              {ga?.anomalies && ga.anomalies.length > 0 && (
                <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-5 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
                    <AlertTriangle className="h-4 w-4 text-yellow-500" />
                    Anomalies Detected
                  </div>
                  <ul className="space-y-1.5">
                    {ga.anomalies.map((a, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 rounded border border-yellow-900/30 bg-yellow-900/10 px-3 py-2 text-xs text-yellow-400"
                      >
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Threat Indicators */}
              {ga?.threat_indicators && ga.threat_indicators.length > 0 && (
                <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-5 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
                    <Target className="h-4 w-4 text-red-400" />
                    Threat Indicators
                  </div>
                  <div className="space-y-2">
                    {ga.threat_indicators.map((t, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 rounded border border-gray-800 bg-gray-950/50 px-3 py-2"
                      >
                        <span className="inline-flex items-center rounded bg-red-900/30 px-2 py-0.5 text-[10px] font-bold uppercase text-red-400 border border-red-800/50">
                          {t.type}
                        </span>
                        <span className="flex-1 text-xs text-gray-400">{t.description}</span>
                        <span className="text-xs font-mono text-gray-500">
                          {(t.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recommended Actions */}
              {ga?.recommended_actions && ga.recommended_actions.length > 0 && (
                <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-5 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
                    <CheckCircle2 className="h-4 w-4 text-green-400" />
                    Recommended Actions
                  </div>
                  <ul className="space-y-1.5">
                    {ga.recommended_actions.map((action, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 text-xs text-gray-400"
                      >
                        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-500" />
                        {action}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Context Events */}
              {analysisResult.context_events.length > 0 && (
                <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-5 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
                    <FileText className="h-4 w-4 text-cyan-400" />
                    Context Events
                    <span className="ml-auto text-xs text-gray-600">
                      {analysisResult.context_events.length} nearby events
                    </span>
                  </div>
                  <div className="max-h-48 space-y-1.5 overflow-y-auto">
                    {analysisResult.context_events.map((ce, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 rounded border border-gray-800 bg-gray-950/50 px-3 py-2 text-xs"
                      >
                        <span className="font-mono text-gray-500">
                          {ce.timestamp ? formatTimestamp(ce.timestamp as string) : "--"}
                        </span>
                        <span
                          className={cn(
                            "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase",
                            severityColor((ce.severity as string) || "info")
                          )}
                        >
                          {(ce.severity as string) || "info"}
                        </span>
                        <span className="text-gray-400">{(ce.event_type as string) || "unknown"}</span>
                        <span className="flex-1 truncate text-gray-600">
                          {(ce.description as string) || ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Visual Frame Search */}
          {analysisResult && selectedEventId && (
            <SimilarFramesPanel
              eventId={selectedEventId}
              onSelectFrame={(eventId) => {
                setSelectedEventId(eventId);
                handleAnalyze();
              }}
            />
          )}

          {/* Empty state */}
          {!analysisResult && !analysisLoading && !analysisError && (
            <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-800/50 border border-gray-700 mb-4">
                <Upload className="h-7 w-7 text-gray-600" />
              </div>
              <p className="text-sm font-medium text-gray-400">Select a camera and event to begin analysis</p>
              <p className="mt-1 text-xs text-gray-600">
                Choose a camera from the dropdown, pick an event, then click &quot;Analyze Frame&quot;
              </p>
            </div>
          )}
        </div>

        {/* ============ RIGHT PANEL (1/3) ======================= */}
        <div className="flex w-1/3 flex-col overflow-y-auto bg-gray-950 p-6 space-y-6">
          <div className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
            Investigation Tools
          </div>

          {/* ── Evidence Timeline Builder (NL) ──────────────── */}
          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
            <div className="flex items-center gap-2 mb-3">
              <Clock className="h-4 w-4 text-cyan-400" />
              <h3 className="text-sm font-bold text-white">Evidence Timeline Builder</h3>
              <span className="text-[9px] text-gray-500 bg-gray-800 rounded px-1.5 py-0.5">AI-Powered</span>
            </div>
            <p className="text-xs text-gray-500 mb-3">
              Describe what you&apos;re looking for in natural language. SENTINEL AI will search cameras, events, and alerts to build a court-ready evidence timeline.
            </p>
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                value={evidenceTimelineQuery}
                onChange={(e) => setEvidenceTimelineQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleBuildEvidenceTimeline()}
                placeholder='e.g. "Find everything involving the person near loading dock from 2pm-5pm"'
                className="flex-1 rounded-md border border-gray-700 bg-gray-800/60 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
              />
              <button
                onClick={handleBuildEvidenceTimeline}
                disabled={evidenceTimelineLoading || !evidenceTimelineQuery.trim()}
                className="flex items-center gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-xs font-bold text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-50 transition-all"
              >
                {evidenceTimelineLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Microscope className="h-3.5 w-3.5" />}
                Build Timeline
              </button>
            </div>

            {/* Timeline Results */}
            {evidenceTimelineResult && (
              <div className="space-y-3">
                {/* Narrative */}
                {evidenceTimelineResult.narrative && (
                  <div className="rounded-md border border-gray-800/50 bg-gray-900/60 p-3">
                    <p className="text-[9px] font-bold uppercase tracking-wider text-gray-500 mb-1">AI Narrative</p>
                    <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap">{evidenceTimelineResult.narrative}</p>
                  </div>
                )}

                {/* Key Findings */}
                {evidenceTimelineResult.key_findings?.length > 0 && (
                  <div className="rounded-md border border-yellow-800/30 bg-yellow-900/10 p-3">
                    <p className="text-[9px] font-bold uppercase tracking-wider text-yellow-500 mb-1">Key Findings</p>
                    <ul className="space-y-0.5">
                      {evidenceTimelineResult.key_findings.map((f: string, i: number) => (
                        <li key={i} className="text-xs text-yellow-300/80 flex items-start gap-1.5">
                          <span className="text-yellow-500 mt-0.5">&#x2022;</span>
                          {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Timeline entries */}
                {evidenceTimelineResult.timeline?.length > 0 && (
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-wider text-gray-500 mb-2">Evidence Timeline ({evidenceTimelineResult.timeline.length} entries)</p>
                    <div className="space-y-1">
                      {evidenceTimelineResult.timeline.map((entry: any, i: number) => (
                        <div key={i} className="flex items-start gap-2 rounded-md border border-gray-800/40 bg-gray-900/40 px-3 py-2">
                          <div className="flex flex-col items-center shrink-0 pt-0.5">
                            <div className={cn(
                              "h-2 w-2 rounded-full",
                              entry.evidence_type === "alert" ? "bg-red-500" :
                              entry.evidence_type === "clip_match" ? "bg-purple-500" :
                              "bg-cyan-500"
                            )} />
                            {i < evidenceTimelineResult.timeline.length - 1 && <div className="w-px h-6 bg-gray-700/40 mt-1" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] text-gray-500 tabular-nums">{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "\u2014"}</span>
                              <span className="text-[8px] font-bold uppercase text-gray-600">{entry.evidence_type}</span>
                              {entry.camera_id && <span className="text-[8px] text-cyan-500/60">{entry.camera_name || entry.camera_id}</span>}
                            </div>
                            <p className="text-[10px] text-gray-400">{entry.description}</p>
                          </div>
                          {entry.confidence != null && (
                            <span className="text-[8px] text-gray-500 tabular-nums shrink-0">{Math.round(entry.confidence * 100)}%</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Evidence quality + chain of custody */}
                <div className="flex items-center gap-4 text-[9px] text-gray-600 pt-2 border-t border-gray-800/30">
                  <span>Quality: <span className={cn("font-bold", evidenceTimelineResult.evidence_quality === "strong" ? "text-emerald-400" : evidenceTimelineResult.evidence_quality === "moderate" ? "text-yellow-400" : "text-gray-400")}>{evidenceTimelineResult.evidence_quality || "N/A"}</span></span>
                  <span>Items: <span className="text-gray-400 font-bold">{evidenceTimelineResult.total_items ?? 0}</span></span>
                  {evidenceTimelineResult.chain_of_custody && <span>Chain of Custody: <span className="text-emerald-400 font-bold">Verified</span></span>}
                </div>
              </div>
            )}
          </div>

          {/* ── Timeline Builder ────────────────────────────── */}
          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
              <Clock className="h-4 w-4 text-cyan-400" />
              Build Timeline
            </div>

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-500">
                  Start Time
                </label>
                <input
                  type="datetime-local"
                  value={timelineStart}
                  onChange={(e) => setTimelineStart(e.target.value)}
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-100 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700 [color-scheme:dark]"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-500">
                  End Time
                </label>
                <input
                  type="datetime-local"
                  value={timelineEnd}
                  onChange={(e) => setTimelineEnd(e.target.value)}
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-100 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700 [color-scheme:dark]"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={handleBuildTimeline}
              disabled={!timelineStart || !timelineEnd || timelineLoading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-900/40 border border-cyan-800/50 px-4 py-2 text-xs font-semibold text-cyan-400 transition-colors hover:bg-cyan-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {timelineLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Clock className="h-3.5 w-3.5" />
              )}
              {timelineLoading ? "Building..." : "Build Timeline"}
            </button>

            {/* Timeline error */}
            {timelineError && (
              <div className="flex items-center gap-2 rounded border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-400">
                <XCircle className="h-3 w-3 shrink-0" />
                {timelineError}
              </div>
            )}

            {/* Timeline loading */}
            {timelineLoading && (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            )}

            {/* Timeline results */}
            {timelineResult && !timelineLoading && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>{timelineResult.total_entries} entries</span>
                  <span>
                    {formatTimestamp(timelineResult.start_time)} - {formatTimestamp(timelineResult.end_time)}
                  </span>
                </div>
                <div className="max-h-64 space-y-1.5 overflow-y-auto">
                  {timelineResult.entries.map((entry) => (
                    <div
                      key={entry.id}
                      className="relative flex items-start gap-3 rounded border border-gray-800 bg-gray-950/50 px-3 py-2"
                    >
                      {/* Timeline dot */}
                      <div className="mt-1.5 flex flex-col items-center">
                        <span
                          className={cn(
                            "h-2 w-2 rounded-full",
                            entry.type === "alert" ? "bg-red-500" : "bg-cyan-500"
                          )}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] text-gray-500">
                            {formatTimestamp(entry.timestamp)}
                          </span>
                          <span
                            className={cn(
                              "inline-flex rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase",
                              severityColor(entry.severity)
                            )}
                          >
                            {entry.severity}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-gray-400">
                          {entry.event_type && (
                            <span className="font-medium text-gray-300">{entry.event_type}: </span>
                          )}
                          {entry.description || "No description"}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Timeline summary */}
                {timelineResult.summary && (
                  <div className="mt-2 rounded border border-gray-800 bg-gray-900/30 px-3 py-2 text-[10px] text-gray-500">
                    Events: {(timelineResult.summary as Record<string, unknown>).total_events as number || 0} |
                    Alerts: {(timelineResult.summary as Record<string, unknown>).total_alerts as number || 0}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Cross-Camera Correlation ────────────────────── */}
          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
              <GitBranch className="h-4 w-4 text-cyan-400" />
              Cross-Camera Correlation
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-500">
                Anchor Event ID
              </label>
              <input
                type="text"
                value={correlationEventId || selectedEventId}
                onChange={(e) => setCorrelationEventId(e.target.value)}
                placeholder="Event ID to correlate..."
                className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-100 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
              />
            </div>

            <button
              type="button"
              onClick={handleCorrelate}
              disabled={(!correlationEventId && !selectedEventId) || correlationLoading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-900/40 border border-cyan-800/50 px-4 py-2 text-xs font-semibold text-cyan-400 transition-colors hover:bg-cyan-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {correlationLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Crosshair className="h-3.5 w-3.5" />
              )}
              {correlationLoading ? "Correlating..." : "Cross-Camera Correlation"}
            </button>

            {/* Correlation error */}
            {correlationError && (
              <div className="flex items-center gap-2 rounded border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-400">
                <XCircle className="h-3 w-3 shrink-0" />
                {correlationError}
              </div>
            )}

            {/* Correlation loading */}
            {correlationLoading && (
              <div className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            )}

            {/* Correlation results */}
            {correlationResult && !correlationLoading && (
              <div className="space-y-3">
                {/* Overall score */}
                <div className="flex items-center justify-between rounded border border-gray-800 bg-gray-950/50 px-3 py-2">
                  <span className="text-xs text-gray-500">Correlation Score</span>
                  <span
                    className={cn(
                      "text-sm font-bold font-mono",
                      correlationResult.correlation_score >= 0.7
                        ? "text-red-400"
                        : correlationResult.correlation_score >= 0.4
                        ? "text-yellow-400"
                        : "text-green-400"
                    )}
                  >
                    {(correlationResult.correlation_score * 100).toFixed(1)}%
                  </span>
                </div>

                {/* Cameras involved */}
                <div className="flex flex-wrap gap-1.5">
                  {correlationResult.cameras_involved.map((camId) => (
                    <span
                      key={camId}
                      className="inline-flex items-center gap-1 rounded bg-gray-800 px-2 py-0.5 text-[10px] font-mono text-gray-400"
                    >
                      <Camera className="h-2.5 w-2.5" />
                      {camId.slice(0, 8)}
                    </span>
                  ))}
                </div>

                {/* Summary */}
                <p className="text-xs leading-relaxed text-gray-500">
                  {correlationResult.summary}
                </p>

                {/* Correlated events */}
                <div className="max-h-48 space-y-1.5 overflow-y-auto">
                  {correlationResult.correlated_events.map((ce, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 rounded border border-gray-800 bg-gray-950/50 px-3 py-2"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-xs text-gray-300">
                          {(ce.event_type as string) || "event"}
                        </p>
                        <p className="text-[10px] text-gray-600">
                          {ce.timestamp ? formatTimestamp(ce.timestamp as string) : "--"}
                        </p>
                      </div>
                      <div className="text-right">
                        <span
                          className={cn(
                            "text-xs font-mono font-semibold",
                            (ce.correlation_score ?? 0) >= 0.7
                              ? "text-red-400"
                              : (ce.correlation_score ?? 0) >= 0.4
                              ? "text-yellow-400"
                              : "text-cyan-400"
                          )}
                        >
                          {((ce.correlation_score ?? 0) * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                {correlationResult.correlated_events.length === 0 && (
                  <p className="text-xs text-gray-600 text-center py-2">No correlated events found</p>
                )}
              </div>
            )}
          </div>

          {/* ── Subject Search (AI-powered) ─────────────────── */}
          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
              <Users className="h-4 w-4 text-purple-400" />
              Subject Search
            </div>
            <p className="text-[10px] text-gray-500">
              Search across all cameras using natural-language appearance descriptions
            </p>

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-500">
                  Appearance Description
                </label>
                <textarea
                  value={subjectQuery}
                  onChange={(e) => setSubjectQuery(e.target.value)}
                  placeholder="e.g. man in red jacket carrying backpack..."
                  rows={2}
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-100 placeholder-gray-600 focus:border-purple-700 focus:outline-none focus:ring-1 focus:ring-purple-700 resize-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-500">
                  Time Range (hours)
                </label>
                <select
                  value={subjectTimeRange}
                  onChange={(e) => setSubjectTimeRange(Number(e.target.value))}
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-100 focus:border-purple-700 focus:outline-none focus:ring-1 focus:ring-purple-700"
                >
                  <option value={1}>Last 1 hour</option>
                  <option value={6}>Last 6 hours</option>
                  <option value={24}>Last 24 hours</option>
                  <option value={72}>Last 3 days</option>
                  <option value={168}>Last 7 days</option>
                </select>
              </div>
            </div>

            <button
              type="button"
              onClick={handleSubjectSearch}
              disabled={!subjectQuery.trim() || subjectLoading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-purple-900/40 border border-purple-800/50 px-4 py-2 text-xs font-semibold text-purple-400 transition-colors hover:bg-purple-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {subjectLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Users className="h-3.5 w-3.5" />
              )}
              {subjectLoading ? "Searching..." : "Search Subject"}
            </button>

            {subjectError && (
              <div className="flex items-center gap-2 rounded border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-400">
                <XCircle className="h-3 w-3 shrink-0" />
                {subjectError}
              </div>
            )}

            {subjectLoading && (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            )}

            {subjectResults && !subjectLoading && (() => {
              const appearances = Array.isArray(subjectResults.appearances) ? subjectResults.appearances as Record<string, unknown>[] : [];
              return (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span>{Number(subjectResults.total_appearances) || 0} appearances</span>
                    <span>{Number(subjectResults.cameras_found) || 0} cameras</span>
                  </div>
                  <div className="max-h-48 space-y-1.5 overflow-y-auto">
                    {appearances.map((app, i) => (
                      <div key={i} className="rounded border border-gray-800 bg-gray-950/50 px-3 py-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-mono text-gray-400">
                            <Camera className="mr-1 inline h-3 w-3" />
                            {String(app.camera_id || "").slice(0, 8)}...
                          </span>
                          <span className="text-[10px] text-purple-400 font-semibold">
                            {Number(app.match_count) || 0} matches
                          </span>
                        </div>
                        <div className="mt-1 text-[10px] text-gray-500">
                          Best score: {(Number(app.best_score) * 100 || 0).toFixed(1)}%
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>

          {/* ── Movement Trail ───────────────────────────────── */}
          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
              <GitBranch className="h-4 w-4 text-green-400" />
              Movement Trail
            </div>
            <p className="text-[10px] text-gray-500">
              Reconstruct a subject&apos;s path across cameras with AI narrative
            </p>

            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-500">
                Subject Description
              </label>
              <input
                type="text"
                value={trailSubject}
                onChange={(e) => setTrailSubject(e.target.value)}
                placeholder="e.g. person in blue uniform..."
                className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-100 placeholder-gray-600 focus:border-green-700 focus:outline-none focus:ring-1 focus:ring-green-700"
              />
            </div>

            <button
              type="button"
              onClick={handleMovementTrail}
              disabled={!trailSubject.trim() || trailLoading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-green-900/40 border border-green-800/50 px-4 py-2 text-xs font-semibold text-green-400 transition-colors hover:bg-green-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {trailLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <GitBranch className="h-3.5 w-3.5" />
              )}
              {trailLoading ? "Building trail..." : "Build Movement Trail"}
            </button>

            {trailError && (
              <div className="flex items-center gap-2 rounded border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-400">
                <XCircle className="h-3 w-3 shrink-0" />
                {trailError}
              </div>
            )}

            {trailLoading && (
              <div className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            )}

            {trailResult && !trailLoading && (() => {
              const summary = trailResult.summary as Record<string, unknown> | undefined;
              const cameraSeq = Array.isArray(trailResult.camera_sequence) ? trailResult.camera_sequence as string[] : [];
              const narrative = typeof trailResult.narrative === "string" ? trailResult.narrative : "";
              const trail = Array.isArray(trailResult.trail) ? trailResult.trail as Record<string, unknown>[] : [];
              return (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span>
                      {Number(summary?.total_appearances) || 0} appearances
                    </span>
                    <span>
                      {Number(summary?.cameras_visited) || 0} cameras
                    </span>
                  </div>

                  {cameraSeq.length > 0 && (
                    <div className="flex items-center gap-1 flex-wrap">
                      {cameraSeq.map((cam, i) => (
                        <span key={i} className="flex items-center gap-1">
                          {i > 0 && <span className="text-gray-600 text-[10px]">&rarr;</span>}
                          <span className="inline-flex items-center rounded bg-green-900/30 border border-green-800/50 px-1.5 py-0.5 text-[10px] font-mono text-green-400">
                            {cam.slice(0, 8)}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}

                  {narrative && (
                    <div className="rounded border border-green-800/30 bg-green-950/20 px-3 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-green-400 mb-1">
                        AI Narrative
                      </p>
                      <p className="text-xs text-gray-400 leading-relaxed">
                        {narrative}
                      </p>
                    </div>
                  )}

                  <div className="max-h-40 space-y-1 overflow-y-auto">
                    {trail.map((point, i) => (
                      <div key={i} className="flex items-center gap-2 rounded border border-gray-800 bg-gray-950/50 px-2 py-1.5 text-[10px]">
                        <span className="h-1.5 w-1.5 rounded-full bg-green-500 shrink-0" />
                        <span className="font-mono text-gray-500">
                          {point.timestamp ? formatTimestamp(String(point.timestamp)) : "--"}
                        </span>
                        <span className="text-gray-400 truncate">{String(point.camera_id || "").slice(0, 8)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>

          {/* ── Event Clusters ───────────────────────────────── */}
          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
              <Target className="h-4 w-4 text-amber-400" />
              Event Clusters
            </div>
            <p className="text-[10px] text-gray-500">
              Find temporally correlated events across multiple cameras with AI analysis
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-500">
                  Time Window (s)
                </label>
                <select
                  value={clusterTimeWindow}
                  onChange={(e) => setClusterTimeWindow(Number(e.target.value))}
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-100 focus:border-amber-700 focus:outline-none focus:ring-1 focus:ring-amber-700"
                >
                  <option value={60}>60s</option>
                  <option value={300}>5 min</option>
                  <option value={600}>10 min</option>
                  <option value={1800}>30 min</option>
                  <option value={3600}>1 hour</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-500">
                  Min Cameras
                </label>
                <select
                  value={clusterMinCameras}
                  onChange={(e) => setClusterMinCameras(Number(e.target.value))}
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-100 focus:border-amber-700 focus:outline-none focus:ring-1 focus:ring-amber-700"
                >
                  <option value={1}>1+</option>
                  <option value={2}>2+</option>
                  <option value={3}>3+</option>
                  <option value={5}>5+</option>
                </select>
              </div>
            </div>

            <button
              type="button"
              onClick={handleEventClusters}
              disabled={clusterLoading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-900/40 border border-amber-800/50 px-4 py-2 text-xs font-semibold text-amber-400 transition-colors hover:bg-amber-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {clusterLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Target className="h-3.5 w-3.5" />
              )}
              {clusterLoading ? "Clustering..." : "Find Event Clusters"}
            </button>

            {clusterError && (
              <div className="flex items-center gap-2 rounded border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-400">
                <XCircle className="h-3 w-3 shrink-0" />
                {clusterError}
              </div>
            )}

            {clusterLoading && (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            )}

            {clusterResults && !clusterLoading && (() => {
              const clusters = Array.isArray(clusterResults.clusters) ? clusterResults.clusters as Record<string, unknown>[] : [];
              return (
                <div className="space-y-2">
                  <div className="text-xs text-gray-500">
                    {Number(clusterResults.total_clusters) || 0} clusters found
                  </div>
                  <div className="max-h-52 space-y-2 overflow-y-auto">
                    {clusters.map((cluster, i) => {
                      const camIds = Array.isArray(cluster.camera_ids) ? cluster.camera_ids as string[] : [];
                      const timeRange = cluster.time_range as Record<string, string> | undefined;
                      const aiCorr = cluster.ai_correlation;
                      return (
                        <div key={i} className="rounded border border-gray-800 bg-gray-950/50 px-3 py-2 space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-amber-400">
                              Cluster #{i + 1}
                            </span>
                            <span className="text-[10px] text-gray-500">
                              {Number(cluster.event_count) || 0} events &middot;{" "}
                              {Number(cluster.camera_count) || 0} cameras
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {camIds.map((cam, j) => (
                              <span key={j} className="rounded bg-gray-800 px-1.5 py-0.5 text-[9px] font-mono text-gray-400">
                                {cam.slice(0, 8)}
                              </span>
                            ))}
                          </div>
                          {timeRange && (
                            <div className="text-[10px] text-gray-600">
                              {formatTimestamp(timeRange.start || "")} &mdash;{" "}
                              {formatTimestamp(timeRange.end || "")}
                            </div>
                          )}
                          {aiCorr != null && (
                            <div className="rounded bg-amber-950/20 border border-amber-800/30 px-2 py-1.5">
                              <p className="text-[10px] font-semibold text-amber-400 mb-0.5">AI Analysis</p>
                              <p className="text-[10px] text-gray-400 leading-relaxed">
                                {typeof aiCorr === "object"
                                  ? String((aiCorr as Record<string, unknown>).incident_summary || JSON.stringify(aiCorr))
                                  : String(aiCorr)}
                              </p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      </div>}
    </div>
  );
}
