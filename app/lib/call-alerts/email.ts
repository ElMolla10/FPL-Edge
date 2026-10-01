/**
 * Email copy for call alerts: plain text + simple HTML. The body carries ONLY: the call (HOLD or OUT → IN),
 * the captain, a one-line why, a link to the app shell, and the "turn this off" sentence. No marketing,
 * no season-pass pitch, no tracking pixels, no per-user tokens in the link.
 */
import type { CallDetail, CanonicalCall, PreviousCall } from "./call";
import { normalizeSiteUrl } from "../site";

export const OFF_SENTENCE = "You can turn this off in account settings.";

export type ComposeInput = {
  call: CanonicalCall;
  detail: CallDetail;
  previous: PreviousCall | null;
  /** A NEW official flag appeared since the last emailed fingerprint. */
  newFlag: boolean;
  siteUrl: string;
};

export type ComposedEmail = { subject: string; text: string; html: string; link: string };

const clean = (value: string, max = 200) => value.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function appShellLink(siteUrl: string): string {
  return `${normalizeSiteUrl(siteUrl)}/?app=1`;
}

export function callLine(call: CanonicalCall, detail: CallDetail): string {
  return call.decision === "MAKE" && detail.outName && detail.inName ? `${detail.outName} → ${detail.inName}` : "HOLD";
}

export function composeSubject(input: ComposeInput): string {
  const { call, detail, previous, newFlag } = input;
  const gw = `GW${call.gw}`;
  const captainName = detail.captainName ? clean(detail.captainName, 40) : null;
  if (newFlag && detail.flagged.length) {
    // The flag subject names the (first) flagged player, then the captain in force.
    const flagged = detail.flagged[0];
    const captainChanged = previous && previous.captainId !== call.captainId;
    const tail = captainName ? ` — captain ${captainChanged ? "is now" : "stays"} ${captainName}` : "";
    return `FPL Edge · ${gw} flag: ${clean(flagged.name, 40)} ${flagged.label}${tail}`;
  }
  const line = callLine(call, detail);
  const sameGwChange = previous && previous.gw === call.gw;
  return sameGwChange ? `FPL Edge · ${gw} call changed: ${line}` : `FPL Edge · ${gw} call: ${line}`;
}

export function composeWhy(input: ComposeInput): string {
  const { detail, newFlag } = input;
  const base = clean(detail.reason, 200);
  if (newFlag && detail.flagged.length) {
    const flagged = detail.flagged[0];
    return clean(`${flagged.name} is ${flagged.label} (official FPL flag). ${base}`, 240);
  }
  return base;
}

export function composeEmail(input: ComposeInput): ComposedEmail {
  const link = appShellLink(input.siteUrl);
  const call = callLine(input.call, input.detail);
  const captain = input.detail.captainName ? clean(input.detail.captainName, 60) : "—";
  const why = composeWhy(input);
  const gw = input.call.gw;
  const text = [`GW${gw} call: ${call}`, `Captain: ${captain}`, `Why: ${why}`, "", `Open FPL Edge: ${link}`, "", OFF_SENTENCE, ""].join("\n");
  const html = [
    "<!doctype html><html><body style=\"font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;line-height:1.5;max-width:520px\">",
    `<p><strong>GW${gw} call:</strong> ${escapeHtml(call)}</p>`,
    `<p><strong>Captain:</strong> ${escapeHtml(captain)}</p>`,
    `<p><strong>Why:</strong> ${escapeHtml(why)}</p>`,
    `<p><a href="${escapeHtml(link)}">Open FPL Edge</a></p>`,
    `<p style="color:#555;font-size:13px">${escapeHtml(OFF_SENTENCE)}</p>`,
    "</body></html>",
  ].join("");
  return { subject: composeSubject(input), text, html, link };
}
