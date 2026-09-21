/**
 * Horizon-aware availability / injury / suspension model.
 *
 * Critical fix (audit H1): FPL's chance_of_playing_next_round must NOT be copied
 * flat across every future GW. Yellow-flag injury (e.g. João Pedro 75%) applies
 * to the next round only and recovers toward a healthy baseline — never a 5-GW ban.
 *
 * Suspensions use exact multi-GW duration parsed from news when possible.
 * Role security / confidence influence uncertainty only (see projectionMetrics).
 */
import type { FplPlayer } from "./fpl";

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export type AvailabilityState =
  | "AVAILABLE"
  | "DOUBTFUL"
  | "INJURED"
  | "SUSPENDED"
  | "RETURNING"
  | "ROTATION_RISK"
  | "UNKNOWN";

export type AvailabilitySchedule = {
  state: AvailabilityState;
  /** P(available to be selected / play) for this horizon offset — feeds start blend. */
  availability: number;
  chanceOfStart: number;
  chanceOfAppearance: number;
  /** Expected minutes contribution factor from availability alone (0–1). */
  expectedMinutesFactor: number;
  availabilityConfidence: number;
  /** Official next-round chance (0–1) before horizon recovery. */
  nextRoundChance: number;
  horizonOffset: number;
  /** Parsed suspension ban length in GWs; null when not suspended. */
  suspensionRemaining: number | null;
  notes: string[];
};

/** Next-round chance from FPL fields (legacy flat helper). */
export function nextRoundAvailability(player: Pick<FplPlayer, "chance" | "status" | "chanceThisRound">): number {
  if (player.chance !== null && player.chance !== undefined) return clamp(player.chance / 100, 0, 1);
  if (player.status === "a") return 1;
  if (player.status === "d") return 0.72;
  if (player.status === "s") return 0;
  if (player.status === "i") return 0.15;
  return 0.2;
}

/**
 * Parse suspension length from FPL news strings.
 * Examples: "Suspended until 21 Sep", "3 match ban", "One-match ban".
 * Falls back to 1 GW when status is suspended but news is opaque.
 */
export function parseSuspensionDurationGws(news: string, status: string): number | null {
  if (status !== "s" && !/suspend/i.test(news)) return null;
  const lower = news.toLowerCase();
  const matchBan = lower.match(/(\d+)\s*[- ]?match/);
  if (matchBan) return clamp(Number(matchBan[1]), 1, 8);
  if (/\bone[-\s]?match\b/.test(lower) || /\b1\s*match\b/.test(lower)) return 1;
  if (/\btwo[-\s]?match\b/.test(lower) || /\b2\s*match\b/.test(lower)) return 2;
  if (/\bthree[-\s]?match\b/.test(lower) || /\b3\s*match\b/.test(lower)) return 3;
  if (status === "s") return 1;
  return null;
}

function newsAgeDays(newsAdded: string | null | undefined, nowMs: number): number | null {
  if (!newsAdded) return null;
  const t = Date.parse(newsAdded);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (nowMs - t) / 86_400_000);
}

function classifyState(
  status: string,
  nextRound: number,
  suspensionRemaining: number | null,
  horizonOffset: number,
  scoutRisks: number,
): AvailabilityState {
  if (suspensionRemaining !== null && horizonOffset < suspensionRemaining) return "SUSPENDED";
  if (status === "i" || nextRound < 0.35) {
    if (horizonOffset >= 2 && nextRound >= 0.2) return "RETURNING";
    return "INJURED";
  }
  if (status === "d" || (nextRound >= 0.35 && nextRound < 0.9)) {
    if (horizonOffset >= 1 && nextRound >= 0.6) return "RETURNING";
    return "DOUBTFUL";
  }
  if (scoutRisks > 0 && nextRound >= 0.9) return "ROTATION_RISK";
  if (status === "a" || nextRound >= 0.9) return "AVAILABLE";
  if (status === "u") return "UNKNOWN";
  return nextRound >= 0.5 ? "DOUBTFUL" : "UNKNOWN";
}

/**
 * Horizon-aware availability for a specific future event.
 * @param horizonOffset 0 = first future GW (next round), 1 = GW after, …
 */
