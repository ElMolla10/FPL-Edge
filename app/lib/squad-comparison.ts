import { FplPlayer } from "./fpl";
import { SquadEvaluation, SquadScores } from "./optimizer";
import { TRANSFER_ACTION_THRESHOLD, transferHitCost } from "./transfer-quality";
import { Transfer } from "./transfers";

export type DeltaState = "positive" | "negative" | "neutral";
export type ComparisonValue = { before: number; after: number; delta: number };
export type HorizonComparison = ComparisonValue & { availableGameweeks: number };
export type OfficialPick = { elementId: number; position: number; multiplier: number; isCaptain: boolean; isViceCaptain: boolean; sellingPrice?: number | null };
export type ManagerMeta = { id: number; name: string; teamName: string; overallPoints: number; overallRank: number; gameweekPoints: number; gameweekRank: number; squadValue: number | null; bank: number | null; transfersMade: number; transferCost: number; captainId: number | null; viceCaptainId: number | null; chip: string | null; event?: number; picks?: OfficialPick[] };
export type SandboxFinancialSource = "official" | "current-price-assumption";
export type SandboxFinancialContext = { baselineBank: number; baselineSellingPrices: Map<number, number>; source: SandboxFinancialSource };
export type SandboxFinances = { sellingValue: number; buyingValue: number; finalBank: number; affordable: boolean };
export type RatingComponentKey = Exclude<keyof SquadScores, "overall">;
export type RatingComponentComparison = ComparisonValue & {
  key: RatingComponentKey;
  label: string;
  higherIsBetter: boolean;
  state: DeltaState;
};

const ratingComponents: { key: RatingComponentKey; label: string; higherIsBetter: boolean }[] = [
  { key: "projectedPoints", label: "Projected points", higherIsBetter: true },
  { key: "captaincy", label: "Captaincy", higherIsBetter: true },
  { key: "fixtures", label: "Fixtures", higherIsBetter: true },
  { key: "minutesSecurity", label: "Minutes security", higherIsBetter: true },
  { key: "bench", label: "Bench", higherIsBetter: true },
  { key: "flexibility", label: "Flexibility", higherIsBetter: true },
  { key: "value", label: "Value", higherIsBetter: true },
  // optimizer.scores.risk is explicitly a resilience score (100 is safest), not raw risk.
  { key: "risk", label: "Risk resilience", higherIsBetter: true },
];

export type SquadComparison = {
  beforeSquad: FplPlayer[];
  afterSquad: FplPlayer[];
  beforeEvaluation: SquadEvaluation;
  afterEvaluation: SquadEvaluation;
  rating: ComparisonValue;
  objective: ComparisonValue;
  expectedPoints: {
    nextGameweek: HorizonComparison;
    nextThree: HorizonComparison;
    nextFive: HorizonComparison;
  };
  ratingComponents: RatingComponentComparison[];
  structural: {
    formation?: { before: string; after: string };
    captain?: { before: FplPlayer; after: FplPlayer };
    viceCaptain?: { before: FplPlayer; after: FplPlayer };
    enteredXi: FplPlayer[];
    exitedXi: FplPlayer[];
    benchOrder?: { before: FplPlayer[]; after: FplPlayer[] };
    bank?: ComparisonValue;
    newWarnings: string[];
    resolvedWarnings: string[];
  };
};

const valueComparison = (before: number, after: number): ComparisonValue => ({ before, after, delta: after - before });
const money = (value: number) => Math.round(value * 10) / 10;

export function sellingPricesFor(meta: ManagerMeta | null): Map<number, number> {
  return new Map((meta?.picks ?? []).flatMap(pick => pick.sellingPrice !== null && pick.sellingPrice !== undefined ? [[pick.elementId, pick.sellingPrice] as [number, number]] : []));
}

