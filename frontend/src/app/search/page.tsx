"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Search, Sparkles, ScanSearch, Eye, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const SemanticSearch = dynamic(() => import("./SemanticSearchTab"), {
  ssr: false,
  loading: () => <TabLoadingSpinner label="Semantic Search" />,
});
const ForensicSearch = dynamic(() => import("./ForensicSearchTab"), {
  ssr: false,
  loading: () => <TabLoadingSpinner label="Forensic Search" />,
});
const VisualSearch = dynamic(() => import("./VisualSearchTab"), {
  ssr: false,
  loading: () => <TabLoadingSpinner label="Visual Search" />,
});

type Tab = "semantic" | "forensic" | "visual";

const TABS: {
  key: Tab;
  label: string;
  shortLabel: string;
  icon: typeof Search;
  accent: string;
  activeClasses: string;
}[] = [
  {
    key: "semantic",
    label: "Semantic Search",
    shortLabel: "Semantic",
    icon: Sparkles,
    accent: "cyan",
    activeClasses:
      "bg-cyan-900/40 text-cyan-400 border-cyan-800/60",
  },
  {
    key: "forensic",
    label: "Forensic Search",
    shortLabel: "Forensic",
    icon: ScanSearch,
    accent: "cyan",
    activeClasses:
      "bg-cyan-900/40 text-cyan-400 border-cyan-800/60",
  },
  {
    key: "visual",
    label: "Visual Search",
    shortLabel: "Visual",
    icon: Eye,
    accent: "violet",
    activeClasses:
      "bg-violet-900/40 text-violet-400 border-violet-800/60",
  },
];

function TabLoadingSpinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24">
      <div className="relative h-10 w-10">
        <div className="absolute inset-0 rounded-full border-2 border-gray-800" />
        <div className="absolute inset-0 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
      </div>
      <p className="mt-4 text-sm text-gray-500">Loading {label}…</p>
    </div>
  );
}

function UnifiedSearchInner() {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab") as Tab | null;

  const [activeTab, setActiveTab] = useState<Tab>(() => {
    if (tabParam && ["semantic", "forensic", "visual"].includes(tabParam)) {
      return tabParam;
    }
    return "semantic";
  });

  // Sync tab when URL param changes (e.g. redirect from old pages)
  useEffect(() => {
    if (tabParam && ["semantic", "forensic", "visual"].includes(tabParam)) {
      setActiveTab(tabParam as Tab);
    }
  }, [tabParam]);

  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ── Top header ─────────────────────────────────── */}
      <div className="border-b border-gray-800 bg-gray-950 px-6 py-3">
        <div className="flex items-center gap-3 mb-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
            <Search className="h-5 w-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Unified Search
            </h1>
            <p className="text-xs text-gray-500">
              Semantic, forensic, and visual search across all security events
            </p>
          </div>
        </div>

        {/* ── Tab bar ─────────────────────────────────── */}
        <div className="flex gap-1 rounded-xl border border-gray-800 bg-gray-900/60 p-1">
          {TABS.map(({ key, label, shortLabel, icon: Icon, activeClasses }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-all duration-150",
                activeTab === key
                  ? activeClasses
                  : "border-transparent text-gray-500 hover:text-gray-200 hover:bg-gray-800/50"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline">{label}</span>
              <span className="sm:hidden">{shortLabel}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Tab content ─────────────────────────────────── */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "semantic" && <SemanticSearch />}
        {activeTab === "forensic" && <ForensicSearch />}
        {activeTab === "visual" && <VisualSearch />}
      </div>
    </div>
  );
}

export default function UnifiedSearchPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full flex-col items-center justify-center bg-gray-950">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
        </div>
      }
    >
      <UnifiedSearchInner />
    </Suspense>
  );
}
