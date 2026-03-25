"use client";

import { useEffect, useCallback, useState, useRef } from "react";
import { useWebSocket } from "./useWebSocket";
import { apiFetch } from "@/lib/utils";
import type {
  ThreatResponse,
  ThreatResponseAction,
  EmergencyService,
  WSMessage,
} from "@/lib/types";

export function useThreatResponse() {
  const [activeResponses, setActiveResponses] = useState<ThreatResponse[]>([]);
  const [responseHistory, setResponseHistory] = useState<ThreatResponse[]>([]);
  const [emergencyServices, setEmergencyServices] = useState<EmergencyService[]>([]);
  const [facilityLocation, setFacilityLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const activeRef = useRef(activeResponses);
  activeRef.current = activeResponses;

  // Handle incoming WebSocket messages for threat_response channel
  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.channel !== "threat_response") return;

    const data = msg.data as Record<string, unknown>;
    const responseId = data.response_id as string;
    if (!responseId) return;

    const action: ThreatResponseAction = {
      step_number: (data.step_number as number) || 0,
      total_steps: (data.total_steps as number) || 7,
      action: (data.action as string) || "",
      status: (data.status as ThreatResponseAction["status"]) || "completed",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      details: (data.details as Record<string, any>) || {},
      timestamp: (data.timestamp as string) || new Date().toISOString(),
    };

    setActiveResponses((prev) => {
      const existing = prev.find((r) => r.response_id === responseId);
      if (existing) {
        // Update existing response with new action
        return prev.map((r) => {
          if (r.response_id !== responseId) return r;
          const actions = [...r.actions];
          const idx = actions.findIndex(
            (a) => a.step_number === action.step_number && a.action === action.action
          );
          if (idx >= 0 && action.status !== "executing") {
            actions[idx] = action;
          } else if (idx < 0) {
            actions.push(action);
          }
          // Check if response completed (all steps completed)
          const allDone = actions.filter((a) => a.status === "completed").length >= action.total_steps;
          return {
            ...r,
            actions: actions.sort((a, b) => a.step_number - b.step_number),
            status: allDone ? "completed" : r.status,
            completed_at: allDone ? new Date().toISOString() : r.completed_at,
          };
        });
      } else {
        // New response — create from WebSocket data
        const newResp: ThreatResponse = {
          response_id: responseId,
          alert_id: (data.alert_id as string) || "",
          severity: (data.severity as ThreatResponse["severity"]) || "high",
          threat_type: (data.threat_type as string) || "unknown",
          confidence: (data.confidence as number) || 0,
          source_camera: (data.source_camera as string) || "",
          zone_name: (data.zone_name as string) || "",
          title: (data.title as string) || "",
          description: "",
          status: "active",
          actions: [action],
          started_at: action.timestamp,
          completed_at: null,
        };
        return [newResp, ...prev];
      }
    });
  }, []);

  const { connected } = useWebSocket({
    channels: ["threat_response", "notifications"],
    onMessage: handleMessage,
  });

  // Fetch initial state on mount
  useEffect(() => {
    let cancelled = false;

    async function fetchState() {
      try {
        const [activeRes, historyRes, locationRes] = await Promise.allSettled([
          apiFetch<ThreatResponse[]>("/api/threat-response/active"),
          apiFetch<ThreatResponse[]>("/api/threat-response/history?limit=20"),
          apiFetch<{ latitude: number; longitude: number; configured: boolean }>(
            "/api/emergency/facility-location"
          ),
        ]);

        if (cancelled) return;

        if (activeRes.status === "fulfilled" && activeRes.value) {
          setActiveResponses(activeRes.value);
        }
        if (historyRes.status === "fulfilled" && historyRes.value) {
          setResponseHistory(historyRes.value);
        }
        if (locationRes.status === "fulfilled" && locationRes.value) {
          const loc = locationRes.value;
          setFacilityLocation({ latitude: loc.latitude, longitude: loc.longitude });

          // Fetch nearby emergency services
          try {
            const svcRes = await apiFetch<{
              services: EmergencyService[];
              total_found: number;
            }>("/api/emergency/nearby", {
              method: "POST",
              body: JSON.stringify({
                latitude: loc.latitude,
                longitude: loc.longitude,
                radius_km: 5.0,
              }),
            });
            if (!cancelled && svcRes?.services) {
              setEmergencyServices(svcRes.services);
            }
          } catch {
            // Emergency services optional
          }
        }
      } catch {
        // Graceful degradation
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchState();
    return () => { cancelled = true; };
  }, []);

  // Move completed active responses to history
  useEffect(() => {
    const completed = activeResponses.filter(
      (r) => r.status === "completed" || r.status === "aborted" || r.status === "failed"
    );
    if (completed.length > 0) {
      const timer = setTimeout(() => {
        setActiveResponses((prev) =>
          prev.filter((r) => r.status === "active")
        );
        setResponseHistory((prev) => [...completed, ...prev].slice(0, 100));
      }, 5000); // Keep completed on screen for 5s before archiving
      return () => clearTimeout(timer);
    }
  }, [activeResponses]);

  // Trigger test response
  const triggerTest = useCallback(async () => {
    try {
      await apiFetch("/api/threat-response/test", { method: "POST" });
    } catch {
      // Error handled by UI
    }
  }, []);

  // Abort response
  const abortResponse = useCallback(async (responseId: string, reason = "manual_override") => {
    try {
      await apiFetch(`/api/threat-response/${responseId}/override`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      setActiveResponses((prev) =>
        prev.map((r) =>
          r.response_id === responseId ? { ...r, status: "aborted" as const } : r
        )
      );
    } catch {
      // Error handled by UI
    }
  }, []);

  // Refresh history
  const refreshHistory = useCallback(async () => {
    try {
      const res = await apiFetch<ThreatResponse[]>("/api/threat-response/history?limit=50");
      if (res) setResponseHistory(res);
    } catch {
      // Graceful
    }
  }, []);

  return {
    activeResponses,
    responseHistory,
    emergencyServices,
    facilityLocation,
    connected,
    loading,
    triggerTest,
    abortResponse,
    refreshHistory,
  };
}
