// Theme preference (FPL Edge identity v1.0). Dark is the DEFAULT for every first visit, regardless of the OS colour scheme.
// Light is an explicit opt-in: the ONLY thing that ever writes THEME_KEY is the theme toggle's click handler.
// The key is versioned (-v2): the pre-identity `fpl-edge-theme` key was written by the old sidebar switch and is
// intentionally NOT read, so nobody keeps a theme chosen by an earlier UI; everyone starts dark.
export const THEME_KEY = "fpl-edge-theme-v2";
export type Theme = "dark" | "light";
export const THEME_COLOR: Record<Theme, string> = { dark: "#121614", light: "#F7F7F5" };

/** Pure decision: only a literally stored "light" yields light; null / garbage / legacy values yield dark. */
export function resolveTheme(stored: string | null | undefined): Theme {
  return stored === "light" ? "light" : "dark";
}

/**
 * Inline <head> script (served with the per-request CSP nonce by app/layout.tsx). It runs synchronously before first paint, so the
 * stored explicit choice is applied with no flash. Keep it dependency-free: tests execute this exact string.
 */
export const themeInitScript =
  `try{var t=localStorage.getItem("${THEME_KEY}")==="light"?"light":"dark";var d=document.documentElement;d.setAttribute("data-theme",t);` +
  `if(t==="light"){var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content","${THEME_COLOR.light}")}}catch(e){}`;
