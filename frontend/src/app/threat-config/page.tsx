"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Shield,
  Target,
  Users,
  Lock,
  Eye,
  ClipboardList,
  Send,
  Loader2,
  Play,
  Square,
  RotateCcw,
  Zap,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  Sliders,
  BookOpen,
  Power,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Plus,
  Package,
  Clock,
  Sparkles,
  Globe,
  Calendar,
  BarChart3,
  Activity,
  Building2,
  Hospital,
  GraduationCap,
  TreePine,
  Warehouse,
  ShoppingCart,
  Plane,
  Home,
  XCircle,
  History,
  TrendingUp,
  Fingerprint,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { apiFetch, cn } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Protocol {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  agents: Record<string, string[]>;
  sensitivity: Record<string, number>;
  tier_status: Record<string, boolean>;
}

interface ActiveProtocol {
  protocol_id: string;
  name: string;
  deployed_at: string;
  status: string;
}

interface DetectionRule {
  id: string;
  name: string;
  description: string;
  category: string;
  conditions: Record<string, unknown>;
  actions: string[];
  severity: string;
  enabled: boolean;
}

interface SensitivityConfig {
  perception_sensitivity: number;
  anomaly_threshold: number;
  threat_escalation_threshold: number;
  crowd_density_threshold: number;
  [key: string]: number;
}

interface AgentStatus {
  name: string;
  tier: string;
  running: boolean;
  role: string;
  description: string;
  cycle_count: number;
}

interface NLPResponse {
  status: string;
  command: string;
  cortex_response: {
    response: string;
    tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
  };
}

interface QuickScenario {
  id: string;
  name: string;
  description: string;
  icon: string;
}

interface ScenarioDeployment {
  id: string;
  scenario_id: string;
  scenario_name: string;
  deployed_at: string;
  status: string;
  deactivated_at?: string;
}

interface EnvironmentProfile {
  name: string;
  display_name: string;
  description: string;
  boosted_categories: string[];
  suppressed_categories: string[];
  sensitivity_overrides: Record<string, number>;
  default_severity_boost: number;
  enabled_signatures: string[];
  disabled_signatures: string[];
}

interface ScheduleEntry {
  name: string;
  days: string[];
  start_hour: number;
  end_hour: number;
  mode?: string;
  performance?: string;
  context_profile?: string;
}

interface CategoryStat {
  category: string;
  count: number;
  signatures: Array<{
    name: string;
    severity: string;
    detection_method: string;
    detection_count: number;
  }>;
}

interface VersionEntry {
  version: number;
  saved_at: string;
  label: string;
}

interface ThreatMetrics {
  total_signatures: number;
  total_categories: number;
  category_stats: CategoryStat[];
  agents_running: number;
  agents_total: number;
  active_rules: number;
  total_rules: number;
  rules_by_severity: Record<string, number>;
  rules_by_category: Record<string, number>;
  sensitivity: SensitivityConfig;
  active_protocol: string;
  deployed_scenarios_count: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const ICON_MAP: Record<string, typeof Shield> = {
  shield: Shield,
  target: Target,
  users: Users,
  lock: Lock,
  eye: Eye,
  clipboard: ClipboardList,
  package: Package,
  clock: Clock,
};

const ENV_ICON_MAP: Record<string, typeof Shield> = {
  bank: Building2,
  hospital: Hospital,
  school: GraduationCap,
  park: TreePine,
  warehouse: Warehouse,
  retail: ShoppingCart,
  airport: Plane,
  residential: Home,
};

const COLOR_MAP: Record<string, { bg: string; border: string; text: string; glow: string }> = {
  cyan: { bg: "bg-cyan-900/20", border: "border-cyan-700/50", text: "text-cyan-400", glow: "shadow-cyan-500/10" },
  orange: { bg: "bg-orange-900/20", border: "border-orange-700/50", text: "text-orange-400", glow: "shadow-orange-500/10" },
  violet: { bg: "bg-violet-900/20", border: "border-violet-700/50", text: "text-violet-400", glow: "shadow-violet-500/10" },
  red: { bg: "bg-red-900/20", border: "border-red-700/50", text: "text-red-400", glow: "shadow-red-500/10" },
  emerald: { bg: "bg-emerald-900/20", border: "border-emerald-700/50", text: "text-emerald-400", glow: "shadow-emerald-500/10" },
  blue: { bg: "bg-blue-900/20", border: "border-blue-700/50", text: "text-blue-400", glow: "shadow-blue-500/10" },
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: "text-red-400 bg-red-900/30 border-red-800/50",
  high: "text-orange-400 bg-orange-900/30 border-orange-800/50",
  medium: "text-yellow-400 bg-yellow-900/30 border-yellow-800/50",
  low: "text-blue-400 bg-blue-900/30 border-blue-800/50",
  info: "text-gray-400 bg-gray-800/30 border-gray-700/50",
};

const CATEGORY_LABELS: Record<string, string> = {
  intrusion: "Intrusion Detection",
  anomaly: "Anomaly Detection",
  crowd: "Crowd Analytics",
  compliance: "Compliance",
  custom: "Custom Rule",
  violence: "Violence & Weapons",
  theft: "Theft & Property",
  vehicle: "Vehicle Anomalies",
  safety: "Safety & Environmental",
  behavioral: "Behavioral Patterns",
  insider: "Insider Threat",
  cyber_physical: "Cyber-Physical",
  micro_behavior: "Micro-Behavior",
};

const DAY_LABELS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_DISPLAY: Record<string, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
};

const NLP_SUGGESTIONS = [
  "Activate perimeter defense with max sensitivity",
  "Start all perception agents",
  "Set anomaly threshold to 40%",
  "Switch to crowd control protocol",
  "Enable full lockdown mode",
  "Focus monitoring on restricted zones",
  "Lower false positives for after-hours",
  "Restart reasoning tier agents",
];

/* ------------------------------------------------------------------ */
/*  Sensitivity Slider Component                                       */
/* ------------------------------------------------------------------ */

