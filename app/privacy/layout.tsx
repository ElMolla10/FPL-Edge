import type { Metadata } from "next";
import { SITE_URL } from "../lib/site";

const title = "Privacy — FPL Edge";
const description = "What FPL Edge stores, why, and how to reach support.";
export const metadata: Metadata = {
  title, description,
  alternates: { canonical: `${SITE_URL}/privacy` },
  openGraph: { title, description, type: "website", url: `${SITE_URL}/privacy` },
  twitter: { card: "summary", title, description },
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
