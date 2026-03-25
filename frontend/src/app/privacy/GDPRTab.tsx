"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ShieldCheck,
  Loader2,
  AlertTriangle,
  Trash2,
  Pencil,
  Plus,
  Play,
  Search,
  FileText,
  Clock,
  User,
  Mail,
  Database,
  Download,
  RefreshCw,
  Filter,
  X,
  CheckCircle2,
  XCircle,
  Eye,
  Lock,
  ChevronDown,
  Calendar,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { exportCSV } from "@/lib/export";

/* ---------- Toast ---------- */
interface Toast { id: number; message: string; type: "success" | "error" }

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} onClick={() => onDismiss(t.id)}
          className={cn(
            "pointer-events-auto flex items-center gap-2 px-4 py-3 rounded-lg border text-sm font-medium shadow-lg cursor-pointer transition",
            t.type === "success"
              ? "bg-green-900/90 border-green-600/60 text-green-200"
              : "bg-red-900/90 border-red-600/60 text-red-200"
          )}>
          {t.type === "success" ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
          {t.message}
        </div>
      ))}
    </div>
  );
}

function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const show = useCallback((message: string, type: "success" | "error" = "success") => {
    const id = ++counter.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);
  return { toasts, show, dismiss };
}

/* ---------- Types ---------- */
interface RetentionPolicy {
  id: string;
  name: string;
  data_type: string;
  retention_days: number;
  auto_purge: boolean;
  last_purge: string | null;
  records_purged: number;
  created_at: string;
}

interface PrivacyRequest {
  id: string;
  request_type: string;
  subject_name: string;
  subject_email: string;
  data_categories: string[];
  status: string;
  created_at: string;
  completed_at: string | null;
}

interface AuditEntry {
  id: string;
  user: string;
  action: string;
  resource_type: string;
  resource_id: string;
  details: string;
  timestamp: string;
  ip_address: string;
}

interface ComplianceReport {
  report_type: string;
  generated_at: string;
  retention_policies: number;
  privacy_requests: { total: number; pending: number; completed: number };
  audit_log_entries: number;
  compliance_status: string;
  /** Derived on the frontend from real API data — not hardcoded */
  score: number;
  findings: Array<{ category: string; status: string; details: string }>;
}

type TabId = "retention" | "requests" | "audit" | "compliance";

/* ---------- PII Detection ---------- */
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/;
const SSN_RE = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/;

function detectPII(value: string): string[] {
  const hits: string[] = [];
  if (EMAIL_RE.test(value)) hits.push("Email");
  if (PHONE_RE.test(value)) hits.push("Phone");
  if (SSN_RE.test(value)) hits.push("SSN");
  return hits;
}

/** Check a record object for PII patterns across all string fields */
function hasPII(obj: Record<string, unknown>): boolean {
  return Object.values(obj).some(
    (v) => typeof v === "string" && detectPII(v).length > 0
  );
}

/** Collect PII type labels found in a record */
function piiTypes(obj: Record<string, unknown>): string[] {
  const found = new Set<string>();
  Object.values(obj).forEach((v) => {
    if (typeof v === "string") {
      detectPII(v).forEach((t) => found.add(t));
    }
  });
  return Array.from(found);
}

const TABS: { id: TabId; label: string; icon: typeof ShieldCheck }[] = [
  { id: "retention", label: "Retention Policies", icon: Database },
  { id: "requests", label: "Privacy Requests", icon: Lock },
  { id: "audit", label: "Audit Trail", icon: Eye },
  { id: "compliance", label: "Compliance Reports", icon: FileText },
];

