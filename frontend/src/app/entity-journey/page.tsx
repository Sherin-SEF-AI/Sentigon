"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useToast } from "@/components/common/Toaster";
import type { Camera } from "@/lib/types";
import { apiFetch, formatTimestamp } from "@/lib/utils";

interface JourneyEntity {
  entity_id: string;
  entity_type?: string;
  risk_score?: number;
  cameras_visited?: number;
  zones_entered?: string[];
  last_seen_at?: string;
}

interface Appearance {
  id: string;
  camera_id: string;
  zone_id: string | null;
  timestamp: string | null;
  duration_seconds: number;
  behavior: string | null;
  frame_path: string | null;
}

export default function EntityJourneyPage() {
  const { addToast } = useToast();
  const [entities, setEntities] = useState<JourneyEntity[]>([]);
  const [cameras, setCameras] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string>("");
  const [appearances, setAppearances] = useState<Appearance[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch<Camera[]>("/api/cameras")
      .then((c) => {
        if (Array.isArray(c)) {
          setCameras(Object.fromEntries(c.map((cam) => [cam.id, cam.name])));
        }
      })
      .catch(() => {});
    apiFetch<JourneyEntity[]>("/api/entity-tracking/active")
      .then((e) => {
        if (Array.isArray(e)) setEntities(e);
      })
      .catch(() => {});
  }, []);

  const loadJourney = useCallback(
    async (entityId: string) => {
      setSelected(entityId);
      setLoading(true);
      try {
        const data = await apiFetch<Appearance[]>(
          `/api/entity-tracking/${entityId}/appearances?limit=200`
        );
        // API returns newest-first; show the journey chronologically.
        const ordered = Array.isArray(data) ? [...data].reverse() : [];
        setAppearances(ordered);
      } catch (e) {
        addToast("error", e instanceof Error ? e.message : "Failed to load journey");
        setAppearances([]);
      } finally {
        setLoading(false);
      }
    },
    [addToast]
  );

  const camName = useCallback((id: string) => cameras[id] ?? `Camera ${id.slice(0, 8)}`, [cameras]);

  const camerasInJourney = useMemo(
    () => new Set(appearances.map((a) => a.camera_id)).size,
    [appearances]
  );

  return (
    <div className="p-6 grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
      {/* Entity list */}
      <div className="space-y-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-100">Entity Journey</h1>
          <p className="text-sm text-gray-400">
            Cross-camera path of a tracked entity (privacy-preserving re-ID).
          </p>
        </div>
        <div className="rounded-xl border border-gray-800 bg-gray-900/60">
          <div className="px-3 py-2 border-b border-gray-800 text-xs text-gray-500">
            {entities.length} active entit{entities.length === 1 ? "y" : "ies"}
          </div>
          <ul className="divide-y divide-gray-800 max-h-[70vh] overflow-auto">
            {entities.map((e) => (
              <li key={e.entity_id}>
                <button
                  onClick={() => loadJourney(e.entity_id)}
                  className={`w-full text-left px-3 py-2 hover:bg-gray-800/60 ${
                    selected === e.entity_id ? "bg-gray-800/80" : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-200">
                      {(e.entity_type ?? "entity")} · {e.entity_id.slice(0, 8)}
                    </span>
                    {typeof e.risk_score === "number" && e.risk_score >= 0.4 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-orange-500/40 text-orange-400">
                        risk {e.risk_score.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500">
                    {e.cameras_visited ?? 0} cameras · {e.zones_entered?.length ?? 0} zones
                  </div>
                </button>
              </li>
            ))}
            {entities.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-gray-500">No active entities.</li>
            )}
          </ul>
        </div>
      </div>

      {/* Journey timeline */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-4">
        {!selected ? (
          <div className="text-sm text-gray-500 py-12 text-center">
            Select an entity to view its cross-camera journey.
          </div>
        ) : loading ? (
          <div className="text-sm text-gray-500 py-12 text-center">Loading journey…</div>
        ) : appearances.length === 0 ? (
          <div className="text-sm text-gray-500 py-12 text-center">No appearances recorded.</div>
        ) : (
          <>
            <div className="text-sm text-gray-400 mb-4">
              {appearances.length} appearances across {camerasInJourney} camera(s)
            </div>
            <ol className="relative border-l border-gray-700 ml-3 space-y-4">
              {appearances.map((a) => (
                <li key={a.id} className="ml-4">
                  <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full bg-cyan-500 border border-gray-900" />
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-100">{camName(a.camera_id)}</span>
                    {a.behavior && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-gray-600 text-gray-400">
                        {a.behavior}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500">
                    {a.timestamp ? formatTimestamp(a.timestamp) : "—"}
                    {a.duration_seconds ? ` · ${a.duration_seconds.toFixed(0)}s dwell` : ""}
                    {a.zone_id ? ` · zone ${a.zone_id.slice(0, 8)}` : ""}
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}
