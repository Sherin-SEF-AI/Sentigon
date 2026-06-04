"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, Search } from "lucide-react";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { NAV_LINKS } from "@/lib/nav";
import { cn } from "@/lib/utils";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Cmd/Ctrl+K command palette: fuzzy-jump to any page. A static, fully
 * client-side index built from NAV_LINKS (shared with the sidebar).
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return NAV_LINKS;
    return NAV_LINKS.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.group.toLowerCase().includes(q) ||
        c.href.includes(q)
    );
  }, [query]);

  React.useEffect(() => {
    setActive(0);
  }, [query, open]);

  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = filtered[active];
      if (c) go(c.href);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showClose={false} className="max-w-xl overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a page…  (type a name)"
            className="h-11 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
            esc
          </kbd>
        </div>
        <ul className="max-h-80 overflow-auto p-1">
          {filtered.map((c, i) => {
            const Icon = c.icon;
            return (
              <li key={c.href}>
                <button
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(c.href)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
                    i === active
                      ? "bg-secondary/70 text-foreground"
                      : "text-muted-foreground hover:bg-secondary/40"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1 truncate">{c.label}</span>
                  <span className="text-[10px] text-muted-foreground/60">{c.group}</span>
                  {i === active && (
                    <CornerDownLeft className="h-3.5 w-3.5 text-muted-foreground/70" />
                  )}
                </button>
              </li>
            );
          })}
          {filtered.length === 0 && (
            <li className="px-3 py-8 text-center text-sm text-muted-foreground">
              No matching pages
            </li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
