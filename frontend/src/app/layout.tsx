"use client";

import { useEffect, useState, useCallback } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Shield,
  LayoutDashboard,
  AlertTriangle,
  Search,
  Microscope,
  FolderOpen,
  BarChart3,
  MapPin,
  Settings,
  LogOut,
  Brain,
  Activity,
  Zap,
  Car,
  Volume2,
  MessageSquare,
  Flame,
  ScanSearch,
  HardHat,
  Globe,
  Map,
  FileCheck,
  ClipboardCheck,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ScanEye,
  Webhook,
  Film,
  Fingerprint,
  Radar,
  UserX,
  Crown,
  Truck,
  Network,
  Target,
  BookOpen,
  DoorOpen,
  Users,
  Route,
  Sparkles,
  Clapperboard,
  Siren,
  Monitor,
  Bell,
  UserCheck,
  BarChart,
  Lock,
  Columns,
  Building,
  Camera,
  Layers,
  Eye,
  BellRing,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import type { OperationModeStatus } from "@/lib/types";
import { ToastProvider } from "@/components/common/Toaster";
import { ConfirmProvider } from "@/components/common/useConfirm";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import CopilotWidget from "@/components/copilot/CopilotWidget";
import { NAV_GROUPS } from "@/lib/nav";
import { CommandPalette } from "@/components/common/CommandPalette";
import { NotificationCenter } from "@/components/common/NotificationCenter";
import { TopBar } from "@/components/layout/TopBar";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

/* ------------------------------------------------------------------ */
/*  Navigation structure — grouped with collapsible sections           */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/*  Sidebar component                                                  */
/* ------------------------------------------------------------------ */

