"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Globe,
  ShieldAlert,
  AlertTriangle,
  Plus,
  Loader2,
  ChevronDown,
  X,
  RefreshCw,
  Clock,
  Crosshair,
  Hash,
  Mail,
  Network,
  Car,
  Eye,
  Zap,
  CheckCircle2,
  Search,
  ExternalLink,
  ArrowUpDown,
} from "lucide-react";
import { cn, apiFetch, severityColor } from "@/lib/utils";
import FeedManager from "@/components/threat-intel/FeedManager";
import ActiveContextPanel from "@/components/threat-intel/ActiveContextPanel";
import ThresholdAdjustmentViewer from "@/components/threat-intel/ThresholdAdjustmentViewer";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ThreatIntelEntry {
  id: string;
  source: string;
  threat_type: string;
  severity: string;
  title: string;
  description: string;
  ioc_type: string;
  ioc_value: string;
  first_seen: string;
  last_seen: string;
  expires_at: string | null;
  auto_actions: string[];
  confidence: number;
}

interface NewThreatForm {
  source: string;
  threat_type: string;
  severity: string;
  title: string;
  description: string;
  ioc_type: string;
  ioc_value: string;
  auto_actions: string[];
  confidence: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const SEVERITY_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All Severities" },
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

const THREAT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All Types" },
  { value: "malware", label: "Malware" },
  { value: "intrusion", label: "Intrusion" },
  { value: "phishing", label: "Phishing" },
  { value: "surveillance", label: "Surveillance" },
  { value: "insider_threat", label: "Insider Threat" },
  { value: "physical_breach", label: "Physical Breach" },
  { value: "vehicle_threat", label: "Vehicle Threat" },
  { value: "suspicious_entity", label: "Suspicious Entity" },
  { value: "cyber_physical", label: "Cyber-Physical" },
];

const IOC_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "ip_address", label: "IP Address" },
  { value: "domain", label: "Domain" },
  { value: "hash", label: "Hash" },
  { value: "plate_number", label: "Plate Number" },
  { value: "email", label: "Email" },
];

const AUTO_ACTION_OPTIONS: string[] = [
  "watchlist_add",
  "alert_security",
  "block_access",
  "notify_admin",
  "log_event",
  "escalate",
  "quarantine",
  "track_entity",
];

const EMPTY_FORM: NewThreatForm = {
  source: "",
  threat_type: "suspicious_entity",
  severity: "medium",
  title: "",
  description: "",
  ioc_type: "ip_address",
  ioc_value: "",
  auto_actions: ["alert_security"],
  confidence: 0.75,
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function timeAgo(iso: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(iso).getTime()) / 1000
  );
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/* ------------------------------------------------------------------ */
/*  IOC Type Badge                                                     */
/* ------------------------------------------------------------------ */

const IOC_ICONS: Record<string, typeof Globe> = {
  ip_address: Network,
  domain: Globe,
  hash: Hash,
  plate_number: Car,
  email: Mail,
};

const IOC_COLORS: Record<string, string> = {
  ip_address: "text-purple-400 bg-purple-900/30 border-purple-800/50",
  domain: "text-blue-400 bg-blue-900/30 border-blue-800/50",
  hash: "text-amber-400 bg-amber-900/30 border-amber-800/50",
  plate_number: "text-emerald-400 bg-emerald-900/30 border-emerald-800/50",
  email: "text-pink-400 bg-pink-900/30 border-pink-800/50",
};

function IocBadge({ type, value }: { type: string; value: string }) {
  const Icon = IOC_ICONS[type] || Crosshair;
  const color = IOC_COLORS[type] || "text-gray-400 bg-gray-800 border-gray-700";

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-mono",
        color
      )}
      title={`${type}: ${value}`}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate max-w-[140px]">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Auto-Action Tag                                                    */
/* ------------------------------------------------------------------ */

