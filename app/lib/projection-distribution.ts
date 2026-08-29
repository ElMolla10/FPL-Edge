import { projectionMetrics } from "./fpl";
import type { FplFixture, FplPlayer, ProjectionMetrics } from "./fpl";

// A discrete probability mass function over non-negative integer point totals: pmf[k] = P(points = k).
// Always sums to 1 (within floating-point tolerance), no negative entries. Everything in this file
// is a pure function of its inputs -- no Math.random, no Date.now, deterministic given the same
// ProjectionMetrics every time, matching this codebase's existing testing discipline.
export type Pmf = number[];

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const pmfMean = (pmf: Pmf): number => pmf.reduce((sum, p, k) => sum + p * k, 0);

// Smallest k such that P(points <= k) >= quantile. A direct read off the PMF's own CDF -- floor
// (quantile .1), median (.5) and ceiling (.9) below all reduce to this one query, not three
// separate re-derivations of "typical range."
export function pmfQuantile(pmf: Pmf, quantile: number): number {
  let cumulative = 0;
  for (let k = 0; k < pmf.length; k++) {
    cumulative += pmf[k];
    if (cumulative >= quantile - 1e-9) return k;
  }
  return pmf.length - 1;
}

export const pmfAtMost = (pmf: Pmf, k: number): number => k < 0 ? 0 : pmf.slice(0, k + 1).reduce((sum, p) => sum + p, 0);
export const pmfAtLeast = (pmf: Pmf, k: number): number => clamp(1 - pmfAtMost(pmf, k - 1), 0, 1);

const pointMass = (value: number): Pmf => {
  const pmf = new Array(Math.max(0, value) + 1).fill(0);
  pmf[Math.max(0, value)] = 1;
  return pmf;
};

// Standard discrete convolution: if X and Y are independent integer-valued random variables with
// PMFs a and b, (a*b)[k] = P(X+Y=k) = sum over i+j=k of a[i]*b[j].
function convolve2(a: Pmf, b: Pmf): Pmf {
  const result = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0) continue;
    for (let j = 0; j < b.length; j++) {
      if (b[j] === 0) continue;
      result[i + j] += a[i] * b[j];
    }
  }
  return result;
}

export function convolvePmfs(pmfs: Pmf[]): Pmf {
  return pmfs.reduce((accumulated, pmf) => convolve2(accumulated, pmf), [1]);
}

// Remaps every outcome index of `pmf` through toValue(index), folding probability mass that lands
// on the same output value together (e.g. save counts 3, 4 and 5 all become 1 save point). A
// mapped value beyond maxValue is folded into maxValue rather than dropped, so total probability
// is always conserved even under aggressive truncation.
function remapPmf(pmf: Pmf, toValue: (index: number) => number, maxValue: number): Pmf {
  const result = new Array(maxValue + 1).fill(0);
  pmf.forEach((probability, index) => {
    if (probability === 0) return;
    result[clamp(Math.round(toValue(index)), 0, maxValue)] += probability;
  });
  return result;
}

export function bernoulliPmf(successProbability: number, valueIfSuccess: number): Pmf {
  const p = clamp(successProbability, 0, 1), value = Math.max(0, valueIfSuccess);
  const pmf = new Array(value + 1).fill(0);
  pmf[0] += 1 - p;
  pmf[value] += p;
  return pmf;
}

// Poisson(lambda) truncated at maxK, with the residual tail folded into the final bucket so the
// PMF still sums to exactly 1. maxK is chosen generously per call site so this folding is never
// material for realistic football rates (verified in tests).
export function poissonCountPmf(lambda: number, maxK: number): Pmf {
  if (lambda <= 0) return pointMass(0);
  const pmf = new Array(maxK + 1).fill(0);
  let term = Math.exp(-lambda), remaining = 1;
  for (let k = 0; k < maxK; k++) {
    pmf[k] = term;
    remaining -= term;
    term *= lambda / (k + 1);
  }
  pmf[maxK] = clamp(remaining, 0, 1);
  return pmf;
}

