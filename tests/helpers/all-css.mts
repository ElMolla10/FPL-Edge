import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const appDir = new URL("../../app/", import.meta.url).pathname;
/** app/globals.css (base sheet) + every app/styles/*.css (per-route / per-panel sheets), concatenated. */
export function readAllCss(): string {
  const parts = [readFileSync(join(appDir, "globals.css"), "utf8")];
  for (const f of readdirSync(join(appDir, "styles")).sort()) if (f.endsWith(".css")) parts.push(readFileSync(join(appDir, "styles", f), "utf8"));
  return parts.join("\n");
}
export const readStyle = (name: string): string => readFileSync(join(appDir, "styles", name), "utf8");
