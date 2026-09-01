"use client";

import { useMemo, useState } from "react";
import type { FplData } from "../lib/fpl";
import { buildSandboxReasoning, DeltaState, ManagerMeta, sandboxEconomics, sandboxFinancialSourceLabel, SandboxComparisonResult, SquadComparison } from "../lib/squad-comparison";
import type { SandboxState } from "../lib/squad-comparison";
import { Transfer } from "../lib/transfers";
import DecisionConfidencePanel from "./DecisionConfidencePanel";
import RankEstimatePanel from "./RankEstimatePanel";
import TransferBreakdown from "./TransferBreakdown";
import { useSandboxDecisionConfidence } from "./useSandboxDecisionConfidence";
import { usePopulationPercentiles } from "./usePopulationPercentiles";
import { estimateRankDistribution } from "../lib/rank-estimate-core";

const signed = (value: number, places = 1) => `${value >= 0 ? "+" : ""}${value.toFixed(places)}`;
const stateFor = (value: number) => value > .0001 ? "positive" : value < -.0001 ? "negative" : "neutral";

export function ValueTransition({ before, after, delta, places = 1, suffix = "", state }: { before: number; after: number; delta: number; places?: number; suffix?: string; state?: DeltaState }) {
  return <b className={state ?? stateFor(delta)}>{before.toFixed(places)} <i>→</i> {after.toFixed(places)} <em>({signed(delta, places)}{suffix})</em></b>;
}

function HorizonRows({ comparison }: { comparison: SquadComparison }) {
  const rows = [
    { label: "Next gameweek", value: comparison.expectedPoints.nextGameweek },
    { label: `Next ${comparison.expectedPoints.nextThree.availableGameweeks} available gameweek${comparison.expectedPoints.nextThree.availableGameweeks === 1 ? "" : "s"}`, value: comparison.expectedPoints.nextThree },
    { label: `Next ${comparison.expectedPoints.nextFive.availableGameweeks} available gameweek${comparison.expectedPoints.nextFive.availableGameweeks === 1 ? "" : "s"}`, value: comparison.expectedPoints.nextFive },
  ];
  return <div className="sandbox-horizon-rows">{rows.map(row => <article key={row.label}><span>{row.label}</span><ValueTransition {...row.value} /></article>)}</div>;
}

function StructuralChanges({ comparison, label }: { comparison: SquadComparison; label: string }) {
  const changes = comparison.structural;
  const hasChanges = changes.formation || changes.captain || changes.viceCaptain || changes.enteredXi.length || changes.exitedXi.length || changes.benchOrder || changes.bank || changes.newWarnings.length || changes.resolvedWarnings.length;
  return <section className="sandbox-structure-card"><span>{label}</span>{hasChanges ? <div>
    {changes.formation && <p><b>Formation</b> {changes.formation.before} → {changes.formation.after}</p>}
    {changes.captain && <p><b>Captain</b> {changes.captain.before.name} → {changes.captain.after.name}</p>}
    {changes.viceCaptain && <p><b>Vice-captain</b> {changes.viceCaptain.before.name} → {changes.viceCaptain.after.name}</p>}
    {changes.enteredXi.map(player => <p className="positive" key={`in-${player.id}`}><b>Into XI</b> {player.name}</p>)}
    {changes.exitedXi.map(player => <p className="negative" key={`out-${player.id}`}><b>Out of XI</b> {player.name}</p>)}
    {changes.benchOrder && <p><b>Bench order</b> {changes.benchOrder.before.map(player => player.name).join(" · ")} → {changes.benchOrder.after.map(player => player.name).join(" · ")}</p>}
    {changes.bank && <p><b>Bank</b> £{changes.bank.before.toFixed(1)}m → £{changes.bank.after.toFixed(1)}m ({signed(changes.bank.delta)}m)</p>}
    {changes.newWarnings.map(warning => <p className="negative" key={`new-${warning}`}><b>New warning</b> {warning}</p>)}
    {changes.resolvedWarnings.map(warning => <p className="positive" key={`resolved-${warning}`}><b>Resolved</b> {warning}</p>)}
  </div> : <p>No structural changes.</p>}</section>;
}

export type SandboxConfidenceInput = {
  data: FplData;
  futureEventIds: readonly number[];
  sandbox: SandboxState;
  settingsKey: string;
};

