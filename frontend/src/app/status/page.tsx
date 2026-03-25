"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, Camera, Cpu, Database, Network, Server, Users, Zap } from "lucide-react";
import SystemHealthGauge from "@/components/common/SystemHealthGauge";
import MetricSparkline from "@/components/common/MetricSparkline";

interface SystemStatus {
  status: string;
  cameras: {
    total: number;
    active: number;
  };
  websockets: {
    connections: number;
    channels: Record<string, number>;
  };
}

interface CameraStatus {
  id: string;
  name: string;
  status: string;
  location: string;
  fps?: number;
  resolution?: string;
}

interface AgentStatus {
  name: string;
  tier: string;
  running: boolean;
  cycle_count: number;
  last_cycle_at: string | null;
  error_count: number;
  last_error?: string | null;
}

interface AlertSummary {
  id: string;
  title: string;
  severity: string;
  status: string;
  created_at: string;
}

interface DeepHealth {
  cpu_percent?: number;
  memory_percent?: number;
  disk_percent?: number;
  gpu?: {
    utilization?: number;
    memory_percent?: number;
    available?: boolean;
  };
  services?: {
    backend?: boolean;
    postgres?: boolean;
    redis?: boolean;
    ollama?: boolean;
    yolo?: boolean;
  };
}

/* Ordered dependency chain for the service graph */
const SERVICE_CHAIN: { key: keyof NonNullable<DeepHealth["services"]>; label: string }[] = [
  { key: "backend", label: "Backend API" },
  { key: "postgres", label: "PostgreSQL" },
  { key: "redis", label: "Redis" },
  { key: "ollama", label: "Ollama" },
  { key: "yolo", label: "YOLO" },
];

const MAX_RESPONSE_TIMES = 20;

