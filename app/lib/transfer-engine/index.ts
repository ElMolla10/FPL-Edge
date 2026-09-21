export {
  DEFAULT_TRANSFER_RULES_2026_27,
  mergeTransferRules,
  exactHitCost,
  clampFreeTransfers,
  freeTransfersAfterDeadline,
  hitLabel,
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
} from "./types";

export {
  optimalSquadWeek,
  discountedSquadEp,
  buildHoldBaseline,
  applyLegsToState,
} from "./squad-ep";

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
} from "./recommend";

export {
  bestTransfersFromEngine,
  recommendationToTransfer,
  selectPrimaryEngineTransfer,
} from "./adapter";
export type { EngineTransfer } from "./adapter";
