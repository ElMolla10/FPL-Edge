"use client";

import { useEffect, useState } from "react";
import type { PopulationPercentileResult } from "../lib/population-percentile-core";

// Route already carries a 5-minute edge cache (Cache-Control: public, max-age=300 -- see
// app/api/fpl/population-percentiles/route.ts). Matching the client refetch interval to that window
// means a periodic in-tab refetch is absorbed by the edge cache rather than adding new load, while
// keeping a long-lived tab from permanently freezing on whatever value it first loaded -- otherwise
// Phase 1's own two-tier server TTL (2h live / 12h finished) would be pointless for any tab that
// never asks again.
const REFETCH_INTERVAL_MS = 5 * 60 * 1000;

// Module-level singleton state, not per-hook-instance: both the Transfers page and the Draft Lab
// sandbox call this hook independently, but the underlying data is population-wide and identical for
// every caller. `current` is the last value any fetch resolved to; `subscribers` is every currently-
// mounted hook instance's setState, so a single background refetch (whichever consumer's mount
// started the shared interval) updates every mounted consumer, not just the one that triggered it.
let current: PopulationPercentileResult | null = null;
let inFlight: Promise<void> | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<(result: PopulationPercentileResult) => void>();

function fetchAndBroadcast(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = fetch("/api/fpl/population-percentiles", { cache: "no-store" })
    .then(async response => {
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const reason = body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
          ? (body as { error: string }).error
          : "Population percentile data is unavailable.";
        return { status: "unavailable" as const, reason };
      }
      return body as PopulationPercentileResult;
    })
    .catch(error => ({
      status: "unavailable" as const,
      reason: error instanceof Error ? error.message : "Population percentile data is unavailable.",
    }))
    .then(result => {
      current = result;
      subscribers.forEach(notify => notify(result));
    })
    // Cleared on success AND failure alike: a stuck inFlight would block both the next interval tick
    // and any newly-mounted consumer's own retry from ever firing a real request again.
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** null means no value has loaded yet; a real result (available or unavailable) once at least one fetch has settled. */
export function usePopulationPercentiles(): PopulationPercentileResult | null {
  const [result, setResult] = useState<PopulationPercentileResult | null>(current);
  useEffect(() => {
    subscribers.add(setResult);
    if (current === null) fetchAndBroadcast();
    if (intervalId === null) intervalId = setInterval(fetchAndBroadcast, REFETCH_INTERVAL_MS);
    return () => {
      subscribers.delete(setResult);
      // Stop polling once nobody is listening; a later mount restarts it.
      if (subscribers.size === 0 && intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
  }, []);
  return result;
}