// Negative-Binomial count PMF via the Gamma-Poisson mixture: the scoring rate itself is drawn from
// a Gamma(shape=r, mean=mean) distribution rather than being known exactly, so the observed count
// is over-dispersed relative to a plain Poisson by an amount controlled by r (mean-preserving; r
// -> infinity recovers Poisson exactly). Computed via the standard recursive ratio
// P(k+1)/P(k) = (k+r)/(k+1) * mean/(mean+r), which only needs real-valued pow/exp and is valid for
// any non-integer r -- no gamma or factorial function required.
export function negativeBinomialCountPmf(mean: number, r: number, maxK: number): Pmf {
  if (mean <= 0) return pointMass(0);
  const p = mean / (mean + r);
  const pmf = new Array(maxK + 1).fill(0);
  let term = Math.pow(1 - p, r), remaining = 1;
  for (let k = 0; k < maxK; k++) {
    pmf[k] = term;
    remaining -= term;
    term *= ((k + r) / (k + 1)) * p;
  }
  pmf[maxK] = clamp(remaining, 0, 1);
  return pmf;
}

// Connects the Negative-Binomial dispersion to the existing calibration-driven confidence value
// (see the investigation note in the round this was built) rather than a fresh judgment about
// sample thinness or the raw calibrationGroup label. Linear in confidence, chosen so:
//  - projectionMetrics' own confidence floor is .05 (never 0), so r never actually reaches NB_R_MIN
//    -- at that realistic floor, r=4.4, giving ~14% extra variance over Poisson at a typical
//    attacking lambda of 0.6 (verified in tests: NB variance = mean + mean^2/r = .682 vs .6).
//  - at confidence 1 (an established, high-minutes player at the confidence cap), r = NB_R_MAX
//    makes the distribution numerically indistinguishable from Poisson: exactly 2% extra variance
//    at lambda=1 (1.02 vs 1), negligible in practice.
const NB_R_MIN = 2, NB_R_MAX = 50;
export const negativeBinomialDispersion = (confidence: number): number => NB_R_MIN + (NB_R_MAX - NB_R_MIN) * clamp(confidence, 0, 1);

const GOAL_POINTS: Record<string, number> = { FWD: 4, MID: 5, DEF: 6, GKP: 6 };
const CLEAN_SHEET_POINTS: Record<string, number> = { MID: 1, GKP: 4, DEF: 4, FWD: 0 };
const ASSIST_POINTS = 3;
const GOAL_COUNT_CAP = 6, ASSIST_COUNT_CAP = 6, SAVE_COUNT_CAP = 12;

// Factored so its expectation reproduces projectionMetrics' own continuous appearance-points term
// exactly: appearance = (1-sixtyProbability)*startProbability + sixtyProbability*2. Treating
// "started at all" and "played 60+" as independent Bernoulli signals is an approximation (60+
// minutes implies having started) -- but it is the same approximation the existing point-estimate
// formula already makes, so this distribution's mean matches xPts's own appearance term exactly
// rather than introducing a second, disagreeing definition of the same quantity.
function singleFixtureAppearancePmf(startProbability: number, sixtyProbability: number): Pmf {
  const start = clamp(startProbability, 0, 1), sixty = clamp(sixtyProbability, 0, 1);
  return [(1 - start) * (1 - sixty), start * (1 - sixty), sixty];
}

// startProbability/sixtyProbability are computed once per event, not per fixture (fpl.ts's own
// projectionMetricsBase derives them before its per-game loop), so a double gameweek's two
// fixtures are modeled as i.i.d. draws from the same per-fixture appearance PMF -- convolving it
// with itself fixtureCount times gives the correct 0-to-2*fixtureCount range (e.g. 0-4 for a DGW)
// instead of silently capping every event at a single fixture's 0-2. fixtureCount<=0 (a genuine
// blank) correctly collapses to a single point mass at 0 via convolvePmfs([]) = [1], no special
// case needed.
export function appearancePointsPmf(startProbability: number, sixtyProbability: number, fixtureCount: number): Pmf {
  return convolvePmfs(new Array(Math.max(0, fixtureCount)).fill(singleFixtureAppearancePmf(startProbability, sixtyProbability)));
}

