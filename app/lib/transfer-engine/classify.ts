import type { TransferEngineRules } from "./rules";
import { DEFAULT_TRANSFER_RULES_2026_27 } from "./rules";
import type { TransferClassification, TransferNetEV, TransferRecommendationCard } from "./types";

export type ClassificationInput = {
  net?: TransferNetEV | null;
  /** True when evaluating the pure HOLD/ROLL option. */
  isHold?: boolean;
};

export function classifyTransfer(
  input: ClassificationInput,
  rules: TransferEngineRules = DEFAULT_TRANSFER_RULES_2026_27,
): { classification: TransferClassification; reason: string } {
  if (input.isHold || !input.net || input.net.transferCount === 0) {
    return {
      classification: "HOLD",
      reason: "HOLD / NO TRANSFER — keep the current squad. Hit-adjusted alternatives do not clear the risk-adjusted NET bar versus doing nothing.",
    };
  }

  const net = input.net;
  const m = net.inMetrics;
  const riskAdj = net.riskAdjustedNet5;
  const roleWeak =
    m.startProbability < rules.watchStartProbability ||
    m.expectedMinutes < rules.watchExpectedMinutes ||
    m.confidence < rules.watchConfidence;

  if (roleWeak) {
    return {
      classification: "AVOID",
      reason: `Incoming role security is too weak (${Math.round(m.startProbability * 100)}% start, ${Math.round(m.expectedMinutes)} xMins, ${Math.round(m.confidence * 100)}% evidence).`,
    };
  }

  const watchRole =
    m.startProbability < rules.makeStartProbability ||
    m.expectedMinutes < rules.makeExpectedMinutes ||
    m.confidence < rules.makeConfidence;

  if (riskAdj <= rules.avoidNetCeiling) {
    return {
      classification: "AVOID",
      reason: `Risk-adjusted 5-GW NET vs HOLD is ${fmt(riskAdj)} — worse than rolling.`,
    };
  }

  if (watchRole || riskAdj < rules.leanNetThreshold) {
    if (riskAdj >= 0) {
      return {
        classification: "WATCH",
        reason: watchRole
          ? `Positive but provisional: evidence/minutes need confirmation before acting (${fmt(riskAdj)} risk-adj NET).`
          : `Only ${fmt(riskAdj)} risk-adj 5-GW NET vs HOLD — monitor rather than force.`,
      };
    }
    return {
      classification: "AVOID",
      reason: `Negative risk-adj NET (${fmt(riskAdj)}) with incomplete evidence.`,
    };
  }

  if (riskAdj >= rules.makeNetThreshold && !watchRole) {
    return {
      classification: "MAKE",
      reason: `${fmt(riskAdj)} risk-adj 5-GW NET vs HOLD after ${net.hitLabel} hit; role security clears the MAKE floor.`,
    };
  }

  return {
    classification: "LEAN",
    reason: `${fmt(riskAdj)} risk-adj 5-GW NET vs HOLD — worth leaning toward if you accept ${net.hitLabel}.`,
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
      net3: 0,
      net5: 0,
      riskAdjustedNet5: 0,
      confidence: 1,
      risk: "Low",
      reason,
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
    net3: net.netEv3,
    net5: net.netEv5,
    riskAdjustedNet5: net.riskAdjustedNet5,
    confidence: net.confidence,
    risk: net.risk,
    reason,
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
