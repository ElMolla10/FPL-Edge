import type { Metadata } from "next";
import { SITE_URL } from "../lib/site";

const title = "Terms — FPL Edge";
const description = "The FPL Edge season pass terms: what you get, how payment works, and how long it lasts.";
export const metadata: Metadata = {
  title, description,
  alternates: { canonical: `${SITE_URL}/terms` },
  openGraph: { title, description, type: "website", url: `${SITE_URL}/terms` },
  twitter: { card: "summary", title, description },
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