export function goalsPointsPmf(xG: number, confidence: number, positionShort: FplPlayer["positionShort"]): Pmf {
  const counts = negativeBinomialCountPmf(xG, negativeBinomialDispersion(confidence), GOAL_COUNT_CAP);
  const points = GOAL_POINTS[positionShort] ?? GOAL_POINTS.MID;
  return remapPmf(counts, index => index * points, GOAL_COUNT_CAP * points);
}

export function assistsPointsPmf(xA: number, confidence: number): Pmf {
  const counts = negativeBinomialCountPmf(xA, negativeBinomialDispersion(confidence), ASSIST_COUNT_CAP);
  return remapPmf(counts, index => index * ASSIST_POINTS, ASSIST_COUNT_CAP * ASSIST_POINTS);
}

// A clean sheet only pays out when the player actually reaches 60 minutes -- the same
// sixtyProbability discount projectionMetrics already applies to this component
// (csProb*cleanSheetPoints*sixtyProbability in its own per-fixture loop), applied here as the same
// independence approximation rather than a fresh joint model of the two events.
//
// metrics.cleanSheetProbability is ALREADY the average per-fixture probability -- fpl.ts's own
// projectionMetricsBase explicitly divides by games.length before returning it
// (cleanSheetProbability: totals.cleanSheetProbability/games.length), unlike bonus/DC which stay
// as raw per-event sums. So for a double gameweek, treating it as one fixture's probability and
// convolving that same per-fixture Bernoulli with itself fixtureCount times correctly produces
// 0, points or 2*points (for fixtureCount=2) instead of capping at a single fixture's 0-or-points.
// This assumes both fixtures share that same average probability -- an approximation when the two
// fixtures are genuinely different difficulty, but it is the best signal available without
// threading a per-fixture breakdown through ProjectionMetrics, and it is the exact same averaging
// fpl.ts already committed to for this specific field.
export function cleanSheetPointsPmf(cleanSheetProbability: number, sixtyProbability: number, positionShort: FplPlayer["positionShort"], fixtureCount: number): Pmf {
  const points = CLEAN_SHEET_POINTS[positionShort] ?? CLEAN_SHEET_POINTS.MID;
  if (points === 0) return pointMass(0);
  const singleFixture = bernoulliPmf(clamp(cleanSheetProbability, 0, 1) * clamp(sixtyProbability, 0, 1), points);
  return convolvePmfs(new Array(Math.max(0, fixtureCount)).fill(singleFixture));
}

// ProjectionMetrics.defensiveContribution is already P(actions >= threshold) * 2 PER FIXTURE,
// SUMMED across the event (fpl.ts accumulates it via totals.defensiveContribution+=dc inside the
// per-game loop, with no division by games.length afterward -- unlike cleanSheetProbability). For
// a double gameweek this can already exceed 1 as a raw points value (e.g. 2.6 from two independent
// .7 and .6-probability fixtures), so dividing by 2 alone -- correct for a single fixture -- would
// silently clamp to a single Bernoulli(1, 2) and lose the real 0/2/4-point spread. Dividing by
// 2*fixtureCount first recovers an averaged per-fixture probability (the same averaging trade-off
// cleanSheetPointsPmf makes, and for the same reason: no per-fixture breakdown is available), then
// that single-fixture Bernoulli is convolved with itself fixtureCount times.
export function defensiveContributionPmf(defensiveContributionPoints: number, positionShort: FplPlayer["positionShort"], fixtureCount: number): Pmf {
  if (positionShort === "GKP") return pointMass(0);
  const perFixtureProbability = fixtureCount > 0 ? defensiveContributionPoints / (2 * fixtureCount) : 0;
  const singleFixture = bernoulliPmf(clamp(perFixtureProbability, 0, 1), 2);
  return convolvePmfs(new Array(Math.max(0, fixtureCount)).fill(singleFixture));
}

