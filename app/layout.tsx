import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { nonceFromCsp } from "./lib/security-headers";
import { THEME_COLOR, themeInitScript } from "./lib/theme";


const HOME_TITLE = "FPL Edge — weekly FPL lineup, captain and transfer call";
const HOME_DESCRIPTION = "A lineup, a captain, and whether to transfer. Free this gameweek.";

// The homepage is a client component (it cannot export its own metadata), so the root metadata IS the
// homepage's. /signin, /signup and /pay (audit C) and the 404 set their own full titles, so the template
// is a pass-through: it only exists so a child's title is used verbatim.
export const metadata: Metadata = {
  title: { default: HOME_TITLE, template: "%s" },
  description: HOME_DESCRIPTION,
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: { title: HOME_TITLE, description: HOME_DESCRIPTION, type: "website", images: [{ url: "/og.png", width: 1200, height: 630, alt: "FPL Edge. Your next move. Clear." }] },
  twitter: { card: "summary_large_image", title: HOME_TITLE, description: HOME_DESCRIPTION, images: ["/og.png"] },
};

// viewport-fit=cover so env(safe-area-inset-*) is non-zero on notched iPhones
// (Capacitor WKWebView and mobile Safari). Pair with padding in globals.css.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Match the dark canvas (#121614) so iOS chrome / overscroll isn't pure black; the theme script flips it for light.
  themeColor: THEME_COLOR.dark,
};


export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Per-request CSP nonce, minted in worker/index.ts and passed down as a request header (never trusted from the client:
  // the worker overwrites it). Undefined outside the worker (tests, dev) -> no nonce attribute, script still renders.
  const nonce = nonceFromCsp((await headers()).get("content-security-policy"));
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        {/* vinext ViewportHead omits viewport-fit; keep export above and pin the meta here. */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content={THEME_COLOR.dark} />
        {/* Only the two weights/subsets the first paint needs; the latin-ext faces load on demand via unicode-range. */}
        <link rel="preload" href="/fonts/inter-latin-var.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/space-grotesk-latin-var.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