function SensitivitySlider({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const pct = Math.round(value * 100);
  const color =
    pct >= 80 ? "text-red-400" : pct >= 60 ? "text-yellow-400" : "text-emerald-400";
  const barColor =
    pct >= 80
      ? "from-red-600 to-red-400"
      : pct >= 60
        ? "from-yellow-600 to-yellow-400"
        : "from-emerald-600 to-emerald-400";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm font-medium text-gray-200">{label}</span>
          <p className="text-xs text-gray-500">{description}</p>
        </div>
        <span className={`text-sm font-bold tabular-nums ${color}`}>{pct}%</span>
      </div>
      <div className="relative h-2 rounded-full bg-gray-800">
        <div
          className={`absolute left-0 top-0 h-2 rounded-full bg-gradient-to-r ${barColor} transition-all duration-300`}
          style={{ width: `${pct}%` }}
        />
        <input
          type="range"
          min={0}
          max={100}
          value={pct}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
          className="absolute inset-0 w-full cursor-pointer opacity-0"
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Mini Stat Card                                                     */
/* ------------------------------------------------------------------ */

function StatCard({
  icon: Icon,
  label,
  value,
  color = "text-cyan-400",
}: {
  icon: typeof Shield;
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2">
      <Icon className={`h-4 w-4 ${color} shrink-0`} />
      <div>
        <div className={`text-sm font-bold tabular-nums ${color}`}>{value}</div>
        <div className="text-[10px] text-gray-500">{label}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page Component                                                */
/* ------------------------------------------------------------------ */

type TabKey = "protocols" | "sensitivity" | "rules" | "agents" | "environment" | "schedule" | "metrics";

export default function ThreatConfigPage() {
  // State
  const [protocols, setProtocols] = useState<Protocol[]>([]);
  const [activeProtocol, setActiveProtocol] = useState<ActiveProtocol | null>(null);
  const [sensitivity, setSensitivity] = useState<SensitivityConfig>({
    perception_sensitivity: 0.7,
    anomaly_threshold: 0.65,
    threat_escalation_threshold: 0.8,
    crowd_density_threshold: 0.75,
  });
  const [rules, setRules] = useState<DetectionRule[]>([]);
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [nlpCommand, setNlpCommand] = useState("");
  const [nlpResponse, setNlpResponse] = useState<NLPResponse | null>(null);
  const [nlpHistory, setNlpHistory] = useState<Array<{ role: string; content: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState<string | null>(null);
  const [nlpProcessing, setNlpProcessing] = useState(false);
  const [savingSensitivity, setSavingSensitivity] = useState(false);
  const [quickScenarios, setQuickScenarios] = useState<QuickScenario[]>([]);
  const [deployedScenarios, setDeployedScenarios] = useState<ScenarioDeployment[]>([]);
  const [selectedScenario, setSelectedScenario] = useState<string | null>(null);
  const [deployingScenario, setDeployingScenario] = useState(false);
  const [customScenario, setCustomScenario] = useState("");
  const [deployingCustom, setDeployingCustom] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("protocols");
  const [showNewRule, setShowNewRule] = useState(false);
  const [newRule, setNewRule] = useState({
    name: "",
    description: "",
    category: "custom",
    severity: "medium",
    actions: ["alert"],
  });
  const chatEndRef = useRef<HTMLDivElement>(null);
  const { addToast } = useToast();

  // New state for enhanced features
  const [envProfiles, setEnvProfiles] = useState<EnvironmentProfile[]>([]);
  const [activeEnvProfile, setActiveEnvProfile] = useState<string | null>(null);
  const [settingProfile, setSettingProfile] = useState(false);
  const [scheduleEntries, setScheduleEntries] = useState<ScheduleEntry[]>([]);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [showAddSchedule, setShowAddSchedule] = useState(false);
  const [newSchedule, setNewSchedule] = useState<ScheduleEntry>({
    name: "", days: [], start_hour: 8, end_hour: 18, mode: "autonomous", performance: "standard", context_profile: "",
  });
  const [metrics, setMetrics] = useState<ThreatMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [rulesCategoryFilter, setRulesCategoryFilter] = useState<string>("all");
  const [ruleSearch, setRuleSearch] = useState("");
  const [headerStats, setHeaderStats] = useState({ signatures: 0, agentsRunning: 0, agentsTotal: 0, activeRules: 0 });

  // Dry-run mode
  const [dryRunMode, setDryRunMode] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<string | null>(null);

  // Version history (localStorage-backed)
  const [versionHistory, setVersionHistory] = useState<VersionEntry[]>([]);

  // Config impact preview
  const [alertVolume, setAlertVolume] = useState<number | null>(null);
  const [alertVolumeLoading, setAlertVolumeLoading] = useState(false);

  /* ── Data Fetching ──────────────────────────────────────── */

  const fetchAll = useCallback(async () => {
    try {
      const [protocolsRes, activeRes, rulesRes, agentsRes, scenariosRes] = await Promise.all([
        apiFetch<{ protocols: Protocol[]; active_protocol: ActiveProtocol }>("/api/threat-config/protocols"),
        apiFetch<{ sensitivity: SensitivityConfig; agents: AgentStatus[] }>("/api/threat-config/active"),
        apiFetch<{ rules: DetectionRule[] }>("/api/threat-config/rules"),
        apiFetch<{ agents: AgentStatus[]; fleet: Record<string, unknown> }>("/api/agents/status"),
        apiFetch<{ scenarios: QuickScenario[]; deployed: ScenarioDeployment[] }>("/api/threat-config/quick-scenarios"),
      ]);
      setProtocols(protocolsRes.protocols);
      setActiveProtocol(protocolsRes.active_protocol);
      setSensitivity(activeRes.sensitivity);
      setAgents(agentsRes.agents);
      setRules(rulesRes.rules);
      setQuickScenarios(scenariosRes.scenarios);
      setDeployedScenarios(scenariosRes.deployed);

      // Header stats
      const runningAgents = Array.isArray(agentsRes.agents) ? agentsRes.agents.filter((a: AgentStatus) => a.running).length : 0;
      const totalAgents = Array.isArray(agentsRes.agents) ? agentsRes.agents.length : 0;
      const activeRules = Array.isArray(rulesRes.rules) ? rulesRes.rules.filter((r: DetectionRule) => r.enabled).length : 0;
      setHeaderStats({ signatures: 0, agentsRunning: runningAgents, agentsTotal: totalAgents, activeRules });
    } catch (err) {
      console.warn("Failed to load threat config:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchEnvironment = useCallback(async () => {
    try {
      const [profilesRes, activeRes] = await Promise.all([
        apiFetch<{ profiles: EnvironmentProfile[] }>("/api/operation-mode/context-profiles"),
        apiFetch<{ profile: string | null }>("/api/operation-mode/context-profile"),
      ]);
      setEnvProfiles(Array.isArray(profilesRes.profiles) ? profilesRes.profiles : []);
      setActiveEnvProfile(activeRes.profile);
    } catch {
      // Context profiles are optional
    }
  }, []);

  const fetchSchedule = useCallback(async () => {
    try {
      const res = await apiFetch<{ schedule: ScheduleEntry[] }>("/api/operation-mode/schedule");
      setScheduleEntries(Array.isArray(res.schedule) ? res.schedule : []);
    } catch {
      // Schedule is optional
    }
  }, []);

  const fetchMetrics = useCallback(async () => {
    setMetricsLoading(true);
    try {
      const data = await apiFetch<ThreatMetrics>("/api/threat-config/metrics");
      setMetrics(data);
      setHeaderStats((prev) => ({ ...prev, signatures: data.total_signatures }));
    } catch {
      // Metrics are optional
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    fetchEnvironment();
    fetchSchedule();
  }, [fetchAll, fetchEnvironment, fetchSchedule]);

  // Load version history from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem("sentinel_sensitivity_versions");
      if (stored) setVersionHistory(JSON.parse(stored));
    } catch { /* ignore */ }
  }, []);

  // Fetch alert volume when sensitivity tab is active
  useEffect(() => {
    if (activeTab !== "sensitivity") return;
    setAlertVolumeLoading(true);
    apiFetch<{ total?: number; count?: number }>("/api/alerts?limit=1")
      .then((res) => {
        const vol = res.total ?? res.count ?? null;
        setAlertVolume(typeof vol === "number" ? vol : null);
      })
      .catch(() => setAlertVolume(null))
      .finally(() => setAlertVolumeLoading(false));
  }, [activeTab]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [nlpHistory]);

  // Fetch metrics when metrics tab is opened
  useEffect(() => {
    if (activeTab === "metrics") fetchMetrics();
  }, [activeTab, fetchMetrics]);

  /* ── Protocol Deployment ───────────────────────────────── */

  const deployProtocol = async (protocolId: string) => {
    setDeploying(protocolId);
    try {
      const res = await apiFetch<{
        status: string;
        protocol: ActiveProtocol;
        sensitivity: SensitivityConfig;
        results: Record<string, string[]>;
      }>("/api/threat-config/deploy", {
        method: "POST",
        body: JSON.stringify({ protocol_id: protocolId }),
      });
      setActiveProtocol(res.protocol);
      setSensitivity(res.sensitivity);
      await fetchAll();
    } catch (err) {
      console.warn("Deploy failed:", err);
    } finally {
      setDeploying(null);
    }
  };

  /* ── NLP Command ───────────────────────────────────────── */

  const sendNlpCommand = async () => {
    if (!nlpCommand.trim() || nlpProcessing) return;
    const cmd = nlpCommand.trim();
    setNlpCommand("");
    setNlpProcessing(true);
    setNlpHistory((h) => [...h, { role: "user", content: cmd }]);

    try {
      const res = await apiFetch<NLPResponse>("/api/threat-config/nlp-deploy", {
        method: "POST",
        body: JSON.stringify({ command: cmd }),
      });
      setNlpResponse(res);
      const cortexText =
        res.cortex_response?.response || JSON.stringify(res.cortex_response);
      setNlpHistory((h) => [...h, { role: "assistant", content: cortexText }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to process command";
      setNlpHistory((h) => [...h, { role: "error", content: msg }]);
    } finally {
      setNlpProcessing(false);
    }
  };

  /* ── Sensitivity Save ──────────────────────────────────── */

  const saveSensitivity = async () => {
    setSavingSensitivity(true);
    setDryRunResult(null);
    try {
      const url = dryRunMode
        ? "/api/threat-config/sensitivity?dry_run=true"
        : "/api/threat-config/sensitivity";
      const res = await apiFetch<{ affected_alerts?: number; status?: string }>(url, {
        method: "PUT",
        body: JSON.stringify(sensitivity),
      });

      if (dryRunMode) {
        const affected = res?.affected_alerts ?? "unknown";
        setDryRunResult(`Would affect ${affected} alerts`);
        addToast("info", `Dry run: Would affect ${affected} alerts`);
      } else {
        // Record this save in version history
        const newVersion: VersionEntry = {
          version: (versionHistory[0]?.version ?? 0) + 1,
          saved_at: new Date().toISOString(),
          label: `Sensitivity v${(versionHistory[0]?.version ?? 0) + 1}`,
        };
        const updated = [newVersion, ...versionHistory].slice(0, 10);
        setVersionHistory(updated);
        try {
          localStorage.setItem("sentinel_sensitivity_versions", JSON.stringify(updated));
        } catch { /* ignore */ }
        addToast("success", "Sensitivity settings saved.");
      }
    } catch (err) {
      console.warn("Failed to save sensitivity:", err);
      addToast("error", "Failed to save sensitivity settings.");
    } finally {
      setSavingSensitivity(false);
    }
  };

  /* ── Rule Management ───────────────────────────────────── */

  const toggleRule = async (ruleId: string) => {
    try {
      const res = await apiFetch<{ rule: DetectionRule }>(
        `/api/threat-config/rules/${ruleId}/toggle`,
        { method: "POST" }
      );
      setRules((prev) =>
        prev.map((r) => (r.id === ruleId ? res.rule : r))
      );
    } catch (err) {
      console.warn("Toggle rule failed:", err);
    }
  };

  const deleteRule = async (ruleId: string) => {
    try {
      await apiFetch(`/api/threat-config/rules/${ruleId}`, { method: "DELETE" });
      setRules((prev) => prev.filter((r) => r.id !== ruleId));
    } catch (err) {
      console.warn("Delete rule failed:", err);
    }
  };

  const createRule = async () => {
    try {
      const res = await apiFetch<{ rule: DetectionRule }>("/api/threat-config/rules", {
        method: "POST",
        body: JSON.stringify({
          ...newRule,
          conditions: {},
          actions: newRule.actions,
        }),
      });
      setRules((prev) => [...prev, res.rule]);
      setShowNewRule(false);
      setNewRule({ name: "", description: "", category: "custom", severity: "medium", actions: ["alert"] });
    } catch (err) {
      console.warn("Create rule failed:", err);
    }
  };

  /* ── Bulk Rule Toggle ─────────────────────────────────── */

  const bulkToggleRules = async (category: string, enable: boolean) => {
    const targetRules = rules.filter((r) => r.category === category && r.enabled !== enable);
    for (const rule of targetRules) {
      try {
        const res = await apiFetch<{ rule: DetectionRule }>(
          `/api/threat-config/rules/${rule.id}/toggle`,
          { method: "POST" }
        );
        setRules((prev) => prev.map((r) => (r.id === rule.id ? res.rule : r)));
      } catch { /* skip failed */ }
    }
  };

  /* ── Tier Actions ──────────────────────────────────────── */

  const tierAction = async (tier: string, action: string) => {
    try {
      await apiFetch("/api/threat-config/tier-config", {
        method: "POST",
        body: JSON.stringify({ tier, agents: [], action }),
      });
      await fetchAll();
    } catch (err) {
      console.warn(`Tier ${action} failed:`, err);
    }
  };

  /* ── Quick Scenario Deploy ─────────────────────────────── */

  const deployScenario = async (scenarioId: string) => {
    setDeployingScenario(true);
    try {
      const res = await apiFetch<{
        status: string;
        deployment: ScenarioDeployment;
        sensitivity: SensitivityConfig;
      }>("/api/threat-config/deploy-scenario", {
        method: "POST",
        body: JSON.stringify({ scenario_id: scenarioId }),
      });
      setDeployedScenarios((prev) => [...prev, res.deployment]);
      setSensitivity(res.sensitivity);
      setSelectedScenario(scenarioId);
    } catch (err) {
      console.warn("Scenario deploy failed:", err);
    } finally {
      setDeployingScenario(false);
    }
  };

  const deployCustomScenario = async () => {
    if (!customScenario.trim() || deployingCustom) return;
    setDeployingCustom(true);
    try {
      const res = await apiFetch<{
        status: string;
        deployment: ScenarioDeployment;
        sensitivity: SensitivityConfig;
      }>("/api/threat-config/deploy-custom-scenario", {
        method: "POST",
        body: JSON.stringify({ description: customScenario.trim() }),
      });
      setDeployedScenarios((prev) => [...prev, res.deployment]);
      setSensitivity(res.sensitivity);
      setCustomScenario("");
    } catch (err) {
      console.warn("Custom scenario deploy failed:", err);
    } finally {
      setDeployingCustom(false);
    }
  };

  /* ── Environment Profile ───────────────────────────────── */

  const setEnvProfile = async (profileName: string | null) => {
    setSettingProfile(true);
    try {
      await apiFetch("/api/operation-mode/context-profile", {
        method: "PUT",
        body: JSON.stringify({ profile: profileName }),
      });
      setActiveEnvProfile(profileName);
    } catch (err) {
      console.warn("Set profile failed:", err);
    } finally {
      setSettingProfile(false);
    }
  };

  /* ── Schedule Management ───────────────────────────────── */

  const saveSchedule = async () => {
    setSavingSchedule(true);
    try {
      await apiFetch("/api/operation-mode/schedule", {
        method: "PUT",
        body: JSON.stringify({ entries: scheduleEntries }),
      });
    } catch (err) {
      console.warn("Save schedule failed:", err);
    } finally {
      setSavingSchedule(false);
    }
  };

  const addScheduleEntry = () => {
    if (!newSchedule.name.trim() || newSchedule.days.length === 0) return;
    setScheduleEntries((prev) => [...prev, { ...newSchedule }]);
    setShowAddSchedule(false);
    setNewSchedule({ name: "", days: [], start_hour: 8, end_hour: 18, mode: "autonomous", performance: "standard", context_profile: "" });
  };

  const removeScheduleEntry = (idx: number) => {
    setScheduleEntries((prev) => prev.filter((_, i) => i !== idx));
  };

  /* ── Deployment deactivation ───────────────────────────── */

  const deactivateDeployment = async (deploymentId: string) => {
    try {
      const res = await apiFetch<{ sensitivity: SensitivityConfig }>(
        `/api/threat-config/deployments/${deploymentId}/deactivate`,
        { method: "POST" }
      );
      setSensitivity(res.sensitivity);
      setDeployedScenarios((prev) =>
        prev.map((d) => d.id === deploymentId ? { ...d, status: "deactivated" } : d)
      );
    } catch (err) {
      console.warn("Deactivate failed:", err);
    }
  };

  /* ── Loading State ─────────────────────────────────────── */

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-950">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          <span className="text-sm text-gray-500">Loading threat configuration...</span>
        </div>
      </div>
    );
  }

  /* ── Render ────────────────────────────────────────────── */

  const tierGroups = agents.reduce<Record<string, AgentStatus[]>>((acc, a) => {
    (acc[a.tier] = acc[a.tier] || []).push(a);
    return acc;
  }, {});

  const filteredRules = rules.filter((r) => {
    if (rulesCategoryFilter !== "all" && r.category !== rulesCategoryFilter) return false;
    if (ruleSearch && !r.name.toLowerCase().includes(ruleSearch.toLowerCase())) return false;
    return true;
  });

  const ruleCategories = [...new Set(rules.map((r) => r.category))];

  const TABS: { key: TabKey; label: string; icon: typeof Shield }[] = [
    { key: "protocols", label: "Protocols", icon: Zap },
    { key: "sensitivity", label: "Sensitivity", icon: Sliders },
    { key: "rules", label: "Detection Rules", icon: BookOpen },
    { key: "agents", label: "Agent Fleet", icon: Power },
    { key: "environment", label: "Environment", icon: Globe },
    { key: "schedule", label: "Schedule", icon: Calendar },
    { key: "metrics", label: "Threat Metrics", icon: BarChart3 },
  ];

  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ── Header ── */}
      <div className="border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
              <Zap className="h-5 w-5 text-cyan-400" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-wide text-gray-100">
                Adaptive Threat Configuration
              </h1>
              <p className="text-xs text-gray-500">
                Deploy AI sentinels, tune detection, manage environment profiles & schedules
              </p>
            </div>
          </div>
          {activeProtocol && (
            <div className="flex items-center gap-2 rounded-lg border border-cyan-800/50 bg-cyan-900/20 px-3 py-1.5">
              <div className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
              <span className="text-xs font-medium text-cyan-400">
                Active: {activeProtocol.name}
              </span>
            </div>
          )}
        </div>

        {/* Live Stats Bar */}
        <div className="mt-3 flex items-center gap-3 overflow-x-auto">
          <StatCard icon={Fingerprint} label="Signatures" value={headerStats.signatures || "165+"} color="text-violet-400" />
          <StatCard icon={Activity} label="Agents Online" value={`${headerStats.agentsRunning}/${headerStats.agentsTotal}`} color="text-emerald-400" />
          <StatCard icon={BookOpen} label="Active Rules" value={headerStats.activeRules} color="text-yellow-400" />
          <StatCard icon={History} label="Deployments" value={deployedScenarios.filter((d) => d.status === "active").length} color="text-orange-400" />
          {activeEnvProfile && (
            <div className="flex items-center gap-2 rounded-lg border border-violet-800/50 bg-violet-900/20 px-3 py-2">
              <Globe className="h-3.5 w-3.5 text-violet-400" />
              <span className="text-xs font-medium text-violet-400 capitalize">{activeEnvProfile}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── NLP Command Bar ── */}
      <div className="border-b border-gray-800 bg-gray-900/50 px-6 py-4">
        <div className="mx-auto max-w-4xl">
          <div className="mb-3 flex items-center gap-2">
            <Shield className="h-4 w-4 text-cyan-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              Natural Language Deployment
            </span>
          </div>

          {/* Chat History */}
          {nlpHistory.length > 0 && (
            <div className="mb-3 max-h-64 space-y-2 overflow-y-auto rounded-lg border border-gray-800 bg-gray-950/50 p-3">
              {nlpHistory.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                      msg.role === "user"
                        ? "bg-cyan-900/30 text-cyan-100 border border-cyan-800/50"
                        : msg.role === "error"
                          ? "bg-red-900/30 text-red-300 border border-red-800/50"
                          : "bg-gray-800 text-gray-200 border border-gray-700"
                    }`}
                  >
                    {msg.role === "assistant" ? (
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    ) : (
                      msg.content
                    )}
                  </div>
                </div>
              ))}
              {nlpProcessing && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-400 border border-gray-700">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Sentinel Cortex is processing...
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
          )}

          {/* Input */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={nlpCommand}
              onChange={(e) => setNlpCommand(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendNlpCommand()}
              placeholder='Try: "Activate perimeter defense with max sensitivity"'
              className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-cyan-600 focus:ring-1 focus:ring-cyan-600/50 transition-colors"
            />
            <button
              onClick={sendNlpCommand}
              disabled={nlpProcessing || !nlpCommand.trim()}
              className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-600 text-white transition-colors hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {nlpProcessing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </button>
          </div>

          {/* Quick Command Suggestions */}
          {nlpHistory.length === 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {NLP_SUGGESTIONS.slice(0, 4).map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => {
                    setNlpCommand(suggestion);
                  }}
                  className="rounded-full border border-gray-700 bg-gray-800/60 px-3 py-1 text-[10px] text-gray-400 transition-colors hover:border-cyan-700/50 hover:text-cyan-400"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Dry Run Banner ── */}
      {dryRunMode && (
        <div className="border-b border-amber-700/50 bg-amber-900/20 px-6 py-2.5 flex items-center gap-3">
          <div className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
          <span className="text-sm font-semibold text-amber-400">
            DRY RUN MODE — changes will be simulated, not applied
          </span>
          <button
            onClick={() => { setDryRunMode(false); setDryRunResult(null); }}
            className="ml-auto text-xs text-amber-500 hover:text-amber-300 border border-amber-700/50 rounded px-2 py-0.5"
          >
            Exit Dry Run
          </button>
        </div>
      )}

      {/* ── Tab Navigation ── */}
      <div className="border-b border-gray-800 px-6 overflow-x-auto">
        <div className="flex gap-1">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-2 px-4 py-3 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === key
                  ? "border-cyan-400 text-cyan-400"
                  : "border-transparent text-gray-500 hover:text-gray-300"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Content Area ── */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* ──────── Protocols Tab ──────── */}
        {activeTab === "protocols" && (
          <div className="mx-auto max-w-4xl space-y-8">
            {/* ──── Quick Deploy Protocols ──── */}
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
              <div className="mb-5 flex items-center gap-2">
                <Zap className="h-4 w-4 text-cyan-400" />
                <span className="text-xs font-bold uppercase tracking-widest text-gray-400">
                  Quick Deploy Protocols
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {quickScenarios.map((scenario) => {
                  const Icon = ICON_MAP[scenario.icon] || Shield;
                  const isSelected = selectedScenario === scenario.id;
                  const isDeployed = deployedScenarios.some(
                    (d) => d.scenario_id === scenario.id && d.status === "active"
                  );

                  return (
                    <button
                      key={scenario.id}
                      onClick={() => {
                        setSelectedScenario(scenario.id);
                        deployScenario(scenario.id);
                      }}
                      disabled={deployingScenario}
                      className={`group flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-all duration-200 ${
                        isSelected || isDeployed
                          ? "border-cyan-700/60 bg-cyan-950/30 shadow-lg shadow-cyan-950/20"
                          : "border-gray-700/60 bg-gray-800/40 hover:border-gray-600 hover:bg-gray-800/70"
                      } disabled:cursor-wait`}
                    >
                      <div className="flex items-center gap-2.5">
                        <div
                          className={`flex h-7 w-7 items-center justify-center rounded-full border ${
                            isSelected || isDeployed
                              ? "border-cyan-600/60 bg-cyan-900/40"
                              : "border-gray-600/60 bg-gray-700/40"
                          }`}
                        >
                          <Icon
                            className={`h-3.5 w-3.5 ${
                              isSelected || isDeployed
                                ? "text-cyan-400"
                                : "text-gray-400 group-hover:text-gray-300"
                            }`}
                          />
                        </div>
                        <span
                          className={`text-sm font-semibold ${
                            isSelected || isDeployed
                              ? "text-cyan-100"
                              : "text-gray-200 group-hover:text-gray-100"
                          }`}
                        >
                          {scenario.name}
                        </span>
                      </div>
                      <p className="text-xs leading-relaxed text-gray-500">
                        {scenario.description}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ──── Custom Definition ──── */}
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
              <div className="mb-4 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-cyan-400" />
                <span className="text-xs font-bold uppercase tracking-widest text-gray-400">
                  Custom Definition
                </span>
              </div>

              <div className="flex flex-col gap-3">
                <textarea
                  value={customScenario}
                  onChange={(e) => setCustomScenario(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      deployCustomScenario();
                    }
                  }}
                  placeholder="Describe a threat scenario..."
                  rows={3}
                  className="w-full resize-none rounded-lg border border-gray-700 bg-gray-800/60 px-4 py-3 text-sm text-gray-100 placeholder-gray-600 outline-none transition-colors focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700/50"
                />
                <div className="flex justify-end">
                  <button
                    onClick={deployCustomScenario}
                    disabled={!customScenario.trim() || deployingCustom}
                    className="flex items-center gap-2 rounded-lg bg-cyan-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {deployingCustom ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Zap className="h-4 w-4" />
                    )}
                    Deploy
                  </button>
                </div>
              </div>
            </div>

            {/* ──── Full Protocol Presets ──── */}
            <div>
              <div className="mb-4 flex items-center gap-2">
                <Shield className="h-4 w-4 text-gray-500" />
                <span className="text-xs font-bold uppercase tracking-widest text-gray-500">
                  Full Protocol Presets
                </span>
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {protocols.map((protocol) => {
                  const Icon = ICON_MAP[protocol.icon] || Shield;
                  const colors = COLOR_MAP[protocol.color] || COLOR_MAP.cyan;
                  const isActive = activeProtocol?.protocol_id === protocol.id;
                  const isDeploying = deploying === protocol.id;

                  return (
                    <div
                      key={protocol.id}
                      className={`group relative rounded-xl border p-5 transition-all duration-300 ${
                        isActive
                          ? `${colors.border} ${colors.bg} shadow-lg ${colors.glow}`
                          : "border-gray-800 bg-gray-900/50 hover:border-gray-700 hover:bg-gray-900"
                      }`}
                    >
                      {isActive && (
                        <div className="absolute -top-2 right-3">
                          <span className={`flex items-center gap-1 rounded-full ${colors.bg} ${colors.border} border px-2 py-0.5 text-[10px] font-bold uppercase ${colors.text}`}>
                            <CheckCircle2 className="h-3 w-3" />
                            Active
                          </span>
                        </div>
                      )}

                      <div className="mb-3 flex items-center gap-3">
                        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${colors.bg} border ${colors.border}`}>
                          <Icon className={`h-5 w-5 ${colors.text}`} />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold text-gray-100">{protocol.name}</h3>
                          <p className="text-xs text-gray-500">
                            {Object.values(protocol.agents).flat().length} agents
                          </p>
                        </div>
                      </div>

                      <p className="mb-4 text-xs leading-relaxed text-gray-400">
                        {protocol.description}
                      </p>

                      <div className="mb-4 grid grid-cols-4 gap-1.5">
                        {["perception", "reasoning", "action", "supervisor"].map((tier) => {
                          const tierAgents = protocol.agents[tier] || [];
                          const active = protocol.tier_status[tier];
                          return (
                            <div
                              key={tier}
                              className={`rounded px-1.5 py-1 text-center ${
                                active
                                  ? "bg-gray-800 border border-gray-700"
                                  : "bg-gray-900 border border-gray-800 opacity-40"
                              }`}
                            >
                              <div className={`text-[10px] font-bold uppercase ${active ? "text-gray-300" : "text-gray-600"}`}>
                                {tier.slice(0, 4)}
                              </div>
                              <div className={`text-xs font-semibold ${active ? colors.text : "text-gray-600"}`}>
                                {tierAgents.length}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <div className="mb-4 space-y-1">
                        {Object.entries(protocol.sensitivity).map(([key, val]) => (
                          <div key={key} className="flex items-center gap-2">
                            <div className="h-1 flex-1 rounded-full bg-gray-800">
                              <div
                                className={`h-1 rounded-full bg-gradient-to-r ${
                                  val >= 0.8 ? "from-red-600 to-red-400" : val >= 0.6 ? "from-yellow-600 to-yellow-400" : "from-emerald-600 to-emerald-400"
                                }`}
                                style={{ width: `${val * 100}%` }}
                              />
                            </div>
                            <span className="w-8 text-right text-[10px] text-gray-500 tabular-nums">
                              {Math.round(val * 100)}%
                            </span>
                          </div>
                        ))}
                      </div>

                      <button
                        onClick={() => deployProtocol(protocol.id)}
                        disabled={isActive || isDeploying}
                        className={`flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-all ${
                          isActive
                            ? `${colors.bg} ${colors.text} border ${colors.border} cursor-default`
                            : isDeploying
                              ? "bg-gray-800 text-gray-400 border border-gray-700 cursor-wait"
                              : "bg-gray-800 text-gray-300 border border-gray-700 hover:bg-gray-700 hover:text-gray-100"
                        }`}
                      >
                        {isDeploying ? (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Deploying...
                          </>
                        ) : isActive ? (
                          <>
                            <CheckCircle2 className="h-3 w-3" />
                            Currently Active
                          </>
                        ) : (
                          <>
                            <ChevronRight className="h-3 w-3" />
                            Deploy Protocol
                          </>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ──── Deployment History ──── */}
            {deployedScenarios.length > 0 && (
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
                <div className="mb-4 flex items-center gap-2">
                  <History className="h-4 w-4 text-gray-500" />
                  <span className="text-xs font-bold uppercase tracking-widest text-gray-500">
                    Deployment History
                  </span>
                </div>
                <div className="space-y-2">
                  {[...deployedScenarios].reverse().slice(0, 10).map((d) => (
                    <div
                      key={d.id}
                      className={cn(
                        "flex items-center justify-between rounded-lg border px-4 py-2.5",
                        d.status === "active"
                          ? "border-cyan-800/50 bg-cyan-900/10"
                          : "border-gray-800 bg-gray-900/30 opacity-60"
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          "h-2 w-2 rounded-full",
                          d.status === "active" ? "bg-cyan-400 animate-pulse" : "bg-gray-600"
                        )} />
                        <div>
                          <span className="text-xs font-medium text-gray-200">{d.scenario_name}</span>
                          <span className="ml-2 text-[10px] text-gray-500">
                            {new Date(d.deployed_at).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}
                          </span>
                        </div>
                      </div>
                      {d.status === "active" && (
                        <button
                          onClick={() => deactivateDeployment(d.id)}
                          className="flex items-center gap-1 rounded border border-red-800/50 bg-red-900/20 px-2 py-1 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-900/40"
                        >
                          <XCircle className="h-3 w-3" />
                          Deactivate
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ──────── Sensitivity Tab ──────── */}
        {activeTab === "sensitivity" && (
          <div className="mx-auto max-w-2xl space-y-6">
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
              <div className="mb-6 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-yellow-900/30 border border-yellow-800/50">
                    <Sliders className="h-5 w-5 text-yellow-400" />
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-gray-100">Detection Sensitivity</h2>
                    <p className="text-xs text-gray-500">Fine-tune how aggressively agents detect threats</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {/* Dry Run Toggle */}
                  <button
                    onClick={() => { setDryRunMode((v) => !v); setDryRunResult(null); }}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors",
                      dryRunMode
                        ? "border-amber-700/60 bg-amber-900/30 text-amber-400"
                        : "border-gray-700 bg-gray-800 text-gray-400 hover:text-gray-200"
                    )}
                    title="Toggle dry-run mode"
                  >
                    {dryRunMode ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
                    Dry Run
                  </button>
                  <button
                    onClick={saveSensitivity}
                    disabled={savingSensitivity}
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold text-white transition-colors disabled:opacity-50",
                      dryRunMode
                        ? "bg-amber-600 hover:bg-amber-500"
                        : "bg-cyan-600 hover:bg-cyan-500"
                    )}
                  >
                    {savingSensitivity ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3" />
                    )}
                    {dryRunMode ? "Simulate" : "Save Changes"}
                  </button>
                </div>
              </div>

              {/* Config Impact Preview */}
              <div className={cn(
                "mb-5 rounded-lg border px-4 py-3 flex items-center gap-3",
                alertVolumeLoading ? "border-gray-800 bg-gray-900/30" : "border-blue-900/40 bg-blue-950/20"
              )}>
                <Activity className="h-4 w-4 text-blue-400 shrink-0" />
                <span className="text-xs text-blue-300">
                  {alertVolumeLoading
                    ? "Fetching current alert volume..."
                    : alertVolume !== null
                      ? `Current alert volume: ${alertVolume} alerts/24h. Adjusting sensitivity may increase or decrease this.`
                      : "Alert volume unavailable. Adjusting sensitivity may increase or decrease alert frequency."
                  }
                </span>
              </div>

              {/* Dry-run result banner */}
              {dryRunResult && (
                <div className="mb-5 rounded-lg border border-amber-700/50 bg-amber-900/20 px-4 py-3 flex items-center gap-3">
                  <CheckCircle2 className="h-4 w-4 text-amber-400 shrink-0" />
                  <span className="text-xs text-amber-300 font-medium">{dryRunResult}</span>
                </div>
              )}

              <div className="space-y-6">
                <SensitivitySlider
                  label="Perception Sensitivity"
                  description="How aggressively perception agents flag potential objects of interest"
                  value={sensitivity.perception_sensitivity}
                  onChange={(v) => setSensitivity((s) => ({ ...s, perception_sensitivity: v }))}
                />
                <SensitivitySlider
                  label="Anomaly Threshold"
                  description="Minimum deviation from baseline to trigger anomaly detection"
                  value={sensitivity.anomaly_threshold}
                  onChange={(v) => setSensitivity((s) => ({ ...s, anomaly_threshold: v }))}
                />
                <SensitivitySlider
                  label="Threat Escalation Threshold"
                  description="Confidence level required before auto-escalating a threat"
                  value={sensitivity.threat_escalation_threshold}
                  onChange={(v) => setSensitivity((s) => ({ ...s, threat_escalation_threshold: v }))}
                />
                <SensitivitySlider
                  label="Crowd Density Threshold"
                  description="Density level that triggers crowd monitoring alerts"
                  value={sensitivity.crowd_density_threshold}
                  onChange={(v) => setSensitivity((s) => ({ ...s, crowd_density_threshold: v }))}
                />
              </div>
            </div>

            {/* Sensitivity Radar Visual */}
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
              <h3 className="mb-4 text-sm font-bold text-gray-100">Sensitivity Profile</h3>
              <div className="flex items-center justify-center">
                <svg width="240" height="200" viewBox="0 0 240 200" className="overflow-visible">
                  {/* Radar background rings */}
                  {[0.25, 0.5, 0.75, 1].map((r) => (
                    <circle key={r} cx="120" cy="100" r={r * 80} fill="none" stroke="#334155" strokeWidth="0.5" />
                  ))}
                  {/* Radar polygon */}
                  {(() => {
                    const vals = [
                      sensitivity.perception_sensitivity,
                      sensitivity.anomaly_threshold,
                      sensitivity.threat_escalation_threshold,
                      sensitivity.crowd_density_threshold,
                    ];
                    const labels = ["Perception", "Anomaly", "Escalation", "Crowd"];
                    const cx = 120, cy = 100, maxR = 80;
                    const points = vals.map((v, i) => {
                      const angle = (i / vals.length) * Math.PI * 2 - Math.PI / 2;
                      return `${cx + Math.cos(angle) * v * maxR},${cy + Math.sin(angle) * v * maxR}`;
                    }).join(" ");
                    return (
                      <>
                        <polygon points={points} fill="rgba(34,211,238,0.15)" stroke="#22d3ee" strokeWidth="1.5" />
                        {vals.map((v, i) => {
                          const angle = (i / vals.length) * Math.PI * 2 - Math.PI / 2;
                          const lx = cx + Math.cos(angle) * (maxR + 16);
                          const ly = cy + Math.sin(angle) * (maxR + 16);
                          const px = cx + Math.cos(angle) * v * maxR;
                          const py = cy + Math.sin(angle) * v * maxR;
                          return (
                            <g key={i}>
                              <line x1={cx} y1={cy} x2={cx + Math.cos(angle) * maxR} y2={cy + Math.sin(angle) * maxR} stroke="#334155" strokeWidth="0.5" />
                              <circle cx={px} cy={py} r="4" fill="#22d3ee" />
                              <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fill="#94a3b8" fontSize="9" fontFamily="monospace">
                                {labels[i]}
                              </text>
                            </g>
                          );
                        })}
                      </>
                    );
                  })()}
                </svg>
              </div>
            </div>

            {/* Presets */}
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
              <h3 className="mb-4 text-sm font-bold text-gray-100">Quick Presets</h3>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: "Conservative", desc: "Low false positives", color: "border-emerald-700/50", vals: { perception_sensitivity: 0.5, anomaly_threshold: 0.8, threat_escalation_threshold: 0.9, crowd_density_threshold: 0.85 } },
                  { label: "Balanced", desc: "Standard operations", color: "border-cyan-700/50", vals: { perception_sensitivity: 0.7, anomaly_threshold: 0.65, threat_escalation_threshold: 0.8, crowd_density_threshold: 0.75 } },
                  { label: "Aggressive", desc: "Maximum detection", color: "border-red-700/50", vals: { perception_sensitivity: 0.95, anomaly_threshold: 0.3, threat_escalation_threshold: 0.4, crowd_density_threshold: 0.4 } },
                ].map((preset) => (
                  <button
                    key={preset.label}
                    onClick={() => setSensitivity(preset.vals)}
                    className={`rounded-lg border ${preset.color} bg-gray-800 p-3 text-left transition-colors hover:bg-gray-800/80`}
                  >
                    <div className="text-xs font-semibold text-gray-200">{preset.label}</div>
                    <div className="text-[10px] text-gray-500">{preset.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Version History */}
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
              <div className="mb-4 flex items-center gap-2">
                <History className="h-4 w-4 text-gray-500" />
                <h3 className="text-sm font-bold text-gray-100">Version History</h3>
                <span className="ml-auto text-[10px] text-gray-600">(local — saved sessions)</span>
              </div>
              {versionHistory.length === 0 ? (
                <p className="text-xs text-gray-600 text-center py-4">
                  No saved versions yet. Save your sensitivity settings to start tracking changes.
                </p>
              ) : (
                <div className="space-y-2">
                  {versionHistory.map((v, i) => (
                    <div
                      key={v.version}
                      className={cn(
                        "flex items-center justify-between rounded-lg border px-4 py-2.5",
                        i === 0
                          ? "border-cyan-800/50 bg-cyan-900/10"
                          : "border-gray-800 bg-gray-900/30 opacity-70"
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          "h-2 w-2 rounded-full",
                          i === 0 ? "bg-cyan-400 animate-pulse" : "bg-gray-600"
                        )} />
                        <div>
                          <span className="text-xs font-medium text-gray-200">{v.label}</span>
                          {i === 0 && (
                            <span className="ml-2 rounded-full border border-cyan-700/50 bg-cyan-900/30 px-2 py-0.5 text-[9px] font-bold text-cyan-400">
                              LATEST
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="text-[10px] text-gray-500 font-mono">
                        {new Date(v.saved_at).toLocaleString("en-US", {
                          month: "short", day: "2-digit",
                          hour: "2-digit", minute: "2-digit", hour12: false,
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ──────── Rules Tab ──────── */}
        {activeTab === "rules" && (
          <div className="mx-auto max-w-3xl space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-400">
                <span className="font-semibold text-gray-200">{rules.filter((r) => r.enabled).length}</span>
                {" "}active rules of{" "}
                <span className="font-semibold text-gray-200">{rules.length}</span> total
              </div>
              <button
                onClick={() => setShowNewRule(true)}
                className="flex items-center gap-2 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-cyan-500"
              >
                <Plus className="h-3 w-3" />
                Add Rule
              </button>
            </div>

            {/* Search & Bulk Actions */}
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={ruleSearch}
                onChange={(e) => setRuleSearch(e.target.value)}
                placeholder="Search rules by name..."
                className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-100 placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700"
              />
              {rulesCategoryFilter !== "all" && (
                <>
                  <button
                    onClick={() => bulkToggleRules(rulesCategoryFilter, true)}
                    className="rounded-lg border border-emerald-700/50 bg-emerald-900/20 px-3 py-2 text-[10px] font-semibold text-emerald-400 hover:bg-emerald-900/40 transition-colors whitespace-nowrap"
                  >
                    Enable All
                  </button>
                  <button
                    onClick={() => bulkToggleRules(rulesCategoryFilter, false)}
                    className="rounded-lg border border-red-700/50 bg-red-900/20 px-3 py-2 text-[10px] font-semibold text-red-400 hover:bg-red-900/40 transition-colors whitespace-nowrap"
                  >
                    Disable All
                  </button>
                </>
              )}
            </div>

            {/* Category Filter */}
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setRulesCategoryFilter("all")}
                className={cn(
                  "rounded-full border px-3 py-1 text-[10px] font-medium transition-colors",
                  rulesCategoryFilter === "all"
                    ? "border-cyan-700/60 bg-cyan-900/30 text-cyan-400"
                    : "border-gray-700 bg-gray-800/60 text-gray-400 hover:text-gray-300"
                )}
              >
                All ({rules.length})
              </button>
              {ruleCategories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setRulesCategoryFilter(cat)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-[10px] font-medium transition-colors",
                    rulesCategoryFilter === cat
                      ? "border-cyan-700/60 bg-cyan-900/30 text-cyan-400"
                      : "border-gray-700 bg-gray-800/60 text-gray-400 hover:text-gray-300"
                  )}
                >
                  {CATEGORY_LABELS[cat] || cat} ({rules.filter((r) => r.category === cat).length})
                </button>
              ))}
            </div>

            {/* New Rule Form */}
            {showNewRule && (
              <div className="rounded-xl border border-cyan-800/50 bg-cyan-900/10 p-4 space-y-3">
                <h4 className="text-sm font-semibold text-cyan-400">New Detection Rule</h4>
                <input
                  type="text"
                  placeholder="Rule name"
                  value={newRule.name}
                  onChange={(e) => setNewRule((r) => ({ ...r, name: e.target.value }))}
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-600"
                />
                <input
                  type="text"
                  placeholder="Description"
                  value={newRule.description}
                  onChange={(e) => setNewRule((r) => ({ ...r, description: e.target.value }))}
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-600"
                />
                <div className="flex gap-3">
                  <select
                    value={newRule.category}
                    onChange={(e) => setNewRule((r) => ({ ...r, category: e.target.value }))}
                    className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none"
                  >
                    {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                  <select
                    value={newRule.severity}
                    onChange={(e) => setNewRule((r) => ({ ...r, severity: e.target.value }))}
                    className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none"
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={createRule}
                    disabled={!newRule.name || !newRule.description}
                    className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-40"
                  >
                    <CheckCircle2 className="h-3 w-3" />
                    Create Rule
                  </button>
                  <button
                    onClick={() => setShowNewRule(false)}
                    className="rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-xs text-gray-400 hover:text-gray-200"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Rules List */}
            {filteredRules.map((rule) => (
              <div
                key={rule.id}
                className={`rounded-xl border p-4 transition-all ${
                  rule.enabled
                    ? "border-gray-800 bg-gray-900/50"
                    : "border-gray-800/50 bg-gray-900/20 opacity-60"
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <h4 className="text-sm font-semibold text-gray-100">{rule.name}</h4>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${SEVERITY_COLORS[rule.severity]}`}>
                        {rule.severity}
                      </span>
                      <span className="rounded-full border border-gray-700 bg-gray-800 px-2 py-0.5 text-[10px] text-gray-400">
                        {CATEGORY_LABELS[rule.category] || rule.category}
                      </span>
                    </div>
                    <p className="mb-2 text-xs text-gray-500">{rule.description}</p>
                    <div className="flex flex-wrap gap-1">
                      {rule.actions.map((action) => (
                        <span
                          key={action}
                          className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400 border border-gray-700"
                        >
                          {action}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="ml-4 flex items-center gap-2">
                    <button
                      onClick={() => toggleRule(rule.id)}
                      className={`transition-colors ${rule.enabled ? "text-cyan-400 hover:text-cyan-300" : "text-gray-600 hover:text-gray-400"}`}
                      title={rule.enabled ? "Disable rule" : "Enable rule"}
                    >
                      {rule.enabled ? (
                        <ToggleRight className="h-6 w-6" />
                      ) : (
                        <ToggleLeft className="h-6 w-6" />
                      )}
                    </button>
                    <button
                      onClick={() => deleteRule(rule.id)}
                      className="text-gray-600 transition-colors hover:text-red-400"
                      title="Delete rule"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ──────── Agents Tab ──────── */}
        {activeTab === "agents" && (
          <div className="space-y-6">
            {["perception", "reasoning", "action", "supervisor"].map((tier) => {
              const tierAgents = tierGroups[tier] || [];
              const running = tierAgents.filter((a) => a.running).length;
              const tierColors: Record<string, { bg: string; border: string; text: string }> = {
                perception: { bg: "bg-blue-900/20", border: "border-blue-800/50", text: "text-blue-400" },
                reasoning: { bg: "bg-purple-900/20", border: "border-purple-800/50", text: "text-purple-400" },
                action: { bg: "bg-orange-900/20", border: "border-orange-800/50", text: "text-orange-400" },
                supervisor: { bg: "bg-cyan-900/20", border: "border-cyan-800/50", text: "text-cyan-400" },
              };
              const tc = tierColors[tier] || tierColors.perception;

              return (
                <div key={tier} className="rounded-xl border border-gray-800 bg-gray-900/50 p-5">
                  <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${tc.bg} border ${tc.border}`}>
                        <Power className={`h-4 w-4 ${tc.text}`} />
                      </div>
                      <div>
                        <h3 className="text-sm font-bold capitalize text-gray-100">
                          {tier} Tier
                        </h3>
                        <p className="text-xs text-gray-500">
                          {running}/{tierAgents.length} agents running
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => tierAction(tier, "start")}
                        className="flex items-center gap-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-emerald-400 transition-colors hover:bg-emerald-900/20"
                      >
                        <Play className="h-3 w-3" />
                        Start All
                      </button>
                      <button
                        onClick={() => tierAction(tier, "stop")}
                        className="flex items-center gap-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-red-400 transition-colors hover:bg-red-900/20"
                      >
                        <Square className="h-3 w-3" />
                        Stop All
                      </button>
                      <button
                        onClick={() => tierAction(tier, "restart")}
                        className="flex items-center gap-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-yellow-400 transition-colors hover:bg-yellow-900/20"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Restart
                      </button>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                    {tierAgents.map((agent) => (
                      <div
                        key={agent.name}
                        className={`rounded-lg border p-3 transition-all ${
                          agent.running
                            ? `${tc.border} ${tc.bg}`
                            : "border-gray-800 bg-gray-900/30 opacity-60"
                        }`}
                      >
                        <div className="mb-1 flex items-center justify-between">
                          <span className="text-xs font-semibold text-gray-200 truncate">
                            {agent.name.replace(/_/g, " ")}
                          </span>
                          <div
                            className={`h-2 w-2 rounded-full ${
                              agent.running ? "bg-emerald-400 animate-pulse" : "bg-gray-600"
                            }`}
                          />
                        </div>
                        <p className="text-[10px] text-gray-500 truncate">{agent.role || agent.description}</p>
                        {agent.cycle_count > 0 && (
                          <p className="mt-1 text-[10px] text-gray-600">
                            {agent.cycle_count} cycles
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ──────── Environment Profiles Tab ──────── */}
        {activeTab === "environment" && (
          <div className="mx-auto max-w-4xl space-y-6">
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-900/30 border border-violet-800/50">
                    <Globe className="h-5 w-5 text-violet-400" />
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-gray-100">Environment Context Profiles</h2>
                    <p className="text-xs text-gray-500">
                      Select an environment profile to auto-adjust detection sensitivity and severity weighting
                    </p>
                  </div>
                </div>
                {activeEnvProfile && (
                  <button
                    onClick={() => setEnvProfile(null)}
                    disabled={settingProfile}
                    className="flex items-center gap-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-gray-400 transition-colors hover:text-red-400 hover:border-red-800/50"
                  >
                    <XCircle className="h-3 w-3" />
                    Clear Profile
                  </button>
                )}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {envProfiles.map((profile) => {
                const EnvIcon = ENV_ICON_MAP[profile.name] || Globe;
                const isActive = activeEnvProfile === profile.name;

                return (
                  <button
                    key={profile.name}
                    onClick={() => setEnvProfile(isActive ? null : profile.name)}
                    disabled={settingProfile}
                    className={cn(
                      "group flex flex-col items-start rounded-xl border p-4 text-left transition-all duration-200",
                      isActive
                        ? "border-violet-700/60 bg-violet-950/30 shadow-lg shadow-violet-950/20"
                        : "border-gray-800 bg-gray-900/50 hover:border-gray-700 hover:bg-gray-900",
                      settingProfile && "cursor-wait opacity-70"
                    )}
                  >
                    <div className="mb-3 flex items-center gap-2.5">
                      <div className={cn(
                        "flex h-9 w-9 items-center justify-center rounded-lg border",
                        isActive
                          ? "border-violet-600/60 bg-violet-900/40"
                          : "border-gray-700 bg-gray-800"
                      )}>
                        <EnvIcon className={cn("h-4 w-4", isActive ? "text-violet-400" : "text-gray-400")} />
                      </div>
                      {isActive && (
                        <span className="rounded-full border border-violet-700/50 bg-violet-900/30 px-2 py-0.5 text-[10px] font-bold text-violet-400">
                          ACTIVE
                        </span>
                      )}
                    </div>

                    <h3 className={cn("text-sm font-bold mb-1", isActive ? "text-violet-100" : "text-gray-200")}>
                      {profile.display_name}
                    </h3>
                    <p className="mb-3 text-[11px] leading-relaxed text-gray-500">
                      {profile.description}
                    </p>

                    {/* Boosted / Suppressed indicators */}
                    <div className="w-full space-y-1.5">
                      {profile.boosted_categories.length > 0 && (
                        <div className="flex items-start gap-1.5">
                          <TrendingUp className="h-3 w-3 text-red-400 mt-0.5 shrink-0" />
                          <div className="flex flex-wrap gap-1">
                            {profile.boosted_categories.slice(0, 3).map((cat) => (
                              <span key={cat} className="rounded bg-red-900/30 px-1.5 py-0.5 text-[9px] text-red-400 border border-red-800/30">
                                {cat}
                              </span>
                            ))}
                            {profile.boosted_categories.length > 3 && (
                              <span className="text-[9px] text-gray-500">+{profile.boosted_categories.length - 3}</span>
                            )}
                          </div>
                        </div>
                      )}
                      {profile.suppressed_categories.length > 0 && (
                        <div className="flex items-start gap-1.5">
                          <AlertTriangle className="h-3 w-3 text-emerald-400 mt-0.5 shrink-0" />
                          <div className="flex flex-wrap gap-1">
                            {profile.suppressed_categories.slice(0, 3).map((cat) => (
                              <span key={cat} className="rounded bg-emerald-900/30 px-1.5 py-0.5 text-[9px] text-emerald-400 border border-emerald-800/30">
                                {cat}
                              </span>
                            ))}
                            {profile.suppressed_categories.length > 3 && (
                              <span className="text-[9px] text-gray-500">+{profile.suppressed_categories.length - 3}</span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Severity boost indicator */}
                    <div className="mt-2 w-full">
                      <span className={cn(
                        "text-[10px] font-mono",
                        profile.default_severity_boost > 0 ? "text-red-400" :
                        profile.default_severity_boost < 0 ? "text-emerald-400" : "text-gray-500"
                      )}>
                        Severity: {profile.default_severity_boost > 0 ? `+${profile.default_severity_boost}` : profile.default_severity_boost === 0 ? "baseline" : profile.default_severity_boost}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ──────── Schedule Tab ──────── */}
        {activeTab === "schedule" && (
          <div className="mx-auto max-w-3xl space-y-6">
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
              <div className="mb-6 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-900/30 border border-blue-800/50">
                    <Calendar className="h-5 w-5 text-blue-400" />
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-gray-100">Adaptive Time Scheduling</h2>
                    <p className="text-xs text-gray-500">
                      Auto-switch operation mode, performance, and environment profile by day & time
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowAddSchedule(true)}
                    className="flex items-center gap-2 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-cyan-500"
                  >
                    <Plus className="h-3 w-3" />
                    Add Entry
                  </button>
                  <button
                    onClick={saveSchedule}
                    disabled={savingSchedule}
                    className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-200 transition-colors hover:bg-gray-700 disabled:opacity-50"
                  >
                    {savingSchedule ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                    Save Schedule
                  </button>
                </div>
              </div>

              {/* Add Schedule Form */}
              {showAddSchedule && (
                <div className="mb-6 rounded-lg border border-blue-800/50 bg-blue-900/10 p-4 space-y-3">
                  <h4 className="text-sm font-semibold text-blue-400">New Schedule Entry</h4>
                  <input
                    type="text"
                    placeholder="Entry name (e.g., Night Shift)"
                    value={newSchedule.name}
                    onChange={(e) => setNewSchedule((s) => ({ ...s, name: e.target.value }))}
                    className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none focus:border-blue-600"
                  />

                  {/* Day selector */}
                  <div>
                    <span className="text-xs text-gray-400 mb-1 block">Days</span>
                    <div className="flex gap-1.5">
                      {DAY_LABELS.map((day) => (
                        <button
                          key={day}
                          onClick={() =>
                            setNewSchedule((s) => ({
                              ...s,
                              days: s.days.includes(day)
                                ? s.days.filter((d) => d !== day)
                                : [...s.days, day],
                            }))
                          }
                          className={cn(
                            "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                            newSchedule.days.includes(day)
                              ? "border-blue-600/60 bg-blue-900/30 text-blue-400"
                              : "border-gray-700 bg-gray-800 text-gray-500 hover:text-gray-300"
                          )}
                        >
                          {DAY_DISPLAY[day]}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Time range */}
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <span className="text-xs text-gray-400 mb-1 block">Start Hour</span>
                      <select
                        value={newSchedule.start_hour}
                        onChange={(e) => setNewSchedule((s) => ({ ...s, start_hour: Number(e.target.value) }))}
                        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none"
                      >
                        {Array.from({ length: 24 }, (_, i) => (
                          <option key={i} value={i}>{String(i).padStart(2, "0")}:00</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex-1">
                      <span className="text-xs text-gray-400 mb-1 block">End Hour</span>
                      <select
                        value={newSchedule.end_hour}
                        onChange={(e) => setNewSchedule((s) => ({ ...s, end_hour: Number(e.target.value) }))}
                        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none"
                      >
                        {Array.from({ length: 24 }, (_, i) => (
                          <option key={i} value={i}>{String(i).padStart(2, "0")}:00</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Mode / Performance / Profile */}
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <span className="text-xs text-gray-400 mb-1 block">Operation Mode</span>
                      <select
                        value={newSchedule.mode || ""}
                        onChange={(e) => setNewSchedule((s) => ({ ...s, mode: e.target.value || undefined }))}
                        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none"
                      >
                        <option value="">No change</option>
                        <option value="autonomous">Autonomous</option>
                        <option value="hitl">HITL</option>
                      </select>
                    </div>
                    <div className="flex-1">
                      <span className="text-xs text-gray-400 mb-1 block">Performance</span>
                      <select
                        value={newSchedule.performance || ""}
                        onChange={(e) => setNewSchedule((s) => ({ ...s, performance: e.target.value || undefined }))}
                        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none"
                      >
                        <option value="">No change</option>
                        <option value="ultra_fast">Ultra Fast</option>
                        <option value="low_latency">Low Latency</option>
                        <option value="standard">Standard</option>
                        <option value="advanced">Advanced</option>
                      </select>
                    </div>
                    <div className="flex-1">
                      <span className="text-xs text-gray-400 mb-1 block">Environment</span>
                      <select
                        value={newSchedule.context_profile || ""}
                        onChange={(e) => setNewSchedule((s) => ({ ...s, context_profile: e.target.value || undefined }))}
                        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none"
                      >
                        <option value="">No change</option>
                        {envProfiles.map((p) => (
                          <option key={p.name} value={p.name}>{p.display_name}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={addScheduleEntry}
                      disabled={!newSchedule.name.trim() || newSchedule.days.length === 0}
                      className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      Add Entry
                    </button>
                    <button
                      onClick={() => setShowAddSchedule(false)}
                      className="rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-xs text-gray-400 hover:text-gray-200"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Schedule Entries */}
              {scheduleEntries.length === 0 ? (
                <div className="py-12 text-center">
                  <Calendar className="mx-auto mb-3 h-8 w-8 text-gray-700" />
                  <p className="text-sm text-gray-500">No schedule entries configured</p>
                  <p className="text-xs text-gray-600 mt-1">Add entries to auto-switch modes by time of day</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {scheduleEntries.map((entry, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900/30 px-4 py-3"
                    >
                      <div className="flex items-center gap-4">
                        <div>
                          <span className="text-sm font-medium text-gray-200">{entry.name}</span>
                          <div className="flex items-center gap-2 mt-1">
                            <div className="flex gap-0.5">
                              {DAY_LABELS.map((d) => (
                                <span
                                  key={d}
                                  className={cn(
                                    "inline-block w-5 text-center rounded text-[9px] font-bold",
                                    entry.days.includes(d) ? "bg-blue-900/40 text-blue-400" : "text-gray-700"
                                  )}
                                >
                                  {d.charAt(0).toUpperCase()}
                                </span>
                              ))}
                            </div>
                            <span className="text-xs text-gray-500 font-mono">
                              {String(entry.start_hour).padStart(2, "0")}:00 – {String(entry.end_hour).padStart(2, "0")}:00
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="flex gap-1.5">
                          {entry.mode && (
                            <span className={cn(
                              "rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase",
                              entry.mode === "autonomous" ? "border-emerald-700/50 bg-emerald-900/20 text-emerald-400" : "border-amber-700/50 bg-amber-900/20 text-amber-400"
                            )}>
                              {entry.mode === "autonomous" ? "Auto" : "HITL"}
                            </span>
                          )}
                          {entry.performance && (
                            <span className="rounded-full border border-gray-700 bg-gray-800 px-2 py-0.5 text-[10px] text-gray-400">
                              {entry.performance}
                            </span>
                          )}
                          {entry.context_profile && (
                            <span className="rounded-full border border-violet-700/50 bg-violet-900/20 px-2 py-0.5 text-[10px] text-violet-400 capitalize">
                              {entry.context_profile}
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => removeScheduleEntry(idx)}
                          className="text-gray-600 transition-colors hover:text-red-400"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ──────── Threat Metrics Tab ──────── */}
        {activeTab === "metrics" && (
          <div className="mx-auto max-w-5xl space-y-6">
            {metricsLoading && !metrics ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
              </div>
            ) : metrics ? (
              <>
                {/* Overview Stats */}
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Fingerprint className="h-4 w-4 text-violet-400" />
                      <span className="text-xs text-gray-500">Threat Signatures</span>
                    </div>
                    <div className="text-2xl font-bold tabular-nums text-violet-400">{metrics.total_signatures}</div>
                    <div className="text-[10px] text-gray-500">{metrics.total_categories} categories</div>
                  </div>
                  <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Activity className="h-4 w-4 text-emerald-400" />
                      <span className="text-xs text-gray-500">Agent Fleet</span>
                    </div>
                    <div className="text-2xl font-bold tabular-nums text-emerald-400">{metrics.agents_running}/{metrics.agents_total}</div>
                    <div className="text-[10px] text-gray-500">agents online</div>
                  </div>
                  <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <BookOpen className="h-4 w-4 text-yellow-400" />
                      <span className="text-xs text-gray-500">Detection Rules</span>
                    </div>
                    <div className="text-2xl font-bold tabular-nums text-yellow-400">{metrics.active_rules}/{metrics.total_rules}</div>
                    <div className="text-[10px] text-gray-500">rules active</div>
                  </div>
                  <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Shield className="h-4 w-4 text-cyan-400" />
                      <span className="text-xs text-gray-500">Active Protocol</span>
                    </div>
                    <div className="text-sm font-bold text-cyan-400 truncate">{metrics.active_protocol}</div>
                    <div className="text-[10px] text-gray-500">{metrics.deployed_scenarios_count} scenarios deployed</div>
                  </div>
                </div>

                {/* Rules by Severity Distribution */}
                <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
                  <h3 className="mb-4 text-sm font-bold text-gray-100">Rules by Severity</h3>
                  <div className="flex items-end gap-3 h-32">
                    {(["critical", "high", "medium", "low"] as const).map((sev) => {
                      const count = metrics.rules_by_severity[sev] || 0;
                      const maxCount = Math.max(...Object.values(metrics.rules_by_severity), 1);
                      const heightPct = (count / maxCount) * 100;
                      const colors: Record<string, string> = {
                        critical: "bg-red-500", high: "bg-orange-500", medium: "bg-yellow-500", low: "bg-blue-500",
                      };
                      return (
                        <div key={sev} className="flex flex-1 flex-col items-center gap-1">
                          <span className="text-xs font-bold tabular-nums text-gray-300">{count}</span>
                          <div className="w-full max-w-[48px] flex items-end" style={{ height: "80px" }}>
                            <div
                              className={`w-full rounded-t ${colors[sev]} transition-all duration-500`}
                              style={{ height: `${Math.max(heightPct, 4)}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-gray-500 capitalize">{sev}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Signature Categories Breakdown */}
                <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
                  <div className="mb-4 flex items-center justify-between">
                    <h3 className="text-sm font-bold text-gray-100">Signature Categories</h3>
                    <span className="text-xs text-gray-500">{metrics.total_signatures} total signatures across {metrics.total_categories} categories</span>
                  </div>
                  <div className="space-y-1">
                    {metrics.category_stats.map((cat) => {
                      const isExpanded = expandedCategory === cat.category;
                      const maxCount = Math.max(...metrics.category_stats.map((c) => c.count), 1);
                      const barPct = (cat.count / maxCount) * 100;

                      return (
                        <div key={cat.category}>
                          <button
                            onClick={() => setExpandedCategory(isExpanded ? null : cat.category)}
                            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-gray-800/50"
                          >
                            <span className="w-48 text-xs text-gray-300 truncate capitalize">
                              {cat.category.replace(/_/g, " ")}
                            </span>
                            <div className="flex-1 h-2 rounded-full bg-gray-800">
                              <div
                                className="h-2 rounded-full bg-gradient-to-r from-cyan-600 to-cyan-400 transition-all duration-500"
                                style={{ width: `${barPct}%` }}
                              />
                            </div>
                            <span className="w-8 text-right text-xs font-bold tabular-nums text-gray-400">
                              {cat.count}
                            </span>
                            {isExpanded ? (
                              <ChevronUp className="h-3 w-3 text-gray-500" />
                            ) : (
                              <ChevronDown className="h-3 w-3 text-gray-500" />
                            )}
                          </button>

                          {isExpanded && (
                            <div className="ml-6 mt-1 mb-2 space-y-1 pl-3 border-l border-gray-800">
                              {cat.signatures.map((sig) => (
                                <div key={sig.name} className="flex items-center gap-2 py-1">
                                  <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase ${SEVERITY_COLORS[sig.severity] || SEVERITY_COLORS.low}`}>
                                    {sig.severity}
                                  </span>
                                  <span className="text-[11px] text-gray-400 flex-1 truncate">{sig.name}</span>
                                  <span className="text-[10px] text-gray-600 font-mono">{sig.detection_method}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Current Sensitivity Profile */}
                <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
                  <h3 className="mb-4 text-sm font-bold text-gray-100">Current Sensitivity Levels</h3>
                  <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                    {Object.entries(metrics.sensitivity).map(([key, val]) => {
                      const pct = Math.round(val * 100);
                      const color = pct >= 80 ? "text-red-400" : pct >= 60 ? "text-yellow-400" : "text-emerald-400";
                      return (
                        <div key={key} className="rounded-lg border border-gray-800 bg-gray-900/30 p-3">
                          <div className="text-[10px] text-gray-500 capitalize truncate mb-1">
                            {key.replace(/_/g, " ")}
                          </div>
                          <div className={`text-lg font-bold tabular-nums ${color}`}>{pct}%</div>
                          <div className="mt-1 h-1.5 rounded-full bg-gray-800">
                            <div
                              className={cn(
                                "h-1.5 rounded-full transition-all",
                                pct >= 80 ? "bg-red-500" : pct >= 60 ? "bg-yellow-500" : "bg-emerald-500"
                              )}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : (
              <div className="py-20 text-center">
                <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-gray-700" />
                <p className="text-sm text-gray-500">Failed to load threat metrics</p>
                <button
                  onClick={fetchMetrics}
                  className="mt-3 rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-xs text-gray-400 hover:text-gray-200"
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
