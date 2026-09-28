/**
 * Off-main-thread "Build best squad" search. Pure execute helpers + message protocol.
 * Progress is coarse (started / finished); cancel is requestId supersession.
 */
import type { FplData, FplPlayer } from "./fpl";
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
  detail: string;
};

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
    onProgress?.({
      type: "progress",
      requestId: request.requestId,
      phase: "started",
      detail: `Starting ${request.resultMode}…`,
    });
    const optimizer = createOptimizer(request.data, request.horizonMode, request.riskMode, request.philosophy);
    onProgress?.({
      type: "progress",
      requestId: request.requestId,
      phase: "searching",
      detail: "Searching legal squads…",
    });
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
      onProgress?.({
        type: "progress",
        requestId: request.requestId,
        phase: "finished",
        detail: "Search complete.",
      });
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
    const modeLabel = `${request.horizonMode} · ${request.riskMode} · ${request.philosophy} squad built with a coordinated near-exact search.`;
    onProgress?.({
      type: "progress",
      requestId: request.requestId,
      phase: "finished",
      detail: "Search complete.",
    });
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
