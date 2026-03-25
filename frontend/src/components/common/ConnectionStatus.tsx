"use client";

import { useState, useEffect } from "react";

interface ConnectionStatusProps {
  wsConnected?: boolean;
}

export function ConnectionStatus({ wsConnected }: ConnectionStatusProps) {
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    // Set initial state (handle SSR where navigator may not exist)
    if (typeof navigator !== "undefined") {
      setIsOnline(navigator.onLine);
    }

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const showOffline = !isOnline;
  const showWsDisconnected = isOnline && wsConnected === false;
  const visible = showOffline || showWsDisconnected;

  return (
    <div
      className={`fixed top-0 left-0 right-0 z-[9999] transition-all duration-300 ease-in-out ${
        visible
          ? "translate-y-0 opacity-100"
          : "-translate-y-full opacity-0 pointer-events-none"
      }`}
    >
      {showOffline && (
        <div className="flex items-center justify-center gap-2 px-4 py-2 bg-red-600 text-white text-sm font-medium">
          <svg
            className="w-4 h-4 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M18.364 5.636a9 9 0 010 12.728M5.636 18.364a9 9 0 010-12.728M12 9v4m0 4h.01"
            />
          </svg>
          <span>No internet connection. Some features may be unavailable.</span>
        </div>
      )}

      {showWsDisconnected && (
        <div className="flex items-center justify-center gap-2 px-4 py-2 bg-yellow-600 text-white text-sm font-medium">
          <svg
            className="w-4 h-4 shrink-0 animate-pulse"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
            />
          </svg>
          <span>Live connection lost. Reconnecting...</span>
        </div>
      )}
    </div>
  );
}
