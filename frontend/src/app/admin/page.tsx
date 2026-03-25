"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Settings,
  Building2,
  Users,
  Camera,
  MapPin,
  Plus,
  Edit2,
  Ban,
  CheckCircle2,
  Shield,
  ChevronDown,
  X,
  Palette,
  BarChart3,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Eye,
  Globe,
  Cpu,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface TenantBranding {
  primary_color: string;
  accent_color: string;
  logo_url: string | null;
  login_background_url: string | null;
  footer_text: string | null;
}

interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: "basic" | "professional" | "enterprise";
  max_sites: number;
  max_users: number;
  user_count: number;
  site_count: number;
  camera_count: number;
  created_at: string;
  disabled: boolean;
  branding?: TenantBranding;
}

interface PlatformStats {
  total_orgs: number;
  total_users: number;
  total_cameras: number;
  total_sites: number;
}

type Tab = "organizations" | "usage" | "branding";

const PLAN_LABELS: Record<string, string> = {
  basic: "Basic",
  professional: "Professional",
  enterprise: "Enterprise",
};

const PLAN_COLORS: Record<string, string> = {
  basic: "border-gray-700 text-gray-400 bg-gray-800/40",
  professional: "border-blue-700/60 text-blue-400 bg-blue-900/20",
  enterprise: "border-cyan-700/60 text-cyan-400 bg-cyan-900/20",
};

/* ------------------------------------------------------------------ */
/*  Utilities                                                           */
/* ------------------------------------------------------------------ */

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function usageColor(used: number, max: number): string {
  if (max <= 0) return "bg-emerald-500"; // unlimited
  const pct = used / max;
  if (pct >= 0.9) return "bg-red-500";
  if (pct >= 0.7) return "bg-amber-500";
  return "bg-emerald-500";
}

function usagePercent(used: number, max: number): number {
  if (max <= 0) return 0; // unlimited → show 0%
  return Math.min(100, Math.round((used / max) * 100));
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                      */
/* ------------------------------------------------------------------ */

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof Building2;
  label: string;
  value: number | string;
  accent: string;
}) {
  return (
    <div className="rounded-xl border border-gray-800/60 bg-gray-900/60 p-4 flex items-center gap-4">
      <div className={cn("rounded-lg p-2.5", accent)}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-xs text-gray-500 uppercase tracking-wider">{label}</p>
        <p className="text-2xl font-bold text-gray-100 mt-0.5">{value}</p>
      </div>
    </div>
  );
}

