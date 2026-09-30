import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Security response headers (CSP, HSTS, X-Frame-Options, ...) are NOT configured via headers() here:
  // vinext on Workers does not apply them to every response (verified: "/" is served without them).
  // They are applied in worker/index.ts via app/lib/security-headers.ts. See docs/SECURITY.md.
};

export default nextConfig;
