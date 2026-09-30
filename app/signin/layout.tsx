import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in — FPL Edge",
  description: "Sign in to your FPL Edge decision desk.",
  openGraph: { title: "Sign in — FPL Edge", description: "Sign in to your FPL Edge decision desk.", type: "website", images: ["/og.png"] },
  twitter: { card: "summary_large_image", title: "Sign in — FPL Edge", description: "Sign in to your FPL Edge decision desk.", images: ["/og.png"] },
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
