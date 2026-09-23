import type { RiskMode } from "./optimizer";

// Centralized, disclosed defaults for the Wildcard/Best-Squad strategy-preference terms (design
// checkpoint, this feature -- see HANDOFF/session notes). None of these are official FPL rules;
// isValidSquad's budget/squad-size/position-quota/3-per-club checks remain the only hard
// constraints. Everything here is a SOFT preference inside the objective function, chosen so a
// genuinely well-justified unusual squad (a real rotation-proof second keeper, a defence that
// legitimately clean-sheets a lot) can still outscore a "safe" one -- these are starting points to
// tune from with real results in front of us, not calibrated against historical data yet.
export type WildcardArchetype = "Maximum Expected Points" | "Balanced" | "Aggressive / High Ceiling";

export const ARCHETYPE_BY_RISK: Record<RiskMode, WildcardArchetype> = {
  Balanced: "Maximum Expected Points",
  Safe: "Balanced",
  Aggressive: "Aggressive / High Ceiling",
};

export type WildcardWeights = {
  // --- GK structure (see gkStructureTerm) ---
  // A keeper cheaper than this is assumed unavailable/unplayable fodder -- not a real second option.
  minViableGkPrice: number;
  // Points value assigned to each point of genuine week-to-week rotation gain (backup outscoring the
  // "always start GK1" baseline on weeks with a better fixture). 1.0 = a rotation point is worth
  // exactly as much as an XI point elsewhere in the objective.
  gkRotationPointWeight: number;
  // Objective-points penalty per £1m of backup-GK price ABOVE minViableGkPrice, before rotation
  // gain offsets it. A backup that costs +£1.5m over fodder needs ~1.5x this many points of real
  // rotation gain across the horizon to pay for itself.
  gkPremiumPenaltyPerMillion: number;

  // --- Defensive correlation (see defensiveCorrelationPenalty) ---
  // Flat points penalty for a club with exactly 2 DEF/GKP, before the clean-sheet-probability
  // discount below. Deliberately small -- 2 defenders from one club is completely normal squad
  // building, not a real risk concentration.
  defensiveDoubleUpPenalty: number;
  // Flat points penalty for a club with 3 DEF/GKP (the hard-cap maximum). Meaningfully larger than
  // the double-up penalty: this is real correlated risk (one bad defensive performance costs 3
  // squad slots at once), justified only by real clean-sheet evidence.
  defensiveTripleUpPenalty: number;
  // Both penalties above are multiplied by (1 - avg modeled clean-sheet probability of that club's
  // OWN defensive players this GW) -- a defense projected to clean-sheet 55% of the time keeps
  // ~45% of the penalty; a defense at 10% keeps ~90%. This is what lets a genuinely strong defense
  // stack up without being punished as if it were a coin-flip one.

  // --- Attacking correlation (see attackingCorrelationTerm) ---
  // Same club, 3+ MID/FWD: intentionally much smaller than defensive stacking. Two attackers from
  // one rampant attack correlate in a way that's usually GOOD (they score off each other's
  // buildup); only guard against the fully degenerate "whole front line from one club" case.
  attackingTripleUpPenalty: number;

  // --- Captaincy edge (see captaincyEdgeBonus) ---
  // Objective-points bonus per point of (captain's own xPts - vice's own xPts) per gameweek,
  // horizon-decay-weighted. Rewards a squad that HAS a real standout captain option, distinct from
  // just rewarding raw points (which the captain-doubling in weekPlan already captures).
  captaincyEdgeWeight: number;

  // --- Overperformance / reversion risk (see overperformancePenalty; replaces the old
  //     Aggressive-only "currentXPts > priorPointsPerGame" upside term entirely) ---
  // A player's (actual goals+assists) running this many combined non-penalty G+A ahead of their own
  // (xG+xA) this season, per 90 minutes, is flagged as running hot relative to underlying process.
  overperformanceGapPer90Threshold: number;
  // Points penalty per unit of gap above the threshold, before the minutes-sample and role-security
  // discounts below.
  overperformancePenaltyWeight: number;
  // Minutes needed for FULL confidence in the current-season sample (900 = ~10 full matches). Below
  // this, the penalty scales down linearly -- a 200-minute hot streak is mostly noise, not evidence.
  overperformanceFullSampleMinutes: number;
  // A confirmed penalty-taker or first-choice set-piece taker keeps only this fraction of the
  // penalty -- some of their "overperformance" is a real, repeatable role advantage (penalties,
  // direct free kicks), not unsustainable finishing.
  overperformanceRoleDiscount: number;

  // --- Bench opportunity cost (see benchOpportunityCostPenalty; replaces the old flat
  //     benchSpend>£20m threshold) ---
  // Objective-points penalty per £1m a bench slot's price exceeds what its OWN modeled appearance
  // probability and horizon-decayed expected value justify. A high-appearance-probability slot 1
  // priced at £5.5m can owe little or no penalty; a rarely-playing slot 3 at the same price owes a
  // lot -- opportunity cost, not a fixed budget line.
  benchOpportunityCostPerMillion: number;

  // --- Price flexibility / one-transfer reachability (see priceFlexibilityBonus) ---
  // A same-position replacement within this many £m of a squad player's own price, projecting at
  // least reachableTargetMinValueRatio of that player's own horizon value, counts as a real
  // reachable one-transfer upgrade route.
  reachableTargetPriceBand: number;
  reachableTargetMinValueRatio: number;
  // Objective-points bonus per reachable target found, averaged per squad player (so a squad boxed
  // into unique, hard-to-replace price points scores lower here even if its raw points are fine).
  priceFlexibilityWeight: number;

  // --- Captaincy edge reference pool (see captaincyEdgeBonus) ---
  // How many of the best pool-wide captain-eligible xPts scores (across ALL clubs/positions, not
  // just this squad) are averaged into the "realistic elite alternative" benchmark a squad's actual
  // captain choice is compared against each week.
  captaincyReferencePoolSize: number;
};

