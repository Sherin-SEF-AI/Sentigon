"use client";

import { useState, useEffect, useRef } from "react";
import { Search, Loader2, Clock } from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";
import type { SearchResult } from "@/lib/types";

interface SemanticSearchBarProps {
  onSearch: (results: SearchResult[]) => void;
  className?: string;
}

export default function SemanticSearchBar({
  onSearch,
  className,
}: SemanticSearchBarProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Debounced search
  useEffect(() => {
    if (!query.trim() || query.length < 3) {
      setResults([]);
      setShowDropdown(false);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const resp = await apiFetch<{ results: SearchResult[] }>("/api/search/semantic", {
          method: "POST",
          body: JSON.stringify({ query, limit: 10 }),
        });
        setResults(Array.isArray(resp) ? resp : resp.results ?? []);
        setShowDropdown(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const handleSelect = (result: SearchResult) => {
    onSearch([result]);
    setShowDropdown(false);
  };

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search security events..."
          className="w-full rounded-lg border border-gray-700 bg-gray-900 pl-10 pr-10 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600"
          onFocus={() => results.length > 0 && setShowDropdown(true)}
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-cyan-400" />
        )}
      </div>

      {/* Dropdown results */}
      {showDropdown && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 shadow-xl max-h-80 overflow-y-auto">
          {results.length === 0 ? (
            <div className="p-4 text-center text-xs text-gray-500">
              No results found
            </div>
          ) : (
            results.map((r) => (
              <button
                key={r.event_id}
                onClick={() => handleSelect(r)}
                className="flex w-full items-start gap-3 border-b border-gray-800 p-3 text-left transition-colors hover:bg-gray-800/60 last:border-b-0"
              >
                {/* Event type badge */}
                <span className="mt-0.5 shrink-0 rounded bg-cyan-900/30 px-1.5 py-0.5 text-[10px] font-bold uppercase text-cyan-400">
                  {r.event_type || "event"}
                </span>

                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm text-gray-200">
                    {r.description || "No description"}
                  </p>
                  <div className="mt-1 flex items-center gap-3 text-[10px] text-gray-500">
                    {r.timestamp && (
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatTimestamp(r.timestamp)}
                      </span>
                    )}
                    {r.camera_id && <span>Camera: {r.camera_id.slice(0, 8)}</span>}
                  </div>
                </div>

                {/* Score */}
                <div className="shrink-0 text-right">
                  <span className="font-mono text-xs text-cyan-400">
                    {Math.round(r.score * 100)}%
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
