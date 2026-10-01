// Single source of truth for the public origin, used by robots.ts and sitemap.ts (and any future
// canonical/OG URL). Defaults to the live Workers host; override at BUILD time with
// NEXT_PUBLIC_SITE_URL (e.g. once a custom domain is attached). No trailing slash.
const DEFAULT_SITE_URL = "https://fpl-edge.elmolla10.workers.dev";

export function normalizeSiteUrl(raw: string | undefined | null): string {
  const value = (raw ?? "").trim();
  if (!/^https?:\/\/[^/\s]+/i.test(value)) return DEFAULT_SITE_URL;
  return value.replace(/\/+$/, "");
}

export const SITE_URL = normalizeSiteUrl(process.env.NEXT_PUBLIC_SITE_URL);

// Public, indexable pages. Everything else (the signed-in app shell at /?app=1, /api/*) is excluded.
export const PUBLIC_PATHS = ["/", "/signin", "/signup", "/pay", "/privacy", "/terms"] as const;

// Support contact. Set SUPPORT_EMAIL (or NEXT_PUBLIC_SUPPORT_EMAIL) at build time to override.
// PLACEHOLDER: replace with the real support inbox before launch.
export const SUPPORT_EMAIL_PLACEHOLDER = "support@fpl-edge.example";
export const SUPPORT_EMAIL = (process.env.NEXT_PUBLIC_SUPPORT_EMAIL || process.env.SUPPORT_EMAIL || SUPPORT_EMAIL_PLACEHOLDER).trim();
export const PASS_END_DATE_LABEL = "31 May 2027";
