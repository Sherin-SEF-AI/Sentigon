"use client";

import { useEffect } from "react";

interface ShortcutMap {
  [key: string]: () => void;
}

export function useKeyboardShortcuts(shortcuts: ShortcutMap) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't trigger when typing in inputs
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        if (e.key === "Escape") {
          // Escape always works
        } else {
          return;
        }
      }

      let key = "";
      if (e.ctrlKey || e.metaKey) key += "ctrl+";
      if (e.shiftKey) key += "shift+";
      key += e.key.toLowerCase();

      const action = shortcuts[key];
      if (action) {
        e.preventDefault();
        action();
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [shortcuts]);
}