export function availabilityForHorizon(
  player: Pick<FplPlayer, "chance" | "chanceThisRound" | "status" | "news" | "newsAdded" | "scoutRisks">,
  horizonOffset: number,
  nowMs = Date.now(),
): AvailabilitySchedule {
  const offset = Math.max(0, Math.floor(horizonOffset));
  const nextRound = nextRoundAvailability(player);
  const notes: string[] = [];
  const banGws = parseSuspensionDurationGws(player.news ?? "", player.status);
  const ageDays = newsAgeDays(player.newsAdded, nowMs);

  // Exact suspension calendar: unavailable for banGws GWs from next round, then healthy.
  if (banGws !== null && player.status === "s") {
    const remaining = Math.max(0, banGws - offset);
    if (remaining > 0) {
      notes.push(`Suspended: ${remaining} GW remaining of ${banGws}-match ban.`);
      return {
        state: "SUSPENDED",
        availability: 0,
        chanceOfStart: 0,
        chanceOfAppearance: 0.02,
        expectedMinutesFactor: 0,
        availabilityConfidence: 0.85,
        nextRoundChance: nextRound,
        horizonOffset: offset,
        suspensionRemaining: remaining,
        notes,
      };
    }
    notes.push(`Suspension cleared after ${banGws} GW ban.`);
    return {
      state: "AVAILABLE",
      availability: 1,
      chanceOfStart: 0.95,
      chanceOfAppearance: 0.98,
      expectedMinutesFactor: 1,
      availabilityConfidence: 0.75,
      nextRoundChance: nextRound,
      horizonOffset: offset,
      suspensionRemaining: 0,
      notes,
    };
  }

  // Next-round chance applies ONLY at offset 0. Later GWs recover toward healthy.
  // Older news accelerates recovery (flag is staler).
  const ageBoost = ageDays !== null ? clamp(ageDays / 14, 0, 0.35) : 0;
  let availability: number;
  if (offset === 0) {
    availability = nextRound;
    notes.push("Using official chance_of_playing_next_round for GW+0 only.");
  } else if (nextRound >= 0.99 && player.status === "a") {
    availability = 1;
  } else if (player.status === "i" || nextRound < 0.45) {
    // Injured / low chance: slower exponential recovery — never flat multi-GW copy.
    const tau = 2.2;
    const recovered = nextRound + (1 - nextRound) * (1 - Math.exp(-offset / tau));
    availability = clamp(recovered + ageBoost * (1 - recovered), nextRound, 1);
    notes.push(`Injury recovery curve at GW+${offset} (not flat next-round %).`);
  } else {
    // Doubtful / yellow flag (e.g. 75% knee): recover quickly — NOT a 5-GW penalty.
    const recovered = nextRound + (1 - nextRound) * (1 - Math.pow(0.32, offset));
    availability = clamp(recovered + ageBoost * (1 - nextRound), nextRound, 1);
    notes.push(`Doubtful flag decays after next round (GW+${offset}).`);
  }

  const state = classifyState(player.status, nextRound, banGws, offset, player.scoutRisks?.length ?? 0);
  const chanceOfStart = clamp(availability * (state === "ROTATION_RISK" ? 0.92 : 0.98), 0, 1);
  const chanceOfAppearance = clamp(availability * 0.99 + (1 - availability) * 0.08, 0.02, 1);
  const expectedMinutesFactor = clamp(0.15 + 0.85 * availability, 0.05, 1);
  const availabilityConfidence = clamp(
    0.45 + (player.chance !== null ? 0.35 : 0.15) + (ageDays !== null && ageDays < 3 ? 0.1 : 0) - (state === "UNKNOWN" ? 0.2 : 0),
    0.2,
    0.95,
  );

  return {
    state,
    availability,
    chanceOfStart,
    chanceOfAppearance,
    expectedMinutesFactor,
    availabilityConfidence,
    nextRoundChance: nextRound,
    horizonOffset: offset,
    suspensionRemaining: banGws,
    notes,
  };
}

/** Convenience: map event id → schedule given the first future event id. */
export function availabilityForEvent(
  player: Pick<FplPlayer, "chance" | "chanceThisRound" | "status" | "news" | "newsAdded" | "scoutRisks">,
  eventId: number,
  firstEvent: number,
  nowMs = Date.now(),
): AvailabilitySchedule {
  return availabilityForHorizon(player, eventId - firstEvent, nowMs);
}
