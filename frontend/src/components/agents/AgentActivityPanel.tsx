"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  AlertTriangle,
  Brain,
  ChevronDown,
  Clock,
  Filter,
  Loader2,
  MessageSquare,
  Wrench,
  Zap,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";
import { useWebSocket } from "@/hooks/useWebSocket";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AuditEntry {
  id: string;
  agent_name: string;
  action_type: "tool_call" | "decision" | "message_sent" | "error" | string;
  description: string;
  timestamp: string;
  tool_name?: string;
  tool_params?: Record<string, unknown>;
  prompt_summary?: string;
  response_summary?: string;
  latency_ms?: number;
  tier?: "perception" | "reasoning" | "action" | "supervisor";
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MAX_ENTRIES = 100;

const TIER_COLORS: Record<string, string> = {
  perception: "text-cyan-400",
  reasoning: "text-amber-400",
  action: "text-green-400",
  supervisor: "text-purple-400",
};

const ACTION_ICONS: Record<string, typeof Wrench> = {
  tool_call: Wrench,
  decision: Brain,
  message_sent: MessageSquare,
  error: AlertTriangle,
};

const ACTION_COLORS: Record<string, string> = {
  tool_call: "text-blue-400",
  decision: "text-purple-400",
  message_sent: "text-cyan-400",
  error: "text-red-400",
};

/* ------------------------------------------------------------------ */
/*  ActivityEntry                                                      */
/* ------------------------------------------------------------------ */

function ActivityEntry({
  entry,
  expanded,
  onToggle,
}: {
  entry: AuditEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Icon = ACTION_ICONS[entry.action_type] || Zap;
  const iconColor = ACTION_COLORS[entry.action_type] || "text-gray-400";
  const tierColor = TIER_COLORS[entry.tier || ""] || "text-gray-400";

  return (
    <div
      className={cn(
        "rounded-md border border-gray-800/60 transition-all duration-150",
        expanded ? "bg-gray-900/80" : "bg-gray-900/40 hover:bg-gray-900/60"
      )}
    >
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
      >
        {/* Action icon */}
        <Icon className={cn("h-3.5 w-3.5 shrink-0", iconColor)} />

        {/* Agent name */}
        <span
          className={cn(
            "shrink-0 text-[11px] font-bold uppercase tracking-wider",
            tierColor
          )}
        >
          {entry.agent_name}
        </span>

        {/* Description */}
        <span className="flex-1 truncate text-xs text-gray-300">
          {entry.description}
        </span>

        {/* Latency */}
        {entry.latency_ms != null && (
          <span className="shrink-0 font-mono text-[10px] text-gray-600">
            {entry.latency_ms}ms
          </span>
        )}

        {/* Timestamp */}
        <span className="flex shrink-0 items-center gap-1 text-[10px] text-gray-600">
          <Clock className="h-2.5 w-2.5" />
          {formatTimestamp(entry.timestamp)}
        </span>

        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 text-gray-700 transition-transform duration-150",
            expanded && "rotate-180"
          )}
        />
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-gray-800/60 px-3 py-2.5 space-y-2">
          {entry.tool_name && (
            <div className="text-xs">
              <span className="text-gray-500">Tool: </span>
              <span className="font-mono text-blue-300">{entry.tool_name}</span>
            </div>
          )}
          {entry.tool_params && (
            <div className="text-xs">
              <span className="text-gray-500">Params: </span>
              <pre className="mt-1 overflow-x-auto rounded border border-gray-800 bg-gray-950 p-2 text-[11px] text-gray-400">
                {JSON.stringify(entry.tool_params, null, 2)}
              </pre>
            </div>
          )}
          {entry.prompt_summary && (
            <div className="text-xs">
              <span className="text-gray-500">Prompt: </span>
              <span className="text-gray-300">{entry.prompt_summary}</span>
            </div>
          )}
          {entry.response_summary && (
            <div className="text-xs">
              <span className="text-gray-500">Response: </span>
              <span className="text-gray-300">{entry.response_summary}</span>
            </div>
          )}
          {entry.latency_ms != null && (
            <div className="text-xs">
              <span className="text-gray-500">Latency: </span>
              <span className="font-mono text-gray-300">{entry.latency_ms}ms</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AgentActivityPanel                                                 */
/* ------------------------------------------------------------------ */

export default function AgentActivityPanel({
  className,
}: {
  className?: string;
}) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const scrollRef = useRef<HTMLDivElement>(null);

  /* --- Fetch audit log (polling fallback) --- */
  const fetchAudit = useCallback(async () => {
    try {
      const data = await apiFetch<AuditEntry[]>(
        "/api/agents/audit?limit=30"
      );
      setEntries((prev) => {
        const existingIds = new Set(prev.map((e) => e.id));
        const newEntries = data.filter((e) => !existingIds.has(e.id));
        if (newEntries.length === 0) return prev;
        return [...newEntries, ...prev].slice(0, MAX_ENTRIES);
      });
    } catch {
      // Silently handle
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAudit();
    const timer = setInterval(fetchAudit, 5_000);
    return () => clearInterval(timer);
  }, [fetchAudit]);

  /* --- WebSocket for real-time entries --- */
  useWebSocket({
    channels: ["agent_activity"],
    onMessage: (msg) => {
      if (msg.channel === "agent_activity" && msg.data) {
        const entry = msg.data as unknown as AuditEntry;
        if (entry.id && entry.agent_name) {
          setEntries((prev) => {
            if (prev.some((e) => e.id === entry.id)) return prev;
            return [entry, ...prev].slice(0, MAX_ENTRIES);
          });
        }
      }
    },
  });

  /* --- Auto-scroll to top on new entries --- */
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [entries.length]);

  /* --- Unique agent names for filter dropdown --- */
  const agentNames = useMemo(
    () => Array.from(new Set(entries.map((e) => e.agent_name))).sort(),
    [entries]
  );

  const actionTypes = useMemo(
    () => Array.from(new Set(entries.map((e) => e.action_type))).sort(),
    [entries]
  );

  /* --- Filtered entries --- */
  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (agentFilter !== "all" && e.agent_name !== agentFilter) return false;
      if (typeFilter !== "all" && e.action_type !== typeFilter) return false;
      return true;
    });
  }, [entries, agentFilter, typeFilter]);

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
          <Zap className="h-4 w-4 text-cyan-400" />
          <h3 className="text-sm font-semibold text-gray-200">
            Agent Activity
          </h3>
          <span className="rounded-full bg-gray-800 px-2 py-0.5 text-[10px] font-mono text-gray-400">
            {filtered.length}
          </span>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2">
          <Filter className="h-3 w-3 text-gray-600" />
          <div className="relative">
            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="appearance-none rounded border border-gray-700 bg-gray-900 py-1 pl-2 pr-6 text-[11px] text-gray-400 focus:border-cyan-700 focus:outline-none"
            >
              <option value="all">All Agents</option>
              {agentNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 text-gray-600" />
          </div>
          <div className="relative">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="appearance-none rounded border border-gray-700 bg-gray-900 py-1 pl-2 pr-6 text-[11px] text-gray-400 focus:border-cyan-700 focus:outline-none"
            >
              <option value="all">All Types</option>
              {actionTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 text-gray-600" />
          </div>
        </div>
      </div>

      {/* Activity list */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800"
      >
        {loading && (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-cyan-400" />
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10">
            <Zap className="mb-2 h-6 w-6 text-gray-700" />
            <p className="text-xs text-gray-600">No activity recorded</p>
          </div>
        )}

        {filtered.map((entry) => (
          <ActivityEntry
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
