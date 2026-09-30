import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Season pass — FPL Edge",
  description: "Get the FPL Edge season pass: every gameweek's decision desk through the end of the season.",
  openGraph: { title: "Season pass — FPL Edge", description: "Get the FPL Edge season pass: every gameweek's decision desk through the end of the season.", type: "website", images: ["/og.png"] },
  twitter: { card: "summary_large_image", title: "Season pass — FPL Edge", description: "Get the FPL Edge season pass: every gameweek's decision desk through the end of the season.", images: ["/og.png"] },
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
