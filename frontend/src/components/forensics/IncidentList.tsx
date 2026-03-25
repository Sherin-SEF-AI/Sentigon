"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  AlertTriangle,
  Archive,
  Camera,
  ChevronDown,
  Circle,
  Clock,
  Film,
  Loader2,
  Play,
  Plus,
  Radio,
  X,
  Zap,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Incident {
  id: string;
  title: string;
  status: "recording" | "complete" | "archived";
  start_time: string;
  end_time: string | null;
  total_frames: number;
  total_agent_actions: number;
  trigger_type: "alert" | "case" | string;
  trigger_id: string | null;
  camera_ids: string[];
}

interface ActiveRecordingsResponse {
  active_count: number;
  recordings: { id: string; title: string }[];
}

interface IncidentListProps {
  onSelect: (incidentId: string) => void;
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CARD = "rounded-lg border border-gray-800 bg-gray-900/60 backdrop-blur p-4";

const STATUS_STYLES: Record<string, { color: string; label: string; Icon: typeof Circle }> = {
  recording: { color: "bg-green-500", label: "Recording", Icon: Radio },
  complete: { color: "bg-blue-500", label: "Complete", Icon: Circle },
  archived: { color: "bg-gray-500", label: "Archived", Icon: Archive },
};

const TRIGGER_STYLES: Record<string, string> = {
  alert: "bg-red-900/30 text-red-400 border-red-800/40",
  case: "bg-violet-900/30 text-violet-400 border-violet-800/40",
};

/* ------------------------------------------------------------------ */
/*  StatusBadge                                                        */
/* ------------------------------------------------------------------ */

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] || STATUS_STYLES.complete;
  const isRecording = status === "recording";

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-800/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-300">
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          style.color,
          isRecording && "animate-pulse shadow-[0_0_6px_rgba(34,197,94,0.6)]"
        )}
      />
      {style.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  StartRecordingForm                                                 */
/* ------------------------------------------------------------------ */

function StartRecordingForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [cameraIds, setCameraIds] = useState("");
  const [preBuffer, setPreBuffer] = useState(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setLoading(true);
    setError("");

    try {
      const ids = cameraIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      await apiFetch("/api/incident-replay/incidents", {
        method: "POST",
        body: JSON.stringify({
          title,
          camera_ids: ids,
          pre_buffer_seconds: preBuffer,
        }),
      });

      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start recording");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={cn(CARD, "mb-4")}>
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-200">Start Recording</h4>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300">
          <X className="h-4 w-4" />
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">
            Title
          </label>
          <input
            type="text"
            placeholder="Incident title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600"
          />
        </div>

        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">
            Camera IDs (comma-separated)
          </label>
          <input
            type="text"
            placeholder="cam-01, cam-02, cam-03"
            value={cameraIds}
            onChange={(e) => setCameraIds(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600"
          />
        </div>

        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">
            Pre-buffer (seconds)
          </label>
          <input
            type="number"
            min={0}
            max={300}
            value={preBuffer}
            onChange={(e) => setPreBuffer(Number(e.target.value))}
            className="w-32 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600"
          />
        </div>

        <button
          onClick={handleSubmit}
          disabled={loading || !title.trim()}
          className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Starting...
            </>
          ) : (
            <>
              <Radio className="h-4 w-4" />
              Start Recording
            </>
          )}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  IncidentList                                                       */
/* ------------------------------------------------------------------ */

export default function IncidentList({ onSelect, className }: IncidentListProps) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showForm, setShowForm] = useState(false);
  const [activeCount, setActiveCount] = useState(0);
  const [error, setError] = useState("");

  /* --- Fetch incidents --- */
  const fetchIncidents = useCallback(async () => {
    try {
      const data = await apiFetch<Incident[]>("/api/incident-replay/incidents");
      setIncidents(data);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load incidents");
    } finally {
      setLoading(false);
    }
  }, []);

  /* --- Fetch active recording count --- */
  const fetchActive = useCallback(async () => {
    try {
      const data = await apiFetch<ActiveRecordingsResponse>(
        "/api/incident-replay/active"
      );
      setActiveCount(data.active_count);
    } catch {
      // Silently handle
    }
  }, []);

  useEffect(() => {
    fetchIncidents();
    fetchActive();
    const timer = setInterval(() => {
      fetchIncidents();
      fetchActive();
    }, 10_000);
    return () => clearInterval(timer);
  }, [fetchIncidents, fetchActive]);

  /* --- Filtered incidents --- */
  const filtered = useMemo(() => {
    if (statusFilter === "all") return incidents;
    return incidents.filter((i) => i.status === statusFilter);
  }, [incidents, statusFilter]);

  return (
    <div className={cn("flex flex-col", className)}>
      {/* Header */}
      <div className={cn(CARD, "mb-4")}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Film className="h-5 w-5 text-cyan-400" />
            <h2 className="text-sm font-bold text-gray-100">Incident Replays</h2>
            <span className="rounded-full bg-gray-800 px-2 py-0.5 text-[10px] font-mono text-gray-400">
              {filtered.length}
            </span>
          </div>

          <div className="flex items-center gap-3">
            {/* Active recordings indicator */}
            {activeCount > 0 && (
              <span className="flex items-center gap-1.5 rounded-full bg-green-900/30 px-2.5 py-1 text-[10px] font-semibold text-green-400 border border-green-800/40">
                <Radio className="h-3 w-3 animate-pulse" />
                {activeCount} Active
              </span>
            )}

            {/* Status filter */}
            <div className="relative">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="appearance-none rounded-lg border border-gray-700 bg-gray-800 py-1.5 pl-3 pr-7 text-xs text-gray-300 focus:border-cyan-600 focus:outline-none"
              >
                <option value="all">All Status</option>
                <option value="recording">Recording</option>
                <option value="complete">Complete</option>
                <option value="archived">Archived</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-500" />
            </div>

            {/* Start Recording button */}
            <button
              onClick={() => setShowForm(!showForm)}
              className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-cyan-500"
            >
              <Plus className="h-3.5 w-3.5" />
              Start Recording
            </button>
          </div>
        </div>
      </div>

      {/* Recording form */}
      {showForm && (
        <StartRecordingForm
          onClose={() => setShowForm(false)}
          onCreated={() => {
            fetchIncidents();
            fetchActive();
          }}
        />
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-xs text-red-400">
          <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" />
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
        </div>
      )}

      {/* Empty state */}
      {!loading && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Film className="mb-3 h-10 w-10 text-gray-700" />
          <p className="text-sm text-gray-500">No incidents found</p>
          <p className="mt-1 text-xs text-gray-600">
            Start a recording to capture an incident replay
          </p>
        </div>
      )}

      {/* Incident table */}
      {!loading && filtered.length > 0 && (
        <div className={cn(CARD, "overflow-hidden p-0")}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  <th className="px-4 py-3">Title</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Start</th>
                  <th className="px-4 py-3">End</th>
                  <th className="px-4 py-3 text-right">Frames</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                  <th className="px-4 py-3">Trigger</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/60">
                {filtered.map((incident) => (
                  <tr
                    key={incident.id}
                    onClick={() => onSelect(incident.id)}
                    className="cursor-pointer transition-colors hover:bg-gray-800/40"
                  >
                    {/* Title */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Play className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
                        <span className="font-medium text-gray-200 truncate max-w-[200px]">
                          {incident.title}
                        </span>
                      </div>
                    </td>

                    {/* Status */}
                    <td className="px-4 py-3">
                      <StatusBadge status={incident.status} />
                    </td>

                    {/* Start time */}
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1 text-xs text-gray-400 font-mono">
                        <Clock className="h-3 w-3 text-gray-600" />
                        {formatTimestamp(incident.start_time)}
                      </span>
                    </td>

                    {/* End time */}
                    <td className="px-4 py-3">
                      {incident.end_time ? (
                        <span className="text-xs text-gray-400 font-mono">
                          {formatTimestamp(incident.end_time)}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-600">--</span>
                      )}
                    </td>

                    {/* Frames */}
                    <td className="px-4 py-3 text-right">
                      <span className="font-mono text-xs text-gray-300">
                        {incident.total_frames.toLocaleString()}
                      </span>
                    </td>

                    {/* Agent actions */}
                    <td className="px-4 py-3 text-right">
                      <span className="flex items-center justify-end gap-1 font-mono text-xs text-gray-300">
                        <Zap className="h-3 w-3 text-amber-400" />
                        {incident.total_agent_actions}
                      </span>
                    </td>

                    {/* Trigger */}
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                          TRIGGER_STYLES[incident.trigger_type] ||
                            "bg-gray-800/40 text-gray-400 border-gray-700/40"
                        )}
                      >
                        {incident.trigger_type === "alert" && (
                          <AlertTriangle className="h-2.5 w-2.5" />
                        )}
                        {incident.trigger_type === "case" && (
                          <Camera className="h-2.5 w-2.5" />
                        )}
                        {incident.trigger_type}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
