"use client";

import { useState } from "react";
import { Transfer } from "../lib/transfers";
import type { FplData } from "../lib/fpl";
import { blankProbability, haulProbability, playerPointsDistribution, pointsRange } from "../lib/projection-distribution";
import type { TransferAnalysisEntry } from "../lib/transfer-decision-ui";
import DecisionConfidencePanel from "./DecisionConfidencePanel";
import TransferSensitivityPanel from "./TransferSensitivityPanel";
import { qualityPopulation, qualityScoreOutOf10 } from "../lib/team-quality";
import { difficultyScoreOutOf10 } from "../lib/fixture-difficulty";

// Extracted from CoachApp.tsx so LiveDraftBuilder.tsx's pitch-click swap can reuse the same full
// breakdown the Transfers page already shows for its ranked candidates -- CoachApp.tsx already
// imports LiveDraftBuilder, so LiveDraftBuilder importing this back from CoachApp.tsx would cycle.
// Same pattern as the Pitch.tsx extraction. Behavior and markup are unchanged from the original;
// the Transfers page's own usage is untouched (just imported from here instead of defined inline).
export default function TransferBreakdown({r,data,decision,onAnalyze,analysisActive=false,analysisBusy=false,developerMode=false}:{r:Transfer;data:FplData;decision?:TransferAnalysisEntry;onAnalyze?:()=>void;analysisActive?:boolean;analysisBusy?:boolean;developerMode?:boolean}){
  const [openLeg,setOpenLeg]=useState<number|null>(null);
  const [showAdvanced,setShowAdvanced]=useState(false);
  // teamAttackIn/teamDefenceIn/opponentAttackIn/opponentDefenceIn are each averaged across the
  // incoming player's own upcoming fixtures (a mix of home and away games), so no single club's
  // home-only or away-only number is the right comparison -- "overall" (home+away averaged per
  // club) is the one population that fairly represents all four.
  const attackPopulation=qualityPopulation(data.teams,"attack","overall"),defencePopulation=qualityPopulation(data.teams,"defence","overall");
  const horizons=[
    {label:"NEXT GAMEWEEK",out:r.outGw1,incoming:r.inGw1,gain:r.gain1,individual:r.individualGain1},
    {label:"NEXT 3 GWs",out:r.outGw3,incoming:r.inGw3,gain:r.gain3,individual:r.individualGain3},
    {label:"NEXT 5 GWs",out:r.outGw5,incoming:r.inGw5,gain:r.gain5,individual:r.individualGain5},
  ];
  const statusCopy=r.qualityStatus==="actionable"?"The role, evidence and multi-week upside are strong enough to act on.":r.qualityStatus==="watchlist"?"The upside is interesting, but at least one signal needs more evidence.":"This route failed a hard plausibility or role-security check.";
  const signed=(value:number,places=1)=>`${value>=0?"+":""}${value.toFixed(places)}`;
  const outDist=playerPointsDistribution(r.outMetrics,r.out.positionShort),inDist=playerPointsDistribution(r.inMetrics,r.incoming.positionShort);
  const outRange=pointsRange(outDist),inRange=pointsRange(inDist);
  const hitCopy=r.hitCost>0?`${r.hitCost}-point cost included`:r.hitCost<0?`${Math.abs(r.hitCost)} modelled hit points avoided`:"No additional hit required";
  const rawNet=r.fiveGwNetVsHold??r.netEv5??r.netDifference;
  const adjNet=r.riskAdjustedFiveGwNetVsHold??r.riskAdjustedNet5??rawNet;
  const riskDelta=r.riskAdjustmentPointsDelta??(adjNet-rawNet);
  const pathLegs=r.transferNowPathLegs??[];
  return <div className={`transfer-detail ${r.qualityStatus}`}>
    <header className="transfer-detail-head">
      <div><span>MODEL VERDICT</span><h3>{r.out.name} <i>→</i> {r.incoming.name}</h3><p>{statusCopy}</p></div>
      <strong><small>{r.qualityStatus.toUpperCase()} · DECISION CONFIDENCE</small>{r.qualityScore}<em>/100</em></strong>
    </header>

    <section className="transfer-horizons">{horizons.map(horizon=><article key={horizon.label}>
      <span>{horizon.label}</span>
      <div><p><small>KEEP {r.out.name.toUpperCase()}</small><b>{horizon.out.toFixed(1)}</b></p><i>vs</i><p><small>BUY {r.incoming.name.toUpperCase()}</small><b>{horizon.incoming.toFixed(1)}</b></p></div>
      <footer><b>{signed(horizon.gain)} squad pts</b><small>{signed(horizon.individual)} individual edge</small></footer>
    </article>)}</section>

    <section className="engine-net-detail transfer-raw-net">
      <header><span>NET VS HOLD</span><small>Expected points — not the /100 decision score</small></header>
      <p><span>Raw 5-GW NET vs HOLD</span><b>{signed(rawNet)}</b></p>
      <p><span>Risk adjustment (points Δ)</span><b>{signed(riskDelta)}</b><small>confidence-only; start risk already in xPts</small></p>
      <p><span>Adjusted 5-GW NET vs HOLD</span><b>{signed(adjNet)}</b></p>
      <p><span>After transfer-hit change</span><b>{signed(r.netDifference)} pts</b><small>{hitCopy}</small></p>
    </section>

    <div className="transfer-detail-columns">
      <section className="player-signal-card">
        <header><span>PLAYER SIGNALS</span><b>{r.out.name}</b><b>{r.incoming.name}</b></header>
        <p><span>Expected minutes</span><b>{Math.round(r.expectedMinutesOut)}</b><strong>{Math.round(r.expectedMinutesIn)}</strong></p>
        <p><span>Start probability</span><b>{Math.round(r.startProbOut*100)}%</b><strong>{Math.round(r.startProbIn*100)}%</strong></p>
        <p><span>Attacking threat</span><b>{r.attackingOut.toFixed(2)}</b><strong>{r.attackingIn.toFixed(2)}</strong></p>
        <p><span>Defensive contribution</span><b>{r.dcOut.toFixed(2)}</b><strong>{r.dcIn.toFixed(2)}</strong></p>
        <p><span>Projection evidence</span><b>{Math.round(r.confidenceOut*100)}%</b><strong>{Math.round(r.confidenceIn*100)}%</strong></p>
        {(r.outMetrics.availabilityState||r.inMetrics.availabilityState)&&<p><span>Availability state</span><b>{r.outMetrics.availabilityState??"—"}</b><strong>{r.inMetrics.availabilityState??"—"}</strong></p>}
      </section>

      <section className="fixture-context-card">
        <header><span>INCOMING PLAYER CONTEXT</span><small>0-10, 10 = best, relative to the 20 clubs modeled this season</small></header>
        <div><p><span>Team attack</span><b>{qualityScoreOutOf10(r.teamAttackIn,attackPopulation).toFixed(1)}/10</b></p><p><span>Opponent defence</span><b>{qualityScoreOutOf10(r.opponentDefenceIn,defencePopulation).toFixed(1)}/10</b></p><p className="accent"><span>Attack matchup</span><b>×{r.fixtureAttackMultiplierIn.toFixed(2)}</b></p><p><span>Team defence</span><b>{qualityScoreOutOf10(r.teamDefenceIn,defencePopulation).toFixed(1)}/10</b></p><p><span>Opponent attack</span><b>{qualityScoreOutOf10(r.opponentAttackIn,attackPopulation).toFixed(1)}/10</b></p><p className="accent"><span>Defence matchup</span><b>×{r.fixtureDefenceMultiplierIn.toFixed(2)}</b></p></div>
        <footer><span>Average fixture difficulty</span><b>{difficultyScoreOutOf10(r.fixtureAdjustmentIn).toFixed(1)}/10</b></footer>
      </section>
    </div>

    <section className="player-signal-card points-distribution-card">
      <header><span>POINTS DISTRIBUTION (PER GAMEWEEK)</span><b>{r.out.name}</b><b>{r.incoming.name}</b></header>
      <p><span>Floor (10th %ile)</span><b>{outRange.floor}</b><strong>{inRange.floor}</strong></p>
      <p><span>Median</span><b>{outRange.median}</b><strong>{inRange.median}</strong></p>
      <p><span>Ceiling (90th %ile)</span><b>{outRange.ceiling}</b><strong>{inRange.ceiling}</strong></p>
      <p><span>Blank risk (≤2 pts)</span><b>{Math.round(blankProbability(outDist)*100)}%</b><strong>{Math.round(blankProbability(inDist)*100)}%</strong></p>
      <p><span>Haul chance (10+ pts)</span><b>{Math.round(haulProbability(outDist)*100)}%</b><strong>{Math.round(haulProbability(inDist)*100)}%</strong></p>
    </section>

    {!!pathLegs.length&&<section className="future-path-drilldown">
      <header><span>WHY THIS FUTURE MOVE?</span><small>Click a path leg for metrics at that simulated GW</small></header>
      <ol>{pathLegs.map((leg,idx)=>{
        const open=openLeg===idx;
        return <li key={`${leg.eventId}-${idx}`}>
          <button type="button" className={open?"open":""} onClick={()=>setOpenLeg(open?null:idx)}>
            <b>{leg.summary}</b>
          </button>
          {open&&<div className="path-leg-metrics">
            <p><span>Action</span><b>{leg.action}</b></p>
            {leg.action==="TRANSFER"&&<p><span>Transfer</span><b>{leg.outName} → {leg.inName}</b></p>}
            <p><span>Weekly gross xPts</span><b>{leg.weeklyGross.toFixed(2)}</b></p>
            <p><span>Discounted EP</span><b>{leg.discountedEp.toFixed(2)}</b></p>
            <p><span>Net EP (after hit if week 0)</span><b>{leg.netEp.toFixed(2)}</b></p>
            <p><span>Hit cost</span><b>{leg.hitCost?`−${leg.hitCost}`:"0"}</b></p>
            <p><span>FT</span><b>{leg.freeTransfersBefore} → {leg.freeTransfersAfter}</b></p>
            <p><span>Event id</span><b>{leg.eventId}</b></p>
          </div>}
        </li>;
      })}</ol>
      {!!r.holdNowPath?.length&&<div className="future-paths hold-path"><span>HOLD-NOW PATH (summary)</span><ol>{r.holdNowPath.map(s=><li key={s}>{s}</li>)}</ol></div>}
    </section>}

    <section className="transfer-decision-math">
      <p><span>Ranking score (risk-adj NET)</span><b>{r.rankScore.toFixed(1)}</b><small>{r.risk} minutes risk · not /100 rating</small></p>
      <p><span>Multi-week robustness</span><b>{r.positiveWeeks}/{r.weeklyGains.length} positive</b><small>{signed(r.gainWithoutBestWeek)} without best GW</small></p>
    </section>

    <section className="advanced-model-diagnostics">
      <button type="button" className="advanced-toggle" onClick={()=>setShowAdvanced(v=>!v)}>{showAdvanced?"Hide":"Show"} ADVANCED MODEL DIAGNOSTICS</button>
      {showAdvanced&&<div className="advanced-diagnostics-body">
        <p><span>Optimizer utility Δ</span><b>{r.utilityChange===null?"— (not computed on engine rows)":signed(r.utilityChange)}</b><small>Not expected points · Draft Lab objective only</small></p>
        <p><span>Decision / avoid confidence</span><b>{r.qualityScore}/100</b><small>Quality-gate score — capped band, not a probability</small></p>
        <p><span>Risk multiplier</span><b>×{(r.riskAdjustment??1).toFixed(2)}</b><small>confidence-only post H4</small></p>
        {(developerMode||showAdvanced)&&<div className="projection-debug-panel">
          <span>PROJECTION DEBUG</span>
          <p><span>Out start / mins / state</span><b>{Math.round(r.startProbOut*100)}% · {Math.round(r.expectedMinutesOut)} · {r.outMetrics.availabilityState??"—"}</b></p>
          <p><span>In start / mins / state</span><b>{Math.round(r.startProbIn*100)}% · {Math.round(r.expectedMinutesIn)} · {r.inMetrics.availabilityState??"—"}</b></p>
          <p><span>Out mins|start / |bench</span><b>{(r.outMetrics.minutesIfStart??0).toFixed(1)} / {(r.outMetrics.minutesIfBench??12).toFixed(1)}</b></p>
          <p><span>In mins|start / |bench</span><b>{(r.inMetrics.minutesIfStart??0).toFixed(1)} / {(r.inMetrics.minutesIfBench??12).toFixed(1)}</b></p>
          <p><span>Role security out/in</span><b>{((r.outMetrics.roleSecurity??0)*100).toFixed(0)}% / {((r.inMetrics.roleSecurity??0)*100).toFixed(0)}%</b></p>
        </div>}
      </div>}
    </section>

    {(r.qualityReasons.length>0||r.anomalies.length>0)&&<section className="transfer-detail-warnings">
      <span>{r.qualityStatus==="blocked"?"WHY THIS ROUTE IS BLOCKED":"WHAT TO WATCH"}</span>
      {[...r.qualityReasons.map(reason=>({key:`quality-${reason.code}`,message:reason.message})),...r.anomalies.map(flag=>({key:`anomaly-${flag.code}`,message:flag.message}))].map(item=><p key={item.key}>{item.message}</p>)}
    </section>}
    <section className="transfer-breakdown-confidence" aria-label={`Decision Confidence for ${r.out.name} to ${r.incoming.name}`}>
      <header><span>DECISION CONFIDENCE</span><h3>Transfer versus current squad</h3><p>Scenario analysis stays separate from the {r.qualityStatus} quality-gate verdict above. The /100 score is decision confidence — not expected points.</p></header>
      {decision?<>
        <DecisionConfidencePanel title="Expanded transfer confidence" state={decision.main} candidateLabel="Make transfer" baselineLabel="Keep current squad" metricDirection="Transfer minus current squad" metricLabel="transfer delta" />
        <TransferSensitivityPanel state={decision.sensitivity} onRetry={onAnalyze} retryDisabled={analysisBusy}/>
      </>:<button type="button" onClick={onAnalyze} disabled={!onAnalyze||analysisActive}>{analysisActive?"Calculating Decision Confidence…":"Analyze Decision Confidence"}</button>}
    </section>
  </div>;
}
