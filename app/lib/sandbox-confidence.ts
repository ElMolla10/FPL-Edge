import type { FplPlayer } from "./fpl";
import type { SandboxEconomics, SandboxState } from "./squad-comparison";

export type SandboxSquadConfidenceComparison = {
  baselineSquad: readonly FplPlayer[];
  candidateSquad: readonly FplPlayer[];
  candidateAdditionalHitCost: number;
};

export type SandboxConfidenceComparisons = {
  latest: SandboxSquadConfidenceComparison;
  cumulative: SandboxSquadConfidenceComparison;
};

export function deriveSandboxConfidenceComparisons(
  sandbox: SandboxState,
  economics: Pick<SandboxEconomics, "incrementalHitChange" | "cumulativeHitCost">,
): SandboxConfidenceComparisons | null {
  const latest = sandbox.history.at(-1);
  if (!latest) return null;
  return {
    latest: {
      baselineSquad: latest.beforeSquad,
      candidateSquad: sandbox.currentSquad,
      candidateAdditionalHitCost: economics.incrementalHitChange,
    },
    cumulative: {
      baselineSquad: sandbox.baselineSquad,
      candidateSquad: sandbox.currentSquad,
      candidateAdditionalHitCost: economics.cumulativeHitCost,
    },
  };
}

