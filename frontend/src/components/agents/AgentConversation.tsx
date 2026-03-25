"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Brain,
  ChevronDown,
  Clock,
  Gauge,
  Loader2,
  Search,
  Wrench,
  Zap,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface DecisionEntry {
  id: string;
  agent_name: string;
  action_type: string;
  timestamp: string;
  prompt_summary?: string;
  response_summary?: string;
  tools_called?: { name: string; params?: Record<string, unknown> }[];
  decision?: string;
  confidence?: number;
  tokens_used?: number;
  latency_ms?: number;
  full_prompt?: string;
  full_response?: string;
}

/* ------------------------------------------------------------------ */
/*  ConversationEntry                                                  */
/* ------------------------------------------------------------------ */

function ConversationEntry({
  entry,
  expanded,
  onToggle,
}: {
  entry: DecisionEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-gray-800 transition-all duration-200",
        expanded ? "bg-gray-900/80 ring-1 ring-purple-900/30" : "bg-gray-900/50 hover:bg-gray-900/70"
      )}
    >
      {/* Summary row */}
      <button
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-4 py-3 text-left"
      >
        <Brain className="mt-0.5 h-4 w-4 shrink-0 text-purple-400" />

        <div className="flex-1 min-w-0 space-y-1">
          {/* Decision summary */}
          {entry.decision && (
            <p className="text-sm font-medium text-gray-200 line-clamp-2">
              {entry.decision}
            </p>
          )}
          {!entry.decision && entry.response_summary && (
            <p className="text-sm text-gray-300 line-clamp-2">
              {entry.response_summary}
            </p>
          )}

          {/* Meta row */}
          <div className="flex flex-wrap items-center gap-3 text-[10px] text-gray-500">
            <span className="flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              {formatTimestamp(entry.timestamp)}
            </span>
            {entry.confidence != null && (
              <span className="flex items-center gap-1">
                <Gauge className="h-2.5 w-2.5" />
                <span className="font-mono text-cyan-400">
                  {Math.round(entry.confidence * 100)}%
                </span>
              </span>
            )}
            {entry.tokens_used != null && (
              <span className="font-mono">
                {entry.tokens_used.toLocaleString()} tokens
              </span>
            )}
            {entry.latency_ms != null && (
              <span className="font-mono">{entry.latency_ms}ms</span>
            )}
            {entry.tools_called && entry.tools_called.length > 0 && (
              <span className="flex items-center gap-1 text-blue-400">
                <Wrench className="h-2.5 w-2.5" />
                {entry.tools_called.length} tool
                {entry.tools_called.length > 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>

        <ChevronDown
          className={cn(
            "mt-1 h-4 w-4 shrink-0 text-gray-600 transition-transform duration-200",
            expanded && "rotate-180"
          )}
        />
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-gray-800 px-4 py-3 space-y-3">
          {/* Prompt */}
          {(entry.full_prompt || entry.prompt_summary) && (
            <div>
              <h4 className="mb-1 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                Prompt
              </h4>
              <div className="rounded-md border border-gray-800 bg-gray-950 p-3 text-xs leading-relaxed text-gray-400 max-h-48 overflow-y-auto">
                {entry.full_prompt || entry.prompt_summary}
              </div>
            </div>
          )}

          {/* Response */}
          {(entry.full_response || entry.response_summary) && (
            <div>
              <h4 className="mb-1 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                Response
              </h4>
              <div className="rounded-md border border-purple-900/40 bg-purple-950/10 p-3 text-xs leading-relaxed text-purple-300 max-h-48 overflow-y-auto">
                {entry.full_response || entry.response_summary}
              </div>
            </div>
          )}

          {/* Tools called */}
          {entry.tools_called && entry.tools_called.length > 0 && (
            <div>
              <h4 className="mb-1 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                Tools Called
              </h4>
              <div className="space-y-1">
                {entry.tools_called.map((tool, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded border border-gray-800 bg-gray-950/80 px-2.5 py-1.5"
                  >
                    <Wrench className="h-3 w-3 shrink-0 text-blue-400" />
                    <span className="font-mono text-xs text-blue-300">
                      {tool.name}
                    </span>
                    {tool.params && (
                      <span className="ml-auto truncate text-[10px] text-gray-600 max-w-[200px]">
                        {JSON.stringify(tool.params)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Decision */}
          {entry.decision && (
            <div>
              <h4 className="mb-1 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                Decision
              </h4>
              <p className="rounded-md border border-green-900/40 bg-green-950/10 p-3 text-xs text-green-300">
                {entry.decision}
              </p>
            </div>
          )}

          {/* Stats */}
          <div className="flex flex-wrap gap-4 text-[11px] text-gray-500">
            {entry.confidence != null && (
              <span>
                Confidence:{" "}
                <span className="font-mono text-cyan-400">
                  {Math.round(entry.confidence * 100)}%
                </span>
              </span>
            )}
            {entry.tokens_used != null && (
              <span>
                Tokens:{" "}
                <span className="font-mono text-gray-300">
                  {entry.tokens_used.toLocaleString()}
                </span>
              </span>
            )}
            {entry.latency_ms != null && (
              <span>
                Latency:{" "}
                <span className="font-mono text-gray-300">
                  {entry.latency_ms}ms
                </span>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AgentConversation                                                  */
/* ------------------------------------------------------------------ */

export default function AgentConversation({
  agentName,
  className,
}: {
  agentName: string;
  className?: string;
}) {
  const [entries, setEntries] = useState<DecisionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  /* --- Fetch decisions --- */
  const fetchDecisions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<DecisionEntry[]>(
        `/api/agents/${agentName}/audit?limit=20&action_type=decision`
      );
      setEntries(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch conversations"
      );
    } finally {
      setLoading(false);
    }
  }, [agentName]);

  useEffect(() => {
    fetchDecisions();
  }, [fetchDecisions]);

  /* --- Filtered by search --- */
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return entries;
    const q = searchQuery.toLowerCase();
    return entries.filter(
      (e) =>
        (e.decision?.toLowerCase().includes(q)) ||
        (e.prompt_summary?.toLowerCase().includes(q)) ||
        (e.response_summary?.toLowerCase().includes(q)) ||
        (e.full_prompt?.toLowerCase().includes(q)) ||
        (e.full_response?.toLowerCase().includes(q))
    );
  }, [entries, searchQuery]);

  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border border-gray-800 bg-gray-950",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-purple-400" />
          <h3 className="text-sm font-semibold text-gray-200">
            Reasoning Chain
          </h3>
          <span className="rounded-full bg-purple-900/30 border border-purple-800/40 px-2 py-0.5 text-[10px] font-semibold text-purple-400">
            {agentName}
          </span>
        </div>
      </div>

      {/* Search bar */}
      <div className="border-b border-gray-800 px-4 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-600" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search decisions..."
            className="w-full rounded-md border border-gray-700 bg-gray-900 py-1.5 pl-8 pr-3 text-xs text-gray-300 placeholder-gray-600 focus:border-purple-700 focus:outline-none focus:ring-1 focus:ring-purple-700"
          />
        </div>
      </div>

      {/* Entries */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-purple-400" />
            <span className="ml-2 text-sm text-gray-500">
              Loading reasoning chain...
            </span>
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center justify-center py-12">
            <Zap className="mb-2 h-6 w-6 text-red-500" />
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={fetchDecisions}
              className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12">
            <Brain className="mb-2 h-6 w-6 text-gray-700" />
            <p className="text-xs text-gray-600">
              {searchQuery ? "No matching decisions" : "No decisions recorded"}
            </p>
          </div>
        )}

        {filtered.map((entry) => (
          <ConversationEntry
            key={entry.id}
            entry={entry}
            expanded={expandedId === entry.id}
            onToggle={() =>
              setExpandedId(expandedId === entry.id ? null : entry.id)
            }
          />
        ))}
      </div>
    </div>
  );
}
