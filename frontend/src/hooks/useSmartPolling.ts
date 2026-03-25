"use client";

import { useEffect, useRef, useCallback } from "react";

export function useSmartPolling(
  fetcher: () => Promise<void> | void,
  intervalMs: number,
  enabled: boolean = true
) {
  const fetcherRef = useRef(fetcher);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  fetcherRef.current = fetcher;

  const schedule = useCallback(() => {
    timerRef.current = setTimeout(async () => {
      if (!document.hidden) {
        try {
          await fetcherRef.current();
        } catch {}
      }
      schedule();
    }, intervalMs);
  }, [intervalMs]);

  useEffect(() => {
    if (!enabled) return;

    // Initial fetch
    try { fetcherRef.current(); } catch {}

    schedule();

    const handleVisibility = () => {
      if (!document.hidden) {
        // Tab became visible — fetch immediately
        try { fetcherRef.current(); } catch {}
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [enabled, schedule]);
}