// Real FPL bonus points are awarded to the top 3 BPS scorers in a match -- a rank-dependent
// outcome that would require modeling every other player on the pitch, well beyond this player's
// own metrics. projectionMetrics only exposes an expected bonus VALUE per event (0-1.6 per fixture,
// summed across fixtures -- fpl.ts's own bonus clamp is explicitly 1.6*games.length, confirming a
// double gameweek's raw value can already reach 3.2), not a distribution. This is a genuine,
// openly-approximated simplification, not a reuse of anything: each fixture's share of that total
// (expectedBonus/fixtureCount) is spread across {0,1,2,3} using a fixed 3:2:1 relative-frequency
// shape for {1,2,3} bonus points (1 being the most common non-zero outcome in practice, 3 the
// rarest), then that single-fixture PMF is convolved with itself fixtureCount times -- giving a
// double gameweek its real 0-6 ceiling instead of silently capping at a single match's 0-3. The
// 3:2:1 shape is NOT derived from real BPS data -- it is a labeled guess, and the one place in this
// engine where "reuse what exists" runs out. Flagged here and in the accompanying report.
const BONUS_SHAPE = [3, 2, 1]; // relative weight of {1, 2, 3} bonus points, most-common-first
export function bonusPointsPmf(expectedBonus: number, fixtureCount: number): Pmf {
  const totalShape = BONUS_SHAPE.reduce((sum, weight) => sum + weight, 0);
  const meanGivenAnyBonus = BONUS_SHAPE.reduce((sum, weight, index) => sum + (weight / totalShape) * (index + 1), 0);
  const perFixtureExpected = fixtureCount > 0 ? expectedBonus / fixtureCount : 0;
  const anyBonusProbability = clamp(perFixtureExpected / meanGivenAnyBonus, 0, 1);
  const singleFixture = [1 - anyBonusProbability, 0, 0, 0];
  BONUS_SHAPE.forEach((weight, index) => { singleFixture[index + 1] = anyBonusProbability * (weight / totalShape); });
  return convolvePmfs(new Array(Math.max(0, fixtureCount)).fill(singleFixture));
}

export function savesPointsPmf(expectedSaves: number, positionShort: FplPlayer["positionShort"]): Pmf {
  if (positionShort !== "GKP") return pointMass(0);
  const counts = poissonCountPmf(expectedSaves, SAVE_COUNT_CAP);
  return remapPmf(counts, index => Math.floor(index / 3), Math.floor(SAVE_COUNT_CAP / 3));
}

// The full points distribution: an exact discrete convolution of independent component
// distributions built entirely from the existing ProjectionMetrics a player already has -- no new
// upstream computation, no Math.random, deterministic given identical input. Position-inapplicable
// components (e.g. clean-sheet points for a FWD, DC for a GKP) contribute a degenerate {0: 1} PMF,
// so convolving them is a correct no-op rather than a special case.
//
// fixtureCount (double/blank-gameweek awareness, investigated and added after the initial build):
// goals, assists and saves need NO fixture-count handling at all -- projectionMetrics already sums
// xG/xA/saves across every fixture in the event (Poisson's mean is exactly additive), and a SINGLE
// Negative-Binomial draw on that combined mean is the mathematically correct model for a double
// gameweek, not two independent draws: the confidence-driven dispersion represents uncertainty
// about the player's one true underlying rate, which does not re-resolve independently between two
// fixtures in the same event. Convolving two separate NB draws would double-count that uncertainty.
// Appearance, clean sheet, DC and bonus are different: their inputs are per-fixture-shaped (a
// single startProbability/sixtyProbability pair, or an average/sum that assumes one fixture) and
// were silently capping every event at a single match's ceiling before this fix. metrics.fixtureCount
// defaults to 1 for any ProjectionMetrics that predates this field (every existing hand-built test
// mock in this codebase), preserving single-fixture behavior exactly.
export function playerPointsDistribution(metrics: ProjectionMetrics, positionShort: FplPlayer["positionShort"]): Pmf {
  const fixtureCount = metrics.fixtureCount ?? 1;
  return convolvePmfs([
    appearancePointsPmf(metrics.startProbability, metrics.sixtyProbability, fixtureCount),
    goalsPointsPmf(metrics.xG, metrics.confidence, positionShort),
    assistsPointsPmf(metrics.xA, metrics.confidence),
    cleanSheetPointsPmf(metrics.cleanSheetProbability, metrics.sixtyProbability, positionShort, fixtureCount),
    defensiveContributionPmf(metrics.defensiveContribution, positionShort, fixtureCount),
    bonusPointsPmf(metrics.bonus, fixtureCount),
    savesPointsPmf(metrics.saves, positionShort),
  ]);
}