function SandboxDecisionConfidenceBlocks({ input, comparison, freeTransfers, managerMeta }: {
  input: SandboxConfidenceInput;
  comparison: SandboxComparisonResult;
  freeTransfers: number;
  managerMeta: ManagerMeta | null;
}) {
  const confidence = useSandboxDecisionConfidence({ ...input, comparison, freeTransfers });
  const populationPercentiles = usePopulationPercentiles();
  const economics = sandboxEconomics(comparison, freeTransfers);
  // Rank estimate is scoped to CUMULATIVE only, not latest: both compare the same current sandbox
  // squad, but "latest" only accounts for the incremental hit change from the most recent swap --
  // if earlier sandbox transfers also cost hits this session, that would understate the true cost
  // a real projected rank needs. Cumulative's hit cost is the real total across the whole session.
  const cumulativeRankEstimate = useMemo(() => {
    if (populationPercentiles === null) return null;
    if (!managerMeta) return { status: "unavailable" as const, reason: "Connect your official FPL team to see a rank estimate." };
    if (confidence.cumulative.status !== "available") return null;
    return estimateRankDistribution({
      candidateScenarioTotals: confidence.cumulative.result.candidateScenarioTotals,
      candidateAdditionalHitCost: economics.cumulativeHitCost,
      currentRealTotal: managerMeta.overallPoints,
      currentRealRank: managerMeta.overallRank,
      horizonWeeks: confidence.cumulative.result.availableGameweeks,
      horizonTier: confidence.cumulative.result.horizonTier,
      populationPercentiles,
    });
  }, [populationPercentiles, managerMeta, confidence.cumulative, economics.cumulativeHitCost]);
  return <section className="sandbox-decision-confidence" aria-label="Decision Confidence">
    <header><span>DECISION CONFIDENCE</span><h3>Modeled outcomes, separate from the transfer-quality gate</h3><p>These deterministic scenario frequencies compare frozen optimizer plans. They do not change transfer ordering or the /100 rating.</p></header>
    <div>
      <DecisionConfidencePanel title="Latest transfer confidence" state={confidence.latest} candidateLabel="Make transfer" baselineLabel="Keep previous squad" metricDirection="Current sandbox squad minus previous squad" metricLabel="latest sandbox delta" />
      <DecisionConfidencePanel title="Cumulative sandbox confidence" state={confidence.cumulative} candidateLabel="Make transfers" baselineLabel="Keep baseline squad" metricDirection="Current sandbox squad minus original baseline" metricLabel="cumulative sandbox delta" />
    </div>
    <RankEstimatePanel title="Estimated rank if your whole sandbox session plays out" result={cumulativeRankEstimate} />
  </section>;
}

