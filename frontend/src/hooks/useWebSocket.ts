"use client";

import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { WS_BASE } from "@/lib/utils";
import type { WSMessage } from "@/lib/types";

interface UseWebSocketOptions {
  channels?: string[];
  onMessage?: (msg: WSMessage) => void;
  reconnectInterval?: number;
  maxReconnectInterval?: number;
}

export function useWebSocket({
  channels,
  onMessage,
  reconnectInterval = 3000,
  maxReconnectInterval = 30000,
}: UseWebSocketOptions = {}) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const connectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mountedRef = useRef(false);
  const onMessageRef = useRef(onMessage);
  const backoffRef = useRef(reconnectInterval);
  onMessageRef.current = onMessage;

  // Stabilize channel list — avoids re-creating the connect function on every render
  const channelKey = channels?.sort().join(",") ?? "";
  const stableChannels = useMemo(() => channels, [channelKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = useCallback(() => {
    // Don't connect if unmounted or no auth token
    if (!mountedRef.current) return;
    const token = typeof window !== "undefined" ? localStorage.getItem("sentinel_token") : null;
    if (!token) return;

    // Close any existing connection
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    const channelParam = stableChannels?.length ? `?channels=${stableChannels.join(",")}` : "";
    const ws = new WebSocket(`${WS_BASE}/ws${channelParam}`);

    ws.onopen = () => {
      if (!mountedRef.current) {
        ws.close();
        return;
      }
      setConnected(true);
      backoffRef.current = reconnectInterval; // Reset backoff on success
    };

    ws.onmessage = (ev) => {
      try {
        const msg: WSMessage = JSON.parse(ev.data);
        onMessageRef.current?.(msg);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      if (!mountedRef.current) return;
      // Exponential backoff reconnect
      reconnectTimer.current = setTimeout(connect, backoffRef.current);
      backoffRef.current = Math.min(backoffRef.current * 1.5, maxReconnectInterval);
    };

    ws.onerror = () => {
      // onclose will fire after onerror, let it handle cleanup
    };

    wsRef.current = ws;
  }, [stableChannels, reconnectInterval, maxReconnectInterval]);

  useEffect(() => {
    mountedRef.current = true;

    // Delay initial connection slightly — prevents React strict mode
    // double-mount from creating a WebSocket that gets immediately torn down
    connectTimer.current = setTimeout(connect, 50);

    return () => {
      mountedRef.current = false;
      if (connectTimer.current) clearTimeout(connectTimer.current);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const send = useCallback((data: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { connected, send, ws: wsRef };
}
