"use client";

import { useSyncExternalStore } from "react";
import { THEME_COLOR, THEME_KEY, resolveTheme, type Theme } from "../lib/theme";

const listeners = new Set<() => void>();
function apply(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
  listeners.forEach(l => l());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab changed the stored choice: follow it (storage events never fire in the tab that wrote).
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_KEY) apply(resolveTheme(event.newValue));
  };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}
const current = (): Theme => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
const server = (): Theme => "dark";

/** Accessible light-theme switch used on the public pages and in the app. Pressed = light theme on. Click is the only writer of the stored choice. */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const theme = useSyncExternalStore(subscribe, current, server);
  const toggle = () => {
    const next: Theme = theme === "light" ? "dark" : "light";
    apply(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode: the choice just lasts for this page */ }
  };
  return (
    <button type="button" className={compact ? "theme-toggle theme-toggle-compact" : "theme-toggle"} aria-pressed={theme === "light"} aria-label="Light theme" onClick={toggle}>
      <svg className="theme-toggle-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {theme === "light" ? <><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></> : <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />}
      </svg>
      {compact ? null : <span className="theme-toggle-label">Light theme</span>}
      <span className="theme-toggle-state" aria-hidden="true">{theme === "light" ? "On" : "Off"}</span>
    </button>
  );
}
