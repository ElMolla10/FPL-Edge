import type { FplPlayer } from "./fpl";
import type { HorizonMode, RiskMode, SquadPhilosophy } from "./optimizer";
import type { SandboxState } from "./squad-comparison";
import { applySandboxTransfer, createSandboxState } from "./squad-comparison";
import { persist } from "./persistence";

// Storage shape only ever holds player IDs, never full FplPlayer blobs -- exactly the same
// discipline squadData.squadIds already uses (see savedSquad() in fpl.ts). A plan's real player
// data (price, projections, status) is always rehydrated fresh from the live pool, so a saved plan
// can never silently show stale prices or projections from whenever it was created.
export type PersistedPlanTransfer = Readonly<{ outId: number; incomingId: number }>;
// The Draft Lab settings active at save time -- not used to compute anything (the Board always
// scores every plan live, under its own current settings, for a real apples-to-apples comparison
// across rows). Kept purely so the Board can disclose when a plan's *content* was shaped by
// different settings than the ones it's currently being viewed under, the same way
// LiveDraftBuilder.tsx's own staleFields discloses a stale cached result.
export type PlanSettings = Readonly<{ horizonMode: HorizonMode; riskMode: RiskMode; philosophy: SquadPhilosophy }>;
export type PersistedPlan = Readonly<{
  id: string;
  name: string;
  createdAt: string;
  baselineSquadIds: readonly number[];
  transferHistory: readonly PersistedPlanTransfer[];
  savedUnder: PlanSettings;
}>;

// The real, approved cap -- confirmed against the existing Players-page Compare precedent
// (compare.length>=4, .compare-drawer's 4-column grid) rather than picked arbitrarily for this
// feature. Enforced both here (client) and in the /api/squad PUT handler (server), so a stale tab
// or a manual API call can't silently write more than this into the persisted row.
export const MAX_PLANS = 4;

export function createPlan(name: string, baselineSquad: readonly FplPlayer[], savedUnder: PlanSettings): PersistedPlan {
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    baselineSquadIds: baselineSquad.map(player => player.id),
    transferHistory: [],
    savedUnder,
  };
}

export type PlanHydration =
  | { status: "complete"; sandbox: SandboxState }
  | { status: "partial"; sandbox: SandboxState; reason: string }
  | { status: "failed"; reason: string };

/**
 * Turns a PersistedPlan's IDs back into a real SandboxState by resolving them against the live
 * player pool and replaying transferHistory through the existing, unmodified applySandboxTransfer
 * -- no new engine, no re-derived logic. If a baseline player ID no longer resolves, the whole plan
 * is unrecoverable (status "failed"). If a transfer step's outgoing or incoming player ID no longer
 * resolves, replay stops at that step -- applySandboxTransfer itself silently no-ops on an unknown
 * "out" id and would happily insert `undefined` for an unknown "incoming" id, so this must be
 * checked explicitly before calling it, not discovered after the fact. The plan is still returned
 * (status "partial") showing exactly as it stood immediately before the broken step, with a real,
 * specific reason the UI must surface -- never a silent truncation and never a crash.
 */
export function hydratePlanSandbox(plan: PersistedPlan, players: readonly FplPlayer[]): PlanHydration {
  const byId = new Map(players.map(player => [player.id, player]));
  const baselineSquad = plan.baselineSquadIds.map(id => byId.get(id)).filter((player): player is FplPlayer => !!player);
  if (baselineSquad.length !== plan.baselineSquadIds.length) {
    return { status: "failed", reason: "This plan's baseline squad couldn't be restored -- one or more players are no longer in the live player pool." };
  }
  let sandbox = createSandboxState(baselineSquad);
  for (let index = 0; index < plan.transferHistory.length; index++) {
    const { outId, incomingId } = plan.transferHistory[index];
    const out = sandbox.currentSquad.find(player => player.id === outId);
    const incoming = byId.get(incomingId);
    if (!out || !incoming) {
      return {
        status: "partial",
        sandbox,
        reason: `This plan's history couldn't be fully restored -- transfer ${index + 1} of ${plan.transferHistory.length} referenced a player no longer in the live pool. Showing the plan as it stood before that transfer.`,
      };
    }
    sandbox = applySandboxTransfer(sandbox, out, incoming);
  }
  return { status: "complete", sandbox };
}

/** The inverse of hydratePlanSandbox -- extracts the ID-only storage shape from a live SandboxState. */
export function dehydratePlanSandbox(plan: Pick<PersistedPlan, "id" | "name" | "createdAt" | "savedUnder">, sandbox: SandboxState): PersistedPlan {
  return {
    id: plan.id,
    name: plan.name,
    createdAt: plan.createdAt,
    baselineSquadIds: sandbox.baselineSquad.map(player => player.id),
    transferHistory: sandbox.history.map(transfer => ({ outId: transfer.out.id, incomingId: transfer.incoming.id })),
    savedUnder: plan.savedUnder,
  };
}

const PLANS_STORAGE_KEY = "fpl-edge-plans";
// Shared contract between the Board (writer, before navigating to Draft Lab) and Draft Lab (reader,
// on mount) for "load this specific plan for editing" -- a single named key so both sides reference
// the same string instead of two independently-typed magic strings.
export const LOAD_PLAN_SIGNAL_KEY = "fpl-edge-load-plan-id";

export function readPlans(): readonly PersistedPlan[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PLANS_STORAGE_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** Drop-in write path for plans -- goes through persist() so the existing 800ms-debounced
 * background sync (see persistence.ts) picks it up automatically, no new sync mechanism. */
export function writePlans(plans: readonly PersistedPlan[]): void {
  persist(PLANS_STORAGE_KEY, JSON.stringify(plans.slice(0, MAX_PLANS)));
}