function ActionTag({ action }: { action: string }) {
  const label = action.replace(/_/g, " ");
  return (
    <span className="inline-flex items-center gap-1 rounded bg-gray-800 border border-gray-700 px-1.5 py-0.5 text-[10px] font-medium text-gray-400">
      <Zap className="h-2.5 w-2.5 text-cyan-500" />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  StatCard                                                           */
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
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold text-gray-100">{value}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Add Threat Modal                                                   */
/* ------------------------------------------------------------------ */

function AddThreatModal({
  open,
  onClose,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (form: NewThreatForm) => void;
  submitting: boolean;
}) {
  const [form, setForm] = useState<NewThreatForm>({ ...EMPTY_FORM });
  const [actionInput, setActionInput] = useState("");

  const updateField = <K extends keyof NewThreatForm>(
    key: K,
    value: NewThreatForm[K]
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const addAction = (action: string) => {
    if (action && !form.auto_actions.includes(action)) {
      updateField("auto_actions", [...form.auto_actions, action]);
    }
    setActionInput("");
  };

  const removeAction = (action: string) => {
    updateField(
      "auto_actions",
      form.auto_actions.filter((a) => a !== action)
    );
  };

  const handleSubmit = () => {
    if (!form.title.trim() || !form.source.trim() || !form.ioc_value.trim()) return;
    onSubmit(form);
    setForm({ ...EMPTY_FORM });
  };

  const handleClose = () => {
    setForm({ ...EMPTY_FORM });
    onClose();
  };

  if (!open) return null;

  const isValid = form.title.trim() && form.source.trim() && form.ioc_value.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-2xl rounded-2xl border border-gray-800 bg-gray-950 shadow-2xl shadow-black/50">
        {/* Modal header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
              <Plus className="h-5 w-5 text-cyan-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-gray-100">
                Add Threat Intelligence
              </h2>
              <p className="text-xs text-gray-500">
                Manually ingest a new threat intel entry
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-300"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Modal body */}
        <div className="max-h-[70vh] overflow-y-auto px-6 py-5 space-y-4">
          {/* Row 1: Title + Source */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
                Title *
              </label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => updateField("title", e.target.value)}
                placeholder="e.g., Known malicious IP range"
                className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-sm text-gray-100 placeholder-gray-600 outline-none transition-colors focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700/50"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
                Source *
              </label>
              <input
                type="text"
                value={form.source}
                onChange={(e) => updateField("source", e.target.value)}
                placeholder="e.g., OSINT, FBI, Internal"
                className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-sm text-gray-100 placeholder-gray-600 outline-none transition-colors focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700/50"
              />
            </div>
          </div>

          {/* Row 2: Threat Type + Severity */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
                Threat Type
              </label>
              <div className="relative">
                <select
                  value={form.threat_type}
                  onChange={(e) => updateField("threat_type", e.target.value)}
                  className="w-full appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2.5 text-sm text-gray-300 outline-none focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700/50"
                >
                  {THREAT_TYPE_OPTIONS.filter((o) => o.value !== "all").map(
                    (opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    )
                  )}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
                Severity
              </label>
              <div className="relative">
                <select
                  value={form.severity}
                  onChange={(e) => updateField("severity", e.target.value)}
                  className="w-full appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2.5 text-sm text-gray-300 outline-none focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700/50"
                >
                  {SEVERITY_OPTIONS.filter((o) => o.value !== "all").map(
                    (opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    )
                  )}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
              </div>
            </div>
          </div>

          {/* Row 3: IOC Type + IOC Value */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
                IOC Type
              </label>
              <div className="relative">
                <select
                  value={form.ioc_type}
                  onChange={(e) => updateField("ioc_type", e.target.value)}
                  className="w-full appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2.5 text-sm text-gray-300 outline-none focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700/50"
                >
                  {IOC_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
              </div>
            </div>
            <div className="col-span-2">
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
                IOC Value *
              </label>
              <input
                type="text"
                value={form.ioc_value}
                onChange={(e) => updateField("ioc_value", e.target.value)}
                placeholder="e.g., 192.168.1.100 or ABC-1234"
                className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-sm text-gray-100 placeholder-gray-600 outline-none transition-colors focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700/50"
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
              Description
            </label>
            <textarea
              value={form.description}
              onChange={(e) => updateField("description", e.target.value)}
              placeholder="Describe the threat intelligence detail..."
              rows={3}
              className="w-full resize-none rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-sm text-gray-100 placeholder-gray-600 outline-none transition-colors focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700/50"
            />
          </div>

          {/* Confidence */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                Confidence
              </label>
              <span className="text-sm font-bold tabular-nums text-cyan-400">
                {Math.round(form.confidence * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(form.confidence * 100)}
              onChange={(e) =>
                updateField("confidence", Number(e.target.value) / 100)
              }
              className="w-full cursor-pointer accent-cyan-500"
            />
            <div className="mt-1 flex justify-between text-[10px] text-gray-600">
              <span>Low</span>
              <span>Medium</span>
              <span>High</span>
            </div>
          </div>

          {/* Auto Actions */}
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
              Auto Actions
            </label>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {form.auto_actions.map((action) => (
                <span
                  key={action}
                  className="inline-flex items-center gap-1 rounded-md border border-cyan-800/50 bg-cyan-900/20 px-2 py-0.5 text-[11px] font-medium text-cyan-400"
                >
                  {action.replace(/_/g, " ")}
                  <button
                    onClick={() => removeAction(action)}
                    className="ml-0.5 rounded p-0.5 text-cyan-600 transition-colors hover:text-cyan-300"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
            <div className="relative">
              <select
                value={actionInput}
                onChange={(e) => {
                  addAction(e.target.value);
                }}
                className="w-full appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-400 outline-none focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700/50"
              >
                <option value="">Select action to add...</option>
                {AUTO_ACTION_OPTIONS.filter(
                  (a) => !form.auto_actions.includes(a)
                ).map((action) => (
                  <option key={action} value={action}>
                    {action.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
            </div>
          </div>
        </div>

        {/* Modal footer */}
        <div className="flex items-center justify-end gap-3 border-t border-gray-800 px-6 py-4">
          <button
            onClick={handleClose}
            className="rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 text-xs font-medium text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!isValid || submitting}
            className={cn(
              "flex items-center gap-2 rounded-lg px-5 py-2 text-xs font-semibold transition-colors",
              "bg-cyan-600 text-white hover:bg-cyan-500",
              "disabled:opacity-40 disabled:cursor-not-allowed"
            )}
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            Submit Threat Intel
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Threat Intel Row (for table)                                       */
/* ------------------------------------------------------------------ */

function ThreatRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: ThreatIntelEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        "border border-gray-800 rounded-lg transition-all duration-200",
        expanded ? "bg-gray-900/90" : "bg-gray-900/50 hover:bg-gray-800/50"
      )}
    >
      {/* Main row */}
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {/* Severity badge */}
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
            severityColor(entry.severity)
          )}
        >
          <ShieldAlert className="h-3 w-3" />
          {entry.severity}
        </span>

        {/* Title */}
        <span className="flex-1 truncate text-sm font-medium text-gray-200">
          {entry.title}
        </span>

        {/* Source */}
        <span className="hidden items-center gap-1 text-xs text-gray-500 md:flex">
          <ExternalLink className="h-3 w-3" />
          {entry.source}
        </span>

        {/* Threat type */}
        <span className="hidden shrink-0 rounded border border-gray-700 bg-gray-800 px-2 py-0.5 text-[10px] font-medium text-gray-400 lg:inline-flex">
          {entry.threat_type.replace(/_/g, " ")}
        </span>

        {/* IOC badge */}
        <span className="hidden xl:inline-flex">
          <IocBadge type={entry.ioc_type} value={entry.ioc_value} />
        </span>

        {/* Confidence */}
        <span className="shrink-0 w-12 text-right font-mono text-xs text-cyan-400">
          {Math.round(entry.confidence * 100)}%
        </span>

        {/* First seen */}
        <span className="hidden shrink-0 items-center gap-1 text-[11px] text-gray-500 sm:flex">
          <Clock className="h-3 w-3" />
          {timeAgo(entry.first_seen)}
        </span>

        {/* Expand indicator */}
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-gray-600 transition-transform duration-200",
            expanded && "rotate-180"
          )}
        />
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-gray-800 px-4 py-4 space-y-4">
          {/* Description */}
          {entry.description && (
            <div>
              <h4 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
                <Eye className="h-3.5 w-3.5" />
                Description
              </h4>
              <p className="text-sm leading-relaxed text-gray-300">
                {entry.description}
              </p>
            </div>
          )}

          {/* IOC detail */}
          <div>
            <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
              <Crosshair className="h-3.5 w-3.5 text-purple-400" />
              Indicator of Compromise
            </h4>
            <div className="rounded-lg border border-purple-900/50 bg-purple-950/20 px-3 py-2">
              <div className="flex items-center gap-3">
                <IocBadge type={entry.ioc_type} value={entry.ioc_value} />
                <span className="text-xs text-gray-500">
                  Type: <span className="font-medium text-gray-400">{entry.ioc_type.replace(/_/g, " ")}</span>
                </span>
              </div>
            </div>
          </div>

          {/* Auto Actions */}
          {entry.auto_actions && entry.auto_actions.length > 0 && (
            <div>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
                <Zap className="h-3.5 w-3.5 text-cyan-400" />
                Auto Actions
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {entry.auto_actions.map((action) => (
                  <ActionTag key={action} action={action} />
                ))}
              </div>
            </div>
          )}

          {/* Metadata row */}
          <div className="flex flex-wrap gap-4 text-xs text-gray-500">
            <span>
              ID:{" "}
              <span className="font-mono text-gray-400">
                {entry.id.slice(0, 8)}
              </span>
            </span>
            <span>
              Source:{" "}
              <span className="text-gray-400">{entry.source}</span>
            </span>
            <span>
              First Seen:{" "}
              <span className="text-gray-400">
                {formatDateTime(entry.first_seen)}
              </span>
            </span>
            <span>
              Last Seen:{" "}
              <span className="text-gray-400">
                {formatDateTime(entry.last_seen)}
              </span>
            </span>
            {entry.expires_at && (
              <span>
                Expires:{" "}
                <span className="text-gray-400">
                  {formatDateTime(entry.expires_at)}
                </span>
              </span>
            )}
            <span>
              Confidence:{" "}
              <span className="font-semibold text-cyan-400">
                {Math.round(entry.confidence * 100)}%
              </span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Threshold Loader (fetches data for ThresholdAdjustmentViewer)      */
/* ------------------------------------------------------------------ */

function ThresholdLoader() {
  const [adjustments, setAdjustments] = useState<Record<string, Record<string, number>>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<{
          threshold_adjustments?: Record<string, Record<string, number>>;
        }>("/api/threat-intel/context");
        if (!cancelled) {
          setAdjustments(data.threshold_adjustments ?? {});
        }
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      <ThresholdAdjustmentViewer adjustments={adjustments} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page Component                                                */
/* ------------------------------------------------------------------ */

type ThreatTabKey = "threats" | "feeds" | "context" | "thresholds";

export default function ThreatIntelPage() {
  /* --- State --- */
  const [activeTab, setActiveTab] = useState<ThreatTabKey>("threats");
  const [entries, setEntries] = useState<ThreatIntelEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [severityFilter, setSeverityFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  // UI state
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Sorting
  const [sortField, setSortField] = useState<"first_seen" | "severity" | "confidence">("first_seen");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  /* --- Fetch threat intel --- */
  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await apiFetch<ThreatIntelEntry[]>(
        "/api/threat-intel/active"
      );
      setEntries(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch threat intel"
      );
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  /* --- Submit new entry --- */
  const handleSubmit = useCallback(
    async (form: NewThreatForm) => {
      setSubmitting(true);
      try {
        await apiFetch<ThreatIntelEntry>("/api/threat-intel/webhook", {
          method: "POST",
          body: JSON.stringify(form),
        });
        setShowAddModal(false);
        await fetchEntries();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to submit threat intel");
      } finally {
        setSubmitting(false);
      }
    },
    [fetchEntries]
  );

  /* --- Filtering and sorting --- */
  const SEVERITY_ORDER: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  const filtered = entries
    .filter((e) => {
      if (severityFilter !== "all" && e.severity !== severityFilter) return false;
      if (typeFilter !== "all" && e.threat_type !== typeFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          e.title.toLowerCase().includes(q) ||
          e.source.toLowerCase().includes(q) ||
          e.ioc_value.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q) ||
          e.threat_type.toLowerCase().includes(q)
        );
      }
      return true;
    })
    .sort((a, b) => {
      let cmp = 0;
      if (sortField === "first_seen") {
        cmp =
          new Date(a.first_seen).getTime() - new Date(b.first_seen).getTime();
      } else if (sortField === "severity") {
        cmp =
          (SEVERITY_ORDER[a.severity] ?? 4) -
          (SEVERITY_ORDER[b.severity] ?? 4);
      } else if (sortField === "confidence") {
        cmp = a.confidence - b.confidence;
      }
      return sortDir === "desc" ? -cmp : cmp;
    });

  /* --- Stats --- */
  const totalActive = entries.length;
  const criticalCount = entries.filter((e) => e.severity === "critical").length;
  const highCount = entries.filter((e) => e.severity === "high").length;
  const uniqueSources = new Set(entries.map((e) => e.source)).size;

  /* --- Sort toggle helper --- */
  const toggleSort = (field: typeof sortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  /* --- Render --- */
  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
            <Globe className="h-5 w-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Threat Intelligence
            </h1>
            <p className="text-xs text-gray-500">
              External threat feeds, IOCs, and automated response actions
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Refresh button */}
          <button
            onClick={fetchEntries}
            disabled={loading}
            className={cn(
              "flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs font-medium text-gray-400 transition-colors",
              "hover:bg-gray-800 hover:text-gray-200",
              "disabled:opacity-40 disabled:cursor-not-allowed"
            )}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
            />
            Refresh
          </button>

          {/* Add threat button */}
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-cyan-500"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Threat Intel
          </button>
        </div>
      </div>

      {/* ---- Stats bar ---- */}
      <div className="border-b border-gray-800 px-6 py-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard
            label="Active Threats"
            value={totalActive}
            icon={ShieldAlert}
            accent="text-cyan-400"
          />
          <StatCard
            label="Critical"
            value={criticalCount}
            icon={AlertTriangle}
            accent="text-red-400"
          />
          <StatCard
            label="High"
            value={highCount}
            icon={AlertTriangle}
            accent="text-orange-400"
          />
          <StatCard
            label="Sources"
            value={uniqueSources}
            icon={Globe}
            accent="text-emerald-400"
          />
        </div>
      </div>

      {/* ---- Tabs ---- */}
      <div className="flex items-center gap-1 border-b border-gray-800 px-6">
        {([
          { key: "threats" as const, label: "Threats" },
          { key: "feeds" as const, label: "Feeds" },
          { key: "context" as const, label: "Active Context" },
          { key: "thresholds" as const, label: "Threshold Impact" },
        ]).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors",
              activeTab === tab.key
                ? "border-cyan-500 text-cyan-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ---- Feeds Tab ---- */}
      {activeTab === "feeds" && (
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <FeedManager />
        </div>
      )}

      {/* ---- Active Context Tab ---- */}
      {activeTab === "context" && (
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <ActiveContextPanel />
        </div>
      )}

      {/* ---- Threshold Impact Tab ---- */}
      {activeTab === "thresholds" && (
        <ThresholdLoader />
      )}

      {/* ---- Threats Tab: Filter bar ---- */}
      {activeTab === "threats" && <div className="flex flex-wrap items-center gap-3 border-b border-gray-800 px-6 py-3">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search threats, IOCs, sources..."
            className="w-full rounded-lg border border-gray-700 bg-gray-900 pl-9 pr-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          />
        </div>

        {/* Severity filter */}
        <div className="relative">
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          >
            {SEVERITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
        </div>

        {/* Type filter */}
        <div className="relative">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="appearance-none rounded-lg border border-gray-700 bg-gray-900 pl-3 pr-8 py-2 text-xs text-gray-300 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          >
            {THREAT_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
        </div>

        {/* Sort controls */}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-600">
            Sort by
          </span>
          {(
            [
              { key: "first_seen" as const, label: "Time" },
              { key: "severity" as const, label: "Severity" },
              { key: "confidence" as const, label: "Confidence" },
            ] as const
          ).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => toggleSort(key)}
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                sortField === key
                  ? "bg-cyan-900/30 text-cyan-400 border border-cyan-800/50"
                  : "text-gray-500 hover:text-gray-300"
              )}
            >
              {label}
              {sortField === key && (
                <ArrowUpDown className="h-2.5 w-2.5" />
              )}
            </button>
          ))}

          {/* Results count */}
          <span className="ml-2 text-xs text-gray-500">
            {filtered.length} of {totalActive}
          </span>
        </div>
      </div>}

      {/* ---- Threat intel list (threats tab) ---- */}
      {activeTab === "threats" && <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {/* Loading state */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
            <p className="mt-3 text-sm text-gray-500">
              Loading threat intelligence...
            </p>
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="flex flex-col items-center justify-center py-20">
            <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={fetchEntries}
              className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && entries.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20">
            <Globe className="mb-2 h-10 w-10 text-gray-700" />
            <p className="text-sm font-medium text-gray-400">
              No threat intelligence entries
            </p>
            <p className="mt-1 text-xs text-gray-600">
              Add a new entry or connect external threat feeds
            </p>
            <button
              onClick={() => setShowAddModal(true)}
              className="mt-4 flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-cyan-500"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Threat Intel
            </button>
          </div>
        )}

        {/* Filtered empty state */}
        {!loading && !error && entries.length > 0 && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20">
            <Search className="mb-2 h-8 w-8 text-gray-700" />
            <p className="text-sm font-medium text-gray-400">
              No matching threats
            </p>
            <p className="mt-1 text-xs text-gray-600">
              Adjust your filters or search criteria
            </p>
            <button
              onClick={() => {
                setSeverityFilter("all");
                setTypeFilter("all");
                setSearchQuery("");
              }}
              className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
            >
              Clear filters
            </button>
          </div>
        )}

        {/* Threat rows */}
        {!loading &&
          !error &&
          filtered.map((entry) => (
            <ThreatRow
              key={entry.id}
              entry={entry}
              expanded={expandedId === entry.id}
              onToggle={() =>
                setExpandedId(expandedId === entry.id ? null : entry.id)
              }
            />
          ))}
      </div>}

      {/* ---- Footer status bar ---- */}
      {!loading && !error && entries.length > 0 && (
        <div className="flex items-center justify-between border-t border-gray-800 px-6 py-3">
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Live feed connected
            </span>
            <span>
              Last updated:{" "}
              <span className="text-gray-400">
                {new Date().toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  hour12: false,
                })}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-600">
            {criticalCount > 0 && (
              <span className="flex items-center gap-1 text-red-400">
                <AlertTriangle className="h-3 w-3" />
                {criticalCount} critical threat{criticalCount !== 1 ? "s" : ""}{" "}
                active
              </span>
            )}
            <span>
              {uniqueSources} source{uniqueSources !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
      )}

      {/* ---- Add Threat Modal ---- */}
      <AddThreatModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSubmit={handleSubmit}
        submitting={submitting}
      />
    </div>
  );
}
