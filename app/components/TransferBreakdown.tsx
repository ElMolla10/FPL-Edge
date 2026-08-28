"use client";

import { Transfer } from "../lib/transfers";
import { blankProbability, haulProbability, playerPointsDistribution, pointsRange } from "../lib/projection-distribution";

// Extracted from CoachApp.tsx so LiveDraftBuilder.tsx's pitch-click swap can reuse the same full
// breakdown the Transfers page already shows for its ranked candidates -- CoachApp.tsx already
// imports LiveDraftBuilder, so LiveDraftBuilder importing this back from CoachApp.tsx would cycle.
// Same pattern as the Pitch.tsx extraction. Behavior and markup are unchanged from the original;
// the Transfers page's own usage is untouched (just imported from here instead of defined inline).
export default function TransferBreakdown({r}:{r:Transfer}){
  const horizons=[
    {label:"NEXT GAMEWEEK",out:r.outGw1,incoming:r.inGw1,gain:r.gain1,individual:r.individualGain1},
    {label:"NEXT 3 GWs",out:r.outGw3,incoming:r.inGw3,gain:r.gain3,individual:r.individualGain3},
    {label:"NEXT 5 GWs",out:r.outGw5,incoming:r.inGw5,gain:r.gain5,individual:r.individualGain5},
  ];
  const statusCopy=r.qualityStatus==="actionable"?"The role, evidence and multi-week upside are strong enough to act on.":r.qualityStatus==="watchlist"?"The upside is interesting, but at least one signal needs more evidence.":"This route failed a hard plausibility or role-security check.";
  const signed=(value:number,places=1)=>`${value>=0?"+":""}${value.toFixed(places)}`;
  const outDist=playerPointsDistribution(r.outMetrics,r.out.positionShort),inDist=playerPointsDistribution(r.inMetrics,r.incoming.positionShort);
  const outRange=pointsRange(outDist),inRange=pointsRange(inDist);
  return <div className={`transfer-detail ${r.qualityStatus}`}>
    <header className="transfer-detail-head">
      <div><span>MODEL VERDICT</span><h3>{r.out.name} <i>→</i> {r.incoming.name}</h3><p>{statusCopy}</p></div>
      <strong><small>{r.qualityStatus.toUpperCase()}</small>{r.qualityScore}<em>/100</em></strong>
    </header>

    <section className="transfer-horizons">{horizons.map(horizon=><article key={horizon.label}>
      <span>{horizon.label}</span>
      <div><p><small>KEEP {r.out.name.toUpperCase()}</small><b>{horizon.out.toFixed(1)}</b></p><i>vs</i><p><small>BUY {r.incoming.name.toUpperCase()}</small><b>{horizon.incoming.toFixed(1)}</b></p></div>
      <footer><b>{signed(horizon.gain)} squad pts</b><small>{signed(horizon.individual)} individual edge</small></footer>
    </article>)}</section>

    <div className="transfer-detail-columns">
      <section className="player-signal-card">
        <header><span>PLAYER SIGNALS</span><b>{r.out.name}</b><b>{r.incoming.name}</b></header>
        <p><span>Expected minutes</span><b>{Math.round(r.expectedMinutesOut)}</b><strong>{Math.round(r.expectedMinutesIn)}</strong></p>
        <p><span>Start probability</span><b>{Math.round(r.startProbOut*100)}%</b><strong>{Math.round(r.startProbIn*100)}%</strong></p>
        <p><span>Attacking threat</span><b>{r.attackingOut.toFixed(2)}</b><strong>{r.attackingIn.toFixed(2)}</strong></p>
        <p><span>Defensive contribution</span><b>{r.dcOut.toFixed(2)}</b><strong>{r.dcIn.toFixed(2)}</strong></p>
        <p><span>Model confidence</span><b>{Math.round(r.confidenceOut*100)}%</b><strong>{Math.round(r.confidenceIn*100)}%</strong></p>
      </section>

      <section className="fixture-context-card">
        <header><span>INCOMING PLAYER CONTEXT</span><small>1.00 = league average</small></header>
        <div><p><span>Team attack</span><b>×{r.teamAttackIn.toFixed(2)}</b></p><p><span>Opponent defence</span><b>×{r.opponentDefenceIn.toFixed(2)}</b></p><p className="accent"><span>Attack matchup</span><b>×{r.fixtureAttackMultiplierIn.toFixed(2)}</b></p><p><span>Team defence</span><b>×{r.teamDefenceIn.toFixed(2)}</b></p><p><span>Opponent attack</span><b>×{r.opponentAttackIn.toFixed(2)}</b></p><p className="accent"><span>Defence matchup</span><b>×{r.fixtureDefenceMultiplierIn.toFixed(2)}</b></p></div>
        <footer><span>Average fixture difficulty</span><b>{r.fixtureAdjustmentIn.toFixed(1)} / 5</b></footer>
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

    <section className="transfer-decision-math">
      <p><span>After transfer hit</span><b>{signed(r.netDifference)} pts</b><small>{r.hitCost?`${r.hitCost}-point cost included`:"No hit required"}</small></p>
      <p><span>Risk-adjusted score</span><b>{r.rankScore.toFixed(1)}</b><small>{r.risk} minutes risk</small></p>
      <p><span>Multi-week robustness</span><b>{r.positiveWeeks}/{r.weeklyGains.length} positive</b><small>{signed(r.gainWithoutBestWeek)} without best GW</small></p>
      <p><span>Squad utility change</span><b>{r.utilityChange===null?"—":signed(r.utilityChange)}</b><small>structure, bench and flexibility</small></p>
    </section>

    {(r.qualityReasons.length>0||r.anomalies.length>0)&&<section className="transfer-detail-warnings">
      <span>{r.qualityStatus==="blocked"?"WHY THIS ROUTE IS BLOCKED":"WHAT TO WATCH"}</span>
      {[...r.qualityReasons.map(reason=>({key:`quality-${reason.code}`,message:reason.message})),...r.anomalies.map(flag=>({key:`anomaly-${flag.code}`,message:flag.message}))].map(item=><p key={item.key}>{item.message}</p>)}
    </section>}
  </div>;
}
