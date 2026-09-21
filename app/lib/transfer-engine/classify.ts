import type { TransferEngineRules } from "./rules";
import { DEFAULT_TRANSFER_RULES_2026_27, thresholdsForHit } from "./rules";
import type {
  TransferClassification,
  TransferNetEV,
  TransferRecommendationCard,
} from "./types";

/** Slim net shape for classification (full TransferNetEV or test stubs). */
export type ClassifiableNet = {
  transferCount: number;
  hitCost: number;
  hitLabel?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inMetrics: TransferNetEV["inMetrics"] | any;
  riskAdjustedFiveGwNetVsHold?: number;
  riskAdjustedNet5?: number;
  threeGwNetVsHold?: number;
  netEv3?: number;
  fiveGwNetVsHold?: number;
  netEv5?: number;
};

export type ClassificationInput = {
  net?: ClassifiableNet | null;
  /** True when evaluating the pure HOLD/ROLL option. */
  isHold?: boolean;
};

/**
 * Multi-signal deterministic classification.
 * Confidence (evidence strength) is NOT the same as risk (minutes/start volatility).
 */
export function classifyTransfer(
  input: ClassificationInput,
  rules: TransferEngineRules = DEFAULT_TRANSFER_RULES_2026_27,
): { classification: TransferClassification; reason: string; reasonCodes: string[] } {
  if (input.isHold || !input.net || input.net.transferCount === 0) {
    return {
      classification: "HOLD",
      reason:
        "HOLD / NO TRANSFER — keep the squad now, bank the free transfer, and keep future free moves available. Hit-adjusted alternatives do not clear the risk-adjusted NET bar versus the type-B HOLD plan.",
      reasonCodes: ["hold-baseline"],
    };
  }

  const net = input.net;
  const m = net.inMetrics as TransferNetEV["inMetrics"];
  const riskAdj = Number(net.riskAdjustedFiveGwNetVsHold ?? net.riskAdjustedNet5 ?? 0);
  const shortTerm = Number(net.threeGwNetVsHold ?? net.netEv3 ?? 0);
  const t = thresholdsForHit(net.hitCost, rules);
  const codes: string[] = [];

  const roleWeak =
    m.startProbability < rules.watchStartProbability ||
    m.expectedMinutes < rules.watchExpectedMinutes ||
    m.confidence < rules.watchConfidence;

  if (roleWeak) {
    codes.push("role-weak");
    return {
      classification: "AVOID",
      reason: `Incoming role security is too weak (${Math.round(m.startProbability * 100)}% start, ${Math.round(m.expectedMinutes)} xMins, ${Math.round(m.confidence * 100)}% evidence).`,
      reasonCodes: codes,
    };
  }

  const watchRole =
    m.startProbability < rules.makeStartProbability ||
    m.expectedMinutes < rules.makeExpectedMinutes ||
    m.confidence < rules.makeConfidence;
  if (watchRole) codes.push("role-provisional");

  // Clearly negative → AVOID
  if (riskAdj <= t.avoid) {
    codes.push("negative-net");
    return {
      classification: "AVOID",
      reason: `Risk-adjusted 5-GW NET vs HOLD is modelled at ${fmt(riskAdj)} — worse than holding now.`,
      reasonCodes: codes,
    };
  }

  // HOLD band (near-zero)
  if (Math.abs(riskAdj) <= t.holdBand) {
    codes.push("near-zero-net");
    return {
      classification: "WATCH",
      reason: `Near-zero risk-adj NET (${fmt(riskAdj)}) — edge is too thin to prefer over HOLD.`,
      reasonCodes: codes,
    };
  }

  // Hit + negative short-term + only modest long-term → WATCH (not LEAN)
  // Behaviour case: -4, 3GW -0.6, 5GW +2.1 → WATCH
  if (
    t.isHit &&
    shortTerm < 0 &&
    riskAdj < rules.hitStrongLongTermFloor &&
    riskAdj <= rules.hitModestLongTermCeiling
  ) {
    codes.push("hit-short-negative-modest-long");
    return {
      classification: "WATCH",
      reason: `Hit move with negative short-term NET (${fmt(shortTerm)} over 3 GWs) and only modest 5-GW edge (${fmt(riskAdj)} risk-adj) — watch rather than lean.`,
      reasonCodes: codes,
    };
  }

  // Below WATCH floor but still positive → WATCH
  if (riskAdj < t.watch || watchRole) {
    if (riskAdj >= 0) {
      codes.push(watchRole ? "watch-role" : "watch-thin-edge");
      return {
        classification: "WATCH",
        reason: watchRole
          ? `Positive but provisional: evidence/minutes need confirmation before acting (modelled ${fmt(riskAdj)} risk-adj NET vs HOLD).`
          : `Only ${fmt(riskAdj)} risk-adj 5-GW NET vs HOLD — monitor rather than force.`,
        reasonCodes: codes,
      };
    }
    codes.push("negative-incomplete");
    return {
      classification: "AVOID",
      reason: `Negative risk-adj NET (${fmt(riskAdj)}) with incomplete evidence.`,
      reasonCodes: codes,
    };
  }

  // Below LEAN → WATCH
  if (riskAdj < t.lean) {
    codes.push("watch-band");
    return {
      classification: "WATCH",
      reason: `Modelled ${fmt(riskAdj)} risk-adj 5-GW NET vs HOLD sits in the WATCH band (${fmt(t.watch)}–${fmt(t.lean)}).`,
      reasonCodes: codes,
    };
  }

  // MAKE requires clearing threshold + margin; hits also prefer non-negative 3GW + confidence
  const makeFloor = t.make + t.makeMargin;
  const hitMakeOk =
    !t.isHit ||
    (shortTerm >= 0 && m.confidence >= rules.makeConfidence) ||
    riskAdj >= rules.hitStrongLongTermFloor;

  if (riskAdj >= makeFloor && !watchRole && hitMakeOk) {
    codes.push("make-clears-margin");
    return {
      classification: "MAKE",
      reason: `Modelled ${fmt(riskAdj)} risk-adj 5-GW NET vs HOLD after ${net.hitLabel ?? (net.hitCost > 0 ? `−${net.hitCost}` : "Free")} hit; clears MAKE floor ${fmt(t.make)} with margin.`,
      reasonCodes: codes,
    };
  }

  // Hit that would be MAKE on NET but fails short-term/conf → WATCH or LEAN
  if (t.isHit && riskAdj >= t.make && !hitMakeOk) {
    codes.push("hit-make-gated");
    if (riskAdj >= t.lean) {
      return {
        classification: shortTerm < 0 ? "WATCH" : "LEAN",
        reason:
          shortTerm < 0
            ? `Strong 5-GW edge (${fmt(riskAdj)}) but negative 3-GW NET (${fmt(shortTerm)}) on a hit — watch timing.`
            : `Strong 5-GW edge (${fmt(riskAdj)}) on a hit but confidence/short-term gate keeps this at LEAN.`,
        reasonCodes: codes,
      };
    }
  }

  // LEAN band
  if (riskAdj >= t.lean && !watchRole) {
    codes.push("lean-band");
    return {
      classification: "LEAN",
      reason: `Modelled ${fmt(riskAdj)} risk-adj 5-GW NET vs HOLD — worth leaning toward if you accept ${net.hitLabel ?? (net.hitCost > 0 ? `−${net.hitCost}` : "Free")}.`,
      reasonCodes: codes,
    };
  }

  codes.push("fallback-watch");
  return {
    classification: "WATCH",
    reason: `Modelled ${fmt(riskAdj)} risk-adj NET vs HOLD — monitor.`,
    reasonCodes: codes,
  };
}