function UsageBar({
  label,
  used,
  max,
}: {
  label: string;
  used: number;
  max: number;
}) {
  const unlimited = max <= 0;
  const pct = usagePercent(used, max);
  const color = usageColor(used, max);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-400">{label}</span>
        <span className="text-gray-500">
          {used} / {unlimited ? "∞" : max}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-gray-800">
        {!unlimited && (
          <div
            className={cn("h-1.5 rounded-full transition-all", color)}
            style={{ width: `${pct}%` }}
          />
        )}
        {unlimited && (
          <div className="h-1.5 rounded-full bg-emerald-500/30" style={{ width: "100%" }} />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Create Org Modal                                                    */
/* ------------------------------------------------------------------ */

interface CreateOrgModalProps {
  onClose: () => void;
  onCreated: (tenant: Tenant) => void;
}

function CreateOrgModal({ onClose, onCreated }: CreateOrgModalProps) {
  const { addToast } = useToast();
  const [form, setForm] = useState({
    name: "",
    slug: "",
    plan: "basic" as "basic" | "professional" | "enterprise",
    max_sites: 1,
    max_users: 3,
  });
  const [saving, setSaving] = useState(false);

  const handleNameChange = (v: string) => {
    setForm((f) => ({ ...f, name: v, slug: slugify(v) }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.slug.trim()) {
      addToast("error", "Name and slug are required.");
      return;
    }
    setSaving(true);
    try {
      const data = await apiFetch<Tenant>("/api/admin/tenants", {
        method: "POST",
        body: JSON.stringify(form),
      });
      onCreated(data);
      addToast("success", `Organisation "${data.name}" created.`);
      onClose();
    } catch {
      // Backend may not exist yet — store in localStorage as demo
      const demoTenant: Tenant = {
        id: `tenant-local-${Date.now()}`,
        ...form,
        user_count: 0,
        site_count: 0,
        camera_count: 0,
        created_at: new Date().toISOString(),
        disabled: false,
        branding: {
          primary_color: "#06b6d4",
          accent_color: "#8b5cf6",
          logo_url: null,
          login_background_url: null,
          footer_text: `${form.name} © 2026`,
        },
      };
      const stored = JSON.parse(localStorage.getItem("sentinel_tenants") || "[]");
      stored.push(demoTenant);
      localStorage.setItem("sentinel_tenants", JSON.stringify(stored));
      onCreated(demoTenant);
      addToast("info", "Saved locally (backend unavailable).");
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-700/60 bg-gray-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-100">
            <Building2 className="h-4 w-4 text-cyan-400" />
            Create Organisation
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-gray-500 hover:text-gray-300 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {/* Name */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider">
              Organisation Name
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="Acme Security Corp"
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600/50"
              required
            />
          </div>

          {/* Slug */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider">
              Slug (URL identifier)
            </label>
            <input
              type="text"
              value={form.slug}
              onChange={(e) => setForm((f) => ({ ...f, slug: slugify(e.target.value) }))}
              placeholder="acme-security"
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm font-mono text-cyan-400 placeholder-gray-600 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600/50"
              required
            />
          </div>

          {/* Plan */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider">
              Plan Tier
            </label>
            <div className="relative">
              <select
                value={form.plan}
                onChange={(e) => {
                  const plan = e.target.value as "basic" | "professional" | "enterprise";
                  const defaults = {
                    basic: { max_sites: 1, max_users: 3 },
                    professional: { max_sites: 5, max_users: 20 },
                    enterprise: { max_sites: -1, max_users: -1 },
                  }[plan];
                  setForm((f) => ({ ...f, plan, ...defaults }));
                }}
                className="w-full appearance-none rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600/50 pr-8"
              >
                <option value="basic">Basic</option>
                <option value="professional">Professional</option>
                <option value="enterprise">Enterprise</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
            </div>
          </div>

          {/* Limits row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider">
                Max Sites
              </label>
              <input
                type="number"
                value={form.max_sites === -1 ? "" : form.max_sites}
                onChange={(e) =>
                  setForm((f) => ({ ...f, max_sites: e.target.value === "" ? -1 : Number(e.target.value) }))
                }
                placeholder="-1 = unlimited"
                min={-1}
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600/50"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider">
                Max Users
              </label>
              <input
                type="number"
                value={form.max_users === -1 ? "" : form.max_users}
                onChange={(e) =>
                  setForm((f) => ({ ...f, max_users: e.target.value === "" ? -1 : Number(e.target.value) }))
                }
                placeholder="-1 = unlimited"
                min={-1}
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600/50"
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-50 transition-colors"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Organisations Tab                                                   */
/* ------------------------------------------------------------------ */

function OrganisationsTab({
  tenants,
  onToggleDisabled,
}: {
  tenants: Tenant[];
  onToggleDisabled: (id: string) => void;
}) {
  if (tenants.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Building2 className="mb-3 h-10 w-10 text-gray-700" />
        <p className="text-sm font-medium text-gray-400">No tenants configured</p>
        <p className="mt-1 text-xs text-gray-600">
          Create an organisation above to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {tenants.map((tenant) => (
        <div
          key={tenant.id}
          className={cn(
            "rounded-xl border bg-gray-900/60 p-5 flex flex-col gap-3 transition-opacity",
            tenant.disabled ? "border-gray-800 opacity-60" : "border-gray-700/60"
          )}
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold text-gray-100 truncate">{tenant.name}</p>
              <p className="text-xs font-mono text-gray-500 mt-0.5">{tenant.slug}</p>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                PLAN_COLORS[tenant.plan]
              )}
            >
              {PLAN_LABELS[tenant.plan]}
            </span>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-2 rounded-lg bg-gray-800/40 p-3">
            <div className="text-center">
              <p className="text-xs text-gray-500">Users</p>
              <p className="text-sm font-bold text-gray-200 mt-0.5">
                {tenant.user_count}
                <span className="text-gray-600 font-normal">
                  /{tenant.max_users === -1 ? "∞" : tenant.max_users}
                </span>
              </p>
            </div>
            <div className="text-center border-x border-gray-700/50">
              <p className="text-xs text-gray-500">Sites</p>
              <p className="text-sm font-bold text-gray-200 mt-0.5">
                {tenant.site_count}
                <span className="text-gray-600 font-normal">
                  /{tenant.max_sites === -1 ? "∞" : tenant.max_sites}
                </span>
              </p>
            </div>
            <div className="text-center">
              <p className="text-xs text-gray-500">Cameras</p>
              <p className="text-sm font-bold text-gray-200 mt-0.5">{tenant.camera_count}</p>
            </div>
          </div>

          {/* Created */}
          <p className="text-[11px] text-gray-600">
            Created {formatDate(tenant.created_at)}
          </p>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            <button className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:border-cyan-700/60 hover:text-cyan-400 transition-colors">
              <Edit2 className="h-3 w-3" />
              Edit
            </button>
            <button
              onClick={() => onToggleDisabled(tenant.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors",
                tenant.disabled
                  ? "border-emerald-700/60 text-emerald-400 hover:bg-emerald-900/20"
                  : "border-red-800/60 text-red-400 hover:bg-red-900/20"
              )}
            >
              {tenant.disabled ? (
                <>
                  <CheckCircle2 className="h-3 w-3" /> Enable
                </>
              ) : (
                <>
                  <Ban className="h-3 w-3" /> Disable
                </>
              )}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Usage Tab                                                           */
/* ------------------------------------------------------------------ */

function UsageTab({ tenants }: { tenants: Tenant[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-800/60">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800 bg-gray-900/80">
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
              Organisation
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
              Users
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
              Sites
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
              Cameras
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
              API Calls (24h)
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
              Storage
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/60">
          {tenants.map((tenant) => (
            <tr key={tenant.id} className="bg-gray-900/40 hover:bg-gray-800/40 transition-colors">
              <td className="px-4 py-3">
                <p className="font-medium text-gray-200">{tenant.name}</p>
                <p className="text-xs text-gray-500 font-mono">{tenant.slug}</p>
              </td>
              <td className="px-4 py-3 min-w-[140px]">
                <UsageBar
                  label={`${tenant.user_count} / ${tenant.max_users === -1 ? "∞" : tenant.max_users}`}
                  used={tenant.user_count}
                  max={tenant.max_users}
                />
              </td>
              <td className="px-4 py-3 min-w-[120px]">
                <UsageBar
                  label={`${tenant.site_count} / ${tenant.max_sites === -1 ? "∞" : tenant.max_sites}`}
                  used={tenant.site_count}
                  max={tenant.max_sites}
                />
              </td>
              <td className="px-4 py-3">
                <span className="text-gray-200 font-medium">{tenant.camera_count}</span>
              </td>
              <td className="px-4 py-3">
                <span className="text-gray-200 font-medium tabular-nums">0</span>
              </td>
              <td className="px-4 py-3">
                <span className="text-gray-200 font-medium">—</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tenants.length === 0 && (
        <div className="py-12 text-center text-gray-500 text-sm">No organisations found.</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Branding Tab                                                        */
/* ------------------------------------------------------------------ */

function BrandingTab({ tenants }: { tenants: Tenant[] }) {
  const { addToast } = useToast();
  const [selectedId, setSelectedId] = useState<string>(tenants[0]?.id ?? "");
  const [saving, setSaving] = useState(false);

  const selectedTenant = tenants.find((t) => t.id === selectedId);

  const [branding, setBranding] = useState<TenantBranding>({
    primary_color: "#06b6d4",
    accent_color: "#8b5cf6",
    logo_url: null,
    login_background_url: null,
    footer_text: null,
  });

  // Sync branding when tenant selection changes
  useEffect(() => {
    if (selectedTenant?.branding) {
      setBranding({ ...selectedTenant.branding });
    } else {
      setBranding({
        primary_color: "#06b6d4",
        accent_color: "#8b5cf6",
        logo_url: null,
        login_background_url: null,
        footer_text: selectedTenant?.name ? `${selectedTenant.name} © 2026` : null,
      });
    }
  }, [selectedId, selectedTenant]);

  const handleSave = async () => {
    if (!selectedId) return;
    setSaving(true);
    try {
      await apiFetch(`/api/admin/tenants/${selectedId}/branding`, {
        method: "POST",
        body: JSON.stringify(branding),
      });
      addToast("success", "Branding saved successfully.");
    } catch {
      // Store locally as demo fallback
      const stored = JSON.parse(localStorage.getItem("sentinel_tenants") || "[]");
      const idx = stored.findIndex((t: Tenant) => t.id === selectedId);
      if (idx >= 0) {
        stored[idx].branding = branding;
        localStorage.setItem("sentinel_tenants", JSON.stringify(stored));
      }
      // Also persist in a dedicated branding key
      const brandingMap = JSON.parse(localStorage.getItem("sentinel_branding") || "{}");
      brandingMap[selectedId] = branding;
      localStorage.setItem("sentinel_branding", JSON.stringify(brandingMap));
      addToast("info", "Branding saved locally (backend unavailable).");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Left: Controls */}
      <div className="space-y-5">
        {/* Org selector */}
        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400">
            Select Organisation
          </label>
          <div className="relative">
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="w-full appearance-none rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600/50 pr-8"
            >
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
          </div>
        </div>

        {/* Logo URL */}
        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400">
            Logo URL
          </label>
          <input
            type="url"
            value={branding.logo_url ?? ""}
            onChange={(e) => setBranding((b) => ({ ...b, logo_url: e.target.value || null }))}
            placeholder="https://example.com/logo.svg"
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600/50"
          />
          {branding.logo_url && (
            <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-3 flex items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={branding.logo_url}
                alt="Logo preview"
                className="max-h-12 object-contain"
                onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
              />
            </div>
          )}
        </div>

        {/* Primary color */}
        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400">
            Primary Color
          </label>
          <div className="flex items-center gap-3">
            <div
              className="h-9 w-9 rounded-lg border border-gray-600 shrink-0 cursor-pointer shadow-inner"
              style={{ backgroundColor: branding.primary_color }}
            />
            <input
              type="text"
              value={branding.primary_color}
              onChange={(e) => setBranding((b) => ({ ...b, primary_color: e.target.value }))}
              placeholder="#06b6d4"
              maxLength={7}
              className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm font-mono text-gray-100 placeholder-gray-600 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600/50"
            />
            <input
              type="color"
              value={branding.primary_color}
              onChange={(e) => setBranding((b) => ({ ...b, primary_color: e.target.value }))}
              className="h-9 w-12 cursor-pointer rounded-lg border border-gray-700 bg-gray-800 p-0.5"
              title="Pick primary color"
            />
          </div>
        </div>

        {/* Accent color */}
        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400">
            Accent Color
          </label>
          <div className="flex items-center gap-3">
            <div
              className="h-9 w-9 rounded-lg border border-gray-600 shrink-0 cursor-pointer shadow-inner"
              style={{ backgroundColor: branding.accent_color }}
            />
            <input
              type="text"
              value={branding.accent_color}
              onChange={(e) => setBranding((b) => ({ ...b, accent_color: e.target.value }))}
              placeholder="#8b5cf6"
              maxLength={7}
              className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm font-mono text-gray-100 placeholder-gray-600 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600/50"
            />
            <input
              type="color"
              value={branding.accent_color}
              onChange={(e) => setBranding((b) => ({ ...b, accent_color: e.target.value }))}
              className="h-9 w-12 cursor-pointer rounded-lg border border-gray-700 bg-gray-800 p-0.5"
              title="Pick accent color"
            />
          </div>
        </div>

        {/* Login background */}
        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400">
            Custom Login Background URL
          </label>
          <input
            type="url"
            value={branding.login_background_url ?? ""}
            onChange={(e) =>
              setBranding((b) => ({ ...b, login_background_url: e.target.value || null }))
            }
            placeholder="https://example.com/bg.jpg"
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600/50"
          />
        </div>

        {/* Footer text */}
        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400">
            Custom Footer Text
          </label>
          <input
            type="text"
            value={branding.footer_text ?? ""}
            onChange={(e) => setBranding((b) => ({ ...b, footer_text: e.target.value || null }))}
            placeholder="Acme Security Corp © 2026"
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600/50"
          />
        </div>

        {/* Save button */}
        <button
          onClick={handleSave}
          disabled={saving || !selectedId}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-50 transition-colors"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Palette className="h-4 w-4" />
          )}
          Save Branding
        </button>
      </div>

      {/* Right: Live Preview */}
      <div className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          Login Page Preview
        </p>
        <div
          className="relative overflow-hidden rounded-2xl border border-gray-700/60 shadow-xl"
          style={{ minHeight: 420 }}
        >
          {/* Background */}
          <div
            className="absolute inset-0"
            style={
              branding.login_background_url
                ? {
                    backgroundImage: `url(${branding.login_background_url})`,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                  }
                : { background: "linear-gradient(135deg, #0a0f1e 0%, #0d1b2a 60%, #111827 100%)" }
            }
          />
          {/* Overlay */}
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

          {/* Card */}
          <div className="relative z-10 flex items-center justify-center h-full p-8" style={{ minHeight: 420 }}>
            <div className="w-72 rounded-2xl border bg-gray-900/90 shadow-2xl backdrop-blur-md p-6 space-y-5"
              style={{ borderColor: branding.primary_color + "33" }}>
              {/* Logo / Brand */}
              <div className="flex flex-col items-center gap-2">
                {branding.logo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={branding.logo_url}
                    alt="Brand logo"
                    className="h-10 object-contain"
                    onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                  />
                ) : (
                  <div
                    className="flex h-10 w-10 items-center justify-center rounded-xl"
                    style={{ backgroundColor: branding.primary_color + "22", border: `1px solid ${branding.primary_color}44` }}
                  >
                    <Shield className="h-5 w-5" style={{ color: branding.primary_color }} />
                  </div>
                )}
                <p className="text-sm font-bold text-gray-100">
                  {selectedTenant?.name ?? "Platform Name"}
                </p>
                <p className="text-[10px] text-gray-500">Security Operations Platform</p>
              </div>

              {/* Fake inputs */}
              <div className="space-y-2">
                <div className="h-8 rounded-lg bg-gray-800 border border-gray-700 flex items-center px-3">
                  <span className="text-xs text-gray-500">Email address</span>
                </div>
                <div className="h-8 rounded-lg bg-gray-800 border border-gray-700 flex items-center px-3">
                  <span className="text-xs text-gray-500">Password</span>
                </div>
              </div>

              {/* Fake button */}
              <div
                className="h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white cursor-default"
                style={{ backgroundColor: branding.primary_color }}
              >
                Sign In
              </div>

              {/* Accent strip */}
              <div className="flex items-center gap-1.5 justify-center">
                <div className="h-1 w-8 rounded-full" style={{ backgroundColor: branding.primary_color }} />
                <div className="h-1 w-4 rounded-full" style={{ backgroundColor: branding.accent_color }} />
                <div className="h-1 w-2 rounded-full" style={{ backgroundColor: branding.accent_color + "66" }} />
              </div>
            </div>
          </div>

          {/* Footer preview */}
          {branding.footer_text && (
            <div
              className="absolute bottom-0 inset-x-0 py-2 px-4 text-center text-[10px] text-gray-500 border-t"
              style={{ borderColor: branding.primary_color + "22", backgroundColor: "rgba(0,0,0,0.6)" }}
            >
              {branding.footer_text}
            </div>
          )}
        </div>

        {/* Color swatches summary */}
        <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900/60 px-4 py-3">
          <div className="flex items-center gap-2">
            <div
              className="h-5 w-5 rounded-md border border-gray-700"
              style={{ backgroundColor: branding.primary_color }}
            />
            <span className="text-xs font-mono text-gray-400">{branding.primary_color}</span>
          </div>
          <div className="h-4 w-px bg-gray-700" />
          <div className="flex items-center gap-2">
            <div
              className="h-5 w-5 rounded-md border border-gray-700"
              style={{ backgroundColor: branding.accent_color }}
            />
            <span className="text-xs font-mono text-gray-400">{branding.accent_color}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                           */
/* ------------------------------------------------------------------ */

export default function AdminPage() {
  const { addToast } = useToast();
  const [activeTab, setActiveTab] = useState<Tab>("organizations");
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [stats, setStats] = useState<PlatformStats>({
    total_orgs: 0,
    total_users: 0,
    total_cameras: 0,
    total_sites: 0,
  });
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);

  /* ── Fetch tenants ── */
  const fetchTenants = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{
        tenants: Tenant[];
        total: number;
        total_users: number;
        total_cameras: number;
        total_sites: number;
      }>("/api/admin/tenants");

      // Merge with any localStorage demo tenants
      const localRaw = localStorage.getItem("sentinel_tenants");
      const localTenants: Tenant[] = localRaw ? JSON.parse(localRaw) : [];

      // Merge branding from localStorage branding store
      const brandingMap = JSON.parse(localStorage.getItem("sentinel_branding") || "{}");
      const merged = [...data.tenants, ...localTenants].map((t) => ({
        ...t,
        branding: brandingMap[t.id] ?? t.branding,
      }));

      setTenants(merged);
      setStats({
        total_orgs: merged.length,
        total_users: data.total_users + localTenants.reduce((s, t) => s + t.user_count, 0),
        total_cameras: data.total_cameras + localTenants.reduce((s, t) => s + t.camera_count, 0),
        total_sites: data.total_sites + localTenants.reduce((s, t) => s + t.site_count, 0),
      });
    } catch {
      // Fallback: backend unavailable — show empty state
      setTenants([]);
      setStats({
        total_orgs: 0,
        total_users: 0,
        total_cameras: 0,
        total_sites: 0,
      });
      addToast("info", "No tenants configured — backend unavailable.");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    fetchTenants();
  }, [fetchTenants]);

  /* ── Toggle tenant disabled state ── */
  const handleToggleDisabled = useCallback(
    async (tenantId: string) => {
      try {
        await apiFetch(`/api/admin/tenants/${tenantId}/disable`, { method: "PATCH" });
        setTenants((prev) =>
          prev.map((t) => (t.id === tenantId ? { ...t, disabled: !t.disabled } : t))
        );
        const t = tenants.find((x) => x.id === tenantId);
        addToast("success", `${t?.name ?? "Organisation"} ${t?.disabled ? "enabled" : "disabled"}.`);
      } catch {
        // Toggle locally
        setTenants((prev) =>
          prev.map((t) => (t.id === tenantId ? { ...t, disabled: !t.disabled } : t))
        );
        addToast("info", "Toggled locally (backend unavailable).");
      }
    },
    [tenants, addToast]
  );

  /* ── Handle org created ── */
  const handleOrgCreated = useCallback((newTenant: Tenant) => {
    setTenants((prev) => [newTenant, ...prev]);
    setStats((s) => ({ ...s, total_orgs: s.total_orgs + 1 }));
  }, []);

  /* ── Tabs config ── */
  const TABS: { id: Tab; label: string; icon: typeof BarChart3 }[] = [
    { id: "organizations", label: "Organisations", icon: Building2 },
    { id: "usage", label: "Usage", icon: BarChart3 },
    { id: "branding", label: "Branding", icon: Palette },
  ];

  return (
    <div className="min-h-screen bg-[#030712] p-6 space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-cyan-900/30 border border-cyan-700/40 p-2.5">
            <Settings className="h-5 w-5 text-cyan-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-gray-100">Platform Administration</h1>
              <span className="rounded-full border border-amber-700/60 bg-amber-900/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-amber-400">
                Admin Only
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              Manage organisations, usage quotas, and white-label branding
            </p>
          </div>
        </div>

        <button
          onClick={fetchTenants}
          disabled={loading}
          className="flex items-center gap-2 rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      {/* ── Stats Row ── */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          icon={Building2}
          label="Total Organisations"
          value={loading ? "—" : stats.total_orgs}
          accent="bg-cyan-900/40 text-cyan-400"
        />
        <StatCard
          icon={Users}
          label="Total Users"
          value={loading ? "—" : stats.total_users}
          accent="bg-blue-900/40 text-blue-400"
        />
        <StatCard
          icon={Camera}
          label="Total Cameras"
          value={loading ? "—" : stats.total_cameras}
          accent="bg-purple-900/40 text-purple-400"
        />
        <StatCard
          icon={MapPin}
          label="Total Sites"
          value={loading ? "—" : stats.total_sites}
          accent="bg-emerald-900/40 text-emerald-400"
        />
      </div>

      {/* ── Tabs ── */}
      <div className="flex items-center gap-1 border-b border-gray-800">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px",
              activeTab === id
                ? "border-cyan-500 text-cyan-400"
                : "border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-700"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}

        {/* Create org button — only on organisations tab */}
        {activeTab === "organizations" && (
          <div className="ml-auto pb-1">
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              Create Organisation
            </button>
          </div>
        )}
      </div>

      {/* ── Tab Content ── */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
          <span className="ml-3 text-sm text-gray-500">Loading platform data...</span>
        </div>
      ) : (
        <div>
          {activeTab === "organizations" && (
            <OrganisationsTab tenants={tenants} onToggleDisabled={handleToggleDisabled} />
          )}
          {activeTab === "usage" && <UsageTab tenants={tenants} />}
          {activeTab === "branding" && <BrandingTab tenants={tenants} />}
        </div>
      )}

      {/* ── Create Modal ── */}
      {showCreateModal && (
        <CreateOrgModal
          onClose={() => setShowCreateModal(false)}
          onCreated={handleOrgCreated}
        />
      )}
    </div>
  );
}
