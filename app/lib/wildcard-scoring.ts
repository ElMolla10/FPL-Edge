import type { FplData, FplPlayer, ProjectionMetrics } from "./fpl";
import type { WeekPlan } from "./optimizer";
import { modeledAppearanceProbability } from "./bench-order";
import type { WildcardWeights } from "./wildcard-tuning";

const clamp = (n: number, min = 0, max = 100) => Math.max(min, Math.min(max, n));

// --- GK structure ---
// Values genuine week-to-week rotation (weekPlan already lets whichever keeper scores higher for
// THAT gameweek's fixture start -- see optimizer.ts's keepers.sort per weekPlan call), and only
// charges for backup price ABOVE a realistic fodder floor. A backup that never actually starts
// across the horizon earns zero rotation credit and pays the full premium penalty; a backup that
// legitimately outscores GK1 on several weeks (a real rotation pair) earns it back.
export function gkStructureTerm(
  squad: readonly FplPlayer[],
  weeks: readonly WeekPlan[],
  weights: readonly number[],
  metrics: (player: FplPlayer, eventId: number) => ProjectionMetrics,
  tuning: WildcardWeights,
): number {
  const keepers = [...squad.filter((p) => p.positionShort === "GKP")].sort((a, b) => b.price - a.price || a.id - b.id);
  if (keepers.length < 2) return 0;
  const [primary, backup] = keepers;
  let rotationGain = 0;
  weeks.forEach((week, i) => {
    const primaryScore = metrics(primary, week.eventId).xPts;
    const backupScore = metrics(backup, week.eventId).xPts;
    rotationGain += Math.max(0, backupScore - primaryScore) * (weights[i] ?? 0);
  });
  const backupPremium = Math.max(0, backup.price - tuning.minViableGkPrice);
  return rotationGain * tuning.gkRotationPointWeight - backupPremium * tuning.gkPremiumPenaltyPerMillion;
}

// --- Defensive / attacking correlation ---
// Defensive (GKP+DEF) stacking is penalized on a curve that shrinks with the club's own real
// modeled clean-sheet probability -- a defense projected to clean-sheet often keeps only a small
// fraction of the flat penalty, so genuinely strong defenses can still be stacked. Attacking
// (MID+FWD) stacking is penalized far more lightly and only at 3+ from one club, per instruction
// not to treat attacking correlation the same as defensive. Returns the two components separately
// (rather than one summed number) so the diagnostic breakdown can show each on its own line, per
// explicit request -- callers that only need the objective-function total sum the two themselves.
export function correlationPenalty(
  squad: readonly FplPlayer[],
  firstEventId: number,
  metrics: (player: FplPlayer, eventId: number) => ProjectionMetrics,
  tuning: WildcardWeights,
): { defensive: number; attacking: number } {
  const byClub = new Map<number, FplPlayer[]>();
  squad.forEach((p) => byClub.set(p.teamId, [...(byClub.get(p.teamId) ?? []), p]));
  let defensive = 0;
  let attacking = 0;
  for (const players of byClub.values()) {
    const defensivePlayers = players.filter((p) => p.positionShort === "GKP" || p.positionShort === "DEF");
    const attackingPlayers = players.filter((p) => p.positionShort === "MID" || p.positionShort === "FWD");
    if (defensivePlayers.length >= 2) {
      const avgCleanSheet = defensivePlayers.reduce((s, p) => s + metrics(p, firstEventId).cleanSheetProbability, 0) / defensivePlayers.length;
      const justifiedDiscount = 1 - avgCleanSheet;
      const base = defensivePlayers.length >= 3 ? tuning.defensiveTripleUpPenalty : tuning.defensiveDoubleUpPenalty;
      defensive += base * justifiedDiscount;
    }
    if (attackingPlayers.length >= 3) attacking += tuning.attackingTripleUpPenalty;
  }
  return { defensive, attacking };
}