export function deriveSandboxFinancialContext(baselineSquad: FplPlayer[], budget: number, manager: ManagerMeta | null): SandboxFinancialContext {
  const currentPriceAssumption = (): SandboxFinancialContext => ({
    baselineBank: money(Math.max(0, budget - baselineSquad.reduce((sum, player) => sum + player.price, 0))),
    baselineSellingPrices: new Map(baselineSquad.map(player => [player.id, player.price])),
    source: "current-price-assumption",
  });
  const picks = manager?.picks ?? [];
  const baselineIds = new Set(baselineSquad.map(player => player.id));
  const pickIds = new Set(picks.map(pick => pick.elementId));
  const exactSquad = baselineSquad.length === 15 && picks.length === 15 && baselineIds.size === 15 && pickIds.size === 15 && [...baselineIds].every(id => pickIds.has(id));
  const completePrices = picks.every(pick => typeof pick.sellingPrice === "number" && Number.isFinite(pick.sellingPrice) && pick.sellingPrice >= 0);
  if (!exactSquad || !completePrices || typeof manager?.bank !== "number" || !Number.isFinite(manager.bank) || manager.bank < 0) return currentPriceAssumption();
  return { baselineBank: money(manager.bank), baselineSellingPrices: sellingPricesFor(manager), source: "official" };
}

export function calculateSandboxFinances(context: SandboxFinancialContext, baselineSquad: FplPlayer[], proposedSquad: FplPlayer[]): SandboxFinances {
  const baselineIds = new Set(baselineSquad.map(player => player.id));
  const proposedIds = new Set(proposedSquad.map(player => player.id));
  const sellingValue = money(baselineSquad.filter(player => !proposedIds.has(player.id)).reduce((sum, player) => sum + (context.baselineSellingPrices.get(player.id) ?? player.price), 0));
  const buyingValue = money(proposedSquad.filter(player => !baselineIds.has(player.id)).reduce((sum, player) => sum + player.price, 0));
  const finalBank = money(context.baselineBank + sellingValue - buyingValue);
  return { sellingValue, buyingValue, finalBank, affordable: finalBank >= -.001 };
}

export function sandboxFinancialSourceLabel(source: SandboxFinancialSource): string {
  return source === "official" ? "Official FPL bank and selling prices" : "Current-price assumption";
}

function pointsComparison(before: SquadEvaluation, after: SquadEvaluation, requestedGameweeks: number): HorizonComparison {
  const availableGameweeks = Math.min(requestedGameweeks, before.weeks.length, after.weeks.length);
  const beforePoints = before.weeks.slice(0, availableGameweeks).reduce((sum, week) => sum + week.points, 0);
  const afterPoints = after.weeks.slice(0, availableGameweeks).reduce((sum, week) => sum + week.points, 0);
  return { ...valueComparison(beforePoints, afterPoints), availableGameweeks };
}

function sameOrder(before: FplPlayer[], after: FplPlayer[]): boolean {
  return before.length === after.length && before.every((player, index) => player.id === after[index]?.id);
}

export function compareSquads(
  beforeSquad: FplPlayer[],
  afterSquad: FplPlayer[],
  beforeEvaluation: SquadEvaluation,
  afterEvaluation: SquadEvaluation,
  beforePointsEvaluation = beforeEvaluation,
  afterPointsEvaluation = afterEvaluation,
): SquadComparison {
  const beforeWeek = beforeEvaluation.weeks[0];
  const afterWeek = afterEvaluation.weeks[0];
  const beforeXiIds = new Set(beforeWeek?.xi.map(player => player.id) ?? []);
  const afterXiIds = new Set(afterWeek?.xi.map(player => player.id) ?? []);
  const enteredXi = (afterWeek?.xi ?? []).filter(player => !beforeXiIds.has(player.id));
  const exitedXi = (beforeWeek?.xi ?? []).filter(player => !afterXiIds.has(player.id));
  const beforeBench = beforeWeek?.bench ?? [];
  const afterBench = afterWeek?.bench ?? [];
  const bank = valueComparison(beforeEvaluation.bank, afterEvaluation.bank);

  return {
    beforeSquad,
    afterSquad,
    beforeEvaluation,
    afterEvaluation,
    rating: valueComparison(beforeEvaluation.scores.overall, afterEvaluation.scores.overall),
    objective: valueComparison(beforeEvaluation.objective, afterEvaluation.objective),
    expectedPoints: {
      nextGameweek: pointsComparison(beforePointsEvaluation, afterPointsEvaluation, 1),
      nextThree: pointsComparison(beforePointsEvaluation, afterPointsEvaluation, 3),
      nextFive: pointsComparison(beforePointsEvaluation, afterPointsEvaluation, 5),
    },
    ratingComponents: ratingComponents.map(component => {
      const values = valueComparison(beforeEvaluation.scores[component.key], afterEvaluation.scores[component.key]);
      const semanticDelta = component.higherIsBetter ? values.delta : -values.delta;
      return { ...component, ...values, state: semanticDelta > 0 ? "positive" : semanticDelta < 0 ? "negative" : "neutral" };
    }),
    structural: {
      formation: beforeWeek && afterWeek && beforeWeek.formation !== afterWeek.formation ? { before: beforeWeek.formation, after: afterWeek.formation } : undefined,
      captain: beforeWeek && afterWeek && beforeWeek.captain.id !== afterWeek.captain.id ? { before: beforeWeek.captain, after: afterWeek.captain } : undefined,
      viceCaptain: beforeWeek && afterWeek && beforeWeek.vice.id !== afterWeek.vice.id ? { before: beforeWeek.vice, after: afterWeek.vice } : undefined,
      enteredXi,
      exitedXi,
      benchOrder: !sameOrder(beforeBench, afterBench) ? { before: beforeBench, after: afterBench } : undefined,
      bank: Math.abs(bank.delta) > .0001 ? bank : undefined,
      newWarnings: afterEvaluation.warnings.filter(warning => !beforeEvaluation.warnings.includes(warning)),
      resolvedWarnings: beforeEvaluation.warnings.filter(warning => !afterEvaluation.warnings.includes(warning)),
    },
  };
}

