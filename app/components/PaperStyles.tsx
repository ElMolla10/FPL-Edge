"use client";

// Server components (not-found.tsx, RouteLoading.tsx) cannot import the base + paper sheets directly: vinext links CSS
// imported by a *server* module as a separate "importer resource" file that duplicates the sheet the client pages already
// link (same bytes, two URLs, and wrong cascade position). Rendering this client component pulls in the very same
// chunk (base tokens/resets + paper.css) through the client-reference path instead. See docs/PERF-CSS.md.
import "../globals.css";
import "../styles/paper.css";

export function PaperStyles() {
  return null;
}
