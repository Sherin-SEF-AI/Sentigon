"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/common/Toaster";
import TripwireCanvas, { type Point } from "@/components/tripwires/TripwireCanvas";
import type { Camera } from "@/lib/types";
import { apiFetch } from "@/lib/utils";

interface Tripwire {
  id: string;
  camera_id: string;
  name: string;
  point_a: number[];
  point_b: number[];
  direction: string;
  classes: string[];
  severity: string;
  is_active: boolean;
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-red-500/10 text-red-400 border-red-500/40",
  high: "bg-orange-500/10 text-orange-400 border-orange-500/40",
  medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/40",
  low: "bg-blue-500/10 text-blue-400 border-blue-500/40",
  info: "bg-gray-500/10 text-gray-400 border-gray-500/40",
};

const DIRECTIONS = ["both", "left_to_right", "right_to_left"] as const;

export default function TripwiresPage() {
  const { addToast } = useToast();
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [cameraId, setCameraId] = useState<string>("");
  const [tripwires, setTripwires] = useState<Tripwire[]>([]);
  const [loading, setLoading] = useState(false);

  // create form
  const [name, setName] = useState("New tripwire");
  const [pointA, setPointA] = useState<Point>([0, 240]);
  const [pointB, setPointB] = useState<Point>([640, 240]);
  const [direction, setDirection] = useState<string>("both");
  const [severity, setSeverity] = useState<string>("medium");
  const [classes, setClasses] = useState("person");

  useEffect(() => {
    apiFetch<Camera[]>("/api/cameras")
      .then((c) => {
        if (Array.isArray(c)) {
          setCameras(c);
          setCameraId((prev) => prev || (c[0]?.id ?? ""));
        }
      })
      .catch(() => {});
  }, []);

  const loadTripwires = useCallback(async () => {
    if (!cameraId) {
      setTripwires([]);
      return;
    }
    setLoading(true);
    try {
      const data = await apiFetch<Tripwire[]>(`/api/tripwires?camera_id=${cameraId}`);
      setTripwires(Array.isArray(data) ? data : []);
    } catch (e) {
      addToast("error", e instanceof Error ? e.message : "Failed to load tripwires");
    } finally {
      setLoading(false);
    }
  }, [cameraId, addToast]);

  useEffect(() => {
    loadTripwires();
  }, [loadTripwires]);

  const createTripwire = async () => {
    if (!cameraId) {
      addToast("info", "Select a camera first.");
      return;
    }
    if (pointA.length !== 2 || pointB.length !== 2) {
      addToast("info", "Draw the tripwire line (place points A and B).");
      return;
    }
    try {
      await apiFetch("/api/tripwires", {
        method: "POST",
        body: JSON.stringify({
          camera_id: cameraId,
          name,
          point_a: pointA,
          point_b: pointB,
          direction,
          severity,
          classes: classes.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      addToast("success", "Tripwire created.");
      void loadTripwires();
    } catch (e) {
      addToast("error", e instanceof Error ? e.message : "Create failed");
    }
  };

  const removeTripwire = async (id: string) => {
    try {
      await apiFetch(`/api/tripwires/${id}`, { method: "DELETE" });
      addToast("success", "Tripwire deleted.");
      setTripwires((t) => t.filter((w) => w.id !== id));
    } catch (e) {
      addToast("error", e instanceof Error ? e.message : "Delete failed");
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-100">Tripwires</h1>
        <p className="text-sm text-gray-400">
          Directional line-crossing detection. A watched object crossing a line raises an alert.
        </p>
      </div>

      {/* Camera selector */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-gray-400">Camera</label>
        <select
          value={cameraId}
          onChange={(e) => setCameraId(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-gray-200"
        >
          {cameras.length === 0 && <option value="">No cameras</option>}
          {cameras.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* Create form */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-4 space-y-4">
        <div className="text-sm font-medium text-gray-200">New tripwire</div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Canvas line editor */}
          <div>
            <span className="mb-1 block text-xs text-gray-500">
              Draw line on camera view
            </span>
            <TripwireCanvas
              cameraId={cameraId || undefined}
              pointA={pointA}
              pointB={pointB}
              direction={direction}
              onChange={(a, b) => {
                setPointA(a);
                setPointB(b);
              }}
            />
          </div>

          {/* Metadata fields */}
          <div className="grid grid-cols-2 gap-3 content-start">
            <Field label="Name">
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Direction">
              <select className={inputCls} value={direction} onChange={(e) => setDirection(e.target.value)}>
                {DIRECTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Severity">
              <select className={inputCls} value={severity} onChange={(e) => setSeverity(e.target.value)}>
                {Object.keys(SEVERITY_STYLES).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Classes (comma-separated)">
              <input className={inputCls} value={classes} onChange={(e) => setClasses(e.target.value)} />
            </Field>
            <div className="col-span-2 pt-1">
              <Button onClick={createTripwire}>Create tripwire</Button>
            </div>
          </div>
        </div>
      </div>

      {/* List */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/60">
        <div className="px-4 py-2 border-b border-gray-800 text-sm text-gray-400">
          {loading ? "Loading…" : `${tripwires.length} tripwire(s)`}
        </div>
        <ul className="divide-y divide-gray-800">
          {tripwires.map((w) => (
            <li key={w.id} className="flex items-center justify-between px-4 py-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-100">{w.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${SEVERITY_STYLES[w.severity] ?? SEVERITY_STYLES.info}`}>
                    {w.severity}
                  </span>
                </div>
                <div className="text-xs text-gray-500">
                  ({w.point_a.join(", ")}) → ({w.point_b.join(", ")}) · {w.direction} · {w.classes.join(", ")}
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => removeTripwire(w.id)}>
                Delete
              </Button>
            </li>
          ))}
          {!loading && tripwires.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-gray-500">No tripwires for this camera.</li>
          )}
        </ul>
      </div>
    </div>
  );
}

const inputCls =
  "w-full bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-sm text-gray-200";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-gray-500">{label}</span>
      {children}
    </label>
  );
}
