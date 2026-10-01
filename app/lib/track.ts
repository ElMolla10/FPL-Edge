/** Client beacon for first-party telemetry. No SDK, no third party — one fetch to our own Worker. */
import type { TelemetryEvent, TelemetryMetaValue } from "./telemetry";

const sentOnce = new Set<string>();

export function track(event: TelemetryEvent, meta: Record<string, TelemetryMetaValue> = {}, opts: { onceKey?: string } = {}): void {
  if (typeof window === "undefined") return;
  if (opts.onceKey) {
    const k = `${event}:${opts.onceKey}`;
    if (sentOnce.has(k)) return;
    try { if (sessionStorage.getItem(`fpl-edge-t:${k}`)) return; sessionStorage.setItem(`fpl-edge-t:${k}`, "1"); } catch { /* storage blocked */ }
    sentOnce.add(k);
  }
  try {
    void fetch("/api/telemetry", {
      method: "POST", keepalive: true, credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, meta, path: window.location.pathname }),
    }).catch(() => undefined);
  } catch { /* never throw from analytics */ }
}
