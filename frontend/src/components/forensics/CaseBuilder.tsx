"use client";

import { useState } from "react";
import { FolderPlus, X, Loader2, CheckCircle2, ExternalLink } from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import type { Case, Severity } from "@/lib/types";
import Link from "next/link";

interface CaseBuilderProps {
  selectedEvents?: string[];
  onCaseCreated?: (caseId: string) => void;
  className?: string;
}

const PRIORITY_OPTIONS: Severity[] = ["critical", "high", "medium", "low"];

export default function CaseBuilder({
  selectedEvents = [],
  onCaseCreated,
  className,
}: CaseBuilderProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Severity>("medium");
  const [eventIds, setEventIds] = useState<string[]>(selectedEvents);
  const [loading, setLoading] = useState(false);
  const [createdCase, setCreatedCase] = useState<Case | null>(null);
  const [error, setError] = useState("");

  const removeEvent = (id: string) => {
    setEventIds((prev) => prev.filter((e) => e !== id));
  };

  const handleCreate = async () => {
    if (!title.trim()) return;
    setLoading(true);
    setError("");

    try {
      // Create the case
      const newCase = await apiFetch<Case>("/api/cases", {
        method: "POST",
        body: JSON.stringify({
          title,
          description: description || null,
          priority,
        }),
      });

      // Attach evidence for each selected event
      for (const eventId of eventIds) {
        await apiFetch(`/api/cases/${newCase.id}/evidence`, {
          method: "POST",
          body: JSON.stringify({
            evidence_type: "event",
            reference_id: eventId,
            title: `Event ${eventId.slice(0, 8)}`,
          }),
        });
      }

      setCreatedCase(newCase);
      onCaseCreated?.(newCase.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create case");
    } finally {
      setLoading(false);
    }
  };

  // Success state
  if (createdCase) {
    return (
      <div className={cn("rounded-lg border border-emerald-800/50 bg-emerald-900/10 p-5", className)}>
        <div className="flex items-center gap-2 mb-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-400" />
          <h3 className="text-sm font-semibold text-emerald-400">Case Created</h3>
        </div>
        <p className="text-sm text-gray-300 mb-1">{createdCase.title}</p>
        <p className="text-xs text-gray-500 font-mono mb-4">
          ID: {createdCase.id.slice(0, 12)}
        </p>
        <div className="flex gap-2">
          <Link
            href="/cases"
            className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
          >
            <ExternalLink className="h-3 w-3" />
            View in Cases
          </Link>
          <button
            onClick={() => {
              setCreatedCase(null);
              setTitle("");
              setDescription("");
              setEventIds([]);
            }}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800"
          >
            Create Another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("rounded-lg border border-gray-800 bg-gray-900/60 p-5", className)}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <FolderPlus className="h-5 w-5 text-violet-400" />
        <h3 className="text-sm font-semibold text-gray-200">
          Create Case from Evidence
        </h3>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {/* Title */}
        <input
          type="text"
          placeholder="Case title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-600"
        />

        {/* Description */}
        <textarea
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-violet-600 focus:outline-none resize-none"
        />

        {/* Priority */}
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as Severity)}
          className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-violet-600 focus:outline-none"
        >
          {PRIORITY_OPTIONS.map((p) => (
            <option key={p} value={p}>
              {p.charAt(0).toUpperCase() + p.slice(1)} Priority
            </option>
          ))}
        </select>

        {/* Selected events */}
        {eventIds.length > 0 && (
          <div>
            <span className="mb-2 block text-[10px] font-medium uppercase tracking-wider text-gray-500">
              Linked Events ({eventIds.length})
            </span>
            <div className="flex flex-wrap gap-1.5">
              {eventIds.map((id) => (
                <span
                  key={id}
                  className="flex items-center gap-1 rounded bg-gray-800 px-2 py-1 text-[10px] text-gray-400 font-mono"
                >
                  {id.slice(0, 8)}
                  <button
                    onClick={() => removeEvent(id)}
                    className="ml-0.5 text-gray-600 hover:text-red-400"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Create button */}
        <button
          onClick={handleCreate}
          disabled={loading || !title.trim()}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating...
            </>
          ) : (
            <>
              <FolderPlus className="h-4 w-4" />
              Create Case
            </>
          )}
        </button>
      </div>
    </div>
  );
}
