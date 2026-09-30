import type { MetadataRoute } from "next";
import { PUBLIC_PATHS, SITE_URL } from "./lib/site";

const PRIORITY: Record<string, number> = { "/": 1, "/pay": 0.8, "/signup": 0.6, "/signin": 0.4 };

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_PATHS.map((path) => ({
    url: path === "/" ? `${SITE_URL}/` : `${SITE_URL}${path}`,
    changeFrequency: path === "/" ? "daily" : "monthly",
    priority: PRIORITY[path] ?? 0.5,
  }));
}
