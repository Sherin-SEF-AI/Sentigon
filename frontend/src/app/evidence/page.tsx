"use client";

import { useState, useEffect, useCallback } from "react";
import {
  FileCheck,
  Loader2,
  Package,
  ShieldCheck,
  Hash,
  FileText,
  Clock,
  Download,
  X,
  CheckCircle2,
  AlertTriangle,
  Timer,
  FolderOpen,
  Eye,
  Copy,
  ExternalLink,
  Plus,
  StickyNote,
  Upload,
  CheckSquare,
  Square,
  Shield,
  XCircle,
} from "lucide-react";
import { cn, apiFetch, severityColor, formatTimestamp } from "@/lib/utils";
import FileUpload from "@/components/common/FileUpload";
import { useToast } from "@/components/common/Toaster";
import TimelineView from "@/components/common/TimelineView";
import type { TimelineEvent } from "@/components/common/TimelineView";
import { exportCSV } from "@/lib/export";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Case {
  id: string;
  title: string;
  status: string;
  severity: string;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
}

interface EvidenceManifestItem {
  evidence_type: string;
  file_path: string;
  sha256_hash: string;
  collected_at: string;
}

interface ExportManifest {
  case_id: string;
  case_title: string;
  export_timestamp: string;
  evidence_count: number;
  items: EvidenceManifestItem[];
}

interface ExportResponse {
  status: string;
  case_id: string;
  manifest: ExportManifest;
  evidence_count: number;
}

interface ChainOfCustodyEntry {
  id: string;
  evidence_type: string;
  file_path: string;
  sha256_hash: string;
  created_at: string;
  verified_at: string | null;
  verification_status: string;
}

interface EvidenceItem {
  id: string;
  case_id: string;
  evidence_type: string;
  reference_id: string | null;
  title: string;
  content: string | null;
  file_url: string | null;
  sha256_hash?: string | null;
  added_at: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const STATUS_COLORS: Record<string, string> = {
  open: "bg-blue-900/40 text-blue-400 border-blue-800",
  investigating: "bg-amber-900/40 text-amber-400 border-amber-800",
  closed: "bg-emerald-900/40 text-emerald-400 border-emerald-800",
  archived: "bg-gray-800 text-gray-500 border-gray-700",
  new: "bg-red-900/40 text-red-400 border-red-800",
  active: "bg-cyan-900/40 text-cyan-400 border-cyan-800",
};

const VERIFICATION_COLORS: Record<string, string> = {
  verified: "bg-emerald-900/40 text-emerald-400 border-emerald-800",
  pending: "bg-yellow-900/40 text-yellow-400 border-yellow-800",
  failed: "bg-red-900/40 text-red-400 border-red-800",
};

const VERIFICATION_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  verified: CheckCircle2,
  pending: Timer,
  failed: AlertTriangle,
};

/* ------------------------------------------------------------------ */
/*  Helper components                                                  */
/* ------------------------------------------------------------------ */

function StatCard({
  label,
  value,
  icon: Icon,
  accent = "text-cyan-400",
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className={cn("h-4 w-4", accent)} />
        <span className="text-xs font-medium uppercase tracking-wider text-gray-500">
          {label}
        </span>
      </div>
      <p className={cn("text-2xl font-bold tabular-nums", accent)}>{value}</p>
    </div>
  );
}

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded bg-gray-800/60", className)}
    />
  );
}

function TruncatedHash({ hash, className }: { hash: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const truncated = hash.length > 16 ? `${hash.slice(0, 8)}...${hash.slice(-8)}` : hash;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  };

  return (
    <span className={cn("group relative inline-flex items-center gap-1.5", className)}>
      <code className="font-mono text-[11px] text-gray-400">{truncated}</code>
      <button
        onClick={handleCopy}
        className="opacity-0 group-hover:opacity-100 transition-opacity"
        title="Copy full hash"
      >
        {copied ? (
          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
        ) : (
          <Copy className="h-3 w-3 text-gray-600 hover:text-gray-400" />
        )}
      </button>
      {/* Tooltip with full hash on hover */}
      <span className="pointer-events-none absolute bottom-full left-0 z-50 mb-2 hidden rounded-md border border-gray-700 bg-gray-900 px-3 py-1.5 text-[10px] font-mono text-gray-300 shadow-xl group-hover:block whitespace-nowrap">
        {hash}
      </span>
    </span>
  );
}

function ClickToCopy({
  value,
  children,
  className,
}: {
  value: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  };

  return (
    <span
      className={cn("relative inline-flex items-center gap-1", className)}
      onClick={handleCopy}
      role="button"
      tabIndex={0}
      title="Click to copy"
    >
      {children}
      {copied && (
        <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-emerald-400 animate-in fade-in">
          <CheckCircle2 className="h-2.5 w-2.5" />
          Copied!
        </span>
      )}
    </span>
  );
}

