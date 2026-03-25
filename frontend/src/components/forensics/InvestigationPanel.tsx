"use client";

import { useState, useCallback, useRef } from "react";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Copy,
  Download,
  FileSearch,
  Loader2,
  MessageSquare,
  Search,
  Shield,
  Target,
  XCircle,
  Zap,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface InvestigationStep {
  step_number: number;
  tool: string;
  status: "complete" | "failed" | "skipped";
  result_summary: string;
  evidence_count: number;
}

interface InvestigationReport {
  narrative: string;
  key_findings: string[];
  entities_identified: string[];
  evidence_items: { type: string; description: string; source: string; confidence?: number }[];
  risk_assessment: string;
  recommendations: string[];
}

interface InvestigationResult {
  query: string;
  investigation_plan: { tool: string; params: Record<string, unknown>; reason: string }[];
  steps_completed: InvestigationStep[];
  report: InvestigationReport;
  total_evidence_items: number;
  ai_provider: string;
}

interface InvestigationPanelProps {
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CARD = "rounded-lg border border-gray-800 bg-gray-900/50";

const SUGGESTED_QUERIES = [
  "Who left the package in the lobby?",
  "Trace the person in the red jacket across all cameras",
  "Build a timeline of east entrance activity in the last 4 hours",
  "Find all vehicles that entered the parking lot after 10pm",
  "Identify coordinated movement patterns between cameras",
  "Who was near the server room during the after-hours alert?",
];

const TOOL_ICONS: Record<string, { icon: typeof Search; color: string }> = {
  clip_search: { icon: Search, color: "text-purple-400" },
  subject_search: { icon: Target, color: "text-cyan-400" },
  movement_trail: { icon: Zap, color: "text-green-400" },
  event_correlation: { icon: Brain, color: "text-amber-400" },
  timeline: { icon: FileSearch, color: "text-blue-400" },
  frame_analyze: { icon: Shield, color: "text-red-400" },
};

/* ------------------------------------------------------------------ */
/*  InvestigationPanel                                                 */
/* ------------------------------------------------------------------ */

export default function InvestigationPanel({ className }: InvestigationPanelProps) {
  const [query, setQuery] = useState("");
  const [hoursBack, setHoursBack] = useState(24);
  const [result, setResult] = useState<InvestigationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [liveSteps, setLiveSteps] = useState<InvestigationStep[]>([]);

  const abortRef = useRef<AbortController | null>(null);

  const handleInvestigate = useCallback(async () => {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError("");
    setResult(null);
    setLiveSteps([]);

    abortRef.current = new AbortController();

    try {
      // Try streaming first
      const response = await fetch("/api/forensics/investigate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, hours_back: hoursBack }),
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.detail || `Investigation failed (${response.status})`);
      }

      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("application/x-ndjson") || contentType.includes("text/event-stream")) {
        // Stream NDJSON
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const event = JSON.parse(line);
                if (event.type === "step") {
                  setLiveSteps((prev) => [...prev, event.data]);
                } else if (event.type === "complete") {
                  setResult(event.data);
                } else if (event.type === "error") {
                  setError(event.message || "Investigation failed");
                }
              } catch {
                // Skip malformed lines
              }
            }
          }
        }
      } else {
        // Standard JSON response
        const data = await response.json();
        setResult(data);
        setLiveSteps(data.steps_completed || []);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      // Fallback to apiFetch
      try {
        const data = await apiFetch<InvestigationResult>("/api/forensics/investigate", {
          method: "POST",
          body: JSON.stringify({ query, hours_back: hoursBack }),
        });
        setResult(data);
        setLiveSteps(data.steps_completed || []);
      } catch (err2) {
        setError(err2 instanceof Error ? err2.message : "Investigation failed");
      }
    } finally {
      setLoading(false);
    }
  }, [query, hoursBack, loading]);

  const handleCopy = useCallback(() => {
    if (!result) return;
    navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [result]);

  const handleExportPdf = useCallback(async () => {
    if (!result) return;
    try {
      const response = await fetch("/api/forensics/export-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report_type: "investigation", data: result }),
      });
      if (response.ok) {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `sentinel-investigation-${Date.now()}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch {
      // silently handle
    }
  }, [result]);

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Header */}
      <div className={cn(CARD, "p-5 space-y-4")}>
        <div className="flex items-center gap-2">
          <FileSearch className="h-5 w-5 text-cyan-400" />
          <h2 className="text-sm font-bold text-white">AI Investigation Agent</h2>
          <span className="text-[9px] text-gray-500 bg-gray-800 rounded px-1.5 py-0.5">Detective Mode</span>
        </div>

        <p className="text-xs text-gray-500">
          Describe what you want to investigate in natural language. SENTINEL AI will autonomously search cameras, track subjects, correlate events, and build a comprehensive investigation report.
        </p>

        {/* Query input */}
        <div className="flex gap-2">
          <div className="flex-1 space-y-2">
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleInvestigate(); } }}
              placeholder="e.g. &quot;Find who left the package in the lobby and trace their path through the building&quot;"
              rows={2}
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700 resize-none"
            />
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-gray-500 uppercase tracking-wider">Time Range:</label>
                <select
                  value={hoursBack}
                  onChange={(e) => setHoursBack(Number(e.target.value))}
                  className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-100"
                >
                  <option value={1}>1 hour</option>
                  <option value={6}>6 hours</option>
                  <option value={24}>24 hours</option>
                  <option value={72}>3 days</option>
                  <option value={168}>7 days</option>
                </select>
              </div>
              <button
                onClick={handleInvestigate}
                disabled={!query.trim() || loading}
                className="flex items-center gap-2 rounded-lg bg-cyan-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                {loading ? "Investigating..." : "Investigate"}
              </button>
            </div>
          </div>
        </div>

        {/* Suggested queries */}
        {!result && !loading && (
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTED_QUERIES.map((sq, i) => (
              <button
                key={i}
                onClick={() => setQuery(sq)}
                className="rounded-full border border-gray-700 bg-gray-800/50 px-3 py-1 text-[10px] text-gray-400 hover:border-cyan-700/50 hover:text-cyan-400 transition-colors"
              >
                {sq}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400">
          <XCircle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {/* Live Steps */}
      {(loading || liveSteps.length > 0) && (
        <div className={cn(CARD, "mt-3 p-4 space-y-3")}>
          <p className="text-[9px] font-bold uppercase tracking-wider text-gray-500">
            Investigation Steps
          </p>
          <div className="space-y-2">
            {liveSteps.map((step, i) => {
              const toolInfo = TOOL_ICONS[step.tool] || { icon: Search, color: "text-gray-400" };
              const Icon = toolInfo.icon;
              return (
                <div key={i} className="flex items-start gap-3 rounded-md border border-gray-800/50 bg-gray-900/40 px-3 py-2">
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Icon className={cn("h-3.5 w-3.5", toolInfo.color)} />
                    {step.status === "complete" && <CheckCircle2 className="h-3 w-3 text-green-400" />}
                    {step.status === "failed" && <XCircle className="h-3 w-3 text-red-400" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-gray-300">{step.tool}</span>
                      <span className={cn(
                        "text-[8px] font-bold uppercase",
                        step.status === "complete" ? "text-green-400" : step.status === "failed" ? "text-red-400" : "text-gray-500"
                      )}>
                        {step.status}
                      </span>
                      {step.evidence_count > 0 && (
                        <span className="text-[8px] text-cyan-400">{step.evidence_count} items</span>
                      )}
                    </div>
                    <p className="text-[10px] text-gray-500 mt-0.5 line-clamp-2">{step.result_summary}</p>
                  </div>
                </div>
              );
            })}
            {loading && (
              <div className="flex items-center gap-2 py-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-400" />
                <span className="text-[10px] text-gray-500">AI is investigating...</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Final Report */}
      {result && !loading && (
        <div className={cn(CARD, "mt-3 p-5 space-y-5 flex-1 overflow-y-auto")}>
          {/* Report header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-cyan-400" />
              <h3 className="text-sm font-bold text-white">Investigation Report</h3>
              {result.ai_provider && (
                <span className="text-[8px] text-gray-600">{result.ai_provider}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[10px] text-gray-300 hover:bg-gray-700 transition-colors"
              >
                {copied ? <CheckCircle2 className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy JSON"}
              </button>
              <button
                onClick={handleExportPdf}
                className="flex items-center gap-1 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[10px] text-gray-300 hover:bg-gray-700 transition-colors"
              >
                <Download className="h-3 w-3" />
                Export PDF
              </button>
            </div>
          </div>

          {/* Narrative */}
          {result.report.narrative && (
            <div className="rounded-md border border-cyan-800/30 bg-cyan-900/10 p-4">
              <p className="text-[9px] font-bold uppercase tracking-wider text-cyan-400 mb-2">Summary</p>
              <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
                {result.report.narrative}
              </p>
            </div>
          )}

          {/* Key Findings */}
          {result.report.key_findings?.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                <p className="text-[9px] font-bold uppercase tracking-wider text-gray-500">
                  Key Findings ({result.report.key_findings.length})
                </p>
              </div>
              <ul className="space-y-1.5">
                {result.report.key_findings.map((finding, i) => (
                  <li key={i} className="flex items-start gap-2 rounded-md border border-amber-800/30 bg-amber-900/10 px-3 py-2 text-xs text-amber-300/80">
                    <span className="text-amber-500 mt-0.5 shrink-0">&#x2022;</span>
                    {finding}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Evidence Items */}
          {result.report.evidence_items?.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Shield className="h-3.5 w-3.5 text-green-400" />
                <p className="text-[9px] font-bold uppercase tracking-wider text-gray-500">
                  Evidence Items ({result.total_evidence_items})
                </p>
              </div>
              <div className="space-y-1.5 max-h-52 overflow-y-auto">
                {result.report.evidence_items.map((item, i) => (
                  <div key={i} className="flex items-start gap-3 rounded-md border border-gray-800/50 bg-gray-900/40 px-3 py-2">
                    <span className="text-[8px] font-bold uppercase text-gray-500 bg-gray-800 rounded px-1.5 py-0.5 shrink-0">
                      {item.type}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] text-gray-300">{item.description}</p>
                      <p className="text-[9px] text-gray-600 mt-0.5">
                        Source: {item.source}
                        {item.confidence != null && ` | Conf: ${Math.round(item.confidence * 100)}%`}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Risk Assessment */}
          {result.report.risk_assessment && (
            <div className="rounded-md border border-gray-800/50 bg-gray-900/40 p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <Shield className="h-3 w-3 text-cyan-400" />
                <p className="text-[9px] font-bold uppercase tracking-wider text-gray-500">Risk Assessment</p>
              </div>
              <p className="text-xs text-gray-400">{result.report.risk_assessment}</p>
            </div>
          )}

          {/* Recommendations */}
          {result.report.recommendations?.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                <p className="text-[9px] font-bold uppercase tracking-wider text-gray-500">Recommendations</p>
              </div>
              <ul className="space-y-1">
                {result.report.recommendations.map((rec, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-gray-400">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                    {rec}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {!result && !loading && !error && (
        <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-800/50 border border-gray-700 mb-4">
            <FileSearch className="h-7 w-7 text-gray-600" />
          </div>
          <p className="text-sm font-medium text-gray-400">Ask SENTINEL AI to investigate</p>
          <p className="mt-1 text-xs text-gray-600">
            Describe what you want to find — the AI agent will autonomously search, correlate, and report.
          </p>
        </div>
      )}
    </div>
  );
}
