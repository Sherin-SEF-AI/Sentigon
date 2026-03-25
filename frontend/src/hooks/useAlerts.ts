"use client";

import { useState, useCallback, useEffect } from "react";
import { useWebSocket } from "./useWebSocket";
import { apiFetch } from "@/lib/utils";
import type { Alert, WSMessage } from "@/lib/types";

export function useAlerts(limit = 50) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  // Initial fetch
  useEffect(() => {
    apiFetch<Alert[]>(`/api/alerts?limit=${limit}`)
      .then(setAlerts)
      .catch((err: Error) => { console.warn("Alerts fetch failed:", err.message); })
      .finally(() => setLoading(false));
  }, [limit]);

  // Real-time updates via WebSocket
  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.channel === "alerts") {
      const newAlert = msg.data as unknown as Alert;
      setAlerts((prev) => [newAlert, ...prev].slice(0, limit));
    }
  }, [limit]);

  const { connected } = useWebSocket({
    channels: ["alerts"],
    onMessage: handleMessage,
  });

  const acknowledgeAlert = useCallback(async (id: string) => {
    const updated = await apiFetch<Alert>(`/api/alerts/${id}/acknowledge`, {
      method: "POST",
    });
    setAlerts((prev) => prev.map((a) => (a.id === id ? updated : a)));
    return updated;
  }, []);

  const resolveAlert = useCallback(async (id: string, notes: string) => {
    const updated = await apiFetch<Alert>(`/api/alerts/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution_notes: notes }),
    });
    setAlerts((prev) => prev.map((a) => (a.id === id ? updated : a)));
    return updated;
  }, []);

  const dismissAlert = useCallback(async (id: string) => {
    const updated = await apiFetch<Alert>(`/api/alerts/${id}/dismiss`, {
      method: "POST",
    });
    setAlerts((prev) => prev.map((a) => (a.id === id ? updated : a)));
    return updated;
  }, []);

  return { alerts, loading, connected, acknowledgeAlert, resolveAlert, dismissAlert };
}
