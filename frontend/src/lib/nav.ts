import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard, Building, Monitor, Camera, Activity, Columns, MessageSquare,
  Siren, AlertTriangle, BellRing, ClipboardCheck, Bell, Route, Search, Microscope,
  FolderOpen, FileCheck, Network, Film, Clapperboard, Brain, Sparkles, BarChart,
  Eye, ScanSearch, Target, Car, Volume2, Zap, Fingerprint, Globe, UserX, ScanEye,
  DoorOpen, UserCheck, Crown, Truck, Users, BookOpen, BarChart3, MapPin, Map,
  Radar, Flame, HardHat, Lock, Layers, Webhook, Settings,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
  defaultOpen?: boolean;
}

/**
 * Single source of truth for primary navigation. Consumed by the sidebar
 * (layout.tsx) and the command palette so they never drift.
 */
export const NAV_GROUPS: NavGroup[] = [
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
      { href: "/entity-journey", label: "Entity Journey", icon: Route },
      { href: "/reid", label: "Re-Identification", icon: ScanSearch },
      { href: "/tripwires", label: "Tripwires", icon: Target },
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

/** Flat list of all navigable destinations (for the command palette). */
export const NAV_LINKS = NAV_GROUPS.flatMap((g) =>
  g.items.map((i) => ({ ...i, group: g.label }))
);