function formatDate(iso: string | undefined | null): string {
  if (!iso) return "N/A";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/* ------------------------------------------------------------------ */
/*  Export Modal                                                        */
/* ------------------------------------------------------------------ */

function ExportModal({
  manifest,
  onClose,
}: {
  manifest: ExportManifest;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="relative mx-4 w-full max-w-2xl rounded-2xl border border-gray-700 bg-gray-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-900/30 border border-emerald-800/50">
              <Package className="h-5 w-5 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-100">
                Export Complete
              </h2>
              <p className="text-xs text-gray-500">
                Evidence package generated successfully
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="max-h-[60vh] overflow-y-auto px-6 py-5 space-y-5">
          {/* Manifest metadata */}
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-3">
              <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
                Case
              </span>
              <p className="mt-1 text-sm font-medium text-gray-200 truncate">
                {manifest.case_title}
              </p>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-3">
              <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
                Case ID
              </span>
              <ClickToCopy value={manifest.case_id} className="mt-1">
                <span className="font-mono text-sm text-gray-400 hover:text-gray-300 cursor-pointer transition-colors">
                  {(manifest.case_id ?? "").slice(0, 12)}...
                </span>
              </ClickToCopy>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-3">
              <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
                Export Timestamp
              </span>
              <p className="mt-1 text-sm text-gray-300">
                {formatDate(manifest.export_timestamp)}
              </p>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-3">
              <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
                Evidence Items
              </span>
              <p className="mt-1 text-lg font-bold text-cyan-400">
                {manifest.evidence_count}
              </p>
            </div>
          </div>

          {/* Evidence items list */}
          {manifest.items.length > 0 && (
            <div>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                Package Contents
              </h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {manifest.items.map((item, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-gray-800 bg-gray-950/50 p-3 space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <FileText className="h-3.5 w-3.5 text-gray-500" />
                      <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-bold uppercase text-gray-400">
                        {item.evidence_type}
                      </span>
                      <span className="flex-1 truncate text-xs text-gray-300 font-mono">
                        {item.file_path}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <Hash className="h-3 w-3 text-gray-600" />
                      <code className="text-[10px] font-mono text-gray-500 truncate">
                        SHA-256: {item.sha256_hash}
                      </code>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-gray-600">
                      <Clock className="h-3 w-3" />
                      Collected: {formatDate(item.collected_at)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-gray-800 px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:bg-gray-800 transition-colors"
          >
            Close
          </button>
          <button
            onClick={onClose}
            className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-500 transition-colors"
          >
            <Download className="h-4 w-4" />
            Download Package
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Upload Evidence Modal                                              */
/* ------------------------------------------------------------------ */

interface UploadedFile {
  name: string;
  size: number;
  type: string;
  url?: string;
  id?: string;
}

function UploadEvidenceModal({
  cases,
  onClose,
  onUploadSuccess,
}: {
  cases: Case[];
  onClose: () => void;
  onUploadSuccess: (file: UploadedFile, caseId: string | null) => void;
}) {
  const [selectedCaseId, setSelectedCaseId] = useState<string>("");
  const [uploadError, setUploadError] = useState<string>("");

  const extraFields = selectedCaseId ? { case_id: selectedCaseId } : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="relative mx-4 w-full max-w-lg rounded-2xl border border-gray-700 bg-gray-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
              <Upload className="h-5 w-5 text-cyan-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-100">
                Upload Evidence
              </h2>
              <p className="text-xs text-gray-500">
                Images, video, PDFs, documents &amp; text files up to 50 MB
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-5">
          {/* Optional case selector */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium uppercase tracking-wider text-gray-500">
              Attach to Case <span className="normal-case text-gray-600">(optional)</span>
            </label>
            <select
              value={selectedCaseId}
              onChange={(e) => setSelectedCaseId(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-800"
            >
              <option value="">— No case —</option>
              {cases.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </div>

          {/* File upload zone */}
          <FileUpload
            endpoint="/api/evidence/upload"
            accept="image/*,video/*,.pdf,.doc,.docx,.txt"
            extraFields={extraFields}
            label="Drop evidence file here or click to browse"
            onUpload={(file) => {
              setUploadError("");
              onUploadSuccess(file, selectedCaseId || null);
            }}
            onError={(msg) => setUploadError(msg)}
          />

          {/* Error display */}
          {uploadError && (
            <p className="flex items-center gap-1.5 rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {uploadError}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end border-t border-gray-800 px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:bg-gray-800 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Evidence Item Integrity Badge                                      */
/* ------------------------------------------------------------------ */

type VerifyStatus = "idle" | "loading" | "verified" | "unverified" | "unavailable";

function IntegrityBadge({
  evidenceId,
  hasHash,
}: {
  evidenceId: string;
  hasHash: boolean;
}) {
  const [status, setStatus] = useState<VerifyStatus>("idle");
  const { addToast } = useToast();

  const handleVerify = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!hasHash) {
      setStatus("unavailable");
      return;
    }
    setStatus("loading");
    try {
      await apiFetch(`/api/evidence/${evidenceId}/verify`, { method: "POST" });
      setStatus("verified");
      addToast("success", "Evidence integrity verified successfully.");
    } catch (err: any) {
      if (err?.status === 404 || (err?.message || "").includes("404")) {
        setStatus("unavailable");
        addToast("info", "Verification endpoint not available for this item.");
      } else {
        setStatus("unverified");
        addToast("error", "Integrity verification failed.");
      }
    }
  };

  if (status === "idle") {
    if (!hasHash) return null;
    return (
      <button
        onClick={handleVerify}
        className="flex items-center gap-1 rounded border border-gray-700 px-2 py-0.5 text-[10px] font-medium text-gray-400 hover:border-cyan-700 hover:text-cyan-400 transition-colors"
        title="Verify file integrity via SHA-256"
      >
        <Shield className="h-3 w-3" />
        Verify Integrity
      </button>
    );
  }

  if (status === "loading") {
    return (
      <span className="flex items-center gap-1 rounded border border-gray-700 px-2 py-0.5 text-[10px] text-gray-500">
        <Loader2 className="h-3 w-3 animate-spin" />
        Verifying...
      </span>
    );
  }

  if (status === "verified") {
    return (
      <span className="flex items-center gap-1 rounded border border-emerald-800 bg-emerald-900/30 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        Verified
      </span>
    );
  }

  if (status === "unverified") {
    return (
      <span className="flex items-center gap-1 rounded border border-gray-700 bg-gray-800/40 px-2 py-0.5 text-[10px] font-medium text-gray-400">
        <XCircle className="h-3 w-3" />
        Unverified
      </span>
    );
  }

  // unavailable
  return (
    <span className="flex items-center gap-1 rounded border border-gray-800 px-2 py-0.5 text-[10px] text-gray-600">
      <Shield className="h-3 w-3" />
      Verification N/A
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function EvidencePage() {
  /* --- toast --- */
  const { addToast } = useToast();

  /* --- data state --- */
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /* --- chain of custody --- */
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [custodyEntries, setCustodyEntries] = useState<ChainOfCustodyEntry[]>([]);
  const [custodyLoading, setCustodyLoading] = useState(false);

  /* --- per-evidence chain-of-custody timeline --- */
  const [evidenceItems, setEvidenceItems] = useState<EvidenceItem[]>([]);
  const [evidenceItemsLoading, setEvidenceItemsLoading] = useState(false);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [custodyTimeline, setCustodyTimeline] = useState<TimelineEvent[]>([]);
  const [custodyTimelineLoading, setCustodyTimelineLoading] = useState(false);
  const [custodyTimelineError, setCustodyTimelineError] = useState<string | null>(null);

  /* --- bulk selection --- */
  const [selectedEvidenceIds, setSelectedEvidenceIds] = useState<Set<string>>(new Set());
  const [bulkVerifying, setBulkVerifying] = useState(false);

  /* --- exports --- */
  const [exportingCaseId, setExportingCaseId] = useState<string | null>(null);
  const [exportManifest, setExportManifest] = useState<ExportManifest | null>(null);
  const [showExportModal, setShowExportModal] = useState(false);

  /* --- upload modal --- */
  const [showUploadModal, setShowUploadModal] = useState(false);

  /* --- stats --- */
  const [stats, setStats] = useState({
    totalCases: 0,
    evidenceItems: 0,
    exportsGenerated: 0,
    verifiedHashes: 0,
  });

  /* --- evidence counts per case --- */
  const [evidenceCounts, setEvidenceCounts] = useState<Record<string, number>>({});

  /* --- add note form --- */
  const [noteTitle, setNoteTitle] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [noteSubmitting, setNoteSubmitting] = useState(false);
  const [noteSuccess, setNoteSuccess] = useState(false);
  const [noteError, setNoteError] = useState("");

  /* ---------------------------------------------------------------- */
  /*  Data fetching                                                    */
  /* ---------------------------------------------------------------- */

  const fetchCases = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch<Case[]>("/api/cases");
      setCases(data);
      setStats((prev) => ({
        ...prev,
        totalCases: data.length,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load cases");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCases();
  }, [fetchCases]);

  /* Fetch evidence counts for all cases once cases are loaded */
  useEffect(() => {
    if (cases.length === 0) return;
    const fetchCounts = async () => {
      const counts: Record<string, number> = {};
      await Promise.allSettled(
        cases.map(async (c) => {
          try {
            const items = await apiFetch<EvidenceItem[]>(
              `/api/cases/${c.id}/evidence`
            );
            counts[c.id] = items.length;
          } catch {
            counts[c.id] = 0;
          }
        })
      );
      setEvidenceCounts(counts);
    };
    fetchCounts();
  }, [cases]);

  /* Fetch evidence items for selected case */
  const fetchEvidenceItems = useCallback(async (caseId: string) => {
    setEvidenceItemsLoading(true);
    setEvidenceItems([]);
    setSelectedEvidenceIds(new Set());
    try {
      const items = await apiFetch<EvidenceItem[]>(`/api/cases/${caseId}/evidence`);
      setEvidenceItems(items);
    } catch {
      setEvidenceItems([]);
    } finally {
      setEvidenceItemsLoading(false);
    }
  }, []);

  /* Fetch chain-of-custody timeline for a single evidence item */
  const fetchEvidenceTimeline = useCallback(async (evidenceId: string) => {
    setSelectedEvidenceId(evidenceId);
    setCustodyTimelineLoading(true);
    setCustodyTimelineError(null);
    setCustodyTimeline([]);
    try {
      // Try per-evidence endpoint first, then fallback
      const raw = await apiFetch<any>(`/api/evidence/${evidenceId}/chain-of-custody`);
      // Normalize: the API may return an array or { events: [...] }
      const events: any[] = Array.isArray(raw) ? raw : raw.events ?? [];
      const timeline: TimelineEvent[] = events.map((ev: any, idx: number) => ({
        id: ev.id ?? String(idx),
        timestamp: ev.timestamp ?? ev.created_at ?? new Date().toISOString(),
        title: ev.action ?? ev.title ?? ev.event ?? "Event",
        description: ev.description ?? ev.detail ?? undefined,
        type: ev.action_type ?? ev.type ?? undefined,
        severity: ev.severity ?? "info",
        metadata: ev.actor
          ? { Actor: ev.actor }
          : undefined,
      }));
      setCustodyTimeline(timeline);
    } catch (err: any) {
      if (err?.status === 404 || (err?.message || "").includes("404")) {
        setCustodyTimelineError("Audit trail not available");
      } else {
        setCustodyTimelineError("Failed to load audit trail");
      }
    } finally {
      setCustodyTimelineLoading(false);
    }
  }, []);

  /* Fetch chain-of-custody when a case is selected */
  const fetchChainOfCustody = useCallback(async (caseId: string) => {
    setSelectedCaseId(caseId);
    setCustodyLoading(true);
    setCustodyEntries([]);
    // Reset evidence-level state
    setSelectedEvidenceId(null);
    setCustodyTimeline([]);
    setCustodyTimelineError(null);

    try {
      const entries = await apiFetch<ChainOfCustodyEntry[]>(
        `/api/cases/${caseId}/chain-of-custody`
      );
      setCustodyEntries(entries);

      /* Update stats from custody data */
      const verified = entries.filter(
        (e) => e.verification_status === "verified"
      ).length;
      setStats((prev) => ({
        ...prev,
        evidenceItems: entries.length,
        verifiedHashes: verified,
      }));
    } catch {
      setCustodyEntries([]);
    } finally {
      setCustodyLoading(false);
    }

    // Also load evidence items for bulk operations
    fetchEvidenceItems(caseId);
  }, [fetchEvidenceItems]);

  /* Export a case */
  const handleExport = useCallback(
    async (caseId: string) => {
      setExportingCaseId(caseId);
      try {
        const res = await apiFetch<ExportResponse>(
          `/api/cases/${caseId}/export`,
          { method: "POST" }
        );
        setExportManifest(res.manifest);
        setShowExportModal(true);
        setStats((prev) => ({
          ...prev,
          exportsGenerated: prev.exportsGenerated + 1,
        }));
      } catch {
        // export failed silently
      } finally {
        setExportingCaseId(null);
      }
    },
    []
  );

  /* Add a note to the selected case */
  const handleAddNote = useCallback(async () => {
    if (!selectedCaseId || !noteTitle.trim()) return;
    setNoteSubmitting(true);
    setNoteError("");
    setNoteSuccess(false);
    try {
      await apiFetch<EvidenceItem>(
        `/api/cases/${selectedCaseId}/evidence`,
        {
          method: "POST",
          body: JSON.stringify({
            evidence_type: "note",
            title: noteTitle.trim(),
            content: noteContent.trim() || null,
          }),
        }
      );
      setNoteTitle("");
      setNoteContent("");
      setNoteSuccess(true);
      setTimeout(() => setNoteSuccess(false), 3000);

      /* Refresh evidence count for this case */
      setEvidenceCounts((prev) => ({
        ...prev,
        [selectedCaseId]: (prev[selectedCaseId] || 0) + 1,
      }));

      /* Refresh chain of custody if viewing */
      if (selectedCaseId) {
        fetchChainOfCustody(selectedCaseId);
      }
    } catch (err) {
      setNoteError(
        err instanceof Error ? err.message : "Failed to add note"
      );
    } finally {
      setNoteSubmitting(false);
    }
  }, [selectedCaseId, noteTitle, noteContent, fetchChainOfCustody]);

  /* Handle successful evidence file upload */
  const handleUploadSuccess = useCallback(
    (file: UploadedFile, attachedCaseId: string | null) => {
      setShowUploadModal(false);

      /* Update evidence count for the attached case */
      if (attachedCaseId) {
        setEvidenceCounts((prev) => ({
          ...prev,
          [attachedCaseId]: (prev[attachedCaseId] || 0) + 1,
        }));

        /* Refresh chain of custody if this case is currently selected */
        if (selectedCaseId === attachedCaseId) {
          fetchChainOfCustody(attachedCaseId);
        }
      }

      /* Update total evidence items stat */
      setStats((prev) => ({
        ...prev,
        evidenceItems: prev.evidenceItems + 1,
      }));

      addToast(
        "success",
        attachedCaseId
          ? `"${file.name}" uploaded and attached to case.`
          : `"${file.name}" uploaded successfully.`
      );
    },
    [addToast, selectedCaseId, fetchChainOfCustody]
  );

  /* ---------------------------------------------------------------- */
  /*  Bulk operations                                                  */
  /* ---------------------------------------------------------------- */

  const toggleEvidenceSelection = useCallback((id: string) => {
    setSelectedEvidenceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedEvidenceIds((prev) => {
      if (prev.size === evidenceItems.length) return new Set();
      return new Set(evidenceItems.map((e) => e.id));
    });
  }, [evidenceItems]);

  const handleBulkExportCSV = useCallback(() => {
    const selected = evidenceItems.filter((e) => selectedEvidenceIds.has(e.id));
    if (selected.length === 0) return;
    exportCSV(
      selected.map((e) => ({
        id: e.id,
        case_id: e.case_id,
        evidence_type: e.evidence_type,
        title: e.title,
        content: e.content ?? "",
        file_url: e.file_url ?? "",
        sha256_hash: e.sha256_hash ?? "",
        added_at: e.added_at,
      })),
      `evidence-export-${selectedCaseId ?? "bulk"}-${new Date().toISOString().slice(0, 10)}.csv`
    );
    addToast("success", `Exported ${selected.length} evidence item(s) as CSV.`);
  }, [evidenceItems, selectedEvidenceIds, selectedCaseId, addToast]);

  const handleBulkVerify = useCallback(async () => {
    const selected = evidenceItems.filter(
      (e) => selectedEvidenceIds.has(e.id) && e.sha256_hash
    );
    if (selected.length === 0) {
      addToast("info", "No selected items have a hash to verify.");
      return;
    }
    setBulkVerifying(true);
    let verifiedCount = 0;
    let failedCount = 0;
    await Promise.allSettled(
      selected.map(async (e) => {
        try {
          await apiFetch(`/api/evidence/${e.id}/verify`, { method: "POST" });
          verifiedCount++;
        } catch {
          failedCount++;
        }
      })
    );
    setBulkVerifying(false);
    addToast(
      verifiedCount > 0 ? "success" : "error",
      `Bulk verify complete: ${verifiedCount} verified, ${failedCount} failed/unavailable.`
    );
  }, [evidenceItems, selectedEvidenceIds, addToast]);

  /* ---------------------------------------------------------------- */
  /*  Derived data                                                     */
  /* ---------------------------------------------------------------- */

  const selectedCase = cases.find((c) => c.id === selectedCaseId);

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="flex h-full flex-col overflow-hidden bg-gray-950">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="flex items-center gap-3 border-b border-gray-800 bg-gray-950 px-6 py-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
          <FileCheck className="h-5 w-5 text-cyan-400" />
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-gray-100">
            Evidence Management
          </h1>
          <p className="text-xs text-gray-500">
            Forensic-grade evidence packages with chain of custody
          </p>
        </div>
        <button
          onClick={() => setShowUploadModal(true)}
          className="flex items-center gap-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 px-3 py-2 text-xs font-semibold text-white transition-colors"
        >
          <Upload className="h-3.5 w-3.5" />
          Upload Evidence
        </button>
        <button
          onClick={fetchCases}
          disabled={loading}
          className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ExternalLink className="h-3.5 w-3.5" />
          )}
          Refresh
        </button>
      </header>

      {/* ── Stats Bar ──────────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-4 border-b border-gray-800 bg-gray-950 px-6 py-4">
        <StatCard
          label="Total Cases"
          value={stats.totalCases}
          icon={FolderOpen}
          accent="text-cyan-400"
        />
        <StatCard
          label="Evidence Items"
          value={stats.evidenceItems}
          icon={FileText}
          accent="text-blue-400"
        />
        <StatCard
          label="Exports Generated"
          value={stats.exportsGenerated}
          icon={Package}
          accent="text-emerald-400"
        />
        <StatCard
          label="Verified Hashes"
          value={stats.verifiedHashes}
          icon={ShieldCheck}
          accent="text-violet-400"
        />
      </div>

      {/* ── Main content ───────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ============ LEFT PANEL (2/3): Case list ============= */}
        <div className="flex w-2/3 flex-col overflow-y-auto border-r border-gray-800 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
              Cases ({cases.length})
            </h2>
          </div>

          {/* Loading state */}
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
            </div>
          )}

          {/* Error state */}
          {error && !loading && (
            <div className="flex items-center gap-2 rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && cases.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <FolderOpen className="mb-3 h-12 w-12 text-gray-700" />
              <p className="text-sm text-gray-500">No cases found</p>
              <p className="mt-1 text-xs text-gray-600">
                Cases will appear here when they are created
              </p>
            </div>
          )}

          {/* Case cards */}
          <div className="space-y-3">
            {cases.map((c) => {
              const isExporting = exportingCaseId === c.id;
              const isSelected = selectedCaseId === c.id;

              return (
                <div
                  key={c.id}
                  className={cn(
                    "rounded-lg border bg-gray-900/60 p-4 transition-all",
                    isSelected
                      ? "border-cyan-800/60 bg-cyan-950/20"
                      : "border-gray-800 hover:border-gray-700"
                  )}
                >
                  {/* Top row: title + status */}
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold text-gray-200 truncate">
                        {c.title}
                      </h3>
                      <ClickToCopy value={c.id} className="mt-0.5">
                        <span className="font-mono text-[10px] text-gray-600 hover:text-gray-400 cursor-pointer transition-colors">
                          ID: {c.id.slice(0, 12)}...
                        </span>
                      </ClickToCopy>
                    </div>
                    <span
                      className={cn(
                        "inline-flex shrink-0 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                        STATUS_COLORS[c.status] || STATUS_COLORS.open
                      )}
                    >
                      {c.status}
                    </span>
                  </div>

                  {/* Meta row: severity, assigned_to, date */}
                  <div className="flex flex-wrap items-center gap-3 mb-3">
                    {/* Severity */}
                    <span
                      className={cn(
                        "inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                        severityColor(c.severity)
                      )}
                    >
                      {c.severity}
                    </span>

                    {/* Assigned to */}
                    {c.assigned_to && (
                      <span className="flex items-center gap-1 text-[11px] text-gray-500">
                        <Eye className="h-3 w-3" />
                        {c.assigned_to}
                      </span>
                    )}

                    {/* Evidence count */}
                    {evidenceCounts[c.id] !== undefined && (
                      <span className="flex items-center gap-1 text-[11px] text-gray-500">
                        <FileText className="h-3 w-3" />
                        {evidenceCounts[c.id]} evidence
                      </span>
                    )}

                    {/* Created date */}
                    <span className="flex items-center gap-1 text-[11px] text-gray-600">
                      <Clock className="h-3 w-3" />
                      {formatDate(c.created_at)}
                    </span>
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-center gap-2 pt-2 border-t border-gray-800/60">
                    <button
                      onClick={() => fetchChainOfCustody(c.id)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                        isSelected
                          ? "bg-cyan-900/40 text-cyan-400 border border-cyan-800/50"
                          : "bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700 hover:text-gray-200"
                      )}
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      Chain of Custody
                    </button>

                    <button
                      onClick={() => handleExport(c.id)}
                      disabled={isExporting}
                      className="flex items-center gap-1.5 rounded-lg bg-cyan-900/30 border border-cyan-800/50 px-3 py-1.5 text-xs font-medium text-cyan-400 hover:bg-cyan-900/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isExporting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Package className="h-3.5 w-3.5" />
                      )}
                      {isExporting ? "Exporting..." : "Export Package"}
                    </button>
                  </div>

                  {/* ---- Evidence items with bulk selection (when expanded) ---- */}
                  {isSelected && (
                    <div className="mt-4 border-t border-gray-800/60 pt-4">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                          Evidence Items
                        </span>
                        {evidenceItems.length > 0 && (
                          <button
                            onClick={toggleSelectAll}
                            className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                          >
                            {selectedEvidenceIds.size === evidenceItems.length ? (
                              <CheckSquare className="h-3 w-3" />
                            ) : (
                              <Square className="h-3 w-3" />
                            )}
                            {selectedEvidenceIds.size === evidenceItems.length
                              ? "Deselect All"
                              : "Select All"}
                          </button>
                        )}
                      </div>

                      {/* Bulk toolbar */}
                      {selectedEvidenceIds.size > 0 && (
                        <div className="mb-2 flex items-center gap-2 rounded-lg border border-cyan-800/40 bg-cyan-950/20 px-3 py-2">
                          <span className="text-[10px] text-cyan-400 font-medium">
                            {selectedEvidenceIds.size} selected
                          </span>
                          <div className="flex-1" />
                          <button
                            onClick={handleBulkExportCSV}
                            className="flex items-center gap-1 rounded border border-cyan-800/60 px-2 py-1 text-[10px] font-medium text-cyan-400 hover:bg-cyan-900/30 transition-colors"
                          >
                            <Download className="h-3 w-3" />
                            Export Selected
                          </button>
                          <button
                            onClick={handleBulkVerify}
                            disabled={bulkVerifying}
                            className="flex items-center gap-1 rounded border border-emerald-800/60 px-2 py-1 text-[10px] font-medium text-emerald-400 hover:bg-emerald-900/30 transition-colors disabled:opacity-50"
                          >
                            {bulkVerifying ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Shield className="h-3 w-3" />
                            )}
                            Verify Selected
                          </button>
                        </div>
                      )}

                      {/* Evidence items list */}
                      {evidenceItemsLoading ? (
                        <div className="space-y-2">
                          {Array.from({ length: 3 }).map((_, i) => (
                            <Skeleton key={i} className="h-10 w-full" />
                          ))}
                        </div>
                      ) : evidenceItems.length === 0 ? (
                        <p className="text-[11px] text-gray-600 text-center py-3">
                          No evidence items found
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {evidenceItems.map((item) => (
                            <div
                              key={item.id}
                              className={cn(
                                "flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors",
                                selectedEvidenceIds.has(item.id)
                                  ? "border-cyan-800/60 bg-cyan-950/10"
                                  : "border-gray-800 bg-gray-900/40 hover:border-gray-700"
                              )}
                            >
                              {/* Checkbox */}
                              <button
                                onClick={() => toggleEvidenceSelection(item.id)}
                                className="shrink-0 text-gray-500 hover:text-cyan-400 transition-colors"
                              >
                                {selectedEvidenceIds.has(item.id) ? (
                                  <CheckSquare className="h-4 w-4 text-cyan-400" />
                                ) : (
                                  <Square className="h-4 w-4" />
                                )}
                              </button>

                              {/* Info */}
                              <div className="min-w-0 flex-1">
                                <span className="text-xs font-medium text-gray-300 truncate block">
                                  {item.title}
                                </span>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[9px] font-bold uppercase text-gray-500">
                                    {item.evidence_type}
                                  </span>
                                  {item.sha256_hash && (
                                    <Hash className="h-2.5 w-2.5 text-gray-600" />
                                  )}
                                </div>
                              </div>

                              {/* Integrity + chain-of-custody */}
                              <div className="flex items-center gap-2 shrink-0">
                                <IntegrityBadge
                                  evidenceId={item.id}
                                  hasHash={!!item.sha256_hash}
                                />
                                <button
                                  onClick={() => fetchEvidenceTimeline(item.id)}
                                  className={cn(
                                    "flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-medium transition-colors",
                                    selectedEvidenceId === item.id
                                      ? "border-purple-700 bg-purple-900/30 text-purple-400"
                                      : "border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-300"
                                  )}
                                >
                                  <Clock className="h-3 w-3" />
                                  Audit
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Chain-of-Custody Timeline for selected evidence item */}
                      {selectedEvidenceId && (
                        <div className="mt-4 rounded-lg border border-gray-800 bg-gray-950/50 p-4">
                          <div className="mb-3 flex items-center justify-between">
                            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                              Chain of Custody
                            </h4>
                            <button
                              onClick={() => {
                                setSelectedEvidenceId(null);
                                setCustodyTimeline([]);
                                setCustodyTimelineError(null);
                              }}
                              className="text-gray-600 hover:text-gray-400 transition-colors"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                          {custodyTimelineLoading ? (
                            <div className="space-y-2">
                              {Array.from({ length: 3 }).map((_, i) => (
                                <Skeleton key={i} className="h-8 w-full" />
                              ))}
                            </div>
                          ) : custodyTimelineError ? (
                            <p className="text-xs text-gray-500 text-center py-3">
                              {custodyTimelineError}
                            </p>
                          ) : (
                            <TimelineView
                              events={custodyTimeline}
                              compact
                              maxVisible={10}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ============ RIGHT PANEL (1/3): Chain of Custody ====== */}
        <div className="flex w-1/3 flex-col overflow-y-auto bg-gray-950 p-6">
          <div className="mb-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
              Chain of Custody Log
            </h2>
            {selectedCase && (
              <p className="mt-1 text-xs text-gray-600 truncate">
                Case: {selectedCase.title}
              </p>
            )}
          </div>

          {/* Add Note form (visible when a case is selected) */}
          {selectedCaseId && (
            <div className="mb-4 rounded-lg border border-gray-800 bg-gray-900/50 p-4 space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <StickyNote className="h-3.5 w-3.5 text-amber-400" />
                <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                  Add Note
                </span>
              </div>
              <input
                type="text"
                placeholder="Note title"
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-800"
              />
              <textarea
                placeholder="Note content (optional)"
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-800 resize-none"
              />
              {noteError && (
                <p className="flex items-center gap-1.5 text-xs text-red-400">
                  <AlertTriangle className="h-3 w-3" />
                  {noteError}
                </p>
              )}
              {noteSuccess && (
                <p className="flex items-center gap-1.5 text-xs text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" />
                  Note added successfully
                </p>
              )}
              <button
                onClick={handleAddNote}
                disabled={noteSubmitting || !noteTitle.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-cyan-900/30 border border-cyan-800/50 px-3 py-1.5 text-xs font-medium text-cyan-400 hover:bg-cyan-900/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {noteSubmitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                {noteSubmitting ? "Adding..." : "Add Note"}
              </button>
            </div>
          )}

          {/* No case selected */}
          {!selectedCaseId && (
            <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-800/50 border border-gray-700 mb-4">
                <ShieldCheck className="h-6 w-6 text-gray-600" />
              </div>
              <p className="text-sm font-medium text-gray-400">
                Select a case to view custody log
              </p>
              <p className="mt-1 text-xs text-gray-600">
                Click &quot;Chain of Custody&quot; on any case
              </p>
            </div>
          )}

          {/* Custody loading */}
          {custodyLoading && (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 space-y-3"
                >
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-4/5" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              ))}
            </div>
          )}

          {/* Custody empty */}
          {selectedCaseId && !custodyLoading && custodyEntries.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <FileText className="mb-3 h-8 w-8 text-gray-700" />
              <p className="text-xs text-gray-500">
                No chain of custody entries
              </p>
              <p className="mt-1 text-[10px] text-gray-600">
                Export the case to generate custody records
              </p>
            </div>
          )}

          {/* Custody entries */}
          {!custodyLoading && custodyEntries.length > 0 && (
            <div className="space-y-3">
              {/* Summary bar */}
              <div className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2">
                <span className="text-[10px] text-gray-500">
                  {custodyEntries.length} entries
                </span>
                <span className="text-[10px] text-gray-700">|</span>
                <span className="text-[10px] text-emerald-500">
                  {custodyEntries.filter((e) => e.verification_status === "verified").length} verified
                </span>
                <span className="text-[10px] text-gray-700">|</span>
                <span className="text-[10px] text-yellow-500">
                  {custodyEntries.filter((e) => e.verification_status === "pending").length} pending
                </span>
                <span className="text-[10px] text-gray-700">|</span>
                <span className="text-[10px] text-red-500">
                  {custodyEntries.filter((e) => e.verification_status === "failed").length} failed
                </span>
              </div>

              {/* Entry cards */}
              {custodyEntries.map((entry) => {
                const VerIcon =
                  VERIFICATION_ICONS[entry.verification_status] || Timer;
                return (
                  <div
                    key={entry.id}
                    className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 space-y-3"
                  >
                    {/* Type + verification status */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                        {entry.evidence_type}
                      </span>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                          VERIFICATION_COLORS[entry.verification_status] ||
                            VERIFICATION_COLORS.pending
                        )}
                      >
                        <VerIcon className="h-3 w-3" />
                        {entry.verification_status}
                      </span>
                    </div>

                    {/* File path */}
                    <div className="flex items-start gap-2">
                      <FileText className="mt-0.5 h-3 w-3 shrink-0 text-gray-600" />
                      <span className="text-xs text-gray-400 font-mono break-all leading-relaxed">
                        {entry.file_path}
                      </span>
                    </div>

                    {/* SHA-256 hash */}
                    <div className="flex items-center gap-2">
                      <Hash className="h-3 w-3 shrink-0 text-gray-600" />
                      <TruncatedHash hash={entry.sha256_hash} />
                    </div>

                    {/* Timestamps */}
                    <div className="flex flex-wrap gap-3 text-[10px] text-gray-600 pt-2 border-t border-gray-800/60">
                      <span className="flex items-center gap-1">
                        <Clock className="h-2.5 w-2.5" />
                        Created: {formatDate(entry.created_at)}
                      </span>
                      {entry.verified_at && (
                        <span className="flex items-center gap-1">
                          <CheckCircle2 className="h-2.5 w-2.5" />
                          Verified: {formatDate(entry.verified_at)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Export Modal ────────────────────────────────────────── */}
      {showExportModal && exportManifest && (
        <ExportModal
          manifest={exportManifest}
          onClose={() => {
            setShowExportModal(false);
            setExportManifest(null);
          }}
        />
      )}

      {/* ── Upload Evidence Modal ────────────────────────────────── */}
      {showUploadModal && (
        <UploadEvidenceModal
          cases={cases}
          onClose={() => setShowUploadModal(false)}
          onUploadSuccess={handleUploadSuccess}
        />
      )}
    </div>
  );
}