export default function SystemStatusPage() {
  const { addToast } = useToast();
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [cameras, setCameras] = useState<CameraStatus[]>([]);
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [alerts, setAlerts] = useState<AlertSummary[]>([]);
  const [deepHealth, setDeepHealth] = useState<DeepHealth | null>(null);
  const [responseTimes, setResponseTimes] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAllStatus();
    fetchDeepHealth();
    const interval = setInterval(() => {
      fetchAllStatus();
      fetchDeepHealth();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const fetchAllStatus = async () => {
    try {
      const t0 = performance.now();
      const [sys, cams, agsData, alts] = await Promise.all([
        apiFetch<SystemStatus>("/api/status"),
        apiFetch<CameraStatus[]>("/api/cameras"),
        apiFetch<{ agents: AgentStatus[] }>("/api/agents/status"),
        apiFetch<AlertSummary[]>("/api/alerts?limit=5"),
      ]);
      const elapsed = Math.round(performance.now() - t0);

      setSystemStatus(sys);
      setCameras(cams);
      setAgents(agsData.agents);
      setAlerts(alts);

      // Track response time trend (last 20 samples)
      setResponseTimes((prev) => {
        const next = [...prev, elapsed];
        return next.length > MAX_RESPONSE_TIMES ? next.slice(next.length - MAX_RESPONSE_TIMES) : next;
      });
    } catch (error) {
      console.warn("Failed to fetch status:", (error as Error).message);
      addToast("error", "Failed to refresh system status");
    } finally {
      setLoading(false);
    }
  };

  const fetchDeepHealth = async () => {
    try {
      const data = await apiFetch<DeepHealth>("/api/health/deep");
      setDeepHealth(data);
    } catch {
      // Deep health is optional — don't surface noisy errors
    }
  };

  const getCameraStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case "online":
        return "bg-green-500";
      case "offline":
        return "bg-gray-500";
      case "error":
        return "bg-red-500";
      default:
        return "bg-yellow-500";
    }
  };

  const getAgentStatusColor = (running: boolean, hasError: boolean = false) => {
    if (hasError) return "text-red-500";
    if (running) return "text-green-400";
    return "text-gray-500";
  };

  const getAgentStatusText = (running: boolean, hasError: boolean = false) => {
    if (hasError) return "error";
    if (running) return "running";
    return "stopped";
  };

  const getSeverityColor = (severity: string) => {
    switch (severity.toLowerCase()) {
      case "critical":
        return "bg-red-500";
      case "high":
        return "bg-orange-500";
      case "medium":
        return "bg-yellow-500";
      case "low":
        return "bg-blue-500";
      default:
        return "bg-gray-500";
    }
  };

  const agentsByTier = {
    perception: agents.filter((a) => a.tier === "perception"),
    reasoning: agents.filter((a) => a.tier === "reasoning"),
    action: agents.filter((a) => a.tier === "action"),
    supervisor: agents.filter((a) => a.tier === "supervisor"),
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <Activity className="mx-auto h-12 w-12 animate-pulse text-blue-500" />
          <p className="mt-4 text-gray-400">Loading system status...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">System Status</h1>
          <p className="text-gray-400">Real-time overview of SENTINEL AI platform</p>
        </div>
        <Badge
          variant="outline"
          className={`text-lg ${systemStatus?.status === "operational" ? "border-green-500 text-green-500" : "border-red-500 text-red-500"}`}
        >
          {systemStatus?.status === "operational" ? "● Operational" : "● Degraded"}
        </Badge>
      </div>

      {/* System Overview Cards */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
        <Card className="border-blue-500/20 bg-gray-900">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-400">Cameras</CardTitle>
            <Camera className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">
              {systemStatus?.cameras.active}/{systemStatus?.cameras.total}
            </div>
            <p className="text-xs text-gray-500">Active / Total</p>
          </CardContent>
        </Card>

        <Card className="border-purple-500/20 bg-gray-900">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-400">Agents</CardTitle>
            <Cpu className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">
              {agents.filter((a) => a.running).length}/{agents.length}
            </div>
            <p className="text-xs text-gray-500">Running / Total</p>
          </CardContent>
        </Card>

        <Card className="border-green-500/20 bg-gray-900">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-400">Connections</CardTitle>
            <Network className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">
              {systemStatus?.websockets.connections || 0}
            </div>
            <p className="text-xs text-gray-500">Active WebSockets</p>
          </CardContent>
        </Card>

        <Card className="border-orange-500/20 bg-gray-900">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-400">Recent Alerts</CardTitle>
            <Zap className="h-4 w-4 text-orange-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">{alerts.length}</div>
            <p className="text-xs text-gray-500">Last 5 alerts</p>
          </CardContent>
        </Card>
      </div>

      {/* Infrastructure Metrics Gauges */}
      <Card className="border-gray-800 bg-gray-900">
        <CardHeader>
          <CardTitle className="flex items-center text-white">
            <Cpu className="mr-2 h-5 w-5 text-cyan-400" />
            Infrastructure Metrics
          </CardTitle>
          <CardDescription>Real-time hardware utilization from the host system</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center justify-around gap-6 py-2">
            <SystemHealthGauge
              label="CPU"
              value={deepHealth?.cpu_percent ?? 0}
              unit="%"
              status={deepHealth == null ? "offline" : undefined}
            />
            <SystemHealthGauge
              label="Memory"
              value={deepHealth?.memory_percent ?? 0}
              unit="%"
              status={deepHealth == null ? "offline" : undefined}
            />
            <SystemHealthGauge
              label="Disk"
              value={deepHealth?.disk_percent ?? 0}
              unit="%"
              status={deepHealth == null ? "offline" : undefined}
            />
            <SystemHealthGauge
              label="GPU"
              value={deepHealth?.gpu?.utilization ?? 0}
              unit="%"
              status={
                deepHealth == null
                  ? "offline"
                  : deepHealth.gpu?.available === false
                  ? "offline"
                  : undefined
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* Service Dependencies + Performance Trending — side by side */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Service Dependency Visualization */}
        <Card className="border-gray-800 bg-gray-900">
          <CardHeader>
            <CardTitle className="flex items-center text-white">
              <Network className="mr-2 h-5 w-5 text-indigo-400" />
              Service Dependencies
            </CardTitle>
            <CardDescription>Dependency chain health</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {SERVICE_CHAIN.map(({ key, label }, idx) => {
                const up =
                  deepHealth?.services != null
                    ? deepHealth.services[key] === true
                    : null;
                return (
                  <div key={key} className="flex items-center gap-3">
                    {/* connector line above (skip first) */}
                    <div className="flex flex-col items-center self-stretch">
                      {idx === 0 ? (
                        <div className="h-2 w-px" />
                      ) : (
                        <div className="h-2 w-px bg-gray-700" />
                      )}
                      <div
                        className={`h-3 w-3 rounded-full border-2 ${
                          up === null
                            ? "border-gray-600 bg-gray-700"
                            : up
                            ? "border-green-500 bg-green-500"
                            : "border-red-500 bg-red-500"
                        }`}
                      />
                      {idx < SERVICE_CHAIN.length - 1 && (
                        <div className="flex-1 w-px bg-gray-700" />
                      )}
                    </div>
                    <div className="flex flex-1 items-center justify-between rounded-lg border border-gray-800 bg-gray-950 px-3 py-2 my-0.5">
                      <span className="text-sm text-gray-200">{label}</span>
                      <span
                        className={`text-xs font-semibold ${
                          up === null
                            ? "text-gray-500"
                            : up
                            ? "text-green-400"
                            : "text-red-400"
                        }`}
                      >
                        {up === null ? "Unknown" : up ? "Online" : "Offline"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* API Response Time Sparkline */}
        <Card className="border-gray-800 bg-gray-900">
          <CardHeader>
            <CardTitle className="flex items-center text-white">
              <Activity className="mr-2 h-5 w-5 text-emerald-400" />
              API Response Time
            </CardTitle>
            <CardDescription>
              Last {MAX_RESPONSE_TIMES} health-check round-trips (ms)
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center gap-4 py-4">
            {responseTimes.length < 2 ? (
              <p className="text-sm text-gray-500">Collecting data…</p>
            ) : (
              <>
                <MetricSparkline
                  data={responseTimes}
                  width={300}
                  height={60}
                  color="#10b981"
                  fill
                  showValue
                  unit=" ms"
                />
                <div className="flex gap-6 text-xs text-gray-500">
                  <span>
                    Min:{" "}
                    <span className="font-mono text-gray-300">
                      {Math.min(...responseTimes)} ms
                    </span>
                  </span>
                  <span>
                    Max:{" "}
                    <span className="font-mono text-gray-300">
                      {Math.max(...responseTimes)} ms
                    </span>
                  </span>
                  <span>
                    Avg:{" "}
                    <span className="font-mono text-gray-300">
                      {Math.round(
                        responseTimes.reduce((a, b) => a + b, 0) /
                          responseTimes.length
                      )}{" "}
                      ms
                    </span>
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Camera Grid */}
      <Card className="border-gray-800 bg-gray-900">
        <CardHeader>
          <CardTitle className="flex items-center text-white">
            <Camera className="mr-2 h-5 w-5" />
            Camera Network
          </CardTitle>
          <CardDescription>Status of all registered cameras</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {cameras.map((cam) => (
              <div
                key={cam.id}
                className="rounded-lg border border-gray-800 bg-gray-950 p-4 hover:border-blue-500/50 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="font-semibold text-white">{cam.name}</h3>
                    <p className="text-xs text-gray-500">{cam.location}</p>
                  </div>
                  <div className={`h-3 w-3 rounded-full ${getCameraStatusColor(cam.status)}`} />
                </div>
                <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
                  <span>{cam.resolution || "N/A"}</span>
                  <span>{cam.fps ? `${cam.fps} FPS` : "N/A"}</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Agent Fleet Status */}
      <Card className="border-gray-800 bg-gray-900">
        <CardHeader>
          <CardTitle className="flex items-center text-white">
            <Server className="mr-2 h-5 w-5" />
            Multi-Agent System
          </CardTitle>
          <CardDescription>Autonomous agent fleet status across all tiers</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Supervisor Tier */}
          {agentsByTier.supervisor.length > 0 && (
            <div>
              <h4 className="mb-3 text-sm font-semibold text-purple-400">Supervisor Tier</h4>
              <div className="grid gap-3">
                {agentsByTier.supervisor.map((agent) => (
                  <div
                    key={agent.name}
                    className="flex items-center justify-between rounded-lg border border-purple-500/20 bg-purple-950/20 p-3"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`text-xl ${getAgentStatusColor(agent.running, !!agent.last_error)}`}>●</div>
                      <div>
                        <p className="font-medium text-white">{agent.name.replace(/_/g, " ")}</p>
                        <p className="text-xs text-gray-500">
                          {agent.cycle_count} cycles | {agent.error_count} errors
                        </p>
                      </div>
                    </div>
                    <Badge variant="outline" className="border-purple-500/50 text-purple-400">
                      {getAgentStatusText(agent.running, !!agent.last_error)}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Perception Tier */}
          {agentsByTier.perception.length > 0 && (
            <div>
              <h4 className="mb-3 text-sm font-semibold text-blue-400">Perception Tier</h4>
              <div className="grid gap-2 md:grid-cols-2">
                {agentsByTier.perception.map((agent) => (
                  <div
                    key={agent.name}
                    className="flex items-center justify-between rounded-lg border border-blue-500/20 bg-blue-950/20 p-3"
                  >
                    <div className="flex items-center gap-2">
                      <div className={`text-sm ${getAgentStatusColor(agent.running, !!agent.last_error)}`}>●</div>
                      <div>
                        <p className="text-sm font-medium text-white">
                          {agent.name.replace(/_/g, " ")}
                        </p>
                        <p className="text-xs text-gray-500">{agent.cycle_count} cycles</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reasoning Tier */}
          {agentsByTier.reasoning.length > 0 && (
            <div>
              <h4 className="mb-3 text-sm font-semibold text-yellow-400">Reasoning Tier</h4>
              <div className="grid gap-2 md:grid-cols-2">
                {agentsByTier.reasoning.map((agent) => (
                  <div
                    key={agent.name}
                    className="flex items-center justify-between rounded-lg border border-yellow-500/20 bg-yellow-950/20 p-3"
                  >
                    <div className="flex items-center gap-2">
                      <div className={`text-sm ${getAgentStatusColor(agent.running, !!agent.last_error)}`}>●</div>
                      <div>
                        <p className="text-sm font-medium text-white">
                          {agent.name.replace(/_/g, " ")}
                        </p>
                        <p className="text-xs text-gray-500">{agent.cycle_count} cycles</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action Tier */}
          {agentsByTier.action.length > 0 && (
            <div>
              <h4 className="mb-3 text-sm font-semibold text-green-400">Action Tier</h4>
              <div className="grid gap-2 md:grid-cols-2">
                {agentsByTier.action.map((agent) => (
                  <div
                    key={agent.name}
                    className="flex items-center justify-between rounded-lg border border-green-500/20 bg-green-950/20 p-3"
                  >
                    <div className="flex items-center gap-2">
                      <div className={`text-sm ${getAgentStatusColor(agent.running, !!agent.last_error)}`}>●</div>
                      <div>
                        <p className="text-sm font-medium text-white">
                          {agent.name.replace(/_/g, " ")}
                        </p>
                        <p className="text-xs text-gray-500">{agent.cycle_count} cycles</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Alerts */}
      <Card className="border-gray-800 bg-gray-900">
        <CardHeader>
          <CardTitle className="flex items-center text-white">
            <Zap className="mr-2 h-5 w-5" />
            Recent Alerts
          </CardTitle>
          <CardDescription>Latest security alerts from the system</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {alerts.length === 0 ? (
              <p className="text-center text-gray-500 py-4">No recent alerts</p>
            ) : (
              alerts.map((alert) => (
                <div
                  key={alert.id}
                  className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-950 p-3 hover:border-gray-700 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className={`h-2 w-2 rounded-full ${getSeverityColor(alert.severity)}`} />
                    <div>
                      <p className="text-sm font-medium text-white">{alert.title}</p>
                      <p className="text-xs text-gray-500">
                        {new Date(alert.created_at).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <Badge variant="outline" className="border-gray-700 text-gray-400">
                    {alert.status}
                  </Badge>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
