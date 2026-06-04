"use client";

import * as React from "react";
import { Bell, X } from "lucide-react";

import { useWebSocket } from "@/hooks/useWebSocket";
import { SEVERITY_CLASSES } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import type { WSMessage } from "@/lib/types";

interface LiveNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  severity: string;
  receivedAt: number;
  read: boolean;
}

const MAX_ITEMS = 50;

function severityClass(sev: string): string {
  return SEVERITY_CLASSES[sev?.toLowerCase()] ?? SEVERITY_CLASSES.info;
}

// Explicit (literal) dot colors so Tailwind's scanner keeps them.
const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-blue-400",
  info: "bg-gray-400",
};

function severityDot(sev: string): string {
  return SEVERITY_DOT[sev?.toLowerCase()] ?? SEVERITY_DOT.info;
}

/** Best-effort title/body extraction across the varied payloads broadcast on
 *  the `notifications` channel (pending_action, autonomous_response, auto_response,
 *  mass_notification, agent dispatch …). */
function normalize(data: Record<string, unknown>, seq: number): LiveNotification {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const type = str(data.type) ?? "notification";
  const title =
    str(data.title) ??
    str(data.subject) ??
    str(data.summary) ??
    type.replace(/[_-]+/g, " ");
  const message =
    str(data.message) ?? str(data.summary) ?? str(data.threat_type) ?? "";
  const severity = str(data.severity) ?? "info";
  return {
    id: `${seq}-${type}`,
    type,
    title,
    message,
    severity,
    receivedAt: Date.now(),
    read: false,
  };
}

function timeAgo(ms: number): string {
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/**
 * Live operator notification inbox. Subscribes to the `notifications` WS
 * channel and surfaces incoming messages under a bell with an unread badge.
 * Live-only (no server-side history endpoint exists for inbound notifications).
 */
export function NotificationCenter() {
  const [items, setItems] = React.useState<LiveNotification[]>([]);
  const [open, setOpen] = React.useState(false);
  const seqRef = React.useRef(0);
  const panelRef = React.useRef<HTMLDivElement>(null);

  const handleMessage = React.useCallback((msg: WSMessage) => {
    if (msg.channel !== "notifications" && msg.channel !== "notification") return;
    const next = normalize(msg.data ?? {}, seqRef.current++);
    setItems((prev) => [next, ...prev].slice(0, MAX_ITEMS));
  }, []);

  const { connected } = useWebSocket({
    channels: ["notifications"],
    onMessage: handleMessage,
  });

  const unread = items.filter((i) => !i.read).length;

  // Mark everything read when the panel is opened.
  React.useEffect(() => {
    if (open && unread > 0) {
      setItems((prev) => prev.map((i) => ({ ...i, read: true })));
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on outside click / Escape.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={panelRef} className="fixed top-3 right-3 z-[1100]">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        className={cn(
          "relative flex h-9 w-9 items-center justify-center rounded-lg border border-gray-800 bg-gray-950/80 text-gray-400 backdrop-blur transition-colors hover:text-gray-200",
          open && "text-gray-200"
        )}
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-600 px-1 text-[9px] font-bold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
        <span
          className={cn(
            "absolute -bottom-0.5 -left-0.5 h-2 w-2 rounded-full border border-gray-950",
            connected ? "bg-emerald-500" : "bg-gray-600"
          )}
          title={connected ? "Live" : "Disconnected"}
        />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 overflow-hidden rounded-xl border border-gray-800 bg-gray-950 shadow-2xl">
          <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              Notifications
            </span>
            <div className="flex items-center gap-2">
              {items.length > 0 && (
                <button
                  onClick={() => setItems([])}
                  className="text-[11px] text-gray-500 hover:text-gray-300"
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="text-gray-500 hover:text-gray-300"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="max-h-96 overflow-auto">
            {items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-gray-600">
                <Bell className="mb-2 h-6 w-6 opacity-40" />
                <p className="text-xs">No notifications yet</p>
                <p className="mt-0.5 text-[10px] text-gray-700">
                  {connected ? "Listening for live events…" : "Reconnecting…"}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-800/60">
                {items.map((n) => (
                  <li key={n.id} className="px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <span
                        className={cn(
                          "mt-1 h-2 w-2 shrink-0 rounded-full",
                          severityDot(n.severity)
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-gray-200">
                            {n.title}
                          </span>
                          <span className="shrink-0 text-[10px] text-gray-600">
                            {timeAgo(n.receivedAt)}
                          </span>
                        </div>
                        {n.message && (
                          <p className="mt-0.5 line-clamp-2 text-[11px] text-gray-500">
                            {n.message}
                          </p>
                        )}
                        <span
                          className={cn(
                            "mt-1 inline-block rounded border px-1 py-0.5 text-[9px] font-bold uppercase",
                            severityClass(n.severity)
                          )}
                        >
                          {n.severity}
                        </span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default NotificationCenter;
