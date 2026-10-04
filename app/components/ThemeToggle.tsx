"use client";

import { useEffect, useState } from "react";
import { THEME_COLOR, THEME_KEY, resolveTheme, type Theme } from "../lib/theme";

function apply(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

/** Accessible light-theme switch used on the public pages and in the app. Pressed = light theme on. Click is the only writer of the stored choice. */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    setTheme(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_KEY) return;
      const next = resolveTheme(event.newValue);
      apply(next);
      setTheme(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const toggle = () => {
    const next: Theme = theme === "light" ? "dark" : "light";
    apply(next);
    setTheme(next);
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
