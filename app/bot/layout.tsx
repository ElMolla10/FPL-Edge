import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Bot control — FPL Edge",
  description: "Owner-only control room for the FPL Edge autonomous bot team.",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