export default function GDPRTab() {
  const { toasts, show: toast, dismiss: dismissToast } = useToast();

  const [tab, setTab] = useState<TabId>("retention");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* ---- Retention State ---- */
  const [policies, setPolicies] = useState<RetentionPolicy[]>([]);
  const [showPolicyForm, setShowPolicyForm] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<RetentionPolicy | null>(null);
  const [policyForm, setPolicyForm] = useState({ name: "", data_type: "video", retention_days: 90, auto_purge: true });
  const [enforcing, setEnforcing] = useState(false);

  /* ---- Privacy Requests State ---- */
  const [requests, setRequests] = useState<PrivacyRequest[]>([]);
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [requestForm, setRequestForm] = useState({ type: "erasure", subject_name: "", subject_email: "", data_categories: "video,images" });
  const [processingId, setProcessingId] = useState<string | null>(null);

  /* ---- Audit State ---- */
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditSearch, setAuditSearch] = useState("");
  const [auditFilters, setAuditFilters] = useState({ user: "", action: "", resource_type: "", start_date: "", end_date: "" });
  const [showAuditFilters, setShowAuditFilters] = useState(false);

  /* ---- Compliance State ---- */
  const [complianceReport, setComplianceReport] = useState<ComplianceReport | null>(null);
  const [generatingReport, setGeneratingReport] = useState<string | null>(null);
  const [exportingGDPR, setExportingGDPR] = useState(false);

  /* ==================== Fetch Functions ==================== */

  const fetchPolicies = useCallback(async () => {
    try {
      const data = await apiFetch<RetentionPolicy[]>("/api/privacy/retention-policies");
      setPolicies(Array.isArray(data) ? data : []);
    } catch { /* ignore */ }
  }, []);

  const fetchRequests = useCallback(async () => {
    try {
      const data = await apiFetch<PrivacyRequest[]>("/api/privacy/requests");
      setRequests(Array.isArray(data) ? data : []);
    } catch { /* ignore */ }
  }, []);

  const fetchAudit = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (auditSearch) params.set("search", auditSearch);
      if (auditFilters.user) params.set("user", auditFilters.user);
      if (auditFilters.action) params.set("action", auditFilters.action);
      if (auditFilters.resource_type) params.set("resource_type", auditFilters.resource_type);
      if (auditFilters.start_date) params.set("start_date", auditFilters.start_date);
      if (auditFilters.end_date) params.set("end_date", auditFilters.end_date);
      const qs = params.toString();
      const data = await apiFetch<AuditEntry[]>(`/api/privacy/audit-trail${qs ? `?${qs}` : ""}`);
      setAuditEntries(Array.isArray(data) ? data : []);
    } catch { /* ignore */ }
  }, [auditSearch, auditFilters]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const loader = async () => {
      try {
        if (tab === "retention") await fetchPolicies();
        if (tab === "requests") await fetchRequests();
        if (tab === "audit") await fetchAudit();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Load error");
      } finally {
        setLoading(false);
      }
    };
    loader();
  }, [tab, fetchPolicies, fetchRequests, fetchAudit]);

  /* ==================== Retention Actions ==================== */

  const savePolicyHandler = async () => {
    try {
      if (editingPolicy) {
        await apiFetch(`/api/privacy/retention-policies/${editingPolicy.id}`, { method: "PUT", body: JSON.stringify(policyForm) });
        toast("Retention policy updated", "success");
      } else {
        await apiFetch("/api/privacy/retention-policies", { method: "POST", body: JSON.stringify(policyForm) });
        toast("Retention policy created", "success");
      }
      setShowPolicyForm(false);
      setEditingPolicy(null);
      setPolicyForm({ name: "", data_type: "video", retention_days: 90, auto_purge: true });
      await fetchPolicies();
    } catch (err) { toast(err instanceof Error ? err.message : "Save failed", "error"); }
  };

  const deletePolicy = async (id: string) => {
    if (!confirm("Delete this retention policy?")) return;
    try {
      await apiFetch(`/api/privacy/retention-policies/${id}`, { method: "DELETE" });
      toast("Retention policy deleted", "success");
      await fetchPolicies();
    } catch (err) { toast(err instanceof Error ? err.message : "Delete failed", "error"); }
  };

  const enforceRetention = async () => {
    setEnforcing(true);
    try {
      await apiFetch("/api/privacy/retention/enforce", { method: "POST" });
      toast("Retention enforcement completed", "success");
      await fetchPolicies();
    } catch (err) { toast(err instanceof Error ? err.message : "Enforcement failed", "error"); }
    finally { setEnforcing(false); }
  };

  const startEditPolicy = (p: RetentionPolicy) => {
    setEditingPolicy(p);
    setPolicyForm({ name: p.name, data_type: p.data_type, retention_days: p.retention_days, auto_purge: p.auto_purge });
    setShowPolicyForm(true);
  };

  /* ==================== Privacy Request Actions ==================== */

  const submitRequest = async () => {
    try {
      await apiFetch("/api/privacy/requests", {
        method: "POST",
        body: JSON.stringify({
          request_type: requestForm.type,
          subject_name: requestForm.subject_name,
          subject_email: requestForm.subject_email,
          data_categories: requestForm.data_categories.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      toast("Privacy request submitted", "success");
      setShowRequestForm(false);
      setRequestForm({ type: "erasure", subject_name: "", subject_email: "", data_categories: "video,images" });
      await fetchRequests();
    } catch (err) { toast(err instanceof Error ? err.message : "Submit failed", "error"); }
  };

  const processRequest = async (id: string) => {
    setProcessingId(id);
    try {
      // Backend requires processor_id in the POST body
      const token = typeof window !== "undefined" ? localStorage.getItem("sentinel_token") : null;
      await apiFetch(`/api/privacy/requests/${id}/process`, {
        method: "POST",
        body: JSON.stringify({ processor_id: token ?? "system" }),
      });
      toast("Privacy request processed", "success");
      await fetchRequests();
    } catch (err) { toast(err instanceof Error ? err.message : "Processing failed", "error"); }
    finally { setProcessingId(null); }
  };

  /* ==================== Compliance Actions ==================== */

  const generateReport = async (type: string) => {
    setGeneratingReport(type);
    try {
      const raw = await apiFetch<Omit<ComplianceReport, "score" | "findings">>("/api/privacy/compliance-report", {
        method: "POST",
        body: JSON.stringify({ report_type: type }),
      });

      // --- Derive compliance score from real API data ---
      // Weight 1: Policy coverage (do we have any active policies configured?)
      const hasPolicies = (raw.retention_policies ?? 0) > 0;
      // Weight 2: Request completion rate (pending requests reduce compliance)
      const totalReqs = raw.privacy_requests?.total ?? 0;
      const completedReqs = raw.privacy_requests?.completed ?? 0;
      const pendingReqs = raw.privacy_requests?.pending ?? 0;
      const requestScore = totalReqs === 0
        ? 100
        : Math.round((completedReqs / totalReqs) * 100);
      // Weight 3: Audit trail existence
      const hasAuditLog = (raw.audit_log_entries ?? 0) > 0;
      // Weight 4: Overall status from backend
      const backendCompliant = raw.compliance_status === "compliant";

      // Combine: 40% policy presence, 30% request completion, 20% audit trail, 10% backend status
      const score = Math.round(
        (hasPolicies ? 40 : 0) +
        (requestScore * 0.3) +
        (hasAuditLog ? 20 : 0) +
        (backendCompliant ? 10 : 0)
      );

      // Build findings from real data
      const findings: ComplianceReport["findings"] = [
        {
          category: "Data Retention Policies",
          status: hasPolicies ? "pass" : "fail",
          details: hasPolicies
            ? `${raw.retention_policies} retention policy(ies) configured`
            : "No retention policies configured — data may be kept indefinitely",
        },
        {
          category: "Privacy Request Completion",
          status: pendingReqs === 0 ? "pass" : pendingReqs <= 2 ? "warn" : "fail",
          details: totalReqs === 0
            ? "No privacy requests on record"
            : `${completedReqs} of ${totalReqs} requests completed (${pendingReqs} pending)`,
        },
        {
          category: "Audit Trail",
          status: hasAuditLog ? "pass" : "warn",
          details: hasAuditLog
            ? `${raw.audit_log_entries.toLocaleString()} audit log entries recorded`
            : "Audit trail is empty — user actions are not being logged",
        },
        {
          category: "Overall Compliance Status",
          status: backendCompliant ? "pass" : "warn",
          details: backendCompliant
            ? "All active policies are in compliance"
            : "One or more policies need review",
        },
      ];

      setComplianceReport({ ...raw, score, findings });
      toast(`${type.toUpperCase()} report generated — score: ${score}%`, "success");
    } catch (err) { toast(err instanceof Error ? err.message : "Report generation failed", "error"); }
    finally { setGeneratingReport(null); }
  };

  /* ==================== GDPR CSV Export ==================== */
  const handleGDPRExport = async () => {
    setExportingGDPR(true);
    try {
      // Gather all available privacy audit data
      const [policiesData, requestsData, auditData] = await Promise.all([
        apiFetch<RetentionPolicy[]>("/api/privacy/retention-policies").catch(() => [] as RetentionPolicy[]),
        apiFetch<PrivacyRequest[]>("/api/privacy/requests").catch(() => [] as PrivacyRequest[]),
        apiFetch<AuditEntry[]>("/api/privacy/audit-trail").catch(() => [] as AuditEntry[]),
      ]);

      // Build a combined audit-focused CSV
      const rows = [
        // Retention policy rows
        ...policiesData.map((p) => ({
          section: "Retention Policy",
          id: p.id,
          name: p.name,
          data_type: p.data_type,
          retention_days: String(p.retention_days),
          auto_purge: p.auto_purge ? "Yes" : "No",
          last_purge: p.last_purge ?? "Never",
          records_purged: String(p.records_purged),
          subject: "",
          subject_email: "",
          status: "",
          action: "",
          timestamp: p.created_at,
          pii_detected: "",
        })),
        // Privacy request rows — check for PII
        ...requestsData.map((r) => {
          const rec = r as unknown as Record<string, unknown>;
          const piiFound = piiTypes(rec);
          return {
            section: "Privacy Request",
            id: r.id,
            name: r.request_type,
            data_type: r.data_categories.join("; "),
            retention_days: "",
            auto_purge: "",
            last_purge: "",
            records_purged: "",
            subject: r.subject_name,
            subject_email: r.subject_email,
            status: r.status,
            action: "",
            timestamp: r.created_at,
            pii_detected: piiFound.length > 0 ? piiFound.join("; ") : "None",
          };
        }),
        // Audit trail rows — check for PII
        ...auditData.map((e) => {
          const rec = e as unknown as Record<string, unknown>;
          const piiFound = piiTypes(rec);
          return {
            section: "Audit Entry",
            id: e.id,
            name: "",
            data_type: e.resource_type,
            retention_days: "",
            auto_purge: "",
            last_purge: "",
            records_purged: "",
            subject: e.user,
            subject_email: e.ip_address,
            status: "",
            action: e.action,
            timestamp: e.timestamp,
            pii_detected: piiFound.length > 0 ? piiFound.join("; ") : "None",
          };
        }),
      ];

      exportCSV(rows as unknown as Record<string, unknown>[], `gdpr_audit_report_${new Date().toISOString().slice(0, 10)}.csv`, [
        { key: "section", label: "Section" },
        { key: "id", label: "ID" },
        { key: "name", label: "Name / Type" },
        { key: "data_type", label: "Data Type / Categories" },
        { key: "retention_days", label: "Retention Days" },
        { key: "auto_purge", label: "Auto Purge" },
        { key: "last_purge", label: "Last Purge" },
        { key: "records_purged", label: "Records Purged" },
        { key: "subject", label: "Subject / User" },
        { key: "subject_email", label: "Subject Email / IP" },
        { key: "status", label: "Status" },
        { key: "action", label: "Action" },
        { key: "timestamp", label: "Timestamp" },
        { key: "pii_detected", label: "PII Detected" },
      ]);
      toast(`GDPR report exported — ${rows.length} records.`, "success");
    } catch {
      toast("Failed to generate GDPR report.", "error");
    } finally {
      setExportingGDPR(false);
    }
  };

  const reqStatusColor: Record<string, string> = {
    pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/40",
    processing: "bg-blue-500/20 text-blue-400 border-blue-500/40",
    completed: "bg-green-500/20 text-green-400 border-green-500/40",
    rejected: "bg-red-500/20 text-red-400 border-red-500/40",
  };

  return (
    <div className="bg-[#030712] text-zinc-100">
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-5 h-5 text-cyan-400" />
          <h1 className="text-lg font-semibold">Privacy & Compliance</h1>
        </div>
        <button
          onClick={handleGDPRExport}
          disabled={exportingGDPR}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-600/20 text-amber-400 hover:bg-amber-600/30 text-sm transition disabled:opacity-50 border border-amber-700/40"
        >
          {exportingGDPR ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          Generate GDPR Report
        </button>
      </header>

      {/* Tabs */}
      <div className="border-b border-zinc-800 bg-zinc-950/40 px-6">
        <nav className="flex gap-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={cn("flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition",
                  tab === t.id ? "border-cyan-400 text-cyan-400" : "border-transparent text-zinc-500 hover:text-zinc-300")}>
                <Icon className="w-4 h-4" /> {t.label}
              </button>
            );
          })}
        </nav>
      </div>

      <main className="p-6 max-w-7xl mx-auto">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin text-cyan-400" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-64 gap-3">
            <AlertTriangle className="w-8 h-8 text-red-400" />
            <p className="text-red-400">{error}</p>
          </div>
        ) : (
          <>
            {/* ========== RETENTION POLICIES ========== */}
            {tab === "retention" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Retention Policies</h2>
                  <div className="flex gap-2">
                    <button onClick={enforceRetention} disabled={enforcing}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600/20 text-amber-400 hover:bg-amber-600/30 text-sm transition disabled:opacity-50">
                      {enforcing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Run Enforcement Now
                    </button>
                    <button onClick={() => { setEditingPolicy(null); setPolicyForm({ name: "", data_type: "video", retention_days: 90, auto_purge: true }); setShowPolicyForm(true); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600/20 text-cyan-400 hover:bg-cyan-600/30 text-sm transition">
                      <Plus className="w-4 h-4" /> Create Policy
                    </button>
                  </div>
                </div>

                {/* Policy Form */}
                {showPolicyForm && (
                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium text-zinc-200">{editingPolicy ? "Edit Policy" : "New Retention Policy"}</h3>
                      <button onClick={() => { setShowPolicyForm(false); setEditingPolicy(null); }} className="text-zinc-500 hover:text-zinc-300"><X className="w-4 h-4" /></button>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                      <div>
                        <label className="text-xs text-zinc-500 mb-1 block">Policy Name</label>
                        <input value={policyForm.name} onChange={(e) => setPolicyForm({ ...policyForm, name: e.target.value })}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500" placeholder="e.g. Video Retention" />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-500 mb-1 block">Data Type</label>
                        <select value={policyForm.data_type} onChange={(e) => setPolicyForm({ ...policyForm, data_type: e.target.value })}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500">
                          <option value="video">Video</option>
                          <option value="images">Images</option>
                          <option value="logs">Logs</option>
                          <option value="alerts">Alerts</option>
                          <option value="analytics">Analytics</option>
                          <option value="pii">PII Data</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-zinc-500 mb-1 block">Retention Days</label>
                        <input type="number" value={policyForm.retention_days} onChange={(e) => setPolicyForm({ ...policyForm, retention_days: Number(e.target.value) })}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500" />
                      </div>
                      <div className="flex items-end gap-3">
                        <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
                          <input type="checkbox" checked={policyForm.auto_purge} onChange={(e) => setPolicyForm({ ...policyForm, auto_purge: e.target.checked })}
                            className="rounded bg-zinc-700 border-zinc-600 text-cyan-500 focus:ring-cyan-500" />
                          Auto-Purge
                        </label>
                        <button onClick={savePolicyHandler} className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-medium transition">
                          {editingPolicy ? "Update" : "Create"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Policy Table */}
                <div className="bg-zinc-950/60 border border-zinc-800 rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-zinc-800 bg-zinc-900/40">
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Name</th>
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Data Type</th>
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Retention</th>
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Auto-Purge</th>
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Last Purge</th>
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Purged</th>
                        <th className="text-right px-4 py-3 text-zinc-500 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/60">
                      {policies.map((p) => (
                        <tr key={p.id} className="hover:bg-zinc-900/30 transition">
                          <td className="px-4 py-3 text-zinc-200">{p.name}</td>
                          <td className="px-4 py-3 text-zinc-400 capitalize">{p.data_type}</td>
                          <td className="px-4 py-3 text-zinc-300">{p.retention_days} days</td>
                          <td className="px-4 py-3">
                            {p.auto_purge ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <XCircle className="w-4 h-4 text-zinc-600" />}
                          </td>
                          <td className="px-4 py-3 text-zinc-500 text-xs">{p.last_purge ? new Date(p.last_purge).toLocaleString() : "Never"}</td>
                          <td className="px-4 py-3 text-zinc-400">{p.records_purged.toLocaleString()}</td>
                          <td className="px-4 py-3 text-right">
                            <button onClick={() => startEditPolicy(p)} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-cyan-400 transition"><Pencil className="w-4 h-4" /></button>
                            <button onClick={() => deletePolicy(p.id)} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-red-400 transition ml-1"><Trash2 className="w-4 h-4" /></button>
                          </td>
                        </tr>
                      ))}
                      {policies.length === 0 && (
                        <tr><td colSpan={7} className="px-4 py-8 text-center text-zinc-600">No retention policies configured</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ========== PRIVACY REQUESTS ========== */}
            {tab === "requests" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Privacy Requests</h2>
                  <button onClick={() => setShowRequestForm(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600/20 text-cyan-400 hover:bg-cyan-600/30 text-sm transition">
                    <Plus className="w-4 h-4" /> New Request
                  </button>
                </div>

                {/* Request Form */}
                {showRequestForm && (
                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium text-zinc-200">New Privacy Request</h3>
                      <button onClick={() => setShowRequestForm(false)} className="text-zinc-500 hover:text-zinc-300"><X className="w-4 h-4" /></button>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-zinc-500 mb-1 block">Request Type</label>
                        <select value={requestForm.type} onChange={(e) => setRequestForm({ ...requestForm, type: e.target.value })}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500">
                          <option value="erasure">Erasure (Right to be Forgotten)</option>
                          <option value="access">Access (Data Portability)</option>
                          <option value="rectification">Rectification</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-zinc-500 mb-1 block">Subject Name</label>
                        <input value={requestForm.subject_name} onChange={(e) => setRequestForm({ ...requestForm, subject_name: e.target.value })}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500" placeholder="John Doe" />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-500 mb-1 block">Subject Email</label>
                        <input type="email" value={requestForm.subject_email} onChange={(e) => setRequestForm({ ...requestForm, subject_email: e.target.value })}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500" placeholder="john@example.com" />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-500 mb-1 block">Data Categories (comma-separated)</label>
                        <input value={requestForm.data_categories} onChange={(e) => setRequestForm({ ...requestForm, data_categories: e.target.value })}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500" placeholder="video, images, logs" />
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <button onClick={submitRequest} className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-medium transition">Submit Request</button>
                    </div>
                  </div>
                )}

                {/* Requests Table */}
                <div className="bg-zinc-950/60 border border-zinc-800 rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-zinc-800 bg-zinc-900/40">
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Type</th>
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Subject</th>
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Status</th>
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Created</th>
                        <th className="text-right px-4 py-3 text-zinc-500 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/60">
                      {requests.map((r) => {
                        const rec = r as unknown as Record<string, unknown>;
                        const piiFound = piiTypes(rec);
                        return (
                        <tr key={r.id} className="hover:bg-zinc-900/30 transition">
                          <td className="px-4 py-3">
                            <span className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 text-xs capitalize">{r.request_type}</span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2 flex-wrap">
                              <User className="w-3.5 h-3.5 text-zinc-500" />
                              <span className="text-zinc-200">{r.subject_name}</span>
                              <Mail className="w-3 h-3 text-zinc-600" />
                              <span className="text-zinc-500 text-xs">{r.subject_email}</span>
                              {piiFound.length > 0 && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-900/40 text-amber-400 border border-amber-700/60">
                                  ⚠ PII Detected: {piiFound.join(", ")}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className={cn("px-2 py-0.5 rounded border text-xs capitalize", reqStatusColor[r.status] || reqStatusColor.pending)}>
                              {r.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-zinc-500 text-xs">{new Date(r.created_at).toLocaleString()}</td>
                          <td className="px-4 py-3 text-right">
                            {r.status === "pending" && (
                              <button onClick={() => processRequest(r.id)} disabled={processingId === r.id}
                                className="flex items-center gap-1 px-2 py-1 rounded bg-green-600/20 text-green-400 hover:bg-green-600/30 text-xs transition disabled:opacity-50 ml-auto">
                                {processingId === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} Process
                              </button>
                            )}
                          </td>
                        </tr>
                        );
                      })}
                      {requests.length === 0 && (
                        <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-600">No privacy requests</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ========== AUDIT TRAIL ========== */}
            {tab === "audit" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Audit Trail</h2>
                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                      <input value={auditSearch} onChange={(e) => setAuditSearch(e.target.value)} placeholder="Search audit log..."
                        className="pl-9 pr-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-cyan-500 w-64" />
                    </div>
                    <button onClick={() => setShowAuditFilters(!showAuditFilters)}
                      className={cn("flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm transition",
                        showAuditFilters ? "bg-cyan-600/20 text-cyan-400" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700")}>
                      <Filter className="w-4 h-4" /> Filters
                    </button>
                    <button onClick={fetchAudit} className="p-1.5 rounded-lg bg-zinc-800 text-zinc-400 hover:bg-zinc-700 transition">
                      <RefreshCw className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {showAuditFilters && (
                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                      <div>
                        <label className="text-xs text-zinc-500 mb-1 block">User</label>
                        <input value={auditFilters.user} onChange={(e) => setAuditFilters({ ...auditFilters, user: e.target.value })}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500" placeholder="Username" />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-500 mb-1 block">Action</label>
                        <input value={auditFilters.action} onChange={(e) => setAuditFilters({ ...auditFilters, action: e.target.value })}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500" placeholder="e.g. create, delete" />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-500 mb-1 block">Resource Type</label>
                        <input value={auditFilters.resource_type} onChange={(e) => setAuditFilters({ ...auditFilters, resource_type: e.target.value })}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500" placeholder="e.g. alert, camera" />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-500 mb-1 block">Start Date</label>
                        <input type="date" value={auditFilters.start_date} onChange={(e) => setAuditFilters({ ...auditFilters, start_date: e.target.value })}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500" />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-500 mb-1 block">End Date</label>
                        <input type="date" value={auditFilters.end_date} onChange={(e) => setAuditFilters({ ...auditFilters, end_date: e.target.value })}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500" />
                      </div>
                    </div>
                  </div>
                )}

                <div className="bg-zinc-950/60 border border-zinc-800 rounded-xl overflow-hidden max-h-[600px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-zinc-900/90 backdrop-blur">
                      <tr className="border-b border-zinc-800">
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Time</th>
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">User</th>
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Action</th>
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Resource</th>
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">Details</th>
                        <th className="text-left px-4 py-3 text-zinc-500 font-medium">IP</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/60">
                      {auditEntries.map((entry) => {
                        const auditRec = entry as unknown as Record<string, unknown>;
                        const auditPII = piiTypes(auditRec);
                        return (
                        <tr key={entry.id} className="hover:bg-zinc-900/30 transition">
                          <td className="px-4 py-2.5 text-zinc-500 text-xs whitespace-nowrap">{new Date(entry.timestamp).toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-zinc-300">{entry.user}</td>
                          <td className="px-4 py-2.5">
                            <span className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 text-xs">{entry.action}</span>
                          </td>
                          <td className="px-4 py-2.5 text-zinc-400 text-xs">{entry.resource_type}/{entry.resource_id}</td>
                          <td className="px-4 py-2.5 text-xs max-w-xs">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-zinc-500 truncate">{entry.details}</span>
                              {auditPII.length > 0 && (
                                <span className="inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-900/40 text-amber-400 border border-amber-700/60">
                                  ⚠ PII: {auditPII.join(", ")}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-zinc-600 text-xs">{entry.ip_address}</td>
                        </tr>
                        );
                      })}
                      {auditEntries.length === 0 && (
                        <tr><td colSpan={6} className="px-4 py-8 text-center text-zinc-600">No audit entries found</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ========== COMPLIANCE REPORTS ========== */}
            {tab === "compliance" && (
              <div className="space-y-6">
                <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Generate Compliance Report</h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {[
                    { type: "soc2", label: "SOC 2", desc: "Service Organization Control audit report" },
                    { type: "gdpr", label: "GDPR", desc: "General Data Protection Regulation compliance" },
                    { type: "ccpa", label: "CCPA", desc: "California Consumer Privacy Act compliance" },
                  ].map((r) => (
                    <div key={r.type} className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 flex flex-col gap-3">
                      <div className="flex items-center gap-2">
                        <FileText className="w-5 h-5 text-cyan-400" />
                        <h3 className="text-lg font-semibold text-zinc-200">{r.label}</h3>
                      </div>
                      <p className="text-sm text-zinc-500 flex-1">{r.desc}</p>
                      <button onClick={() => generateReport(r.type)} disabled={generatingReport === r.type}
                        className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-medium transition disabled:opacity-50">
                        {generatingReport === r.type ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                        Generate Report
                      </button>
                    </div>
                  ))}
                </div>

                {complianceReport && (
                  <div className="bg-zinc-950/60 border border-zinc-800 rounded-xl p-6 space-y-5">
                    {/* Header row */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <FileText className="w-5 h-5 text-cyan-400" />
                        <h3 className="text-lg font-semibold text-zinc-200">{complianceReport.report_type.toUpperCase()} Report</h3>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-zinc-500">Generated {new Date(complianceReport.generated_at).toLocaleString()}</span>
                        <div className={cn("px-3 py-1 rounded-full text-sm font-bold",
                          complianceReport.score >= 90 ? "bg-green-500/20 text-green-400" :
                          complianceReport.score >= 70 ? "bg-yellow-500/20 text-yellow-400" :
                          "bg-red-500/20 text-red-400")}>
                          Score: {complianceReport.score}%
                        </div>
                      </div>
                    </div>

                    {/* Live data summary from API */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-3 text-center">
                        <p className="text-2xl font-bold text-cyan-400">{complianceReport.retention_policies}</p>
                        <p className="text-xs text-zinc-500 mt-1">Retention Policies</p>
                      </div>
                      <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-3 text-center">
                        <p className="text-2xl font-bold text-zinc-200">{complianceReport.privacy_requests?.total ?? 0}</p>
                        <p className="text-xs text-zinc-500 mt-1">Total Requests</p>
                      </div>
                      <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-3 text-center">
                        <p className="text-2xl font-bold text-yellow-400">{complianceReport.privacy_requests?.pending ?? 0}</p>
                        <p className="text-xs text-zinc-500 mt-1">Pending Requests</p>
                      </div>
                      <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-3 text-center">
                        <p className="text-2xl font-bold text-zinc-300">{complianceReport.audit_log_entries?.toLocaleString() ?? 0}</p>
                        <p className="text-xs text-zinc-500 mt-1">Audit Log Entries</p>
                      </div>
                    </div>

                    {/* Findings derived from real API data */}
                    {complianceReport.findings && complianceReport.findings.length > 0 && (
                      <div className="space-y-2">
                        <h4 className="text-sm font-medium text-zinc-400">Findings</h4>
                        {complianceReport.findings.map((f, i) => (
                          <div key={i} className="flex items-start gap-3 bg-zinc-900/40 rounded-lg p-3">
                            {f.status === "pass" ? <CheckCircle2 className="w-4 h-4 text-green-400 mt-0.5 shrink-0" /> :
                             f.status === "fail" ? <XCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" /> :
                             <AlertTriangle className="w-4 h-4 text-yellow-400 mt-0.5 shrink-0" />}
                            <div>
                              <span className="text-sm font-medium text-zinc-200">{f.category}</span>
                              <p className="text-xs text-zinc-500 mt-0.5">{f.details}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
