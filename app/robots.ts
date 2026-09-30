import type { MetadataRoute } from "next";
import { SITE_URL } from "./lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // /api/* is JSON/auth/checkout endpoints. The signed-in app shell and demo mode are the
        // homepage with a query flag; checkout-return is /pay with a query flag. None are pages.
        disallow: ["/api/", "/*?app=", "/*?demo=", "/pay?checkout="],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
