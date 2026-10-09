import { readdirSync, readFileSync } from "node:fs";

/**
 * CoachApp.tsx was split by feature (app/components/coach/*.tsx, audit B item 9). Several
 * source-scanning regression tests assert that a piece of behaviour still exists in "the coach
 * app source"; this returns the shell (CoachApp.tsx) followed by every split module, so those scans
 * keep guarding the same code wherever it now lives.
 */
export function readCoachSource(): string {
  const components = new URL("../../app/components/", import.meta.url);
  const parts = [readFileSync(new URL("CoachApp.tsx", components), "utf8")];
  const dir = new URL("coach/", components);
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".tsx")).sort()) {
    parts.push(readFileSync(new URL(name, dir), "utf8"));
  }
  // The shared BEST DECISION pipeline (analysis, withModelUtilityChange, rankTransfersForBestDecision) moved to a pure
  // lib module so the email-alert cron runs identical code; scans for it must still see it.
  parts.push(readFileSync(new URL("../../app/lib/best-decision.ts", import.meta.url), "utf8"));
  return parts.join("\n");
}
