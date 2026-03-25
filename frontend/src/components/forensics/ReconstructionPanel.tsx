"use client";

import { useState, useCallback } from "react";
import {
  AlertTriangle,
  Brain,
  Camera,
  CheckCircle2,
  Clock,
  Download,
  FileText,
  GitBranch,
  Loader2,
  Shield,
  Users,
  XCircle,
  Zap,
} from "lucide-react";
import { cn, apiFetch, formatTimestamp } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface KeyMoment {
  offset: number;
  camera_id: string;
  description: string;
  frame_url: string | null;
  severity: string;
}

interface EntitySummary {
  entity_id: string;
  description: string;
  first_seen: string;
  last_seen: string;
  cameras: string[];
  risk_level: string;
}

interface ReconstructionResult {
  incident_id: string;
  narrative: string;
  key_moments: KeyMoment[];
  entity_summary: EntitySummary[];
  causal_chain: { step: number; description: string; camera_id?: string; timestamp?: string }[];
  risk_assessment: {
    overall_risk: string;
    threat_count: number;
    entity_count: number;
    risk_score?: number;
  };
  recommendations: string[];
  ai_provider: string;
}

interface ReconstructionPanelProps {
  incidentId: string;
  onSeekToOffset?: (offset: number) => void;
  onExportPdf?: (data: ReconstructionResult) => void;
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CARD = "rounded-lg border border-gray-800 bg-gray-900/50";

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-900/30 border-red-800/50 text-red-400",
  high: "bg-orange-900/30 border-orange-800/50 text-orange-400",
  medium: "bg-yellow-900/30 border-yellow-800/50 text-yellow-400",
  low: "bg-blue-900/30 border-blue-800/50 text-blue-400",
  info: "bg-gray-800/30 border-gray-700/50 text-gray-400",
};

