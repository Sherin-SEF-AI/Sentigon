"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { apiFetch, severityColor, formatTimestamp } from "@/lib/utils";
import type { BOLOEntry, PatrolShift } from "@/lib/types";
import FileUpload from "@/components/common/FileUpload";
import { useToast } from "@/components/common/Toaster";
import TimelineView from "@/components/common/TimelineView";
import type { TimelineEvent } from "@/components/common/TimelineView";
import { exportJSON, exportCSV } from "@/lib/export";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

type Tab = "bolo" | "logbook";

const BOLO_TYPE_STYLES: Record<string, string> = {
  person: "bg-blue-500/10 text-blue-400 border-blue-500/40",
  vehicle: "bg-purple-500/10 text-purple-400 border-purple-500/40",
};

const SHIFT_STATUS_STYLES: Record<string, string> = {
  scheduled: "bg-blue-500/10 text-blue-400 border-blue-500/40",
  active: "bg-green-500/10 text-green-400 border-green-500/40",
  completed: "bg-gray-500/10 text-gray-400 border-gray-500/40",
  cancelled: "bg-red-500/10 text-red-400 border-red-500/40",
};

/* ------------------------------------------------------------------ */
/*  BOLO Expiration Helpers                                            */
/* ------------------------------------------------------------------ */

interface ExpirationStatus {
  hoursOld: number;
  badge: "expired" | "expiring_soon" | "active" | null;
}

function getBoloExpirationStatus(entry: BOLOEntry): ExpirationStatus {
  if (!entry.created_at || !entry.active) return { hoursOld: 0, badge: null };
  const hoursOld =
    (Date.now() - new Date(entry.created_at).getTime()) / (1000 * 60 * 60);
  let badge: ExpirationStatus["badge"] = "active";
  if (hoursOld >= 168) badge = "expired";        // 7 days
  else if (hoursOld >= 72) badge = "expiring_soon"; // 3 days
  return { hoursOld, badge };
}

/* ------------------------------------------------------------------ */
/*  Shift Summary Modal                                                */
/* ------------------------------------------------------------------ */

interface ShiftSummaryModalProps {
  entries: BOLOEntry[];
  onClose: () => void;
}

function getBoloDescriptionText(desc: Record<string, unknown>): string {
  if (typeof desc === "string") return desc as unknown as string;
  if (desc.text && typeof desc.text === "string") return desc.text;
  return JSON.stringify(desc).slice(0, 120);
}

