import type { Metadata, Viewport } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";

// Feed the --font-ui/--font-display tokens in globals.css (fpl.page redesign, step 1). vinext's
// next/font/google support is CDN-runtime-loading, not build-time self-hosted/subsetted the way
// real Next.js does (confirmed via node_modules/vinext/README.md's support matrix) -- so this is
// not actually self-hosted here despite Inter/Fraunces both being self-hostable fonts, and it
// doesn't get real Next.js's fallback-metrics FOUC protection. Kept as the two font-loading calls
// only, no manual <link>/@font-face alongside them.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const fraunces = Fraunces({ subsets: ["latin"], weight: ["300"], variable: "--font-fraunces", display: "swap" });

export const metadata: Metadata = {
  title: "FPL Edge",
  description: "A lineup, a captain, and whether to transfer. Free this gameweek.",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: { title: "FPL Edge", description: "A lineup, a captain, and whether to transfer. Free this gameweek.", type: "website", images: ["/og.png"] },
  twitter: { card: "summary_large_image", title: "FPL Edge", description: "A lineup, a captain, and whether to transfer. Free this gameweek.", images: ["/og.png"] },
};

// viewport-fit=cover so env(safe-area-inset-*) is non-zero on notched iPhones
// (Capacitor WKWebView and mobile Safari). Pair with padding in globals.css.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Inline, synchronous, and in <head> so it runs before first paint -- reading localStorage and
// setting data-theme here (rather than in a React effect) is what prevents a flash of the wrong
// theme on load. Step 3 (shell/nav) flips the app's default from OS-driven to dark-by-default:
// no stored override, or a stored value that isn't literally "light", now resolves to dark.
// ThemeToggle's own initial read mirrors this same "light" isn't dark logic.
const themeInitScript = `try{var t=localStorage.getItem("fpl-edge-theme");document.documentElement.setAttribute("data-theme",t==="light"?"light":"dark")}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${fraunces.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