function Sidebar() {
  const pathname = usePathname();
  const [modeStatus, setModeStatus] = useState<OperationModeStatus | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    NAV_GROUPS.forEach((g) => {
      if (g.defaultOpen) initial.add(g.label);
      // Auto-open group containing active page
      if (g.items.some((item) => item.href === "/" ? pathname === "/" : pathname.startsWith(item.href))) {
        initial.add(g.label);
      }
    });
    return initial;
  });

  useEffect(() => {
    const fetchMode = async () => {
      try {
        const data = await apiFetch<OperationModeStatus>("/api/operation-mode");
        setModeStatus(data);
      } catch {
        // optional
      }
    };
    fetchMode();
    const interval = setInterval(fetchMode, 10000);
    return () => clearInterval(interval);
  }, []);

  const toggleGroup = useCallback((label: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  const handleLogout = () => {
    localStorage.removeItem("sentinel_token");
    window.location.href = "/login";
  };

  return (
    <aside
      className={cn(
        "flex h-screen flex-col border-r border-border bg-surface-0 py-2 transition-all duration-200",
        collapsed ? "w-12" : "w-14 lg:w-52"
      )}
    >
      {/* Brand */}
      <Link href="/" className="mb-2 flex items-center gap-2 px-2.5 shrink-0">
        <span className="grid h-7 w-7 place-items-center rounded-md border border-accent/30 bg-accent/10 shrink-0">
          <Shield className="h-4 w-4 text-accent shrink-0" />
        </span>
        {!collapsed && (
          <span className="hidden text-[12px] font-bold tracking-[0.2em] text-foreground uppercase lg:block">
            Sentinel<span className="text-accent">AI</span>
          </span>
        )}
      </Link>

      {/* Mode Indicator */}
      {modeStatus && !collapsed && (
        <div className="mb-2 hidden lg:flex items-center justify-center w-full px-2">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[8px] font-bold uppercase tracking-wider",
              modeStatus.mode === "autonomous"
                ? "border-emerald-700/50 bg-emerald-900/20 text-emerald-400"
                : "border-amber-700/50 bg-amber-900/20 text-amber-400"
            )}
          >
            <span
              className={cn(
                "h-1 w-1 rounded-full",
                modeStatus.mode === "autonomous" ? "bg-emerald-400" : "bg-amber-400 animate-pulse"
              )}
            />
            {modeStatus.mode === "autonomous" ? "AUTO" : "HITL"}
            {modeStatus.mode === "hitl" && modeStatus.pending_count > 0 && (
              <span className="ml-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-red-600 px-0.5 text-[7px] font-bold text-white">
                {modeStatus.pending_count}
              </span>
            )}
          </span>
        </div>
      )}

      {/* Grouped Nav */}
      <nav className="flex flex-1 flex-col gap-0.5 w-full px-1.5 overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {NAV_GROUPS.map((group) => {
          const isOpen = openGroups.has(group.label);
          const hasActiveItem = group.items.some(
            (item) => item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
          );

          return (
            <div key={group.label} className="mb-0.5">
              {/* Group header */}
              {!collapsed && (
                <button
                  onClick={() => toggleGroup(group.label)}
                  className={cn(
                    "hidden lg:flex w-full items-center justify-between rounded-md px-2 py-1 text-[9px] font-bold uppercase tracking-widest transition-colors",
                    hasActiveItem
                      ? "text-accent"
                      : "text-muted-foreground/70 hover:text-muted-foreground"
                  )}
                >
                  <span>{group.label}</span>
                  <ChevronDown
                    className={cn(
                      "h-2.5 w-2.5 transition-transform duration-200",
                      isOpen ? "" : "-rotate-90"
                    )}
                  />
                </button>
              )}

              {/* Group items */}
              {(collapsed || isOpen) && (
                <div className={cn(!collapsed && "lg:ml-1")}>
                  {group.items.map(({ href, label, icon: Icon }) => {
                    const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
                    const isPendingActions = href === "/pending-actions";

                    return (
                      <Link
                        key={href}
                        href={href}
                        className={cn(
                          "relative flex items-center gap-2 rounded-md px-2 py-1 text-[11px] font-medium transition-colors group",
                          isActive
                            ? "bg-accent/10 text-accent before:absolute before:left-0 before:top-1/2 before:h-3.5 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-accent"
                            : "text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                        )}
                        title={collapsed ? label : undefined}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        {!collapsed && (
                          <span className="hidden lg:block truncate">{label}</span>
                        )}
                        {isPendingActions && modeStatus && modeStatus.pending_count > 0 && !collapsed && (
                          <span className="ml-auto hidden lg:flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-600 px-1 text-[8px] font-bold text-white">
                            {modeStatus.pending_count}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="hidden lg:flex items-center justify-center mx-1.5 mt-1 rounded-md py-1 text-muted-foreground/70 hover:bg-surface-2 hover:text-foreground transition-colors"
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5" />
        ) : (
          <ChevronLeft className="h-3.5 w-3.5" />
        )}
      </button>

      {/* Logout */}
      <button
        onClick={handleLogout}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive mx-1.5 mt-0.5"
        title={collapsed ? "Logout" : undefined}
      >
        <LogOut className="h-3.5 w-3.5 shrink-0" />
        {!collapsed && <span className="hidden lg:block">Logout</span>}
      </button>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/*  Root Layout                                                        */
/* ------------------------------------------------------------------ */

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";
  const isSetupPage = pathname === "/setup";
  const isMobilePage = pathname === "/mobile";
  const isFullPage = isLoginPage || isSetupPage || isMobilePage;
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    if (isFullPage) {
      setAuthed(true);
      return;
    }
    const token = localStorage.getItem("sentinel_token");
    if (!token) {
      window.location.href = "/login";
    } else {
      setAuthed(true);
    }
  }, [isFullPage, pathname]);

  // Cmd/Ctrl+K opens the command palette.
  const [cmdOpen, setCmdOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased bg-background text-foreground`}>
        <ToastProvider>
          <ConfirmProvider>
            {authed === null ? (
              <div className="flex h-screen items-center justify-center">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
              </div>
            ) : isFullPage ? (
              children
            ) : (
              <>
                <div className="flex h-screen overflow-hidden bg-vignette">
                  <Sidebar />
                  <main className="flex flex-1 flex-col overflow-hidden">
                    <TopBar onSearch={() => setCmdOpen(true)} />
                    <div className="flex-1 overflow-auto bg-grid">
                      {/* Keyed by route so a crashed page recovers on navigation,
                          and a thrown page can't white-screen the whole shell. */}
                      <ErrorBoundary name="page" key={pathname}>
                        {children}
                      </ErrorBoundary>
                    </div>
                  </main>
                  <ErrorBoundary name="copilot">
                    <CopilotWidget />
                  </ErrorBoundary>
                  <ErrorBoundary name="notifications">
                    <NotificationCenter />
                  </ErrorBoundary>
                </div>
                <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />
              </>
            )}
          </ConfirmProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