function fmt(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}`;
}

export function buildRecommendationCard(
  classification: TransferClassification,
  reason: string,
  net: TransferNetEV | null,
): TransferRecommendationCard {
  if (!net || net.transferCount === 0) {
    return {
      classification: "HOLD",
      outName: "—",
      inName: "—",
      outId: 0,
      inId: 0,
      hitLabel: "Free",
      hitCost: 0,
      bankAfter: 0,
      nextGwGross: 0,
      threeGwNetVsHold: 0,
      fiveGwNetVsHold: 0,
      riskAdjustedFiveGwNetVsHold: 0,
      net3: 0,
      net5: 0,
      riskAdjustedNet5: 0,
      confidence: 1,
      risk: "Low",
      reason,
      riskDrivers: [],
      transferNowPath: net?.holdNowPath,
      holdNowPath: net?.holdNowPath,
      timingEvVsWait: null,
      freeTransfersBefore: net?.freeTransfersBefore,
      freeTransfersAfter: net?.freeTransfersAfter,
    };
  }
  const leg = net.legs[0];
  return {
    classification,
    outName: leg.out.name,
    inName: leg.incoming.name,
    outId: leg.out.id,
    inId: leg.incoming.id,
    hitLabel: net.hitLabel,
    hitCost: net.hitCost,
    bankAfter: net.bankAfter,
    nextGwGross: net.nextGwGross,
    threeGwNetVsHold: net.threeGwNetVsHold,
    fiveGwNetVsHold: net.fiveGwNetVsHold,
    riskAdjustedFiveGwNetVsHold: net.riskAdjustedFiveGwNetVsHold,
    net3: net.threeGwNetVsHold,
    net5: net.fiveGwNetVsHold,
    riskAdjustedNet5: net.riskAdjustedFiveGwNetVsHold,
    confidence: net.confidence,
    risk: net.risk,
    reason,
    riskDrivers: net.riskDrivers,
    transferNowPath: net.transferNowPath,
    holdNowPath: net.holdNowPath,
    timingEvVsWait: net.timingEvVsWait,
    freeTransfersBefore: net.freeTransfersBefore,
    freeTransfersAfter: net.freeTransfersAfter,
  };
}

/** Map new classifications onto legacy qualityStatus for Place / receipts compatibility. */
export function classificationToLegacyQuality(
  classification: TransferClassification,
): "actionable" | "watchlist" | "blocked" {
  if (classification === "MAKE" || classification === "LEAN") return "actionable";
  if (classification === "WATCH" || classification === "ROLL" || classification === "HOLD") return "watchlist";
  return "blocked";
}
