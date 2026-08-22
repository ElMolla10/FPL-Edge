import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FPL Edge",
  description: "Stop guessing. Make the best possible FPL decision every gameweek.",
  openGraph: { title: "FPL Edge — Win the decision", description: "Draft, transfers, captaincy and team-news intelligence in one FPL decision desk.", type: "website", images: ["https://fpl-edge.moehab.chatgpt.site/og.png"] },
  twitter: { card: "summary_large_image", title: "FPL Edge — Win the decision", description: "Make the best possible FPL decision every gameweek.", images: ["https://fpl-edge.moehab.chatgpt.site/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