function ShiftSummaryModal({ entries, onClose }: ShiftSummaryModalProps) {
  const activeEntries = entries.filter((e) => e.active);
  const { addToast } = useToast();

  const summaryText = useMemo(() => {
    if (activeEntries.length === 0) return "No active BOLO entries at this time.";
    const lines = activeEntries.map((e, i) => {
      const exp = getBoloExpirationStatus(e);
      const expLabel =
        exp.badge === "expired"
          ? "[EXPIRED]"
          : exp.badge === "expiring_soon"
          ? "[EXPIRING SOON]"
          : "";
      const desc = getBoloDescriptionText(e.description);
      return `${i + 1}. ${e.bolo_type.toUpperCase()} ${expLabel} — ${desc}${
        e.plate_text ? ` | Plate: ${e.plate_text}` : ""
      } | Severity: ${e.severity.toUpperCase()} | Created: ${
        e.created_at ? new Date(e.created_at).toLocaleString() : "Unknown"
      }`;
    });
    return `BOLO SHIFT HANDOVER SUMMARY\nGenerated: ${new Date().toLocaleString()}\nActive BOLOs: ${activeEntries.length}\n\n${lines.join("\n")}`;
  }, [activeEntries]);

  const handleExportJSON = () => {
    exportJSON(
      activeEntries,
      `bolo-shift-summary-${new Date().toISOString().slice(0, 10)}.json`
    );
    addToast("success", "Exported shift summary as JSON");
  };

  const handleExportCSV = () => {
    const rows = activeEntries.map((e) => ({
      id: e.id,
      bolo_type: e.bolo_type,
      description: getBoloDescriptionText(e.description),
      plate_text: e.plate_text ?? "",
      severity: e.severity,
      active: String(e.active),
      expires_at: e.expires_at ?? "",
      created_at: e.created_at ?? "",
      updated_at: e.updated_at ?? "",
    }));
    exportCSV(rows, `bolo-shift-summary-${new Date().toISOString().slice(0, 10)}.csv`);
    addToast("success", "Exported shift summary as CSV");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-xl border border-gray-700 bg-gray-900 p-6 shadow-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-base font-semibold text-gray-100">
              Shift Handover Summary
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {activeEntries.length} active BOLO{activeEntries.length !== 1 ? "s" : ""} at shift change
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Summary text */}
        <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-gray-900 scrollbar-thumb-gray-700">
          <pre className="whitespace-pre-wrap rounded-lg border border-gray-800 bg-gray-950/60 p-4 text-xs text-gray-300 font-mono leading-relaxed">
            {summaryText}
          </pre>
        </div>

        {/* Export actions */}
        <div className="mt-4 flex items-center justify-end gap-3 shrink-0 border-t border-gray-800 pt-4">
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Export CSV
          </button>
          <button
            onClick={handleExportJSON}
            className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Export JSON
          </button>
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-700 px-4 py-2 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  BOLO Sightings Timeline Modal                                      */
/* ------------------------------------------------------------------ */

interface BOLOSighting {
  id: string;
  timestamp: string;
  camera_id?: string;
  camera_name?: string;
  location?: string;
  confidence?: number;
  notes?: string;
}

interface SightingsModalProps {
  boloId: string;
  boloDescription: string;
  onClose: () => void;
}

function SightingsModal({ boloId, boloDescription, onClose }: SightingsModalProps) {
  const [sightings, setSightings] = useState<BOLOSighting[]>([]);
  const [loading, setLoading] = useState(true);
  const [noSightings, setNoSightings] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNoSightings(false);
    apiFetch<BOLOSighting[]>(`/api/bolo/${boloId}/sightings`)
      .then((data) => {
        if (!cancelled) {
          setSightings(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          // Treat 404 or any error as "no sightings recorded"
          setNoSightings(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [boloId]);

  const timelineEvents: TimelineEvent[] = useMemo(() => {
    return sightings.map((s) => ({
      id: s.id,
      timestamp: s.timestamp,
      title: s.camera_name ?? s.camera_id ?? "Unknown Camera",
      description: [
        s.location ? `Location: ${s.location}` : null,
        s.confidence != null
          ? `Confidence: ${Math.round(s.confidence * 100)}%`
          : null,
        s.notes ?? null,
      ]
        .filter(Boolean)
        .join(" · "),
      type: "sighting",
      severity: "medium" as const,
      metadata: {
        ...(s.camera_id ? { "Camera ID": s.camera_id.slice(0, 8) } : {}),
        ...(s.location ? { Location: s.location } : {}),
      },
    }));
  }, [sightings]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-xl border border-gray-700 bg-gray-900 p-6 shadow-2xl flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-base font-semibold text-gray-100">
              Multi-Camera Sightings
            </h3>
            <p className="text-xs text-gray-500 mt-0.5 truncate max-w-xs">
              {boloDescription}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-gray-900 scrollbar-thumb-gray-700">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <svg className="h-6 w-6 animate-spin text-cyan-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="ml-3 text-sm text-gray-500">Loading sightings...</span>
            </div>
          )}

          {!loading && noSightings && (
            <div className="flex flex-col items-center justify-center py-12">
              <svg className="mb-3 h-8 w-8 text-gray-700" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
              </svg>
              <p className="text-sm text-gray-500">No sightings recorded</p>
            </div>
          )}

          {!loading && !noSightings && sightings.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12">
              <p className="text-sm text-gray-500">No sightings recorded</p>
            </div>
          )}

          {!loading && !noSightings && sightings.length > 0 && (
            <div className="px-1">
              <p className="mb-3 text-xs text-gray-500">
                {sightings.length} sighting{sightings.length !== 1 ? "s" : ""} across camera network
              </p>
              <TimelineView events={timelineEvents} maxVisible={10} />
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end shrink-0 border-t border-gray-800 pt-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-700 px-4 py-2 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  BOLO Add Form                                                      */
/* ------------------------------------------------------------------ */

interface BOLOFormData {
  bolo_type: "person" | "vehicle";
  description: string;
  plate_text: string;
  severity: string;
  reason: string;
  photo_url: string | null;
}

function BOLOForm({
  onSubmit,
  onCancel,
  submitting,
}: {
  onSubmit: (data: BOLOFormData) => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const { addToast } = useToast();
  const [form, setForm] = useState<BOLOFormData>({
    bolo_type: "person",
    description: "",
    plate_text: "",
    severity: "medium",
    reason: "",
    photo_url: null,
  });

  return (
    <div className="rounded-lg border border-cyan-800/40 bg-gray-900/80 p-4 mb-4">
      <h3 className="text-sm font-semibold text-cyan-400 mb-3">
        New BOLO Entry
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* BOLO Type */}
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">
            BOLO Type
          </label>
          <select
            value={form.bolo_type}
            onChange={(e) =>
              setForm({ ...form, bolo_type: e.target.value as "person" | "vehicle" })
            }
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          >
            <option value="person">Person</option>
            <option value="vehicle">Vehicle</option>
          </select>
        </div>

        {/* Severity */}
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">
            Severity
          </label>
          <select
            value={form.severity}
            onChange={(e) => setForm({ ...form, severity: e.target.value })}
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          >
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
            <option value="info">Info</option>
          </select>
        </div>

        {/* Plate text (conditional) */}
        {form.bolo_type === "vehicle" && (
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">
              Plate Text
            </label>
            <input
              type="text"
              value={form.plate_text}
              onChange={(e) => setForm({ ...form, plate_text: e.target.value })}
              placeholder="e.g. ABC-1234"
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            />
          </div>
        )}

        {/* Description (full width) */}
        <div className="md:col-span-2">
          <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">
            Description
          </label>
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={3}
            placeholder="Detailed description of the BOLO subject..."
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700 resize-none"
          />
        </div>

        {/* Reason */}
        <div className="md:col-span-2">
          <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">
            Reason
          </label>
          <textarea
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
            rows={2}
            placeholder="Reason for issuing this BOLO..."
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700 resize-none"
          />
        </div>

        {/* Photo Upload */}
        <div className="md:col-span-2">
          <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">
            Photo
          </label>
          <div className="flex items-center gap-3">
            <FileUpload
              endpoint="/api/bolo/photo"
              accept="image/*"
              compact={true}
              label="Upload Photo"
              onUpload={(file) => {
                setForm((prev) => ({ ...prev, photo_url: file.url ?? null }));
                addToast("success", "Photo uploaded successfully");
              }}
              onError={(msg) => addToast("error", `Photo upload failed: ${msg}`)}
            />
            {form.photo_url && (
              <div className="relative">
                <img
                  src={form.photo_url}
                  alt="BOLO preview"
                  className="h-12 w-12 rounded-lg object-cover border border-gray-700"
                />
                <button
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, photo_url: null }))}
                  className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-white text-[10px] hover:bg-red-500"
                >
                  ×
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={() => onSubmit(form)}
          disabled={submitting || !form.description.trim()}
          className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold bg-cyan-900/40 text-cyan-400 border border-cyan-800/60 hover:bg-cyan-800/50 hover:text-cyan-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting && (
            <svg
              className="h-3.5 w-3.5 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
          )}
          Submit BOLO
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg px-4 py-2 text-xs text-gray-400 border border-gray-700 hover:bg-gray-800 hover:text-gray-200 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  BOLOLogbookPage                                                    */
/* ------------------------------------------------------------------ */

export default function BOLOLogbookPage() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("bolo");

  // BOLO state
  const [boloEntries, setBoloEntries] = useState<BOLOEntry[]>([]);
  const [boloLoading, setBoloLoading] = useState(true);
  const [boloError, setBoloError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Logbook state
  const [shifts, setShifts] = useState<PatrolShift[]>([]);
  const [shiftLoading, setShiftLoading] = useState(true);
  const [shiftError, setShiftError] = useState<string | null>(null);
  const [startingShift, setStartingShift] = useState(false);

  // Shift Summary modal
  const [showShiftSummary, setShowShiftSummary] = useState(false);

  // Sightings timeline modal
  const [sightingsBoloId, setSightingsBoloId] = useState<string | null>(null);
  const [sightingsBoloDesc, setSightingsBoloDesc] = useState<string>("");

  // Renew BOLO loading tracker (keyed by bolo id)
  const [renewingId, setRenewingId] = useState<string | null>(null);

  /* ---- Fetch BOLO entries ---- */
  const fetchBolo = useCallback(async () => {
    setBoloLoading(true);
    setBoloError(null);
    try {
      const data = await apiFetch<BOLOEntry[]>("/api/bolo");
      setBoloEntries(data);
    } catch (err) {
      setBoloError(
        err instanceof Error ? err.message : "Failed to fetch BOLO entries"
      );
    } finally {
      setBoloLoading(false);
    }
  }, []);

  /* ---- Fetch shifts ---- */
  const fetchShifts = useCallback(async () => {
    setShiftLoading(true);
    setShiftError(null);
    try {
      const data = await apiFetch<PatrolShift[]>("/api/shift-logbook");
      setShifts(data);
    } catch (err) {
      setShiftError(
        err instanceof Error ? err.message : "Failed to fetch shift logbook"
      );
    } finally {
      setShiftLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBolo();
    fetchShifts();
  }, [fetchBolo, fetchShifts]);

  /* ---- Form visibility ---- */
  const handleShowForm = useCallback(() => setShowForm(true), []);
  const handleHideForm = useCallback(() => setShowForm(false), []);

  /* ---- Sorted shifts (most recent first) ---- */
  const sortedShifts = useMemo(
    () =>
      [...shifts].sort(
        (a, b) =>
          new Date(b.start_time ?? 0).getTime() - new Date(a.start_time ?? 0).getTime()
      ),
    [shifts]
  );

  /* ---- Add BOLO ---- */
  const handleAddBolo = useCallback(
    async (formData: BOLOFormData) => {
      setSubmitting(true);
      try {
        const body: Record<string, unknown> = {
          bolo_type: formData.bolo_type,
          description: { text: formData.description },
          severity: formData.severity,
          reason: formData.reason || null,
          plate_text: formData.bolo_type === "vehicle" ? formData.plate_text : null,
          photo_url: formData.photo_url || null,
        };
        const created = await apiFetch<BOLOEntry>("/api/bolo", {
          method: "POST",
          body: JSON.stringify(body),
        });
        setBoloEntries((prev) => [created, ...prev]);
        setShowForm(false);
        toast.addToast("success", "BOLO entry created");
      } catch (err) {
        console.error("Failed to create BOLO:", err);
        toast.addToast("error", err instanceof Error ? err.message : "Failed to create BOLO");
      } finally {
        setSubmitting(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast]
  );

  /* ---- Renew BOLO (reset created_at timestamp via PATCH) ---- */
  const handleRenewBolo = useCallback(
    async (boloId: string) => {
      setRenewingId(boloId);
      try {
        const updated = await apiFetch<BOLOEntry>(`/api/bolo/${boloId}`, {
          method: "PATCH",
          body: JSON.stringify({ created_at: new Date().toISOString() }),
        });
        setBoloEntries((prev) =>
          prev.map((e) => (e.id === boloId ? updated : e))
        );
        toast.addToast("success", "BOLO renewed successfully");
      } catch (err) {
        toast.addToast(
          "error",
          err instanceof Error ? err.message : "Failed to renew BOLO"
        );
      } finally {
        setRenewingId(null);
      }
    },
    [toast]
  );

  /* ---- Start shift ---- */
  const handleStartShift = useCallback(async () => {
    setStartingShift(true);
    try {
      const created = await apiFetch<PatrolShift>("/api/shift-logbook", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setShifts((prev) => [created, ...prev]);
    } catch (err) {
      console.error("Failed to start shift:", err);
    } finally {
      setStartingShift(false);
    }
  }, []);

  /* ---- Format date helper ---- */
  function formatDate(iso: string | null) {
    if (!iso) return "---";
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  /* ---- Render loading spinner ---- */
  function renderSpinner(text: string) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <svg
          className="h-8 w-8 animate-spin text-cyan-400"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        <p className="mt-3 text-sm text-gray-500">{text}</p>
      </div>
    );
  }

  /* ---- Render error ---- */
  function renderError(message: string, retry: () => void) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <svg
          className="mb-2 h-8 w-8 text-red-500"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
          />
        </svg>
        <p className="text-sm text-red-400">{message}</p>
        <button
          onClick={retry}
          className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  /* ---- Get BOLO description text ---- */
  function getBoloDescription(desc: Record<string, unknown>): string {
    if (typeof desc === "string") return desc;
    if (desc.text && typeof desc.text === "string") return desc.text;
    return JSON.stringify(desc).slice(0, 120);
  }

  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-900/30 border border-amber-800/50">
            <svg
              className="h-5 w-5 text-amber-400"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m0-10.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.75c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.57-.598-3.75h-.152c-3.196 0-6.1-1.25-8.25-3.286Zm0 13.036h.008v.008H12v-.008Z"
              />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              BOLO & Shift Logbook
            </h1>
            <p className="text-xs text-gray-500">
              Be-On-the-Lookout alerts and shift management
            </p>
          </div>
        </div>

        {/* Shift Summary button */}
        <button
          onClick={() => setShowShiftSummary(true)}
          className="flex items-center gap-1.5 rounded-lg border border-amber-800/50 bg-amber-900/20 px-3 py-1.5 text-xs font-semibold text-amber-400 hover:bg-amber-900/40 transition-colors"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z" />
          </svg>
          Shift Summary
        </button>
      </div>

      {/* ---- Tabs ---- */}
      <div className="flex items-center gap-0 border-b border-gray-800 px-6">
        <button
          onClick={() => setTab("bolo")}
          className={`px-4 py-3 text-sm font-medium transition-colors border-b-2 ${
            tab === "bolo"
              ? "text-cyan-400 border-cyan-400"
              : "text-gray-500 border-transparent hover:text-gray-300"
          }`}
        >
          BOLO Entries
        </button>
        <button
          onClick={() => setTab("logbook")}
          className={`px-4 py-3 text-sm font-medium transition-colors border-b-2 ${
            tab === "logbook"
              ? "text-cyan-400 border-cyan-400"
              : "text-gray-500 border-transparent hover:text-gray-300"
          }`}
        >
          Shift Logbook
        </button>
      </div>

      {/* ---- Tab content ---- */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {/* ============== BOLO Tab ============== */}
        {tab === "bolo" && (
          <>
            {/* Add BOLO button */}
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs text-gray-500">
                {boloEntries.length} entries
              </span>
              {!showForm && (
                <button
                  onClick={handleShowForm}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold bg-cyan-900/40 text-cyan-400 border border-cyan-800/60 hover:bg-cyan-800/50 transition-colors"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 4.5v15m7.5-7.5h-15"
                    />
                  </svg>
                  Add BOLO
                </button>
              )}
            </div>

            {/* Inline form */}
            {showForm && (
              <BOLOForm
                onSubmit={handleAddBolo}
                onCancel={handleHideForm}
                submitting={submitting}
              />
            )}

            {/* Loading */}
            {boloLoading && renderSpinner("Loading BOLO entries...")}

            {/* Error */}
            {!boloLoading && boloError && renderError(boloError, fetchBolo)}

            {/* Empty */}
            {!boloLoading && !boloError && boloEntries.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16">
                <p className="text-sm text-gray-500">No BOLO entries found</p>
              </div>
            )}

            {/* BOLO Table */}
            {!boloLoading && !boloError && boloEntries.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-gray-800">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-gray-800 bg-gray-900/60">
                      <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                        Photo
                      </th>
                      <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                        Type
                      </th>
                      <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                        Description
                      </th>
                      <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                        Plate
                      </th>
                      <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                        Severity
                      </th>
                      <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                        Active
                      </th>
                      <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                        Expiration
                      </th>
                      <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                        Expires
                      </th>
                      <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                        Created
                      </th>
                      <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/50">
                    {boloEntries.map((entry) => {
                      const exp = getBoloExpirationStatus(entry);
                      const descText = getBoloDescription(entry.description);

                      return (
                        <tr
                          key={entry.id}
                          className="hover:bg-gray-900/50 transition-colors"
                        >
                          {/* Photo thumbnail */}
                          <td className="px-3 py-2.5">
                            {(entry as BOLOEntry & { photo_url?: string | null }).photo_url ? (
                              <img
                                src={(entry as BOLOEntry & { photo_url?: string | null }).photo_url!}
                                alt="BOLO"
                                className="h-9 w-9 rounded-lg object-cover border border-gray-700"
                              />
                            ) : (
                              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-gray-800 bg-gray-900">
                                <svg className="h-4 w-4 text-gray-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                                </svg>
                              </div>
                            )}
                          </td>

                          {/* Type badge */}
                          <td className="px-3 py-2.5">
                            <span
                              className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${
                                BOLO_TYPE_STYLES[entry.bolo_type] || "bg-gray-500/10 text-gray-400 border-gray-500/40"
                              }`}
                            >
                              {entry.bolo_type}
                            </span>
                          </td>

                          {/* Description */}
                          <td className="px-3 py-2.5 max-w-xs">
                            <p className="text-xs text-gray-300 truncate">
                              {descText}
                            </p>
                          </td>

                          {/* Plate text */}
                          <td className="px-3 py-2.5">
                            {entry.plate_text ? (
                              <span className="font-mono text-xs text-cyan-400 bg-cyan-900/20 px-1.5 py-0.5 rounded">
                                {entry.plate_text}
                              </span>
                            ) : (
                              <span className="text-xs text-gray-600">---</span>
                            )}
                          </td>

                          {/* Severity */}
                          <td className="px-3 py-2.5">
                            <span
                              className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${severityColor(entry.severity)}`}
                            >
                              {entry.severity}
                            </span>
                          </td>

                          {/* Active */}
                          <td className="px-3 py-2.5">
                            {entry.active ? (
                              <span className="inline-flex items-center gap-1 text-xs text-green-400">
                                <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                                Active
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                                <span className="h-1.5 w-1.5 rounded-full bg-gray-600" />
                                Inactive
                              </span>
                            )}
                          </td>

                          {/* Expiration Badge + Renew */}
                          <td className="px-3 py-2.5">
                            {entry.active && exp.badge === "expired" && (
                              <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border bg-red-900/40 text-red-400 border-red-700/50">
                                <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126Z" />
                                </svg>
                                Expired
                              </span>
                            )}
                            {entry.active && exp.badge === "expiring_soon" && (
                              <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border bg-amber-900/40 text-amber-400 border-amber-700/50">
                                <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                                </svg>
                                Expiring Soon
                              </span>
                            )}
                            {entry.active && exp.badge === "active" && (
                              <span className="text-[10px] text-gray-600">
                                {exp.hoursOld > 0 ? `${Math.round(exp.hoursOld)}h old` : "New"}
                              </span>
                            )}
                            {!entry.active && (
                              <span className="text-[10px] text-gray-700">—</span>
                            )}
                          </td>

                          {/* Expires */}
                          <td className="px-3 py-2.5 text-xs text-gray-500">
                            {formatDate(entry.expires_at)}
                          </td>

                          {/* Created */}
                          <td className="px-3 py-2.5 text-xs text-gray-500">
                            {formatDate(entry.created_at)}
                          </td>

                          {/* Actions */}
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              {/* Renew button — shown for active expired/expiring-soon BOLOs */}
                              {entry.active &&
                                (exp.badge === "expired" || exp.badge === "expiring_soon") && (
                                  <button
                                    onClick={() => handleRenewBolo(entry.id)}
                                    disabled={renewingId === entry.id}
                                    className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold border bg-cyan-900/30 text-cyan-400 border-cyan-800/50 hover:bg-cyan-900/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    {renewingId === entry.id ? (
                                      <svg className="h-2.5 w-2.5 animate-spin" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                      </svg>
                                    ) : (
                                      <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                                      </svg>
                                    )}
                                    Renew
                                  </button>
                                )}

                              {/* View Sightings button */}
                              <button
                                onClick={() => {
                                  setSightingsBoloId(entry.id);
                                  setSightingsBoloDesc(descText);
                                }}
                                className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold border bg-gray-800 text-gray-400 border-gray-700 hover:bg-gray-700 hover:text-gray-200 transition-colors"
                              >
                                <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
                                </svg>
                                Sightings
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ============== Logbook Tab ============== */}
        {tab === "logbook" && (
          <>
            {/* Start Shift button */}
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs text-gray-500">
                {shifts.length} shifts recorded
              </span>
              <button
                onClick={handleStartShift}
                disabled={startingShift}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold bg-green-900/40 text-green-400 border border-green-800/60 hover:bg-green-800/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {startingShift && (
                  <svg
                    className="h-3.5 w-3.5 animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                )}
                Start Shift
              </button>
            </div>

            {/* Loading */}
            {shiftLoading && renderSpinner("Loading shift logbook...")}

            {/* Error */}
            {!shiftLoading &&
              shiftError &&
              renderError(shiftError, fetchShifts)}

            {/* Empty */}
            {!shiftLoading && !shiftError && shifts.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16">
                <p className="text-sm text-gray-500">No shifts recorded yet</p>
              </div>
            )}

            {/* Timeline-style shift list */}
            {!shiftLoading && !shiftError && shifts.length > 0 && (
              <div className="relative space-y-0">
                {/* Vertical timeline line */}
                <div className="absolute left-[15px] top-0 bottom-0 w-px bg-gray-800" />

                {sortedShifts.map((shift, idx) => (
                  <div key={shift.id} className="relative flex gap-4 pb-4">
                    {/* Timeline dot */}
                    <div className="relative z-10 flex shrink-0 items-start pt-1">
                      <div
                        className={`h-[10px] w-[10px] rounded-full border-2 ${
                          shift.status === "active"
                            ? "bg-green-400 border-green-400"
                            : shift.status === "completed"
                            ? "bg-gray-500 border-gray-500"
                            : shift.status === "scheduled"
                            ? "bg-blue-400 border-blue-400"
                            : "bg-red-400 border-red-400"
                        }`}
                        style={{ marginLeft: "10px" }}
                      />
                    </div>

                    {/* Shift card */}
                    <div className="flex-1 rounded-lg border border-gray-800 bg-gray-900/60 p-3 hover:bg-gray-900/90 transition-colors">
                      <div className="flex items-center gap-2 mb-2">
                        {/* Status badge */}
                        <span
                          className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${
                            SHIFT_STATUS_STYLES[shift.status] || "bg-gray-500/10 text-gray-400 border-gray-500/40"
                          }`}
                        >
                          {shift.status}
                        </span>

                        {/* Shift ID */}
                        <span className="text-[10px] font-mono text-gray-600">
                          {shift.id.slice(0, 8)}
                        </span>
                      </div>

                      {/* Time range */}
                      <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
                        <svg
                          className="h-3.5 w-3.5 text-gray-600"
                          fill="none"
                          viewBox="0 0 24 24"
                          strokeWidth={1.5}
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                          />
                        </svg>
                        <span>
                          {formatDate(shift.start_time)}
                          {" "}
                          <span className="text-gray-600">to</span>
                          {" "}
                          {shift.end_time ? formatDate(shift.end_time) : "ongoing"}
                        </span>
                      </div>

                      {/* Zone IDs */}
                      {shift.zone_ids.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {shift.zone_ids.map((zid) => (
                            <span
                              key={zid}
                              className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-mono text-gray-400"
                            >
                              {zid.slice(0, 8)}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Checkpoints completed */}
                      {shift.checkpoints_completed.length > 0 && (
                        <div className="text-[10px] text-gray-500 mb-1">
                          Checkpoints: {shift.checkpoints_completed.length} completed
                        </div>
                      )}

                      {/* Route waypoints count */}
                      {shift.route_waypoints.length > 0 && (
                        <div className="text-[10px] text-gray-500">
                          Route waypoints: {shift.route_waypoints.length}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* ---- Shift Summary Modal ---- */}
      {showShiftSummary && (
        <ShiftSummaryModal
          entries={boloEntries}
          onClose={() => setShowShiftSummary(false)}
        />
      )}

      {/* ---- Sightings Timeline Modal ---- */}
      {sightingsBoloId && (
        <SightingsModal
          boloId={sightingsBoloId}
          boloDescription={sightingsBoloDesc}
          onClose={() => {
            setSightingsBoloId(null);
            setSightingsBoloDesc("");
          }}
        />
      )}
    </div>
  );
}
