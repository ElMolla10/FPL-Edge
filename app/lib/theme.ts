// Theme preference (FPL Edge identity v1.0). Dark is the DEFAULT for every visit with no explicit choice, regardless of the OS colour scheme.
// Light is an explicit opt-in: the ONLY thing that ever writes THEME_KEY is the theme toggle's click handler (and the one-time
// migration below, which only re-saves a choice the user already made).
// Legacy: origin/main stored the choice under `fpl-edge-theme` ("light" | "dark"). That key was written solely by the old sidebar
// switch's click handler (verified in the old source, and in every earlier revision that contained the key), never automatically
// and never from prefers-color-scheme. So a legacy "light" can only have come from a user action: it is honoured and copied into the
// v2 key. A legacy "dark", garbage or an absent value starts dark. The legacy key is left in place (not deleted) so a rollback keeps working.
export const THEME_KEY = "fpl-edge-theme-v2";
export const LEGACY_THEME_KEY = "fpl-edge-theme";
export type Theme = "dark" | "light";
export const THEME_COLOR: Record<Theme, string> = { dark: "#121614", light: "#F7F7F5" };

/** Pure decision: only a literally stored "light" yields light; null / garbage yields dark. */
export function resolveTheme(stored: string | null | undefined): Theme {
  return stored === "light" ? "light" : "dark";
}

/**
 * Inline <head> script (served with the per-request CSP nonce by app/layout.tsx). It runs synchronously before first paint, so the
 * stored explicit choice is applied with no flash. Keep it dependency-free: tests execute this exact string.
 */
export const themeInitScript =
  `try{var s=localStorage,t=s.getItem("${THEME_KEY}");if(t===null){var o=s.getItem("${LEGACY_THEME_KEY}");if(o==="light"){t="light";try{s.setItem("${THEME_KEY}","light")}catch(e){}}}` +
  `t=t==="light"?"light":"dark";var d=document.documentElement;d.setAttribute("data-theme",t);` +
  `if(t==="light"){var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content","${THEME_COLOR.light}")}}catch(e){}`;
