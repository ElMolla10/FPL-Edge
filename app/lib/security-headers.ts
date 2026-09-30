/**
 * Security response headers, applied in worker/index.ts (see docs/SECURITY.md for why not next.config.ts).
 * Pure (Request/Response/crypto only) so it unit-tests in plain Node.
 *
 * CSP uses a per-request NONCE, not hashes: vinext emits several inline <script>s per page whose
 * content changes per request/route (RSC flight chunks, __VINEXT_RSC_NAV__ pathname, bootstrap
 * import()). vinext natively reads a nonce from the request's content-security-policy header and stamps
 * it on all of its inline scripts/styles; app/layout.tsx stamps it on the theme-init script.
 */

export type CspMode = "enforce" | "report-only";

/** Origins the app really uses from the BROWSER (verified by grep + Playwright, see docs/SECURITY.md):
 *  everything is same-origin. FPL API, PingOne and Paymob's API are called server-side from the Worker; Paymob
 *  checkout is a top-level navigation (window.location.assign), which CSP does not restrict. */
export function buildCsp(nonce: string, options: { secure: boolean } = { secure: true }): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    // React renders style="" attributes everywhere; nonces cannot cover attributes, so style-src keeps 'unsafe-inline'.
    // Style injection is far lower impact than script injection; scripts stay strict.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
  ];
  if (options.secure) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function createCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Extracts the script nonce from a CSP header value (used by app/layout.tsx). */
export function nonceFromCsp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(value)?.[1];
}

const STATIC_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
};

export function prepareSecurity(request: Request, options: { cspMode?: string } = {}) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const mode: CspMode = options.cspMode?.trim().toLowerCase() === "report-only" ? "report-only" : "enforce";
  const nonce = createCspNonce();
  const csp = buildCsp(nonce, { secure });
  return {
    nonce,
    csp,
    mode,
    /** vinext (and app/layout.tsx) discover the nonce from this REQUEST header. Always overwritten. */
    applyToRequestHeaders(headers: Headers) {
      headers.delete("content-security-policy-report-only");
      headers.set("content-security-policy", csp);
    },
    finalize(response: Response): Response {
      // Response.redirect()/fetch() responses have immutable headers: rebuild instead of mutating.
      const out = new Response(response.body, response);
      for (const [name, value] of Object.entries(STATIC_HEADERS)) if (!out.headers.has(name)) out.headers.set(name, value);
      if (secure && !out.headers.has("Strict-Transport-Security")) {
        // No includeSubDomains/preload: this is a deliberate, reversible first step.
        out.headers.set("Strict-Transport-Security", "max-age=31536000");
      }
      const contentType = out.headers.get("content-type") ?? "";
      if (/^text\/html\b/i.test(contentType)) {
        out.headers.delete("content-security-policy");
        out.headers.delete("content-security-policy-report-only");
        out.headers.set(mode === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only", csp);
      }
      return out;
    },
  };
}