export type SandboxTransfer = {
  out: FplPlayer;
  incoming: FplPlayer;
  beforeSquad: FplPlayer[];
  afterSquad: FplPlayer[];
};

export type SandboxState = {
  baselineSquad: FplPlayer[];
  currentSquad: FplPlayer[];
  history: SandboxTransfer[];
  financialContext?: SandboxFinancialContext;
};

export function createSandboxState(squad: FplPlayer[], financialContext?: SandboxFinancialContext): SandboxState {
  return { baselineSquad: [...squad], currentSquad: [...squad], history: [], financialContext };
}

export function requiredTransferCount(baselineSquad: FplPlayer[], currentSquad: FplPlayer[]): number {
  const currentIds = new Set(currentSquad.map(player => player.id));
  return baselineSquad.reduce((count, player) => count + (currentIds.has(player.id) ? 0 : 1), 0);
}

export function applySandboxTransfer(state: SandboxState, out: FplPlayer, incoming: FplPlayer): SandboxState {
  if (!state.currentSquad.some(player => player.id === out.id)) return state;
  const beforeSquad = [...state.currentSquad];
  const afterSquad = beforeSquad.map(player => player.id === out.id ? incoming : player);
  return {
    baselineSquad: state.baselineSquad,
    currentSquad: afterSquad,
    history: [...state.history, { out, incoming, beforeSquad, afterSquad }],
    financialContext: state.financialContext,
  };
}

export function undoSandboxTransfer(state: SandboxState): SandboxState {
  const latest = state.history.at(-1);
  if (!latest) return state;
  return { baselineSquad: state.baselineSquad, currentSquad: [...latest.beforeSquad], history: state.history.slice(0, -1), financialContext: state.financialContext };
}

export function resetSandbox(state: SandboxState): SandboxState {
  return { baselineSquad: state.baselineSquad, currentSquad: [...state.baselineSquad], history: [], financialContext: state.financialContext };
}

export type SandboxComparisonResult = {
  latest: SquadComparison;
  cumulative: SquadComparison;
  sandboxActionCount: number;
  requiredTransferCount: number;
  previousRequiredTransferCount: number;
  financial?: {
    source: SandboxFinancialSource;
    latest: ComparisonValue;
    cumulative: ComparisonValue;
  };
};

