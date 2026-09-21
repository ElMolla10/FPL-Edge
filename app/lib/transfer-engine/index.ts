export {
  DEFAULT_TRANSFER_RULES_2026_27,
  OVERVIEW_TRANSFER_RULES,
  mergeTransferRules,
  exactHitCost,
  clampFreeTransfers,
  freeTransfersAfterDeadline,
  hitLabel,
  thresholdsForHit,
} from "./rules";
export type { TransferEngineRules } from "./rules";

export type {
  TransferClassification,
  TeamState,
  SquadWeekLineup,
  HoldBaseline,
  TransferLeg,
  TransferNetEV,
  TransferRecommendation,
  TransferRecommendationCard,
  TransferEngineResult,
  TransferEngineOptions,
  BestDecision,
  RiskDriver,
} from "./types";

export {
  optimalSquadWeek,
  discountedSquadEp,
  buildHoldBaseline,
  applyLegsToState,
} from "./squad-ep";

export {
  bestFuturePlan,
  waitOneGwThenTransferPlan,
  summarizePlanPath,
  createPlanBudget,
  budgetOk,
  chargeBudget,
} from "./plan";
export type { FuturePlan, FuturePlanStep, CandidatePool, PlanBudget } from "./plan";

export {
  isLegalSingleTransfer,
  isLegalMultiTransfer,
  sellingPriceFor,
} from "./legality";
export type { LegalityReason, LegalityResult } from "./legality";

export {
  classifyTransfer,
  buildRecommendationCard,
  classificationToLegacyQuality,
} from "./classify";

export {
  createTeamState,
  recommendTransfers,
  recommendationsToJson,
  diversifyRecommendations,
  groupTransferFamilies,
} from "./recommend";

export {
  bestTransfersFromEngine,
  recommendationToTransfer,
  selectPrimaryEngineTransfer,
  selectBestDecisionTransfer,
} from "./adapter";
export type { EngineTransfer } from "./adapter";