export default function SandboxImpactPanel({ comparison, latestTransfer, freeTransfers, onUndo, onReset, confidenceInput, managerMeta = null }: {
  comparison: SandboxComparisonResult;
  latestTransfer: Transfer;
  freeTransfers: number;
  onUndo: () => void;
  onReset: () => void;
  confidenceInput?: SandboxConfidenceInput;
  managerMeta?: ManagerMeta | null;
}) {
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const { latest, cumulative } = comparison;
  const economics = sandboxEconomics(comparison, freeTransfers);
  const reasoning = buildSandboxReasoning(latest, latestTransfer, economics);
  const status = latestTransfer.qualityStatus === "actionable" ? "Actionable" : latestTransfer.qualityStatus === "watchlist" ? "Watchlist" : "Blocked";
  const incrementalHitCopy = economics.incrementalHitChange > 0
    ? `+${economics.incrementalHitChange} pts`
    : economics.incrementalHitChange < 0
      ? `−${Math.abs(economics.incrementalHitChange)} pts avoided`
      : "No change";
  const financialSource = comparison.financial?.source ?? "current-price-assumption";
  const latestBank = comparison.financial?.latest ?? {
    before: Math.max(0, latest.beforeEvaluation.bank),
    after: Math.max(0, latest.afterEvaluation.bank),
    delta: Math.max(0, latest.afterEvaluation.bank) - Math.max(0, latest.beforeEvaluation.bank),
  };

  return <section className="sandbox-impact-panel">
    <header className="sandbox-impact-head">
      <div><span>TRANSFER SANDBOX · LATEST TRANSFER</span><h2>{latestTransfer.out.name} <i>→</i> {latestTransfer.incoming.name}</h2><p>Latest impact and cumulative change from the squad you entered the sandbox with.</p></div>
      <div className="sandbox-head-actions"><div className="sandbox-quality-gate"><small>Transfer quality gate</small><strong className={latestTransfer.qualityStatus}>{status}</strong></div><button type="button" onClick={onUndo}>Undo last transfer</button><button type="button" onClick={onReset}>Reset all sandbox transfers</button></div>
    </header>

    <div className="sandbox-rating-heroes">
      <article><span>Overall team rating · latest</span><ValueTransition {...latest.rating} places={0} suffix="/100" /></article>
      <article><span>Overall team rating · since baseline</span><ValueTransition {...cumulative.rating} places={0} suffix="/100" /></article>
      <article className="secondary"><span>Risk-adjusted objective · latest</span><ValueTransition {...latest.objective} /></article>
    </div>

    <div className="sandbox-comparison-columns">
      <section><h3>Latest transfer expected points</h3><HorizonRows comparison={latest} /></section>
      <section><h3>Cumulative expected points</h3><HorizonRows comparison={cumulative} /></section>
    </div>

    <section className="sandbox-rating-breakdown">
      <header><span>RATING BREAKDOWN</span><b>LATEST TRANSFER</b><b>SINCE BASELINE</b></header>
      {latest.ratingComponents.map((row, index) => <article key={row.key}>
        <span>{row.label}<small>/100 · higher is better</small></span>
        <ValueTransition before={row.before} after={row.after} delta={row.delta} state={row.state} places={0} />
        <ValueTransition before={cumulative.ratingComponents[index].before} after={cumulative.ratingComponents[index].after} delta={cumulative.ratingComponents[index].delta} state={cumulative.ratingComponents[index].state} places={0} />
      </article>)}
    </section>

    <div className="sandbox-comparison-columns sandbox-structure-grid">
      <StructuralChanges comparison={latest} label="LATEST STRUCTURAL CHANGES" />
      <StructuralChanges comparison={cumulative} label="CUMULATIVE STRUCTURAL CHANGES" />
    </div>

    {confidenceInput && <SandboxDecisionConfidenceBlocks input={confidenceInput} comparison={comparison} freeTransfers={freeTransfers} managerMeta={managerMeta} />}

    <section className="sandbox-economics">
      <header><span>TRANSFER ECONOMICS</span><small>{sandboxFinancialSourceLabel(financialSource)}</small></header>
      <div>
        <article><span>Outgoing price</span><b>£{latestTransfer.out.price.toFixed(1)}m</b></article>
        <article><span>Incoming price</span><b>£{latestTransfer.incoming.price.toFixed(1)}m</b></article>
        <article><span>Bank</span><b>£{Math.max(0,latestBank.before).toFixed(1)}m → £{Math.max(0,latestBank.after).toFixed(1)}m</b></article>
        <article><span>Sandbox transfers</span><b>{economics.requiredTransferCount}</b><small>Required final transfers from baseline</small></article>
        <article><span>Sandbox actions</span><b>{economics.sandboxActionCount}</b><small>Exploratory swaps in this session</small></article>
        <article><span>Free transfers</span><b>{freeTransfers}</b></article>
        <article><span>Cumulative hit cost</span><b>{economics.cumulativeHitCost ? `−${economics.cumulativeHitCost} pts` : "None"}</b><small>Official four-point hit logic</small></article>
        <article><span>Latest hit change</span><b className={stateFor(-economics.incrementalHitChange)}>{incrementalHitCopy}</b><small>Previous modelled cost: {economics.previousHitCost} pts</small></article>
        <article><span>Gross five-GW change</span><b>{signed(economics.grossFiveWeekChange)} pts</b></article>
        <article><span>Net after hits</span><b className={stateFor(economics.netFiveWeekChange)}>{signed(economics.netFiveWeekChange)} pts</b></article>
      </div>
    </section>

    <section className="sandbox-reasoning"><span>WHY THE LATEST TRANSFER CHANGED THE SQUAD</span>{reasoning.map(reason => <p key={reason}>• {reason}</p>)}</section>

    <button type="button" className="swap-detail-toggle" onClick={() => setBreakdownOpen(open => !open)}>{breakdownOpen ? "Hide full transfer breakdown" : "Show full transfer breakdown"}</button>
    {breakdownOpen && <TransferBreakdown r={latestTransfer} />}
  </section>;
}
