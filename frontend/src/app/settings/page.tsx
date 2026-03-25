"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Settings,
  Users,
  Server,
  ScrollText,
  Plus,
  Loader2,
  CheckCircle2,
  XCircle,
  Edit3,
  ToggleLeft,
  ToggleRight,
  RefreshCw,
  Trash2,
  Database,
  Wifi,
  Globe,
  ChevronLeft,
  ChevronRight,
  ShieldAlert,
  ShieldCheck,
  Clock,
  AlertTriangle,
  Zap,
  Gauge,
  Brain,
  Sparkles,
  Download,
  HardDrive,
} from "lucide-react";
import { cn, apiFetch, API_BASE, WS_BASE, formatTimestamp } from "@/lib/utils";
import type { User, OperationModeStatus } from "@/lib/types";
import { useToast } from "@/components/common/Toaster";
import SystemHealthGauge from "@/components/common/SystemHealthGauge";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type TabKey = "users" | "system" | "audit";

interface AuditEntry {
  id: string;
  timestamp: string;
  user_email: string | null;
  action: string;
  details: string | null;
}

interface AuditResponse {
  items: AuditEntry[];
  total: number;
}

/* ------------------------------------------------------------------ */
/*  Deep health types                                                  */
/* ------------------------------------------------------------------ */

interface DeepHealthMetric {
  value: number;
  unit?: string;
  status?: "healthy" | "warning" | "critical" | "offline";
}

interface DeepHealthData {
  cpu?: DeepHealthMetric | number;
  memory?: DeepHealthMetric | number;
  disk?: DeepHealthMetric | number;
  gpu?: DeepHealthMetric | number;
  cpu_percent?: number;
  memory_percent?: number;
  disk_percent?: number;
  gpu_percent?: number;
}

/* ------------------------------------------------------------------ */
/*  Role badge                                                         */
/* ------------------------------------------------------------------ */

const roleBadgeColor: Record<string, string> = {
  admin: "bg-red-500/10 text-red-400 border-red-500/30",
  analyst: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
  operator: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  viewer: "bg-gray-500/10 text-gray-400 border-gray-500/30",
};

/* ------------------------------------------------------------------ */
/*  Add User Form                                                      */
/* ------------------------------------------------------------------ */

interface AddUserFormProps {
  onCreated: () => void;
  onCancel: () => void;
}

