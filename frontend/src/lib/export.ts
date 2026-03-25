/**
 * Shared export utilities for CSV and PDF generation.
 */

/* ------------------------------------------------------------------ */
/*  CSV Export                                                         */
/* ------------------------------------------------------------------ */

/**
 * Convert an array of objects to a CSV string.
 * Handles nested values, commas, quotes, and newlines.
 */
export function toCSV<T extends Record<string, unknown>>(
  rows: T[],
  columns?: { key: string; label: string }[]
): string {
  if (rows.length === 0) return "";

  const cols = columns || Object.keys(rows[0]).map((k) => ({ key: k, label: k }));
  const header = cols.map((c) => escapeCSV(c.label)).join(",");

  const body = rows
    .map((row) =>
      cols
        .map((c) => {
          const val = row[c.key];
          if (val === null || val === undefined) return "";
          if (typeof val === "object") return escapeCSV(JSON.stringify(val));
          return escapeCSV(String(val));
        })
        .join(",")
    )
    .join("\n");

  return `${header}\n${body}`;
}

function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Trigger a browser download of a CSV string.
 */
export function downloadCSV(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Export an array of objects as a CSV file download.
 */
export function exportCSV<T extends Record<string, unknown>>(
  rows: T[],
  filename: string,
  columns?: { key: string; label: string }[]
): void {
  const csv = toCSV(rows, columns);
  downloadCSV(csv, filename);
}

/* ------------------------------------------------------------------ */
/*  PDF Export (server-side)                                            */
/* ------------------------------------------------------------------ */

/**
 * Request a PDF report from the backend and download it.
 *
 * @param endpoint - API endpoint that returns a PDF (e.g. "/api/reports/generate")
 * @param params - Query parameters or POST body
 * @param filename - Downloaded file name
 */
export async function downloadPDF(
  endpoint: string,
  params?: Record<string, string>,
  filename?: string
): Promise<void> {
  const token =
    typeof window !== "undefined"
      ? localStorage.getItem("sentinel_token")
      : null;

  const url = new URL(endpoint, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const res = await fetch(url.toString(), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PDF generation failed: ${res.status} ${text}`);
  }

  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download =
    filename ||
    `report_${new Date().toISOString().slice(0, 10)}.pdf`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(blobUrl);
}

/* ------------------------------------------------------------------ */
/*  JSON Export                                                        */
/* ------------------------------------------------------------------ */

/**
 * Export data as a JSON file download.
 */
export function exportJSON(data: unknown, filename: string): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
