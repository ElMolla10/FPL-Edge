/**
 * Chip scoring, shared by the Chips tab, Final check, Team, Coach, Draft Lab (browser) AND the autonomous bot cron
 * (app/lib/fpl-bot). Moved verbatim out of app/components/LiveIntelligence.tsx ("use client") so the Worker can run
 * the same formula; LiveIntelligence re-exports everything, so existing import paths are unchanged.
 */
import { FplData, FplPlayer, bestXi, eventTotals, optimizeSquad, playerProjection, projectionMetrics } from "./fpl";
import { haulProbability, playerPointsDistribution } from "./projection-distribution";

export type Chip="Wildcard"|"Free Hit"|"Bench Boost"|"Triple Captain";
export type ChipScore={score:number;detail:string};
export type ChipScores={wildcard:ChipScore;freeHit:ChipScore;benchBoost:ChipScore;tripleCaptain:ChipScore};
// Shared by LiveChips (the full Chips tab, scored across an 8-GW horizon) and Final Check's
// single-gameweek summary -- one scoring formula, not a second implementation that could drift.
export function chipScoresForEvent(data:FplData,baseline:FplPlayer[],event:{id:number},window:number[],hasSquad:boolean):ChipScores{
  const clamp=(n:number)=>Math.max(1,Math.min(10,Math.round(n)));
  const oneBest=optimizeSquad(data,[event.id]);const oneXi=bestXi(oneBest,event.id,data.fixtures,event.id);const currentXi=bestXi(baseline,event.id,data.fixtures,event.id);
  const wc=optimizeSquad(data,window);const uplift=eventTotals(wc,window,data.fixtures).reduce((a,b)=>a+b,0)-eventTotals(baseline,window,data.fixtures).reduce((a,b)=>a+b,0);
  const xiBase=currentXi.players.reduce((s,p)=>s+playerProjection(p,event.id,data.fixtures,event.id),0);const squadAll=baseline.reduce((s,p)=>s+playerProjection(p,event.id,data.fixtures,event.id),0);const bench=Math.max(0,squadAll-xiBase);
  const freeHit=Math.max(0,oneXi.total-currentXi.total);const tc=oneXi.captain?playerProjection(oneXi.captain,event.id,data.fixtures,event.id):0;
  // Informational only -- haul probability supplements the detail text, it does not change the
  // score itself, matching how every prior distribution-engine addition in this app has stayed
  // additive to existing recommendations rather than altering what they recommend.
  const tcHaul=oneXi.captain?haulProbability(playerPointsDistribution(projectionMetrics(oneXi.captain,event.id,data.fixtures,event.id),oneXi.captain.positionShort))*100:0;
  return{
    wildcard:{score:clamp(2+uplift/3),detail:hasSquad?`+${Math.max(0,uplift).toFixed(1)} projected pts vs your squad over 5 GWs`:"Build your squad to calculate personal uplift"},
    freeHit:{score:clamp(1+freeHit*1.1),detail:`+${freeHit.toFixed(1)} one-week pts vs current XI`},
    benchBoost:{score:clamp(bench/1.25),detail:`${bench.toFixed(1)} projected bench pts`},
    tripleCaptain:{score:clamp(2+tc/1.25),detail:`${oneXi.captain?.name??"—"} · ${tc.toFixed(1)} xPts · ${Math.round(tcHaul)}% haul chance`},
  };
}