export type PointsRange = { floor: number; median: number; ceiling: number };
export function pointsRange(pmf: Pmf): PointsRange {
  return { floor: pmfQuantile(pmf, 0.1), median: pmfQuantile(pmf, 0.5), ceiling: pmfQuantile(pmf, 0.9) };
}

// FPL-community-convention thresholds already agreed for this feature in the design round: blank =
// 0-2 points, haul = 10+ points. Direct PMF reads, not re-derivations.
export const BLANK_THRESHOLD = 2;
export const HAUL_THRESHOLD = 10;
export const blankProbability = (pmf: Pmf): number => pmfAtMost(pmf, BLANK_THRESHOLD);
export const haulProbability = (pmf: Pmf): number => pmfAtLeast(pmf, HAUL_THRESHOLD);

export type PlayerFixtureOutcomeModel = {
  fixtureId: number;
  teamId: number;
  appearanceProbability: number;
  reached60Probability: number;
  pointsWhenAppearedPmf: Pmf;
  cleanSheetProbability: number;
  cleanSheetPoints: number;
};

export type PlayerEventOutcomeModel = {
  player: FplPlayer;
  eventId: number;
  fixtures: PlayerFixtureOutcomeModel[];
};

// Reads an integer outcome from a PMF's inverse CDF. Keeping this here makes the scenario engine
// consume the same distributions as the player-level floor/median/ceiling views. The caller owns
// the deterministic uniform sequence; this function contains no random state.
export function samplePmf(pmf: Pmf, uniform: number): number {
  const target = clamp(uniform, 0, 1 - Number.EPSILON);
  let cumulative = 0;
  for (let value = 0; value < pmf.length; value++) {
    cumulative += pmf[value] ?? 0;
    if (target < cumulative) return value;
  }
  return Math.max(0, pmf.length - 1);
}

// Builds a joint-capable event model from real fixture-level projection inputs. Scoring PMFs are
// conditional on appearing: the projection rates are unconditional, so dividing their means by
// P(appearance) preserves those component means after the scenario engine gates every component
// behind an appearance. Clean sheets stay separate so one fixture/team factor can be shared by all
// teammates. A blank produces fixtures=[]; a double retains both official fixture ids.
export function buildPlayerEventOutcomeModel(
  player: FplPlayer,
  eventId: number,
  fixtures: FplFixture[],
  firstEvent: number,
): PlayerEventOutcomeModel {
  const games = fixtures.filter(fixture => fixture.event === eventId && (fixture.teamH === player.teamId || fixture.teamA === player.teamId));
  const fixtureModels = games.map(fixture => {
    const metrics = projectionMetrics(player, eventId, [fixture], firstEvent);
    // This is exactly the probability mass represented by singleFixtureAppearancePmf at 1 or 2
    // points: start*(1-sixty)+sixty. It is coherent with the existing marginal distribution and
    // guarantees reached60 is a subset of appeared.
    const reached60Probability = clamp(metrics.sixtyProbability, 0, 1);
    const appearanceProbability = clamp(metrics.startProbability * (1 - reached60Probability) + reached60Probability, reached60Probability, 1);
    const conditional = Math.max(.01, appearanceProbability);
    const pointsWhenAppearedPmf = convolvePmfs([
      goalsPointsPmf(metrics.xG / conditional, metrics.confidence, player.positionShort),
      assistsPointsPmf(metrics.xA / conditional, metrics.confidence),
      defensiveContributionPmf(metrics.defensiveContribution / conditional, player.positionShort, 1),
      bonusPointsPmf(metrics.bonus / conditional, 1),
      savesPointsPmf(metrics.saves / conditional, player.positionShort),
    ]);
    return {
      fixtureId: fixture.id,
      teamId: player.teamId,
      appearanceProbability,
      reached60Probability,
      pointsWhenAppearedPmf,
      cleanSheetProbability: metrics.cleanSheetProbability,
      cleanSheetPoints: CLEAN_SHEET_POINTS[player.positionShort] ?? 0,
    };
  });
  return { player, eventId, fixtures: fixtureModels };
}
