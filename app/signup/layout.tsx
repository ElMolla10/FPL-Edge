import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create an account — FPL Edge",
  description: "Create a free FPL Edge account: lineup, captain and transfer call for this gameweek.",
  openGraph: { title: "Create an account — FPL Edge", description: "Create a free FPL Edge account: lineup, captain and transfer call for this gameweek.", type: "website", images: ["/og.png"] },
  twitter: { card: "summary_large_image", title: "Create an account — FPL Edge", description: "Create a free FPL Edge account: lineup, captain and transfer call for this gameweek.", images: ["/og.png"] },
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