export function evaluateSandbox(
  state: SandboxState,
  evaluate: (squad: FplPlayer[]) => SquadEvaluation,
  evaluateExpectedPoints: (squad: FplPlayer[]) => SquadEvaluation = evaluate,
): SandboxComparisonResult | null {
  const latestTransfer = state.history.at(-1);
  if (!latestTransfer) return null;
  const afterEvaluation = evaluate(state.currentSquad);
  const latestBeforeEvaluation = evaluate(latestTransfer.beforeSquad);
  const baselineEvaluation = state.history.length === 1 ? latestBeforeEvaluation : evaluate(state.baselineSquad);
  const sameEvaluator = evaluateExpectedPoints === evaluate;
  const afterPointsEvaluation = sameEvaluator ? afterEvaluation : evaluateExpectedPoints(state.currentSquad);
  const latestBeforePointsEvaluation = sameEvaluator ? latestBeforeEvaluation : evaluateExpectedPoints(latestTransfer.beforeSquad);
  const baselinePointsEvaluation = state.history.length === 1 ? latestBeforePointsEvaluation : sameEvaluator ? baselineEvaluation : evaluateExpectedPoints(state.baselineSquad);
  let latest = compareSquads(latestTransfer.beforeSquad, state.currentSquad, latestBeforeEvaluation, afterEvaluation, latestBeforePointsEvaluation, afterPointsEvaluation);
  let cumulative = compareSquads(state.baselineSquad, state.currentSquad, baselineEvaluation, afterEvaluation, baselinePointsEvaluation, afterPointsEvaluation);
  let financial: SandboxComparisonResult["financial"];
  if (state.financialContext) {
    const beforeFinance = calculateSandboxFinances(state.financialContext, state.baselineSquad, latestTransfer.beforeSquad);
    const afterFinance = calculateSandboxFinances(state.financialContext, state.baselineSquad, state.currentSquad);
    const latestBank = valueComparison(beforeFinance.finalBank, afterFinance.finalBank);
    const cumulativeBank = valueComparison(state.financialContext.baselineBank, afterFinance.finalBank);
    latest = { ...latest, structural: { ...latest.structural, bank: Math.abs(latestBank.delta) > .0001 ? latestBank : undefined } };
    cumulative = { ...cumulative, structural: { ...cumulative.structural, bank: Math.abs(cumulativeBank.delta) > .0001 ? cumulativeBank : undefined } };
    financial = { source: state.financialContext.source, latest: latestBank, cumulative: cumulativeBank };
  }
  return {
    latest,
    cumulative,
    sandboxActionCount: state.history.length,
    requiredTransferCount: requiredTransferCount(state.baselineSquad, state.currentSquad),
    previousRequiredTransferCount: requiredTransferCount(state.baselineSquad, latestTransfer.beforeSquad),
    financial,
  };
}

export type SandboxEconomics = {
  sandboxActionCount: number;
  requiredTransferCount: number;
  previousRequiredTransferCount: number;
  freeTransfers: number;
  cumulativeHitCost: number;
  previousHitCost: number;
  incrementalHitChange: number;
  grossFiveWeekChange: number;
  netFiveWeekChange: number;
  latestGrossFiveWeekChange: number;
  latestNetFiveWeekChange: number;
  cumulativeWorthwhileAfterHits: boolean;
  latestWorthwhileAfterHits: boolean;
};

export function sandboxEconomics(comparison: SandboxComparisonResult, freeTransfers: number): SandboxEconomics {
  const cumulativeHitCost = transferHitCost(comparison.requiredTransferCount, freeTransfers);
  const previousHitCost = transferHitCost(comparison.previousRequiredTransferCount, freeTransfers);
  const incrementalHitChange = cumulativeHitCost - previousHitCost;
  const grossFiveWeekChange = comparison.cumulative.expectedPoints.nextFive.delta;
  const latestGrossFiveWeekChange = comparison.latest.expectedPoints.nextFive.delta;
  const netFiveWeekChange = grossFiveWeekChange - cumulativeHitCost;
  const latestNetFiveWeekChange = latestGrossFiveWeekChange - incrementalHitChange;
  return {
    sandboxActionCount: comparison.sandboxActionCount,
    requiredTransferCount: comparison.requiredTransferCount,
    previousRequiredTransferCount: comparison.previousRequiredTransferCount,
    freeTransfers,
    cumulativeHitCost,
    previousHitCost,
    incrementalHitChange,
    grossFiveWeekChange,
    netFiveWeekChange,
    latestGrossFiveWeekChange,
    latestNetFiveWeekChange,
    cumulativeWorthwhileAfterHits: netFiveWeekChange >= TRANSFER_ACTION_THRESHOLD,
    latestWorthwhileAfterHits: latestNetFiveWeekChange >= TRANSFER_ACTION_THRESHOLD,
  };
}