// --- Captaincy edge ---
// NOT (captain's own xPts - vice's own xPts) -- that measure can be inflated just by owning a WORSE
// second-best player, with no change to how good the captain choice actually is (in the limit, a
// squad could pad this term purely by making its own bench weaker). What actually matters is
// whether the OWNED captain's score clears a REALISTIC alternative the squad could have owned
// instead, not merely the specific backup this squad happens to carry -- so the reference point is
// the average xPts of the top `captaincyReferencePoolSize` captain-eligible players in the WHOLE
// pool that gameweek (precomputed once per optimizer instance in referenceEliteByEvent, since it is
// squad-independent and this function runs on every evaluate() call during annealing). A squad
// whose captain clears that pool-wide elite bar has genuine, not self-referential, captaincy edge;
// a squad whose "best" player is merely the best of a mediocre bunch scores ~0 here. Falls back to
// the week's own vice score only when no reference is supplied (e.g. simplified test setups),
// preserving the old self-referential behavior there rather than silently returning zero.
export function captaincyEdgeBonus(
  weeks: readonly WeekPlan[],
  weights: readonly number[],
  tuning: WildcardWeights,
  referenceEliteByEvent?: ReadonlyMap<number, number>,
): number {
  return (
    weeks.reduce((sum, week, i) => {
      const reference = referenceEliteByEvent?.get(week.eventId) ?? week.vicePoints;
      return sum + Math.max(0, week.captainPoints - reference) * (weights[i] ?? 0);
    }, 0) * tuning.captaincyEdgeWeight
  );
}

// Precomputes, for each event, the average xPts of the top `poolSize` scorers across the whole
// player pool (all positions -- a captain can legally be anyone in the XI) -- the "realistic elite
// alternative" benchmark captaincyEdgeBonus compares an owned captain against. Squad-independent by
// construction, so this is computed ONCE per optimizer instance, not per evaluate() call (the
// annealing search calls evaluate() many thousands of times per optimize() run).
export function buildCaptaincyReferenceByEvent(
  pool: readonly FplPlayer[],
  eventIds: readonly number[],
  metrics: (player: FplPlayer, eventId: number) => ProjectionMetrics,
  poolSize: number,
): Map<number, number> {
  const reference = new Map<number, number>();
  for (const eventId of eventIds) {
    const top = pool
      .map((p) => metrics(p, eventId).xPts)
      .sort((a, b) => b - a)
      .slice(0, Math.max(1, poolSize));
    reference.set(eventId, top.reduce((s, v) => s + v, 0) / top.length);
  }
  return reference;
}

// --- Overperformance / reversion risk ---
// Real current-season actual output (goals+assists) vs real current-season underlying process
// (expectedGoals+expectedAssists), per 90 minutes -- not "current xPts vs prior PPG" (the old
// Aggressive-only term this replaces, which rewarded exactly the pattern being guarded against
// here). Discounted by minutes sample size (a 200-minute hot streak is mostly noise) and by
// confirmed penalty/set-piece role (some of that "overperformance" is a real repeatable edge).
export function overperformancePenalty(
  squad: readonly FplPlayer[],
  firstEventId: number,
  metrics: (player: FplPlayer, eventId: number) => ProjectionMetrics,
  tuning: WildcardWeights,
): number {
  return squad.reduce((sum, p) => {
    if (p.minutes <= 0) return sum;
    const actual = p.goals + p.assists;
    const underlying = p.expectedGoals + p.expectedAssists;
    const gapPer90 = Math.max(0, (actual - underlying) / (p.minutes / 90));
    const excess = Math.max(0, gapPer90 - tuning.overperformanceGapPer90Threshold);
    if (excess <= 0) return sum;
    const sampleWeight = clamp(p.minutes / tuning.overperformanceFullSampleMinutes, 0, 1);
    const m = metrics(p, firstEventId);
    const roleDiscount = m.penaltyRole || m.setPieceRole ? tuning.overperformanceRoleDiscount : 1;
    return sum + excess * tuning.overperformancePenaltyWeight * sampleWeight * roleDiscount;
  }, 0);
}