function AddUserForm({ onCreated, onCancel }: AddUserFormProps) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<User["role"]>("viewer");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await apiFetch("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          email,
          full_name: fullName,
          password,
          role,
        }),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-gray-800 bg-gray-900/60 p-4 space-y-4"
    >
      <h3 className="text-sm font-semibold text-gray-200">New User</h3>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-400">
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            placeholder="user@sentinel.local"
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-400">
            Full Name
          </label>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            placeholder="John Doe"
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-400">
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            placeholder="Min 8 characters"
            required
            minLength={8}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-400">
            Role
          </label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as User["role"])}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          >
            <option value="admin">Admin</option>
            <option value="analyst">Analyst</option>
            <option value="operator">Operator</option>
            <option value="viewer">Viewer</option>
          </select>
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={loading}
          className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {loading ? "Creating..." : "Create User"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Users Tab                                                          */
/* ------------------------------------------------------------------ */

function UsersTab() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [error, setError] = useState("");

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch<User[]>("/api/auth/users");
      setUsers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleToggleActive = async (user: User) => {
    try {
      await apiFetch(`/api/auth/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: !user.is_active }),
      });
      fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update user");
    }
  };

  const handleRoleChange = async (userId: string, newRole: User["role"]) => {
    try {
      await apiFetch(`/api/auth/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: newRole }),
      });
      setEditingRole(null);
      fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update role");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">
          {users.length} user{users.length !== 1 && "s"} registered
        </p>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-2 rounded-lg bg-cyan-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500"
        >
          <Plus className="h-4 w-4" />
          Add User
        </button>
      </div>

      {showAddForm && (
        <AddUserForm
          onCreated={() => {
            setShowAddForm(false);
            fetchUsers();
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-gray-800 bg-gray-900/60">
            <tr>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-gray-400">
                Email
              </th>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-gray-400">
                Name
              </th>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-gray-400">
                Role
              </th>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-gray-400">
                Status
              </th>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-gray-400">
                Created
              </th>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-gray-400">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {users.map((user) => (
              <tr
                key={user.id}
                className="bg-gray-950 transition-colors hover:bg-gray-900/50"
              >
                <td className="px-4 py-3 font-mono text-xs text-gray-200">
                  {user.email}
                </td>
                <td className="px-4 py-3 text-gray-300">{user.full_name}</td>
                <td className="px-4 py-3">
                  {editingRole === user.id ? (
                    <select
                      defaultValue={user.role}
                      onChange={(e) =>
                        handleRoleChange(user.id, e.target.value as User["role"])
                      }
                      onBlur={() => setEditingRole(null)}
                      autoFocus
                      className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-100 focus:border-cyan-700 focus:outline-none"
                    >
                      <option value="admin">Admin</option>
                      <option value="analyst">Analyst</option>
                      <option value="operator">Operator</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  ) : (
                    <span
                      className={cn(
                        "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                        roleBadgeColor[user.role] || roleBadgeColor.viewer
                      )}
                    >
                      {user.role}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {user.is_active ? (
                    <span className="flex items-center gap-1 text-xs text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" /> Active
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs text-gray-500">
                      <XCircle className="h-3 w-3" /> Inactive
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-gray-500">
                  {formatTimestamp(user.created_at)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setEditingRole(user.id)}
                      className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-800 hover:text-cyan-400"
                      title="Edit role"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => handleToggleActive(user)}
                      className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-800 hover:text-amber-400"
                      title={user.is_active ? "Deactivate" : "Activate"}
                    >
                      {user.is_active ? (
                        <ToggleRight className="h-3.5 w-3.5" />
                      ) : (
                        <ToggleLeft className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  System Tab                                                         */
/* ------------------------------------------------------------------ */

interface PerformanceModeConfig {
  label: string;
  gemini_enabled: boolean;
  thinking_level: string | null;
  cycle_multiplier: number;
  analysis_interval: number;
  max_output_tokens: number;
  description: string;
  use_case?: string;
  model?: string;
  ai_provider?: string | null;
}

interface PerformanceModeResponse {
  mode: string;
  modes: Record<string, PerformanceModeConfig>;
}

const PERF_MODE_ICONS: Record<string, typeof Zap> = {
  ultra_fast: Zap,
  low_latency: Gauge,
  standard: Brain,
  advanced: Sparkles,
  max_accuracy: ShieldCheck,
};

const PERF_MODE_COLORS: Record<string, { border: string; bg: string; text: string; ring: string }> = {
  ultra_fast: { border: "border-orange-500/50", bg: "bg-orange-900/20", text: "text-orange-400", ring: "ring-orange-500/50" },
  low_latency: { border: "border-amber-500/50", bg: "bg-amber-900/20", text: "text-amber-400", ring: "ring-amber-500/50" },
  standard: { border: "border-cyan-500/50", bg: "bg-cyan-900/20", text: "text-cyan-400", ring: "ring-cyan-500/50" },
  advanced: { border: "border-purple-500/50", bg: "bg-purple-900/20", text: "text-purple-400", ring: "ring-purple-500/50" },
  max_accuracy: { border: "border-red-500/50", bg: "bg-red-900/20", text: "text-red-400", ring: "ring-red-500/50" },
};

function SystemTab() {
  const { addToast } = useToast();

  const [modeStatus, setModeStatus] = useState<OperationModeStatus | null>(null);
  const [switching, setSwitching] = useState(false);
  const [savingTimeout, setSavingTimeout] = useState(false);
  const [timeoutInput, setTimeoutInput] = useState("");
  const [modeError, setModeError] = useState("");
  const [showConfirm, setShowConfirm] = useState<"autonomous" | "hitl" | null>(null);

  // Performance mode state
  const [perfData, setPerfData] = useState<PerformanceModeResponse | null>(null);
  const [switchingPerf, setSwitchingPerf] = useState(false);

  // AI Provider state
  const [aiProvider, setAiProvider] = useState<string>("auto");
  const [switchingProvider, setSwitchingProvider] = useState(false);

  // System action loading states
  const [clearingCache, setClearingCache] = useState(false);
  const [resettingAnalytics, setResettingAnalytics] = useState(false);
  const [exportingConfig, setExportingConfig] = useState(false);
  const [backingUp, setBackingUp] = useState(false);

  // System health
  const [deepHealth, setDeepHealth] = useState<DeepHealthData | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);

  const fetchMode = useCallback(async () => {
    try {
      const data = await apiFetch<OperationModeStatus>("/api/operation-mode");
      setModeStatus(data);
      setTimeoutInput(String(Math.floor(data.auto_approve_timeout / 60)));
    } catch {
      // silent
    }
  }, []);

  const fetchPerfMode = useCallback(async () => {
    try {
      const data = await apiFetch<PerformanceModeResponse>("/api/operation-mode/performance");
      setPerfData(data);
    } catch {
      // silent
    }
  }, []);

  const fetchAiProvider = useCallback(async () => {
    try {
      const data = await apiFetch<{ provider: string }>("/api/operation-mode/ai-provider");
      setAiProvider(data.provider);
    } catch {
      // silent
    }
  }, []);

  const fetchDeepHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const data = await apiFetch<DeepHealthData>("/api/health/deep");
      setDeepHealth(data);
    } catch {
      // silent — panel shows N/A if unavailable
    } finally {
      setHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMode();
    fetchPerfMode();
    fetchAiProvider();
    fetchDeepHealth();
  }, [fetchMode, fetchPerfMode, fetchAiProvider, fetchDeepHealth]);

  const handleSwitchPerfMode = async (newMode: string) => {
    setSwitchingPerf(true);
    try {
      await apiFetch("/api/operation-mode/performance", {
        method: "PUT",
        body: JSON.stringify({ mode: newMode }),
      });
      await fetchPerfMode();
    } catch (err) {
      setModeError(err instanceof Error ? err.message : "Failed to switch performance mode");
    } finally {
      setSwitchingPerf(false);
    }
  };

  const handleSwitchProvider = async (provider: string) => {
    setSwitchingProvider(true);
    try {
      await apiFetch("/api/operation-mode/ai-provider", {
        method: "PUT",
        body: JSON.stringify({ provider }),
      });
      setAiProvider(provider);
    } catch (err) {
      setModeError(err instanceof Error ? err.message : "Failed to switch AI provider");
    } finally {
      setSwitchingProvider(false);
    }
  };

  const handleSwitchMode = async (newMode: "autonomous" | "hitl") => {
    setShowConfirm(null);
    setSwitching(true);
    setModeError("");
    try {
      await apiFetch("/api/operation-mode", {
        method: "PUT",
        body: JSON.stringify({ mode: newMode }),
      });
      await fetchMode();
    } catch (err) {
      setModeError(err instanceof Error ? err.message : "Failed to switch mode");
    } finally {
      setSwitching(false);
    }
  };

  const handleSaveTimeout = async () => {
    const minutes = parseInt(timeoutInput, 10);
    if (isNaN(minutes) || minutes < 1 || minutes > 60) {
      setModeError("Timeout must be between 1 and 60 minutes");
      return;
    }
    setSavingTimeout(true);
    setModeError("");
    try {
      await apiFetch("/api/operation-mode/timeout", {
        method: "PUT",
        body: JSON.stringify({ timeout: minutes * 60 }),
      });
      await fetchMode();
    } catch (err) {
      setModeError(err instanceof Error ? err.message : "Failed to update timeout");
    } finally {
      setSavingTimeout(false);
    }
  };

  const handleClearCache = async () => {
    if (!window.confirm("Clear all system caches? This will flush Redis and in-memory LRU caches.")) return;
    setClearingCache(true);
    try {
      await apiFetch("/api/settings/clear-cache", { method: "POST" });
      addToast("success", "Cache cleared successfully");
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "Failed to clear cache");
    } finally {
      setClearingCache(false);
    }
  };

  const handleResetAnalytics = async () => {
    if (!window.confirm("Reset analytics? This will permanently delete all event records. Alerts, cameras, and users are preserved.")) return;
    setResettingAnalytics(true);
    try {
      const result = await apiFetch<{ message: string }>("/api/settings/reset-analytics", { method: "POST" });
      addToast("success", result.message || "Analytics reset successfully");
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "Failed to reset analytics");
    } finally {
      setResettingAnalytics(false);
    }
  };

  const handleExportConfig = async () => {
    setExportingConfig(true);
    try {
      const config = await apiFetch<Record<string, unknown>>("/api/settings");
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sentinel-config-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      addToast("success", "Configuration exported");
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "Failed to export configuration");
    } finally {
      setExportingConfig(false);
    }
  };

  const handleSystemBackup = async () => {
    setBackingUp(true);
    try {
      const result = await apiFetch<{ message: string; manifest: Record<string, unknown> }>("/api/settings/backup", { method: "POST" });
      addToast("success", result.message || "System backup completed");
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "Failed to create system backup");
    } finally {
      setBackingUp(false);
    }
  };

  /* ---- Normalise a DeepHealthData field to a numeric 0-100 value ---- */
  function resolveMetric(raw: DeepHealthMetric | number | undefined): { value: number; status?: "healthy" | "warning" | "critical" | "offline" } {
    if (raw === undefined || raw === null) return { value: 0, status: "offline" };
    if (typeof raw === "number") return { value: raw };
    return { value: raw.value ?? 0, status: raw.status };
  }

  return (
    <div className="space-y-6">
      {/* System Health */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-300">
            System Health
          </h3>
          <button
            onClick={fetchDeepHealth}
            disabled={healthLoading}
            className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            {healthLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Refresh
          </button>
        </div>
        {healthLoading && !deepHealth ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-cyan-400" />
          </div>
        ) : (
          <div className="flex items-end justify-around gap-4 flex-wrap">
            {(() => {
              const cpu = resolveMetric(deepHealth?.cpu ?? deepHealth?.cpu_percent);
              const mem = resolveMetric(deepHealth?.memory ?? deepHealth?.memory_percent);
              const disk = resolveMetric(deepHealth?.disk ?? deepHealth?.disk_percent);
              const gpu = resolveMetric(deepHealth?.gpu ?? deepHealth?.gpu_percent);
              return (
                <>
                  <SystemHealthGauge label="CPU" value={cpu.value} unit="%" status={cpu.status ?? (deepHealth ? undefined : "offline")} size={88} />
                  <SystemHealthGauge label="Memory" value={mem.value} unit="%" status={mem.status ?? (deepHealth ? undefined : "offline")} size={88} />
                  <SystemHealthGauge label="Disk" value={disk.value} unit="%" status={disk.status ?? (deepHealth ? undefined : "offline")} size={88} />
                  <SystemHealthGauge label="GPU" value={gpu.value} unit="%" status={gpu.status ?? (deepHealth ? undefined : "offline")} size={88} />
                </>
              );
            })()}
          </div>
        )}
        {!deepHealth && !healthLoading && (
          <p className="text-center text-xs text-gray-600">Health metrics unavailable</p>
        )}
      </div>

      {/* AI Provider */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-5 space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-300">
          AI Provider
        </h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          Select which AI backend powers analysis and reasoning. Choose between{" "}
          <strong className="text-gray-300">cloud</strong> or{" "}
          <strong className="text-gray-300">local</strong> models.
        </p>

        {/* AI Provider Selection */}
        <div>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-2 block">
            AI Provider
          </span>
          <div className="grid grid-cols-2 gap-3">
            {[
              { key: "gemini", label: "Gemini", desc: "Google Gemini (primary provider)", color: "blue", badge: "PRIMARY" },
              { key: "ollama", label: "Ollama", desc: "Local Ollama models (fallback)", color: "purple", badge: "FALLBACK" },
            ].map((opt) => {
              const isActive = aiProvider === opt.key;
              const borderCls = isActive ? `border-${opt.color}-500/50` : "border-gray-700/50";
              const bgCls = isActive ? `bg-${opt.color}-900/20` : "bg-gray-950";
              const textCls = isActive ? `text-${opt.color}-400` : "text-gray-400";
              const ringCls = isActive ? `ring-2 ring-${opt.color}-500/50` : "";
              return (
                <button
                  key={opt.key}
                  onClick={() => handleSwitchProvider(opt.key)}
                  disabled={switchingProvider}
                  className={cn(
                    "relative flex flex-col items-center gap-1.5 rounded-lg border p-3 transition-all text-center",
                    borderCls, bgCls, ringCls,
                    !isActive && "hover:bg-gray-900/50 hover:border-gray-600",
                    switchingProvider && "opacity-60 cursor-wait"
                  )}
                >
                  <span className={cn("text-xs font-bold uppercase tracking-wider", textCls)}>
                    {opt.label}
                  </span>
                  <span className="text-[10px] text-gray-500 leading-relaxed">
                    {opt.desc}
                  </span>
                  <span className={cn("text-[8px] font-bold uppercase tracking-widest rounded-full px-2 py-0.5 border",
                    opt.key === "gemini" ? "border-blue-500/40 text-blue-400" : "border-purple-500/40 text-purple-400"
                  )}>
                    {opt.badge}
                  </span>
                  {isActive && (
                    <span className={`absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-${opt.color}-400`} />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Performance Mode */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-5 space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-300">
          Performance Mode
        </h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          Control the balance between <strong className="text-gray-300">speed</strong> and{" "}
          <strong className="text-gray-300">analysis depth</strong>. Gemini is the primary AI provider. Higher modes use deeper reasoning but consume more API calls.
        </p>

        {perfData && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {Object.entries(perfData.modes).map(([key, cfg]) => {
              const isActive = perfData.mode === key;
              const Icon = PERF_MODE_ICONS[key] || Brain;
              const colors = PERF_MODE_COLORS[key] || PERF_MODE_COLORS.standard;
              const model = (cfg as any).model;
              const useCase = (cfg as any).use_case;
              return (
                <button
                  key={key}
                  onClick={() => handleSwitchPerfMode(key)}
                  disabled={switchingPerf}
                  className={cn(
                    "relative flex flex-col items-center gap-1.5 rounded-lg border p-4 transition-all text-center",
                    isActive
                      ? `${colors.border} ${colors.bg} ring-2 ${colors.ring}`
                      : "border-gray-700/50 bg-gray-950 hover:bg-gray-900/50 hover:border-gray-600",
                    switchingPerf && "opacity-60 cursor-wait"
                  )}
                >
                  <Icon className={cn("h-6 w-6", isActive ? colors.text : "text-gray-500")} />
                  <span className={cn(
                    "text-xs font-bold uppercase tracking-wider",
                    isActive ? colors.text : "text-gray-400"
                  )}>
                    {cfg.label}
                  </span>
                  {model && (
                    <span className="text-[9px] font-mono text-gray-600">
                      {model}
                    </span>
                  )}
                  <span className="text-[10px] text-gray-500 leading-relaxed">
                    {cfg.description}
                  </span>
                  {useCase && (
                    <span className="text-[9px] text-gray-600 italic leading-tight mt-0.5">
                      {useCase}
                    </span>
                  )}
                  {isActive && (
                    <span className={cn(
                      "absolute top-1.5 right-1.5 h-2 w-2 rounded-full",
                      colors.text.replace("text-", "bg-")
                    )} />
                  )}
                  {key === "standard" && !isActive && (
                    <span className="text-[8px] text-cyan-600 uppercase tracking-wider font-bold">
                      Recommended
                    </span>
                  )}
                  {key === "max_accuracy" && !isActive && (
                    <span className="text-[8px] text-red-600 uppercase tracking-wider font-bold">
                      High Cost
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Operation Mode */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-5 space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-300">
          Operation Mode
        </h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          Switch between <strong className="text-gray-300">Autonomous</strong> (agents act independently) and{" "}
          <strong className="text-gray-300">Human-in-the-Loop (HITL)</strong> (action-tier tools require human approval).
        </p>

        {modeError && (
          <div className="rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 text-sm text-red-400 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {modeError}
          </div>
        )}

        {modeStatus && (
          <>
            {/* Mode Toggle */}
            <div className="flex items-center gap-4">
              <button
                onClick={() => {
                  const target = modeStatus.mode === "autonomous" ? "hitl" : "autonomous";
                  setShowConfirm(target);
                }}
                disabled={switching}
                className={cn(
                  "flex items-center gap-3 rounded-lg border px-5 py-3 text-sm font-semibold transition-all",
                  modeStatus.mode === "autonomous"
                    ? "border-emerald-700/50 bg-emerald-900/20 text-emerald-400 hover:bg-emerald-900/30"
                    : "border-amber-700/50 bg-amber-900/20 text-amber-400 hover:bg-amber-900/30",
                  switching && "opacity-50 cursor-not-allowed"
                )}
              >
                {switching ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : modeStatus.mode === "autonomous" ? (
                  <ShieldCheck className="h-5 w-5" />
                ) : (
                  <ShieldAlert className="h-5 w-5" />
                )}
                {modeStatus.mode === "autonomous" ? "AUTONOMOUS MODE" : "HITL MODE"}
              </button>

              <div className="text-xs text-gray-500">
                {modeStatus.mode === "autonomous"
                  ? "All agents operate independently. Click to switch to HITL."
                  : `Actions require approval. ${modeStatus.pending_count} pending. Click to switch to Autonomous.`}
              </div>
            </div>

            {/* Confirmation Dialog */}
            {showConfirm && (
              <div className="rounded-lg border border-amber-800/50 bg-amber-900/10 p-4 space-y-3">
                <p className="text-sm text-amber-300">
                  {showConfirm === "hitl"
                    ? "Switch to HITL mode? Action-tier tools (create_alert, send_notification, etc.) will require human approval before execution."
                    : "Switch to Autonomous mode? All pending actions will be auto-approved and agents will resume fully autonomous operation."}
                </p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => handleSwitchMode(showConfirm)}
                    className={cn(
                      "rounded-lg px-4 py-2 text-sm font-semibold text-white",
                      showConfirm === "hitl" ? "bg-amber-600 hover:bg-amber-500" : "bg-emerald-600 hover:bg-emerald-500"
                    )}
                  >
                    Confirm Switch
                  </button>
                  <button
                    onClick={() => setShowConfirm(null)}
                    className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:bg-gray-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Auto-Approve Timeout */}
            <div className="flex items-end gap-3 pt-2">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-400">
                  Auto-Approve Timeout (minutes)
                </label>
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-gray-500" />
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={timeoutInput}
                    onChange={(e) => setTimeoutInput(e.target.value)}
                    className="w-20 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
                  />
                </div>
                <p className="mt-1 text-[10px] text-gray-600">
                  Pending actions auto-approve after this timeout if no human acts.
                </p>
              </div>
              <button
                onClick={handleSaveTimeout}
                disabled={savingTimeout}
                className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:opacity-50"
              >
                {savingTimeout && <Loader2 className="h-4 w-4 animate-spin" />}
                Save
              </button>
            </div>
          </>
        )}
      </div>

      {/* Current Config */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-5 space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-300">
          Current Configuration
        </h3>

        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-950 px-4 py-3">
            <Globe className="h-4 w-4 text-cyan-400" />
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-gray-400">
                API URL
              </p>
              <p className="font-mono text-sm text-gray-200">{API_BASE}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-950 px-4 py-3">
            <Wifi className="h-4 w-4 text-cyan-400" />
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-gray-400">
                WebSocket URL
              </p>
              <p className="font-mono text-sm text-gray-200">{WS_BASE}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-950 px-4 py-3">
            <Database className="h-4 w-4 text-emerald-400" />
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-gray-400">
                Database Status
              </p>
              <p className="flex items-center gap-2 text-sm text-emerald-400">
                <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400" />
                Connected
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* System Actions */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-5 space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-300">
          System Actions
        </h3>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={handleClearCache}
            disabled={clearingCache}
            className="flex items-center gap-2 rounded-lg border border-red-800/50 bg-red-900/10 px-4 py-2 text-sm text-red-400 transition-colors hover:bg-red-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {clearingCache ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            {clearingCache ? "Clearing..." : "Clear Cache"}
          </button>
          <button
            onClick={handleResetAnalytics}
            disabled={resettingAnalytics}
            className="flex items-center gap-2 rounded-lg border border-amber-800/50 bg-amber-900/10 px-4 py-2 text-sm text-amber-400 transition-colors hover:bg-amber-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {resettingAnalytics ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {resettingAnalytics ? "Resetting..." : "Reset Analytics"}
          </button>
          <button
            onClick={handleExportConfig}
            disabled={exportingConfig}
            className="flex items-center gap-2 rounded-lg border border-cyan-800/50 bg-cyan-900/10 px-4 py-2 text-sm text-cyan-400 transition-colors hover:bg-cyan-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {exportingConfig ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {exportingConfig ? "Exporting..." : "Export Config"}
          </button>
          <button
            onClick={handleSystemBackup}
            disabled={backingUp}
            className="flex items-center gap-2 rounded-lg border border-emerald-800/50 bg-emerald-900/10 px-4 py-2 text-sm text-emerald-400 transition-colors hover:bg-emerald-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {backingUp ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <HardDrive className="h-4 w-4" />
            )}
            {backingUp ? "Backing up..." : "System Backup"}
          </button>
        </div>
        <p className="text-xs text-gray-600">
          Destructive actions (Clear Cache, Reset Analytics) require confirmation. Export Config downloads a JSON snapshot.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Audit Log Tab                                                      */
/* ------------------------------------------------------------------ */

function AuditLogTab() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const limit = 50;

  const fetchAuditLog = useCallback(async () => {
    setLoading(true);
    setError("");
    setUnavailable(false);

    const ENDPOINTS = [
      `/api/audit-log?limit=${limit}&offset=${offset}`,
      `/api/settings/audit-log?limit=${limit}&offset=${offset}`,
      `/api/analytics/audit-log?limit=${limit}&offset=${offset}`,
    ];

    for (const endpoint of ENDPOINTS) {
      try {
        const data = await apiFetch<AuditResponse>(endpoint);
        setEntries(data.items ?? []);
        setTotal(data.total ?? 0);
        setLoading(false);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        // If 404/not-found, try next endpoint
        if (msg.includes("404") || msg.toLowerCase().includes("not found")) continue;
        // Any other error — surface it
        setError(msg || "Failed to load audit log");
        setLoading(false);
        return;
      }
    }
    // All endpoints returned 404
    setUnavailable(true);
    setLoading(false);
  }, [offset]);

  useEffect(() => {
    fetchAuditLog();
  }, [fetchAuditLog]);

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.floor(offset / limit) + 1;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
      </div>
    );
  }

  if (unavailable) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-gray-800 bg-gray-900/60 py-16 text-center">
        <ScrollText className="mb-3 h-10 w-10 text-gray-700" />
        <p className="text-sm font-medium text-gray-400">Audit log not available</p>
        <p className="mt-1 text-xs text-gray-600">The audit log endpoint is not configured on this instance.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <p className="text-sm text-gray-400">
        {total} audit log entr{total !== 1 ? "ies" : "y"}
      </p>

      <div className="space-y-2">
        {entries.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-gray-800 bg-gray-900/60 py-12 text-center">
            <ScrollText className="mb-2 h-8 w-8 text-gray-700" />
            <p className="text-sm text-gray-500">No audit log entries</p>
          </div>
        )}

        {entries.map((entry) => (
          <div
            key={entry.id}
            className="rounded-lg border border-gray-800 bg-gray-900/60 px-4 py-3 transition-colors hover:bg-gray-900"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="inline-flex rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-400 border border-cyan-500/30">
                    {entry.action}
                  </span>
                  {entry.user_email && (
                    <span className="text-xs text-gray-400">
                      by {entry.user_email}
                    </span>
                  )}
                </div>
                {entry.details && (
                  <p className="text-xs leading-relaxed text-gray-400">
                    {entry.details}
                  </p>
                )}
              </div>
              <span className="whitespace-nowrap font-mono text-[10px] text-gray-600">
                {formatTimestamp(entry.timestamp)}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between border-t border-gray-800 pt-4">
          <button
            onClick={() => setOffset(Math.max(0, offset - limit))}
            disabled={offset === 0}
            className="flex items-center gap-1 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </button>
          <span className="text-xs text-gray-500">
            Page {currentPage} of {totalPages}
          </span>
          <button
            onClick={() =>
              setOffset(Math.min(offset + limit, (totalPages - 1) * limit))
            }
            disabled={offset + limit >= total}
            className="flex items-center gap-1 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Settings Page                                                      */
/* ------------------------------------------------------------------ */

const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: "users", label: "Users", icon: <Users className="h-4 w-4" /> },
  { key: "system", label: "System", icon: <Server className="h-4 w-4" /> },
  {
    key: "audit",
    label: "Audit Log",
    icon: <ScrollText className="h-4 w-4" />,
  },
];

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("users");

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
            <Settings className="h-5 w-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wider text-gray-100 uppercase">
              Settings
            </h1>
            <p className="text-xs text-gray-500">
              Manage users, system configuration, and audit logs
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-800">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                "flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors",
                activeTab === tab.key
                  ? "border-cyan-400 text-cyan-400"
                  : "border-transparent text-gray-500 hover:border-gray-700 hover:text-gray-300"
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div>
          {activeTab === "users" && <UsersTab />}
          {activeTab === "system" && <SystemTab />}
          {activeTab === "audit" && <AuditLogTab />}
        </div>
      </div>
    </div>
  );
}
