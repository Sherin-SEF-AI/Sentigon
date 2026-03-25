"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  AlertTriangle,
  Loader2,
  Clock,
  CheckCircle2,
  XCircle,
  Filter,
  ChevronDown,
} from "lucide-react";
import { cn, apiFetch, severityColor } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Violation {
  id: string;
  event_type: string;
  plate_text: string;
  severity: string;
  confidence: number;
  details: string;
  resolved: boolean;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CARD = "rounded-lg border border-gray-800 bg-gray-900/60 backdrop-blur p-4";

const EVENT_TYPES = [
  "all",
  "speeding",
  "wrong_way",
  "unauthorized_access",
  "expired_registration",
  "parking_violation",
  "tailgating",
  "dwell_exceeded",
] as const;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface ViolationTableProps {
  onPlateClick?: (plateNumber: string) => void;
}

export default function ViolationTable({ onPlateClick }: ViolationTableProps) {
  const [violations, setViolations] = useState<Violation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* Filters */
  const [eventTypeFilter, setEventTypeFilter] = useState<string>("all");
  const [resolvedFilter, setResolvedFilter] = useState<"all" | "resolved" | "open">(
    "all"
  );
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);

  const fetchViolations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ violations: Violation[] }>("/api/lpr/analytics/violations");
      setViolations(Array.isArray(data.violations) ? data.violations : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load violations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchViolations();
  }, [fetchViolations]);

  /* Filtered data */
  const filtered = useMemo(() => {
    return violations.filter((v) => {
      if (eventTypeFilter !== "all" && v.event_type !== eventTypeFilter) return false;
      if (resolvedFilter === "resolved" && !v.resolved) return false;
      if (resolvedFilter === "open" && v.resolved) return false;
      return true;
    });
  }, [violations, eventTypeFilter, resolvedFilter]);

  return (
    <div className={CARD}>
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-300">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          Vehicle Violations
          <span className="ml-1 text-xs font-normal text-gray-600">
            ({filtered.length})
          </span>
        </h2>

        {/* Filters */}
        <div className="flex items-center gap-3">
          {/* Event type dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowFilterDropdown(!showFilterDropdown)}
              className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-gray-600"
            >
              <Filter className="h-3.5 w-3.5 text-gray-500" />
              <span className="capitalize">
                {eventTypeFilter === "all"
                  ? "All Types"
                  : eventTypeFilter.replace(/_/g, " ")}
              </span>
              <ChevronDown className="h-3 w-3 text-gray-500" />
            </button>

            {showFilterDropdown && (
              <div className="absolute right-0 top-full z-20 mt-1 w-52 rounded-lg border border-gray-700 bg-gray-900 py-1 shadow-xl">
                {EVENT_TYPES.map((type) => (
                  <button
                    key={type}
                    onClick={() => {
                      setEventTypeFilter(type);
                      setShowFilterDropdown(false);
                    }}
                    className={cn(
                      "w-full px-3 py-1.5 text-left text-xs capitalize transition-colors",
                      eventTypeFilter === type
                        ? "bg-cyan-900/30 text-cyan-400"
                        : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                    )}
                  >
                    {type === "all" ? "All Types" : type.replace(/_/g, " ")}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Resolved toggle */}
          <div className="flex items-center rounded-lg border border-gray-700 bg-gray-800 p-0.5">
            {(["all", "open", "resolved"] as const).map((opt) => (
              <button
                key={opt}
                onClick={() => setResolvedFilter(opt)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors",
                  resolvedFilter === opt
                    ? "bg-gray-700 text-gray-200"
                    : "text-gray-500 hover:text-gray-300"
                )}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          <p className="mt-3 text-sm text-gray-500">Loading violations...</p>
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="flex flex-col items-center justify-center py-16">
          <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={fetchViolations}
            className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16">
          <CheckCircle2 className="mb-2 h-10 w-10 text-gray-700" />
          <p className="text-sm font-medium text-gray-400">No violations found</p>
          <p className="mt-1 text-xs text-gray-600">
            {eventTypeFilter !== "all" || resolvedFilter !== "all"
              ? "Try adjusting your filters"
              : "No violations have been recorded"}
          </p>
        </div>
      )}

      {/* Table */}
      {!loading && !error && filtered.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                <th className="px-4 py-3">Event Type</th>
                <th className="px-4 py-3">Plate</th>
                <th className="px-4 py-3 text-center">Severity</th>
                <th className="px-4 py-3 text-center">Confidence</th>
                <th className="px-4 py-3">Details</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3">Time</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => (
                <tr
                  key={v.id}
                  className="border-b border-gray-800/50 transition-colors hover:bg-gray-800/30"
                >
                  {/* Event Type */}
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 text-xs capitalize text-gray-300">
                      <AlertTriangle className="h-3 w-3 text-gray-600" />
                      {v.event_type.replace(/_/g, " ")}
                    </span>
                  </td>

                  {/* Plate */}
                  <td className="px-4 py-3">
                    <button
                      onClick={() => onPlateClick?.(v.plate_text)}
                      className="inline-flex items-center rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1 font-mono text-xs font-bold tracking-wider text-gray-100 transition-colors hover:border-cyan-700 hover:text-cyan-400"
                    >
                      {v.plate_text}
                    </button>
                  </td>

                  {/* Severity Badge */}
                  <td className="px-4 py-3 text-center">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                        severityColor(v.severity)
                      )}
                    >
                      {v.severity}
                    </span>
                  </td>

                  {/* Confidence */}
                  <td className="px-4 py-3 text-center">
                    <span
                      className={cn(
                        "font-mono text-xs tabular-nums font-medium",
                        v.confidence >= 0.9
                          ? "text-emerald-400"
                          : v.confidence >= 0.7
                            ? "text-yellow-400"
                            : "text-red-400"
                      )}
                    >
                      {Math.round(v.confidence * 100)}%
                    </span>
                  </td>

                  {/* Details */}
                  <td className="max-w-[200px] px-4 py-3">
                    <span className="block truncate text-xs text-gray-400">
                      {v.details}
                    </span>
                  </td>

                  {/* Resolved Status */}
                  <td className="px-4 py-3 text-center">
                    {v.resolved ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-900/30 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-400">
                        <CheckCircle2 className="h-3 w-3" />
                        Resolved
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-red-900/30 px-2.5 py-0.5 text-[10px] font-semibold text-red-400">
                        <XCircle className="h-3 w-3" />
                        Open
                      </span>
                    )}
                  </td>

                  {/* Time */}
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-1 text-xs text-gray-500">
                      <Clock className="h-3 w-3" />
                      {timeAgo(v.created_at)}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-gray-600">
                      {formatTimestamp(v.created_at)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
