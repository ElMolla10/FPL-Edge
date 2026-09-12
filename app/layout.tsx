import type { Metadata } from "next";
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
  description: "Stop guessing. Make the best possible FPL decision every gameweek.",
  openGraph: { title: "FPL Edge — Win the decision", description: "Draft, transfers, captaincy and team-news intelligence in one FPL decision desk.", type: "website", images: ["https://fpl-edge.moehab.chatgpt.site/og.png"] },
  twitter: { card: "summary_large_image", title: "FPL Edge — Win the decision", description: "Make the best possible FPL decision every gameweek.", images: ["https://fpl-edge.moehab.chatgpt.site/og.png"] },
};

// Inline, synchronous, and in <head> so it runs before first paint -- reading localStorage and
// setting data-theme here (rather than in a React effect) is what prevents a flash of the wrong
// theme on load. No override stored means "follow prefers-color-scheme", handled purely in CSS.
const themeInitScript = `try{var t=localStorage.getItem("fpl-edge-theme");if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${fraunces.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
