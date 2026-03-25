"use client";

import { useState, useCallback, useRef } from "react";
import { Upload, X, FileText, Image, Film, Loader2, CheckCircle2 } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface UploadedFile {
  name: string;
  size: number;
  type: string;
  url?: string;
  id?: string;
}

interface FileUploadProps {
  /** API endpoint to POST the file to */
  endpoint: string;
  /** Extra form fields to include with the upload */
  extraFields?: Record<string, string>;
  /** Accepted MIME types (e.g. "image/*,video/*,.pdf") */
  accept?: string;
  /** Max file size in bytes (default 50MB) */
  maxSize?: number;
  /** Allow multiple files */
  multiple?: boolean;
  /** Callback when upload succeeds */
  onUpload?: (file: UploadedFile) => void;
  /** Callback on error */
  onError?: (message: string) => void;
  /** Custom label */
  label?: string;
  /** Compact mode */
  compact?: boolean;
}

/* ------------------------------------------------------------------ */
/*  File icon helper                                                   */
/* ------------------------------------------------------------------ */

function fileIcon(type: string) {
  if (type.startsWith("image/")) return <Image className="h-4 w-4 text-blue-400" />;
  if (type.startsWith("video/")) return <Film className="h-4 w-4 text-purple-400" />;
  return <FileText className="h-4 w-4 text-gray-400" />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/*  FileUpload Component                                               */
/* ------------------------------------------------------------------ */

export default function FileUpload({
  endpoint,
  extraFields,
  accept,
  maxSize = 50 * 1024 * 1024,
  multiple = false,
  onUpload,
  onError,
  label = "Upload File",
  compact = false,
}: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [lastUploaded, setLastUploaded] = useState<UploadedFile | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploadFile = useCallback(
    async (file: File) => {
      if (file.size > maxSize) {
        onError?.(`File too large. Max size: ${formatSize(maxSize)}`);
        return;
      }

      setUploading(true);
      setProgress(0);

      const formData = new FormData();
      formData.append("file", file);
      if (extraFields) {
        Object.entries(extraFields).forEach(([k, v]) => formData.append(k, v));
      }

      try {
        const token =
          typeof window !== "undefined"
            ? localStorage.getItem("sentinel_token")
            : null;

        const xhr = new XMLHttpRequest();
        xhr.open("POST", endpoint.startsWith("http") ? endpoint : `${window.location.origin}${endpoint}`);
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setProgress(Math.round((e.loaded / e.total) * 100));
          }
        };

        const result = await new Promise<UploadedFile>((resolve, reject) => {
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const data = JSON.parse(xhr.responseText);
                resolve({
                  name: file.name,
                  size: file.size,
                  type: file.type,
                  url: data.url || data.file_url || data.path,
                  id: data.id || data.file_id || data.evidence_id,
                });
              } catch {
                resolve({ name: file.name, size: file.size, type: file.type });
              }
            } else {
              reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
            }
          };
          xhr.onerror = () => reject(new Error("Upload failed — network error"));
          xhr.send(formData);
        });

        setLastUploaded(result);
        onUpload?.(result);
        setTimeout(() => setLastUploaded(null), 3000);
      } catch (err) {
        onError?.(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
        setProgress(0);
      }
    },
    [endpoint, extraFields, maxSize, onUpload, onError]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        if (multiple) {
          files.forEach(uploadFile);
        } else {
          uploadFile(files[0]);
        }
      }
    },
    [uploadFile, multiple]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) {
        if (multiple) {
          files.forEach(uploadFile);
        } else {
          uploadFile(files[0]);
        }
      }
      if (inputRef.current) inputRef.current.value = "";
    },
    [uploadFile, multiple]
  );

  if (compact) {
    return (
      <div className="inline-flex items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={handleFileSelect}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 rounded-md border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700 hover:text-white disabled:opacity-50 transition-colors"
        >
          {uploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : lastUploaded ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          {uploading ? `${progress}%` : lastUploaded ? "Uploaded" : label}
        </button>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      className={`relative rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
        isDragging
          ? "border-cyan-500 bg-cyan-950/20"
          : "border-gray-700 bg-gray-900/40 hover:border-gray-600"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleFileSelect}
        className="hidden"
      />

      {uploading ? (
        <div className="space-y-3">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-cyan-400" />
          <div className="mx-auto w-48">
            <div className="h-1.5 rounded-full bg-gray-700">
              <div
                className="h-1.5 rounded-full bg-cyan-500 transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-gray-500">{progress}% uploaded</p>
          </div>
        </div>
      ) : lastUploaded ? (
        <div className="space-y-2">
          <CheckCircle2 className="mx-auto h-8 w-8 text-green-400" />
          <div className="flex items-center justify-center gap-2">
            {fileIcon(lastUploaded.type)}
            <span className="text-xs text-gray-300">{lastUploaded.name}</span>
            <span className="text-[10px] text-gray-600">
              ({formatSize(lastUploaded.size)})
            </span>
          </div>
        </div>
      ) : (
        <div
          className="cursor-pointer space-y-2"
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="mx-auto h-8 w-8 text-gray-600" />
          <p className="text-sm text-gray-400">{label}</p>
          <p className="text-[10px] text-gray-600">
            Drag & drop or click to browse. Max {formatSize(maxSize)}
          </p>
        </div>
      )}
    </div>
  );
}
