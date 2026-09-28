/**
 * Off-main-thread "Build best squad" search. Pure execute helpers + message protocol.
 * Progress: three labelled steps with coarse % (cancel = requestId supersession).
 * Do not redesign worker architecture here.
 */
import type { FplData, FplPlayer } from "./fpl";
import { futureEvents } from "./fpl";
import { horizonModeLabel } from "./horizon-labels";
import {
  createOptimizer,
  type HorizonMode,
  type RiskMode,
  type SquadEvaluation,
  type SquadPhilosophy,
} from "./optimizer";

export type DraftLabResultMode = "Pure Optimum" | "Practical Upgrade" | "Keep Core";

export type DraftLabOptimizeRequest = {
  type: "optimize";
  requestId: number;
  data: FplData;
  horizonMode: HorizonMode;
  riskMode: RiskMode;
  philosophy: SquadPhilosophy;
  resultMode: DraftLabResultMode;
  squad: FplPlayer[];
  pinnedIds: number[];
  practicalMaxChanges: number;
  keepCoreMaxChanges: number;
};

export type DraftLabOptimizeProgress = {
  type: "progress";
  requestId: number;
  phase: "started" | "searching" | "finished";
  /** 1-based step within the three-phase Build best squad run. */
  step: number;
  /** Total progress steps for cancel/progress UX. */
  totalSteps: number;
  /** Coarse percent 0–100 for progress chrome. */
  percent: number;
  detail: string;
};

const DRAFT_LAB_PROGRESS_TOTAL = 3;

function progressPayload(
  requestId: number,
  phase: DraftLabOptimizeProgress["phase"],
  detail: string,
): DraftLabOptimizeProgress {
  const meta =
    phase === "started"
      ? { step: 1, percent: 8 }
      : phase === "searching"
        ? { step: 2, percent: 45 }
        : { step: 3, percent: 100 };
  return {
    type: "progress",
    requestId,
    phase,
    step: meta.step,
    totalSteps: DRAFT_LAB_PROGRESS_TOTAL,
    percent: meta.percent,
    detail: `Step ${meta.step}/${DRAFT_LAB_PROGRESS_TOTAL} · ${detail}`,
  };
}


export type DraftLabOptimizeResult = {
  type: "result";
  requestId: number;
  squad: FplPlayer[];
  evaluation: SquadEvaluation;
  nearMisses: { player: FplPlayer; difference: number; reason: string }[];
  explanations: Record<number, string[]>;
  modeLabel: string;
  durationMs: number;
};

export type DraftLabOptimizeError = {
  type: "error";
  requestId: number;
  reason: string;
};

export type DraftLabWorkerResponse = DraftLabOptimizeProgress | DraftLabOptimizeResult | DraftLabOptimizeError;

export function executeDraftLabOptimizeRequest(
  request: DraftLabOptimizeRequest,
  onProgress?: (progress: DraftLabOptimizeProgress) => void,
  now: () => number = () => performance.now(),
): DraftLabOptimizeResult | DraftLabOptimizeError {
  const started = now();
  try {
    const nextGwId = futureEvents(request.data, 1)[0]?.id ?? null;
    // Internal HorizonMode id may stay "GW1 Attack"; user-facing/debug labels use real next GW.
    const horizonLabel = horizonModeLabel(request.horizonMode, nextGwId);
    onProgress?.(
      progressPayload(request.requestId, "started", `Starting ${request.resultMode} (${horizonLabel})…`),
    );
    const optimizer = createOptimizer(request.data, request.horizonMode, request.riskMode, request.philosophy);
    onProgress?.(
      progressPayload(request.requestId, "searching", `Searching legal squads (${request.resultMode})…`),
    );
    if (request.resultMode === "Practical Upgrade" || request.resultMode === "Keep Core") {
      const maxChanges =
        request.resultMode === "Keep Core" ? request.keepCoreMaxChanges : request.practicalMaxChanges;
      const lockedPlayerIds =
        request.resultMode === "Keep Core" ? new Set(request.pinnedIds) : new Set<number>();
      const result = optimizer.optimizeConstrained(request.squad, { maxChanges, lockedPlayerIds });
      const modeLabel =
        request.resultMode === "Keep Core"
          ? `Keep Core protected ${request.pinnedIds.length} pinned player${request.pinnedIds.length === 1 ? "" : "s"} and searched up to ${maxChanges} simultaneous changes among the rest (${result.changes.length} applied).`
          : `Practical Upgrade searched up to ${maxChanges} simultaneous changes from your current squad (${result.changes.length} applied).`;
      onProgress?.(progressPayload(request.requestId, "finished", "Search complete."));
      return {
        type: "result",
        requestId: request.requestId,
        squad: result.squad,
        evaluation: result.evaluation,
        nearMisses: [],
        explanations: optimizer.explainSquad(result.squad),
        modeLabel,
        durationMs: now() - started,
      };
    }
    const result = optimizer.optimize();
    const modeLabel = `${horizonLabel} · ${request.riskMode} · ${request.philosophy} squad built with a coordinated near-exact search.`;
    onProgress?.(progressPayload(request.requestId, "finished", "Search complete."));
    return {
      type: "result",
      requestId: request.requestId,
      squad: result.squad,
      evaluation: result.evaluation,
      nearMisses: result.nearMisses,
      explanations: result.explanations,
      modeLabel,
      durationMs: now() - started,
    };
  } catch (error) {
    return {
      type: "error",
      requestId: request.requestId,
      reason: error instanceof Error ? error.message : "Build best squad failed unexpectedly.",
    };
  }
}
