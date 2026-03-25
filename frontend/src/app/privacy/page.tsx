"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Lock, Shield, Camera, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const GDPRTab = dynamic(() => import("./GDPRTab"), { ssr: false });
const CameraPrivacyTab = dynamic(() => import("./CameraPrivacyTab"), { ssr: false });

type Tab = "gdpr" | "camera";

const TABS: { id: Tab; label: string; icon: typeof Lock }[] = [
  { id: "gdpr", label: "GDPR & Compliance", icon: Lock },
  { id: "camera", label: "Camera Privacy", icon: Camera },
];

function TabFallback() {
  return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="w-8 h-8 animate-spin text-cyan-400" />
    </div>
  );
}

function PrivacyPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const initialTab = (searchParams.get("tab") as Tab) ?? "gdpr";
  const [activeTab, setActiveTab] = useState<Tab>(
    initialTab === "camera" ? "camera" : "gdpr"
  );

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="min-h-screen bg-gray-950 text-zinc-100">
      {/* Top-level page header */}
      <header className="sticky top-0 z-40 border-b border-gray-800 bg-gray-950/90 backdrop-blur-md px-6 py-3">
        <div className="flex items-center gap-3 mb-3">
          <Shield className="w-5 h-5 text-cyan-400" />
          <h1 className="text-lg font-semibold text-zinc-100">Privacy Center</h1>
        </div>

        {/* Tab bar */}
        <nav className="flex gap-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => handleTabChange(t.id)}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors",
                  activeTab === t.id
                    ? "border-cyan-400 text-cyan-400 bg-gray-900/50"
                    : "border-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-900/30"
                )}
              >
                <Icon className="w-4 h-4" />
                {t.label}
              </button>
            );
          })}
        </nav>
      </header>

      {/* Tab content */}
      <div className="flex-1">
        {activeTab === "gdpr" && (
          <Suspense fallback={<TabFallback />}>
            <GDPRTab />
          </Suspense>
        )}
        {activeTab === "camera" && (
          <Suspense fallback={<TabFallback />}>
            <CameraPrivacyTab />
          </Suspense>
        )}
      </div>
    </div>
  );
}

export default function PrivacyPage() {
  return (
    <Suspense fallback={<TabFallback />}>
      <PrivacyPageInner />
    </Suspense>
  );
}