type ReasoningTransfer = Pick<Transfer,
  "out" | "incoming" | "expectedMinutesOut" | "expectedMinutesIn" | "startProbOut" | "startProbIn" | "qualityStatus"
>;

const signed = (value: number, places = 1) => `${value >= 0 ? "+" : ""}${value.toFixed(places)}`;

export function buildSandboxReasoning(
  comparison: SquadComparison,
  transfer: ReasoningTransfer,
  economics: SandboxEconomics,
): string[] {
  const positiveComponents = comparison.ratingComponents.filter(component => component.state === "positive").sort((a, b) => b.delta - a.delta);
  const negativeComponents = comparison.ratingComponents.filter(component => component.state === "negative").sort((a, b) => a.delta - b.delta);
  const reasons: string[] = [];
  const five = comparison.expectedPoints.nextFive;

  if (five.delta > .05) reasons.push(`${transfer.incoming.name} improves the ${five.availableGameweeks}-gameweek squad projection by ${signed(five.delta)} points${positiveComponents[0] ? `, led by ${positiveComponents[0].label.toLowerCase()} (${signed(positiveComponents[0].delta, 0)}/100)` : ""}.`);
  else if (positiveComponents[0]) reasons.push(`The strongest positive driver is ${positiveComponents[0].label.toLowerCase()}, improving by ${signed(positiveComponents[0].delta, 0)}/100.`);
  else reasons.push(`The swap does not improve a projected-points horizon or /100 rating component.`);

  if (five.delta < -.05) reasons.push(`The main trade-off is that it reduces the ${five.availableGameweeks}-gameweek squad projection by ${Math.abs(five.delta).toFixed(1)} points${negativeComponents[0] ? ` and lowers ${negativeComponents[0].label.toLowerCase()} by ${Math.abs(negativeComponents[0].delta).toFixed(0)}/100` : ""}.`);
  else if (negativeComponents[0]) reasons.push(`The main trade-off is that it reduces ${negativeComponents[0].label.toLowerCase()} by ${Math.abs(negativeComponents[0].delta).toFixed(0)}/100.`);

  const incomingInXi = comparison.afterEvaluation.weeks[0]?.xi.some(player => player.id === transfer.incoming.id) ?? false;
  const captainWeeks = comparison.afterEvaluation.weeks.filter(week => week.captain.id === transfer.incoming.id).map(week => `GW${week.eventId}`);
  reasons.push(`${transfer.incoming.name} ${incomingInXi ? "enters the starting XI" : "remains outside the starting XI"}${captainWeeks.length ? ` and becomes the preferred captain in ${captainWeeks.join(", ")}` : ""}.`);

  const roleConcern = transfer.expectedMinutesIn < transfer.expectedMinutesOut || transfer.startProbIn < transfer.startProbOut;
  reasons.push(`Role security: ${Math.round(transfer.expectedMinutesIn)} expected minutes and ${Math.round(transfer.startProbIn * 100)}% start probability${roleConcern ? `, down from ${Math.round(transfer.expectedMinutesOut)} minutes and ${Math.round(transfer.startProbOut * 100)}%; monitor the minutes concern` : "; no new minutes/start-probability concern versus the outgoing player"}.`);

  const status = transfer.qualityStatus[0].toUpperCase() + transfer.qualityStatus.slice(1);
  reasons.push(`${status}: the shared transfer-quality gate ${transfer.qualityStatus === "actionable" ? "supports acting" : transfer.qualityStatus === "watchlist" ? "supports monitoring rather than forcing the move" : "blocks the move"}.`);
  const hitEffect = economics.incrementalHitChange > 0
    ? `${economics.incrementalHitChange} additional points of hits`
    : economics.incrementalHitChange < 0
      ? `avoiding ${Math.abs(economics.incrementalHitChange)} points of previously modelled hits`
      : "no additional hit";
  reasons.push(`After ${hitEffect}, the latest action's ${economics.latestNetFiveWeekChange.toFixed(1)}-point net change is ${economics.latestWorthwhileAfterHits ? "worthwhile after hits" : "not worthwhile after hits"} against the ${TRANSFER_ACTION_THRESHOLD.toFixed(1)}-point action threshold.`);
  return reasons;
}