const RISK_COLORS: Record<string, string> = {
  critical: "text-red-400",
  high: "text-orange-400",
  medium: "text-yellow-400",
  low: "text-green-400",
  none: "text-gray-400",
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/*  ReconstructionPanel                                                */
/* ------------------------------------------------------------------ */

export default function ReconstructionPanel({
  incidentId,
  onSeekToOffset,
  onExportPdf,
  className,
}: ReconstructionPanelProps) {
  const [result, setResult] = useState<ReconstructionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleReconstruct = useCallback(async () => {
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const data = await apiFetch<ReconstructionResult>(
        `/api/incident-replay/incidents/${incidentId}/reconstruct`,
        { method: "POST" }
      );
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reconstruction failed");
    } finally {
      setLoading(false);
    }
  }, [incidentId]);

  const handleExportPdf = useCallback(async () => {
    if (!result) return;
    if (onExportPdf) {
      onExportPdf(result);
      return;
    }
    try {
      const response = await fetch("/api/forensics/export-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report_type: "evidence", data: result }),
      });
      if (response.ok) {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `sentinel-reconstruction-${incidentId.slice(0, 8)}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch {
      // silently handle
    }
  }, [result, incidentId, onExportPdf]);

  return (
    <div className={cn(CARD, "p-4 space-y-4", className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-purple-400" />
          <h3 className="text-sm font-bold text-white">AI Reconstruction</h3>
          <span className="text-[9px] text-gray-500 bg-gray-800 rounded px-1.5 py-0.5">AI-Powered</span>
        </div>
        {result && (
          <button
            onClick={handleExportPdf}
            className="flex items-center gap-1 rounded-lg border border-gray-700 bg-gray-800 px-2 py-1 text-[10px] text-gray-300 hover:bg-gray-700 transition-colors"
          >
            <Download className="h-3 w-3" />
            Export PDF
          </button>
        )}
      </div>

      {/* Reconstruct button */}
      {!result && !loading && (
        <>
          <p className="text-[10px] text-gray-500">
            AI analyzes all frames, detections, and agent actions to reconstruct a complete incident narrative with key moments, entity tracking, and risk assessment.
          </p>
          <button
            onClick={handleReconstruct}
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-purple-900/40 border border-purple-800/50 px-4 py-2.5 text-xs font-semibold text-purple-400 transition-colors hover:bg-purple-900/60 disabled:opacity-50"
          >
            <Brain className="h-4 w-4" />
            Reconstruct Incident
          </button>
        </>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center gap-3 py-8">
          <Loader2 className="h-6 w-6 animate-spin text-purple-400" />
          <p className="text-xs text-gray-500">AI is reconstructing the incident...</p>
          <p className="text-[10px] text-gray-600">Analyzing frames, detections, and agent actions</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 rounded border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-400">
          <XCircle className="h-3 w-3 shrink-0" /> {error}
        </div>
      )}

      {/* Results */}
      {result && !loading && (
        <div className="space-y-4 max-h-[600px] overflow-y-auto">
          {/* Narrative */}
          {result.narrative && (
            <div className="rounded-md border border-purple-800/30 bg-purple-900/10 p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <FileText className="h-3 w-3 text-purple-400" />
                <p className="text-[9px] font-bold uppercase tracking-wider text-purple-400">AI Narrative</p>
              </div>
              <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap">
                {result.narrative}
              </p>
            </div>
          )}

          {/* Risk Assessment */}
          {result.risk_assessment && (
            <div className="flex items-center gap-4 rounded-md border border-gray-800/50 bg-gray-900/60 p-3">
              <div className="flex items-center gap-1.5">
                <Shield className="h-3.5 w-3.5 text-cyan-400" />
                <span className="text-[10px] text-gray-500">Risk:</span>
                <span className={cn("text-xs font-bold uppercase", RISK_COLORS[result.risk_assessment.overall_risk] || "text-gray-400")}>
                  {result.risk_assessment.overall_risk}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="h-3 w-3 text-amber-400" />
                <span className="text-[10px] text-gray-500">{result.risk_assessment.threat_count} threats</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Users className="h-3 w-3 text-cyan-400" />
                <span className="text-[10px] text-gray-500">{result.risk_assessment.entity_count} entities</span>
              </div>
              {result.ai_provider && (
                <span className="ml-auto text-[8px] text-gray-600">{result.ai_provider}</span>
              )}
            </div>
          )}

          {/* Key Moments */}
          {result.key_moments.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Zap className="h-3 w-3 text-amber-400" />
                <p className="text-[9px] font-bold uppercase tracking-wider text-gray-500">Key Moments ({result.key_moments.length})</p>
              </div>
              <div className="space-y-1.5">
                {result.key_moments.map((moment, i) => (
                  <div
                    key={i}
                    className={cn(
                      "flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer hover:bg-gray-800/50 transition-colors",
                      SEVERITY_COLORS[moment.severity] || SEVERITY_COLORS.info
                    )}
                    onClick={() => onSeekToOffset?.(moment.offset)}
                  >
                    <Clock className="h-3 w-3 shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono font-bold">{formatDuration(moment.offset)}</span>
                        <span className="text-[8px] uppercase font-bold">{moment.severity}</span>
                        {moment.camera_id && (
                          <span className="text-[8px] text-gray-500 flex items-center gap-0.5">
                            <Camera className="h-2 w-2" />{moment.camera_id.slice(0, 8)}
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] mt-0.5 opacity-80">{moment.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Entity Summary */}
          {result.entity_summary.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Users className="h-3 w-3 text-cyan-400" />
                <p className="text-[9px] font-bold uppercase tracking-wider text-gray-500">Tracked Entities ({result.entity_summary.length})</p>
              </div>
              <div className="space-y-1.5">
                {result.entity_summary.map((entity, i) => (
                  <div key={i} className="rounded-md border border-gray-800/50 bg-gray-900/40 px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-gray-300">
                        {entity.entity_id}
                      </span>
                      <span className={cn(
                        "text-[8px] font-bold uppercase rounded px-1.5 py-0.5",
                        RISK_COLORS[entity.risk_level] || "text-gray-500"
                      )}>
                        {entity.risk_level}
                      </span>
                    </div>
                    <p className="text-[10px] text-gray-500 mt-0.5">{entity.description}</p>
                    <div className="flex items-center gap-3 mt-1 text-[9px] text-gray-600">
                      <span>First: {entity.first_seen ? formatTimestamp(entity.first_seen) : "--"}</span>
                      <span>Last: {entity.last_seen ? formatTimestamp(entity.last_seen) : "--"}</span>
                    </div>
                    {entity.cameras.length > 0 && (
                      <div className="flex items-center gap-1 mt-1 flex-wrap">
                        {entity.cameras.map((cam, ci) => (
                          <span key={ci} className="flex items-center gap-0.5">
                            {ci > 0 && <span className="text-gray-700 text-[8px]">&rarr;</span>}
                            <span className="rounded bg-gray-800 px-1 py-0.5 text-[8px] font-mono text-gray-400">
                              {cam.slice(0, 8)}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Causal Chain */}
          {result.causal_chain.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <GitBranch className="h-3 w-3 text-green-400" />
                <p className="text-[9px] font-bold uppercase tracking-wider text-gray-500">Causal Chain</p>
              </div>
              <div className="space-y-1">
                {result.causal_chain.map((step, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <div className="flex flex-col items-center shrink-0 pt-0.5">
                      <div className="h-2 w-2 rounded-full bg-green-500" />
                      {i < result.causal_chain.length - 1 && <div className="w-px h-5 bg-green-800/40 mt-0.5" />}
                    </div>
                    <p className="text-[10px] text-gray-400">{step.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recommendations */}
          {result.recommendations.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                <p className="text-[9px] font-bold uppercase tracking-wider text-gray-500">Recommendations</p>
              </div>
              <ul className="space-y-1">
                {result.recommendations.map((rec, i) => (
                  <li key={i} className="flex items-start gap-2 text-[10px] text-gray-400">
                    <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-emerald-500" />
                    {rec}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
