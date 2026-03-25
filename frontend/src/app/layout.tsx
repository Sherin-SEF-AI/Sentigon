"use client";

import { useEffect, useState, useCallback } from "react";
import { Inter } from "next/font/google";
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
import CopilotWidget from "@/components/copilot/CopilotWidget";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

/* ------------------------------------------------------------------ */
/*  Navigation structure — grouped with collapsible sections           */
/* ------------------------------------------------------------------ */

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

interface NavGroup {
  label: string;
  items: NavItem[];
  defaultOpen?: boolean;
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Operations",
    defaultOpen: true,
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/command-center", label: "Command Center", icon: Building },
      { href: "/video-wall", label: "Video Wall", icon: Monitor },
      { href: "/cameras", label: "Cameras & ONVIF", icon: Camera },
      { href: "/status", label: "System Status", icon: Activity },
      { href: "/workspace", label: "SOC Workspace", icon: Columns },
      { href: "/copilot", label: "SOC Copilot", icon: MessageSquare },
    ],
  },
  {
    label: "Alerts & Response",
    defaultOpen: true,
    items: [
      { href: "/emergency", label: "Emergency", icon: Siren },
      { href: "/alerts", label: "Alerts", icon: AlertTriangle },
      { href: "/incidents", label: "Incidents", icon: AlertTriangle },
      { href: "/threat-response", label: "Threat Response", icon: Siren },
      { href: "/alarm-management", label: "Alarm Analysis", icon: BellRing },
      { href: "/pending-actions", label: "Pending Actions", icon: ClipboardCheck },
      { href: "/notifications", label: "Mass Notify", icon: Bell },
      { href: "/evacuation", label: "Evacuation", icon: Route },
    ],
  },
  {
    label: "Investigation",
    items: [
      { href: "/search", label: "Search", icon: Search },
      { href: "/forensics", label: "Forensics", icon: Microscope },
      { href: "/cases", label: "Cases", icon: FolderOpen },
      { href: "/evidence", label: "Evidence", icon: FileCheck },
      { href: "/link-analysis", label: "Link Analysis", icon: Network },
      { href: "/video-summary", label: "Video Summary", icon: Film },
      { href: "/video-archive", label: "Video Archive", icon: Clapperboard },
    ],
  },
  {
    label: "Detection & AI",
    items: [
      { href: "/agents", label: "AI Agents", icon: Brain },
      { href: "/agentic-ops", label: "Auto Investigations", icon: Sparkles },
      { href: "/behavioral", label: "Behavioral AI", icon: BarChart },
      { href: "/context-intelligence", label: "Context AI", icon: Brain },
      { href: "/entity-tracking", label: "Entity Tracking", icon: Eye },
      { href: "/reid", label: "Re-Identification", icon: ScanSearch },
      { href: "/lpr", label: "Plate Reader", icon: Car },
      { href: "/audio", label: "Audio Intel", icon: Volume2 },
    ],
  },
  {
    label: "Threat Management",
    items: [
      { href: "/threat-config", label: "Threat Config", icon: Zap },
      { href: "/threat-signatures", label: "Signatures", icon: Fingerprint },
      { href: "/threat-intel", label: "Threat Intel", icon: Globe },
      { href: "/insider-threat", label: "Insider Threat", icon: UserX },
      { href: "/tamper-detection", label: "Tamper Detect", icon: ScanEye },
      { href: "/bolo", label: "BOLO & Logbook", icon: Target },
    ],
  },
  {
    label: "Access & Patrol",
    items: [
      { href: "/pacs", label: "Access Control", icon: DoorOpen },
      { href: "/visitors", label: "Visitors", icon: UserCheck },
      { href: "/vip", label: "VIP Protection", icon: Crown },
      { href: "/patrol", label: "Patrol Command", icon: Route },
      { href: "/dispatch", label: "Dispatch", icon: Truck },
      { href: "/crowd-protocols", label: "Crowd Protocols", icon: Users },
      { href: "/sop", label: "SOP Manager", icon: BookOpen },
    ],
  },
  {
    label: "Analytics & Maps",
    items: [
      { href: "/analytics", label: "Analytics", icon: BarChart3 },
      { href: "/zones", label: "Zones", icon: MapPin },
      { href: "/site-map", label: "Site Map", icon: Map },
      { href: "/floor-plans", label: "Floor Plans", icon: Map },
      { href: "/overwatch", label: "Global Overwatch", icon: Radar },
      { href: "/environmental", label: "Env Safety", icon: Flame },
      { href: "/sla", label: "SLA Dashboard", icon: BarChart3 },
    ],
  },
  {
    label: "Compliance & Privacy",
    items: [
      { href: "/compliance", label: "Compliance", icon: HardHat },
      { href: "/privacy", label: "Privacy & GDPR", icon: Lock },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/integrations", label: "Integrations", icon: Layers },
      { href: "/webhooks", label: "Webhooks", icon: Webhook },
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/customer-portal", label: "Customer Portal", icon: Building },
      { href: "/admin", label: "Administration", icon: Settings },
    ],
  },
];

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
        "flex h-screen flex-col border-r border-gray-800/60 bg-gray-950 py-2 transition-all duration-200",
        collapsed ? "w-12" : "w-14 lg:w-52"
      )}
    >
      {/* Brand */}
      <Link href="/" className="mb-1 flex items-center gap-2 px-2.5 shrink-0">
        <Shield className="h-5 w-5 text-cyan-400 shrink-0" />
        {!collapsed && (
          <span className="hidden text-[11px] font-bold tracking-widest text-gray-100 uppercase lg:block">
            Sentinel AI
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
                    "hidden lg:flex w-full items-center justify-between rounded-md px-2 py-1 text-[9px] font-bold uppercase tracking-wider transition-colors",
                    hasActiveItem
                      ? "text-cyan-500"
                      : "text-gray-600 hover:text-gray-400"
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
                          "flex items-center gap-2 rounded-md px-2 py-1 text-[11px] font-medium transition-colors group",
                          isActive
                            ? "bg-cyan-900/30 text-cyan-400 border border-cyan-800/40"
                            : "text-gray-500 hover:bg-gray-800/50 hover:text-gray-300 border border-transparent"
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
        className="hidden lg:flex items-center justify-center mx-1.5 mt-1 rounded-md py-1 text-gray-600 hover:bg-gray-800/50 hover:text-gray-400 transition-colors"
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
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] font-medium text-gray-600 transition-colors hover:bg-red-900/20 hover:text-red-400 mx-1.5 mt-0.5"
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

  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} font-sans antialiased bg-[#030712] text-gray-100`}>
        <ToastProvider>
          {authed === null ? (
            <div className="flex h-screen items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
            </div>
          ) : isFullPage ? (
            children
          ) : (
            <div className="flex h-screen overflow-hidden">
              <Sidebar />
              <main className="flex-1 overflow-auto">{children}</main>
              <CopilotWidget />
            </div>
          )}
        </ToastProvider>
      </body>
    </html>
  );
}
