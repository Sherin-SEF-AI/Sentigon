"use client";

import { useState, useCallback, useEffect, useRef } from "react";

interface ApiError {
  message: string;
  status?: number;
}

export function useApiError(autoClearMs = 10000) {
  const [error, setError] = useState<ApiError | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const clearError = useCallback(() => {
    setError(null);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  // Auto-clear error after the specified duration
  useEffect(() => {
    if (error) {
      timerRef.current = setTimeout(() => {
        setError(null);
        timerRef.current = undefined;
      }, autoClearMs);
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [error, autoClearMs]);

  const setApiError = useCallback((err: ApiError) => {
    // Clear any existing timer before setting a new error
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    setError(err);
  }, []);

  const withErrorHandling = useCallback(
    <T>(fn: () => Promise<T>): (() => Promise<T | undefined>) => {
      return async () => {
        try {
          clearError();
          return await fn();
        } catch (caught: unknown) {
          let message = "An unexpected error occurred";
          let status: number | undefined;

          if (caught instanceof Response) {
            status = caught.status;
            try {
              const body = await caught.json();
              message = body.detail || body.message || body.error || `Request failed (${status})`;
            } catch {
              message = `Request failed (${status})`;
            }
          } else if (
            caught &&
            typeof caught === "object" &&
            "response" in caught &&
            caught.response instanceof Response
          ) {
            const resp = caught.response;
            status = resp.status;
            try {
              const body = await resp.json();
              message = body.detail || body.message || body.error || `Request failed (${status})`;
            } catch {
              message = `Request failed (${status})`;
            }
          } else if (caught instanceof Error) {
            message = caught.message;
          } else if (typeof caught === "string") {
            message = caught;
          }

          setApiError({ message, status });
          return undefined;
        }
      };
    },
    [clearError, setApiError],
  );

  return { error, setError: setApiError, clearError, withErrorHandling };
}
