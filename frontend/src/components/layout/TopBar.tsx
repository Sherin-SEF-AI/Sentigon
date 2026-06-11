"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { apiFetch } from "@/lib/utils";
import { StatusDot } from "@/components/ui/status-dot";
import type { OperationModeStatus } from "@/lib/types";

/**
 * TopBar — the command-center system strip above every page: a Cmd+K search
 * affordance, the operation-mode pill, a connection LED, and a live UTC clock.
 * One operation-mode poll drives both the mode pill and the connection state.
 */
export function TopBar({ onSearch }: { onSearch: () => void }) {
  const [now, setNow] = useState("");
  const [online, setOnline] = useState<boolean | null>(null);
  const [mode, setMode] = useState<OperationModeStatus | null>(null);

  useEffect(() => {
    const tick = () => setNow(new Date().toISOString().slice(11, 19));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    const ping = async () => {
      try {
        const m = await apiFetch<OperationModeStatus>("/api/operation-mode");
        if (alive) { setMode(m); setOnline(true); }
      } catch {
        if (alive) setOnline(false);
      }
    };
    ping();
    const t = setInterval(ping, 10000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface-1/80 px-3 backdrop-blur">
      <button
        onClick={onSearch}
        className="group flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Search</span>
        <kbd className="data hidden rounded border border-border px-1 text-[10px] text-muted-foreground sm:inline">
          ⌘K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-4">
        {mode && (
          <StatusDot
            tone={mode.mode === "autonomous" ? "live" : "warn"}
            pulse={mode.mode !== "autonomous"}
            label={mode.mode === "autonomous" ? "Auto" : "HITL"}
          />
        )}
        <StatusDot
          tone={online === false ? "crit" : online ? "live" : "idle"}
          pulse={online !== false}
          label={online === false ? "Offline" : "Link"}
        />
        <span className="data text-xs tabular-nums text-muted-foreground">{now} UTC</span>
      </div>
    </header>
  );
}