// Three named presets, one per RiskMode (ARCHETYPE_BY_RISK above maps RiskMode to the requested
// archetype names) -- keyed by RiskMode, but the VALUES are chosen to match the ARCHETYPE each
// RiskMode maps to, not the RiskMode's name. Maximum Expected Points (RiskMode "Balanced") relaxes
// every strategic penalty toward zero (still real, just small, so degenerate exploits are still
// caught) -- it wants the raw, close-to-undistorted expected-points objective; Balanced (RiskMode
// "Safe") sits in the middle of every weight; Aggressive (RiskMode "Aggressive") raises
// captaincy-edge reward and relaxes attacking correlation further while KEEPING the overperformance
// penalty at full strength -- explicit per design instruction: more ceiling tolerance, never a
// reward for chasing unsustainable finishing. NOTE: this is a fully separate axis from the
// pre-existing riskWeight multiplier in optimizer.ts's evaluate() (Safe=1.35/Balanced=.78/
// Aggressive=.38 on rotation-risk), which already correctly makes "Safe" the most rotation-risk-
// averse RiskMode -- that axis is untouched by any of this.
export const WILDCARD_WEIGHTS: Record<RiskMode, WildcardWeights> = {
  Balanced: {
    // "Maximum Expected Points" per ARCHETYPE_BY_RISK -- lowest strategic penalties, heaviest raw
    // xPts weighting, but never zero: a squad can still be caught for a truly degenerate exploit
    // (e.g. two £5.5m keepers with no rotation gain at all), just at a much smaller cost.
    minViableGkPrice: 4.0,
    gkRotationPointWeight: 1.0,
    gkPremiumPenaltyPerMillion: 0.45,
    defensiveDoubleUpPenalty: 0.25,
    defensiveTripleUpPenalty: 1.1,
    attackingTripleUpPenalty: 0.15,
    captaincyEdgeWeight: 0.3,
    overperformanceGapPer90Threshold: 0.16,
    overperformancePenaltyWeight: 4,
    overperformanceFullSampleMinutes: 900,
    overperformanceRoleDiscount: 0.5,
    benchOpportunityCostPerMillion: 0.35,
    reachableTargetPriceBand: 1.0,
    reachableTargetMinValueRatio: 0.9,
    priceFlexibilityWeight: 0.15,
    captaincyReferencePoolSize: 5,
  },
  Safe: {
    // "Balanced" per ARCHETYPE_BY_RISK -- the middle-ground preset: every strategic soft-term at a
    // moderate, real-but-not-dominant weight.
    minViableGkPrice: 4.0,
    gkRotationPointWeight: 1.0,
    gkPremiumPenaltyPerMillion: 1.1,
    defensiveDoubleUpPenalty: 0.8,
    defensiveTripleUpPenalty: 3.2,
    attackingTripleUpPenalty: 0.6,
    captaincyEdgeWeight: 0.5,
    overperformanceGapPer90Threshold: 0.12,
    overperformancePenaltyWeight: 9,
    overperformanceFullSampleMinutes: 900,
    overperformanceRoleDiscount: 0.4,
    benchOpportunityCostPerMillion: 0.9,
    reachableTargetPriceBand: 1.0,
    reachableTargetMinValueRatio: 0.9,
    priceFlexibilityWeight: 0.35,
    captaincyReferencePoolSize: 5,
  },
  Aggressive: {
    // "Aggressive / High Ceiling" -- higher captaincy-edge reward, relaxed attacking correlation
    // (explicitly "more tolerance for... attacking stacks"), defensive correlation and GK/bench
    // discipline held close to Balanced (never asked to loosen those), overperformance penalty at
    // full strength per explicit instruction not to reward unsustainable finishing.
    minViableGkPrice: 4.0,
    gkRotationPointWeight: 1.0,
    gkPremiumPenaltyPerMillion: 1.0,
    defensiveDoubleUpPenalty: 0.8,
    defensiveTripleUpPenalty: 3.0,
    attackingTripleUpPenalty: 0.1,
    captaincyEdgeWeight: 0.85,
    overperformanceGapPer90Threshold: 0.12,
    overperformancePenaltyWeight: 9,
    overperformanceFullSampleMinutes: 900,
    overperformanceRoleDiscount: 0.4,
    benchOpportunityCostPerMillion: 0.7,
    reachableTargetPriceBand: 1.0,
    reachableTargetMinValueRatio: 0.9,
    priceFlexibilityWeight: 0.2,
    captaincyReferencePoolSize: 5,
  },
};
