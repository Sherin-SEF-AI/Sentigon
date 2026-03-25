import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8002";
export const WS_BASE = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8002";

const _inflight = new Map<string, Promise<unknown>>();

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit & { timeoutMs?: number; silent404?: boolean } = {}
): Promise<T> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("sentinel_token") : null;

  const method = (options.method || "GET").toUpperCase();

  // Dedup identical GET requests in-flight
  const dedupKey = method === "GET" ? `${method}:${path}` : "";
  if (dedupKey && _inflight.has(dedupKey)) {
    return _inflight.get(dedupKey) as Promise<T>;
  }

  const execute = async (attempt = 0): Promise<T> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
    let isHttpError = false;

    try {
      const res = await fetch(`${API_BASE}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...options.headers,
        },
      });

      if (!res.ok) {
        // Redirect to login on 401 (token expired/missing)
        if (res.status === 401 && typeof window !== "undefined") {
          const onLogin = window.location.pathname === "/login";
          if (!onLogin) {
            localStorage.removeItem("sentinel_token");
            window.location.href = "/login";
            throw new Error("Session expired");
          }
        }
        // For GET requests, silently return undefined on non-ok responses (optional endpoints)
        if (method === "GET" && !res.ok) {
          return undefined as T;
        }
        isHttpError = true;
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || "API error");
      }

      if (res.status === 204) return undefined as T;
      return res.json();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new Error("Request timeout");
      }
      // For GET network errors, return undefined instead of retrying/throwing
      if (!isHttpError && method === "GET") {
        return undefined as T;
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  };

  const promise = execute();
  if (dedupKey) {
    _inflight.set(dedupKey, promise);
    promise.finally(() => _inflight.delete(dedupKey));
  }
  return promise;
}

export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function severityColor(severity: string): string {
  const map: Record<string, string> = {
    critical: "text-red-500 bg-red-500/10 border-red-500",
    high: "text-orange-500 bg-orange-500/10 border-orange-500",
    medium: "text-yellow-500 bg-yellow-500/10 border-yellow-500",
    low: "text-blue-400 bg-blue-400/10 border-blue-400",
    info: "text-gray-400 bg-gray-400/10 border-gray-400",
  };
  return map[severity] || map.info;
}

export function statusColor(status: string): string {
  const map: Record<string, string> = {
    new: "text-red-400",
    acknowledged: "text-yellow-400",
    investigating: "text-blue-400",
    resolved: "text-green-400",
    dismissed: "text-gray-500",
    escalated: "text-red-600",
  };
  return map[status] || "text-gray-400";
}

export function threatLevelColor(level: string): string {
  const map: Record<string, string> = {
    critical: "#ef4444",
    high: "#f97316",
    elevated: "#eab308",
    normal: "#22c55e",
  };
  return map[level] || "#22c55e";
}
