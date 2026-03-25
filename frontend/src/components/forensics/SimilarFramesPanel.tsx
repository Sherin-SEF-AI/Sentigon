"use client";

import { useState, useCallback } from "react";
import {
  Camera,
  ImageIcon,
  Loader2,
  Search,
  XCircle,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SimilarFrame {
  event_id: string;
  frame_url: string | null;
  camera_id: string;
  camera_name?: string;
  timestamp: string;
  similarity_score: number;
  event_type?: string;
  description?: string;
}

interface SimilarFramesResponse {
  query_event_id: string;
  results: SimilarFrame[];
  total_results: number;
  search_method: string;
}

interface SimilarFramesPanelProps {
  eventId: string;
  onSelectFrame?: (eventId: string) => void;
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CARD = "rounded-lg border border-gray-800 bg-gray-900/50";

/* ------------------------------------------------------------------ */
/*  SimilarFramesPanel                                                 */
/* ------------------------------------------------------------------ */

export default function SimilarFramesPanel({
  eventId,
  onSelectFrame,
  className,
}: SimilarFramesPanelProps) {
  const [results, setResults] = useState<SimilarFramesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [maxResults, setMaxResults] = useState(12);
  const [minScore, setMinScore] = useState(0.5);

  const handleSearch = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);
    setError("");
    setResults(null);
    try {
      const data = await apiFetch<SimilarFramesResponse>("/api/forensics/find-similar", {
        method: "POST",
        body: JSON.stringify({
          event_id: eventId,
          max_results: maxResults,
          min_score: minScore,
        }),
      });
      setResults(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }, [eventId, maxResults, minScore]);

  return (
    <div className={cn(CARD, "p-4 space-y-4", className)}>
      <div className="flex items-center gap-2">
        <ImageIcon className="h-4 w-4 text-purple-400" />
        <h3 className="text-sm font-bold text-white">Find Similar Frames</h3>
        <span className="text-[9px] text-gray-500 bg-gray-800 rounded px-1.5 py-0.5">CLIP</span>
      </div>

      <p className="text-[10px] text-gray-500">
        Find visually similar frames across all cameras using CLIP vector embeddings.
      </p>

      {/* Controls */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">
            Max Results
          </label>
          <select
            value={maxResults}
            onChange={(e) => setMaxResults(Number(e.target.value))}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-100 focus:border-purple-700 focus:outline-none"
          >
            <option value={6}>6</option>
            <option value={12}>12</option>
            <option value={24}>24</option>
            <option value={48}>48</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">
            Min Similarity
          </label>
          <select
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-100 focus:border-purple-700 focus:outline-none"
          >
            <option value={0.3}>30%+</option>
            <option value={0.5}>50%+</option>
            <option value={0.7}>70%+</option>
            <option value={0.9}>90%+</option>
          </select>
        </div>
      </div>

      <button
        onClick={handleSearch}
        disabled={!eventId || loading}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-purple-900/40 border border-purple-800/50 px-4 py-2 text-xs font-semibold text-purple-400 transition-colors hover:bg-purple-900/60 disabled:opacity-50"
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
        {loading ? "Searching..." : "Find Similar"}
      </button>

      {error && (
        <div className="flex items-center gap-2 rounded border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-400">
          <XCircle className="h-3 w-3 shrink-0" /> {error}
        </div>
      )}

      {/* Results grid */}
      {results && !loading && (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>{results.total_results} similar frames found</span>
            <span className="text-[9px] text-gray-600">{results.search_method}</span>
          </div>

          <div className="grid grid-cols-2 gap-2 max-h-80 overflow-y-auto">
            {results.results.map((frame, i) => (
              <div
                key={`${frame.event_id}-${i}`}
                className="rounded-lg border border-gray-800 bg-gray-950/50 overflow-hidden cursor-pointer hover:border-purple-700/50 transition-colors group"
                onClick={() => onSelectFrame?.(frame.event_id)}
              >
                {frame.frame_url ? (
                  <div className="relative aspect-video">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={frame.frame_url}
                      alt={`Similar frame ${i + 1}`}
                      className="h-full w-full object-cover"
                    />
                    {/* Similarity badge */}
                    <div className="absolute top-1 right-1 rounded bg-gray-950/80 px-1.5 py-0.5 text-[9px] font-bold font-mono border border-gray-700">
                      <span className={cn(
                        frame.similarity_score >= 0.8 ? "text-green-400" :
                        frame.similarity_score >= 0.6 ? "text-yellow-400" :
                        "text-gray-400"
                      )}>
                        {Math.round(frame.similarity_score * 100)}%
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="flex aspect-video items-center justify-center bg-gray-950">
                    <ImageIcon className="h-5 w-5 text-gray-700" />
                  </div>
                )}
                <div className="px-2 py-1.5">
                  <div className="flex items-center gap-1 text-[9px] text-gray-500">
                    <Camera className="h-2.5 w-2.5" />
                    {(frame.camera_name || frame.camera_id || "").slice(0, 12)}
                  </div>
                  <div className="text-[9px] text-gray-600 font-mono">
                    {frame.timestamp ? formatTimestamp(frame.timestamp) : "--"}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {results.results.length === 0 && (
            <p className="text-xs text-gray-600 text-center py-4">No similar frames found above threshold</p>
          )}
        </div>
      )}
    </div>
  );
}
