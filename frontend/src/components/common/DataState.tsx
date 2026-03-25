"use client";

import { LucideIcon, AlertTriangle, Loader2, RefreshCw } from "lucide-react";

interface DataStateProps {
  loading?: boolean;
  empty?: boolean;
  error?: string | null;
  icon?: LucideIcon;
  message?: string;
  onRetry?: () => void;
}

export function DataState({ loading, empty, error, icon: Icon, message, onRetry }: DataStateProps) {
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <AlertTriangle className="w-10 h-10 text-red-400" />
        <p className="text-sm text-red-300">{error}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-600"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </button>
        )}
      </div>
    );
  }

  if (empty) {
    const DisplayIcon = Icon || AlertTriangle;
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <DisplayIcon className="w-10 h-10 text-gray-500" />
        <p className="text-sm text-gray-400">{message || "No data available"}</p>
      </div>
    );
  }

  return null;
}
