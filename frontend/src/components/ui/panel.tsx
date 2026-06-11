import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Panel — a titled section frame in the command-center language: a thin uppercase
 * label with a left accent tick + a hairline accent rule, optional right-aligned
 * status/actions, and a raised surface body. The workhorse container for the SOC
 * console (use instead of a bare Card for sectioned content).
 */
interface PanelProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title?: React.ReactNode;
  /** small muted text under / beside the title */
  hint?: React.ReactNode;
  /** right-aligned content in the header (status, filters, buttons) */
  actions?: React.ReactNode;
  /** accent the top edge (cyan hairline) — e.g. for the active/primary panel */
  accent?: boolean;
  /** remove body padding (for tables / full-bleed content) */
  flush?: boolean;
  bodyClassName?: string;
}

export function Panel({
  title, hint, actions, accent, flush, className, bodyClassName, children, ...props
}: PanelProps) {
  return (
    <div
      className={cn("panel overflow-hidden", accent && "panel-accent", className)}
      {...props}
    >
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="h-3 w-0.5 rounded-full bg-accent/70 shrink-0" />
            <h3 className="truncate text-[11px] font-bold uppercase tracking-widest text-foreground">
              {title}
            </h3>
            {hint && <span className="truncate text-[11px] text-muted-foreground">{hint}</span>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
      )}
      <div className={cn(!flush && "p-3", bodyClassName)}>{children}</div>
    </div>
  );
}