// --- Bench opportunity cost ---
// Replaces a single flat "benchSpend > £20m" cutoff with a per-slot opportunity-cost check: a
// slot's own modeled appearance probability (real rotation/injury/fixture-congestion odds this
// player actually plays, from bench-order.ts's shared model) sets how much price is "earned" --
// only the price ABOVE that earned amount is penalized, so a genuinely rotation-proof first bench
// player can cost more without penalty while a rarely-playing third bench player cannot.
export function benchOpportunityCostPenalty(
  weeks: readonly WeekPlan[],
  weights: readonly number[],
  metrics: (player: FplPlayer, eventId: number) => ProjectionMetrics,
  tuning: WildcardWeights,
): number {
  const firstWeek = weeks[0];
  if (!firstWeek) return 0;
  return firstWeek.bench.reduce((sum, player, index) => {
    if (player.positionShort === "GKP") return sum;
    const slotWeight = [0.27, 0.14, 0.07][index] ?? 0.04;
    const avgAppearance = weeks.reduce((s, week, i) => {
      const m = metrics(player, week.eventId);
      return s + modeledAppearanceProbability(player, m) * (weights[i] ?? 0);
    }, 0) / Math.max(1, weeks.reduce((s, _, i) => s + (weights[i] ?? 0), 0));
    // Earned price: a player who always plays (appearance=1) at the top bench weight earns roughly
    // a mid-price bench player's worth; this is deliberately a soft, tunable ratio, not a claimed
    // market valuation.
    const earnedPrice = avgAppearance * slotWeight * 30;
    return sum + Math.max(0, player.price - earnedPrice) * tuning.benchOpportunityCostPerMillion;
  }, 0);
}

// --- Price flexibility / one-transfer reachability ---
// For each squad player, counts same-position players in the real pool priced within
// reachableTargetPriceBand of them who project at least reachableTargetMinValueRatio of their own
// horizon value -- a genuine "could realistically transfer toward this" count, not just price-band
// coverage. Squads boxed into unique, hard-to-replace price points score lower here even when raw
// points are fine.
export function priceFlexibilityBonus(
  squad: readonly FplPlayer[],
  pool: readonly FplPlayer[],
  projectionValue: (player: FplPlayer) => number,
  tuning: WildcardWeights,
): number {
  const owned = new Set(squad.map((p) => p.id));
  const totalReachable = squad.reduce((sum, player) => {
    const ownValue = projectionValue(player);
    const reachable = pool.filter(
      (candidate) =>
        !owned.has(candidate.id) &&
        candidate.positionId === player.positionId &&
        Math.abs(candidate.price - player.price) <= tuning.reachableTargetPriceBand &&
        projectionValue(candidate) >= ownValue * tuning.reachableTargetMinValueRatio,
    ).length;
    return sum + reachable;
  }, 0);
  return (totalReachable / squad.length) * tuning.priceFlexibilityWeight;
}

// --- Real defensive/attacking club exposure, for reporting (not scoring) ---
export function clubExposure(squad: readonly FplPlayer[], data: FplData): { clubId: number; clubName: string; defensive: number; attacking: number }[] {
  const teamName = new Map(data.teams.map((t) => [t.id, t.name]));
  const byClub = new Map<number, FplPlayer[]>();
  squad.forEach((p) => byClub.set(p.teamId, [...(byClub.get(p.teamId) ?? []), p]));
  return [...byClub.entries()]
    .map(([clubId, players]) => ({
      clubId,
      clubName: teamName.get(clubId) ?? "Unknown",
      defensive: players.filter((p) => p.positionShort === "GKP" || p.positionShort === "DEF").length,
      attacking: players.filter((p) => p.positionShort === "MID" || p.positionShort === "FWD").length,
    }))
    .filter((c) => c.defensive > 0 || c.attacking > 0)
    .sort((a, b) => b.defensive + b.attacking - (a.defensive + a.attacking));
}
