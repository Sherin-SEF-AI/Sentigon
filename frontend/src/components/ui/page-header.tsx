import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * PageHeader — the consistent header every route uses: an optional icon, the
 * page title, a muted subtitle, an optional right-aligned status / action area,
 * and a hairline accent rule underneath. Gives the whole app a single, distinct
 * command-center rhythm instead of ad-hoc per-page headings.
 */
export function PageHeader({
  title, subtitle, icon, actions, className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-4", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2.5 min-w-0">
          {icon && (
            <span className="grid h-8 w-8 place-items-center rounded-md border border-border bg-surface-1 text-accent shrink-0">
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold uppercase tracking-wide text-foreground">
              {title}
            </h1>
            {subtitle && (
              <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
      <div className="rule-accent mt-2.5" />
    </div>
  );
}
