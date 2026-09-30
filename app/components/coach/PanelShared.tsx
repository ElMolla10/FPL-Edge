"use client";

import {useState,useEffect} from "react";
import {Chip} from "../LiveIntelligence";
import {resolveCaptaincy,resolveCaptainSwap} from "../../lib/captaincy";
import {FplPlayer,FplData,playerProjection,FplFixture,bestXi,projectionMetrics,simulateAutosubs,PlayerCalibrationGroup,ProjectionMetrics} from "../../lib/fpl";
import {persist} from "../../lib/persistence";
import {optimizeBenchOrder,modeledAppearanceProbability} from "../../lib/bench-order";
import {TransferRoute} from "../../lib/transfer-routes";
import {playerPointsDistribution,blankProbability,haulProbability} from "../../lib/projection-distribution";
import {TransferQualityStatus} from "../../lib/transfer-quality";
import {Transfer} from "../../lib/transfers";
import {ManagerMeta,OfficialPick} from "../../lib/squad-comparison";

export const readIds=(key:string)=>{try{return JSON.parse(localStorage.getItem(key)||"[]") as number[]}catch{return[]}};

export function useCaptaincy(players:FplPlayer[],event:number,modelCaptain:FplPlayer|undefined,modelVice:FplPlayer|undefined){
  const[captainId,setCaptainId]=useState<number|null>(null);const[viceId,setViceId]=useState<number|null>(null);
  let manager:ManagerMeta|null=null;try{manager=JSON.parse(localStorage.getItem("fpl-edge-manager")||"null")}catch{}
  useEffect(()=>{if(!event||!players.length)return;const storedCaptain=Number(localStorage.getItem(`fpl-edge-captain-${event}`));const storedVice=Number(localStorage.getItem(`fpl-edge-vice-${event}`));const resolved=resolveCaptaincy(players,storedCaptain,storedVice,manager?.captainId,manager?.viceCaptainId,modelCaptain,modelVice);if(!resolved)return;setCaptainId(resolved.captainId);setViceId(resolved.viceId)},[event,players.map(p=>p.id).join(","),modelCaptain?.id,modelVice?.id]);
  const saveCaptaincy=(captain:number,vice:number)=>{persist(`fpl-edge-captain-${event}`,String(captain));persist(`fpl-edge-vice-${event}`,String(vice))};
  // Resolves "current" through the same shared resolveCaptaincy() the mount effect above already
  // uses, rather than a second, ad-hoc fallback chain -- in the ordinary case captainId/viceId
  // state is already resolved and this is a same-value round-trip (resolveCaptaincy's own
  // precedence rule always keeps an already-valid stored id). Only matters in the narrow window
  // before the mount effect has flushed, where this is strictly more correct than before (the old
  // inline fallback chain never consulted the manager tier at all).
  const chooseCaptain=(id:number)=>{const current=resolveCaptaincy(players,captainId??0,viceId??0,manager?.captainId,manager?.viceCaptainId,modelCaptain,modelVice);if(!current)return;const next=resolveCaptainSwap(current.captainId,current.viceId,id);setCaptainId(next.captainId);setViceId(next.viceId);saveCaptaincy(next.captainId,next.viceId)};
  const chooseVice=(id:number)=>{const oldVice=viceId??modelVice?.id??players.find(p=>p.id!==captainId)?.id??id;const nextCaptain=id===captainId?oldVice:captainId??modelCaptain?.id??players.find(p=>p.id!==id)?.id??id;setCaptainId(nextCaptain);setViceId(id);saveCaptaincy(nextCaptain,id)};
  return{captain:players.find(p=>p.id===captainId)??modelCaptain??players[0],vice:players.find(p=>p.id===viceId)??modelVice??players.find(p=>p.id!==(captainId??modelCaptain?.id))??players[0],chooseCaptain,chooseVice};
}

export function CaptaincyPicker({players,captain,vice,onCaptain,onVice,event,data,readOnly=false,status}:{players:FplPlayer[];captain:FplPlayer;vice:FplPlayer;onCaptain:(id:number)=>void;onVice:(id:number)=>void;event:number;data:FplData;readOnly?:boolean;status?:string}){return <section className={`captaincy-picker ${readOnly?"locked":""}`}><div><span>CAPTAIN</span><select value={captain.id} onChange={e=>onCaptain(Number(e.target.value))} disabled={readOnly}>{players.map(p=><option key={p.id} value={p.id}>{p.name} · {playerProjection(p,event,data.fixtures,event).toFixed(1)} xPts</option>)}</select><small>{readOnly?"Official selection from FPL.":"Scores double if they play."}</small></div><i>↔</i><div><span>VICE-CAPTAIN</span><select value={vice.id} onChange={e=>onVice(Number(e.target.value))} disabled={readOnly}>{players.map(p=><option key={p.id} value={p.id}>{p.name} · {playerProjection(p,event,data.fixtures,event).toFixed(1)} xPts</option>)}</select><small>Takes over if your captain does not play.</small></div><strong>{status??`Saved automatically for GW${event}`}</strong></section>}

// --- Gameweek navigator: past/current/future squad views on the Team page ---

export type HistoryWeekPick={elementId:number;position:number;multiplier:number;isCaptain:boolean;isViceCaptain:boolean;elementType:number};

export type HistoryPlayerStats={points:number;minutes:number;starts:number;goals:number;assists:number;cleanSheets:number;bonus:number};

export type HistoryWeek={
  event:number;points:number;unavailable?:boolean;squad?:HistoryWeekPick[];
  playerPoints?:Record<string,number>;playerStats?:Record<string,HistoryPlayerStats>;
  automaticSubs?:{elementIn:number;elementOut:number}[];
  captainId?:number|null;viceCaptainId?:number|null;captainRawPoints?:number;captainContribution?:number;
  captain?:string;viceCaptain?:string;chip?:string|null;transferCost?:number;
};

export type CurrentXiResolution={xi:FplPlayer[];bench:FplPlayer[];modelCaptain:FplPlayer|undefined;modelVice:FplPlayer|undefined;source:"official"|"locked"|"model"};

// Official post-deadline picks are authoritative when available. Otherwise, if this event was
// locked in Final Check, that recorded XI is what actually got planned -- bestXi() re-derives its
// OWN pick from today's projections, which can drift from the saved selection. Preferring those
// real sources over the model mirrors
// resolvePastGameweek's locked-prediction branch and useCaptaincy's stored-choice precedence:
// without it, live points would silently sum eventPoints for players who were never actually in
// the real starting XI that week -- the same class of silent disagreement the Final Check
// locks-reconciliation fix exists to prevent. Only falls back to bestXi() when no lock exists.
export function resolveCurrentXi(squad:FplPlayer[],players:FplPlayer[],eventId:number,fixtures:FplFixture[],lock:LockRecord|undefined,officialPicks?:OfficialPick[]):CurrentXiResolution{
  if(officialPicks?.length===15){
    const byId=(id:number)=>players.find(p=>p.id===id);
    const ordered=officialPicks.map(pick=>({pick,player:byId(pick.elementId)})).filter(row=>row.player) as {pick:OfficialPick;player:FplPlayer}[];
    const xi=ordered.filter(row=>row.pick.position<=11).sort((a,b)=>a.pick.position-b.pick.position).map(row=>row.player);
    const bench=ordered.filter(row=>row.pick.position>11).sort((a,b)=>a.pick.position-b.pick.position).map(row=>row.player);
    if(xi.length===11&&bench.length===4){
      const captainPick=ordered.find(row=>row.pick.isCaptain);
      const vicePick=ordered.find(row=>row.pick.isViceCaptain);
      return{xi,bench,modelCaptain:captainPick?.player??xi[0],modelVice:vicePick?.player??xi[1],source:"official"};
    }
  }
  if(lock){
    const byId=(id:number)=>players.find(p=>p.id===id);
    const xi=lock.xiIds.map(byId).filter(Boolean) as FplPlayer[];
    const fallbackBenchIds=lock.squadIds.filter(id=>!lock.xiIds.includes(id));
    const bench=(lock.benchIds?.length===4?lock.benchIds:fallbackBenchIds).map(byId).filter(Boolean) as FplPlayer[];
    return{xi,bench,modelCaptain:xi.find(p=>p.id===lock.captainId)??xi[0],modelVice:xi.find(p=>p.id===lock.viceId)??xi[1],source:"locked"};
  }
  const result=bestXi(squad,eventId,fixtures,eventId);
  const xi=result.players;
  const rawBench=squad.filter(p=>!xi.some(x=>x.id===p.id));
  const bench=optimizeBenchOrder(xi,rawBench,player=>{const metrics=projectionMetrics(player,eventId,fixtures,eventId);return{xPts:metrics.xPts,appearanceProbability:modeledAppearanceProbability(player,metrics)}}).bench;
  const modelVice=[...xi].sort((a,b)=>playerProjection(b,eventId,fixtures,eventId)-playerProjection(a,eventId,fixtures,eventId))[1];
  return{xi,bench,modelCaptain:result.captain??xi[0],modelVice,source:"model"};
}

// What the bench should actually display: normally just `bench`, but once autosub promotes a
// bench player into `effectiveXi` they need to drop out of this list (or they'd show twice -- once
// on the pitch, once here) and whoever they replaced (no longer in effectiveXi) needs to appear
// here instead of vanishing -- they're off the pitch, not off the squad.
export function resolveBenchDisplay(bench:FplPlayer[],xi:FplPlayer[],effectiveXi:FplPlayer[]):FplPlayer[]{
  return[...bench,...xi].filter(p=>!effectiveXi.some(e=>e.id===p.id));
}

export type OfficialScoringAuthority={event:number;captainId:number|null;viceCaptainId:number|null;chip:string|null};

export type LiveScoringResult={
  effectiveXi:FplPlayer[];displayedBench:FplPlayer[];effectiveCaptainId:number|null;
  captainId:number;viceId:number;captainMultiplier:number;activeChip:string|null;
  captainBonus:number;benchBoostPoints:number;liveTotal:number;
  armbandPassedToVice:boolean;captaincyLost:boolean;captaincySource:"official"|"local";
  swaps:{outId:number;outName:string;inId:number;inName:string}[];
};

// The official FPL code for Triple Captain is "3xc". A missing or unrelated chip must never be
// guessed up to x3; an armband holder defaults honestly to standard captaincy, while a week where
// both captain and vice fail to play has no multiplier at all.
export function resolveCaptainMultiplier(isArmbandHolder:boolean,activeChip:string|null):number{
  if(!isArmbandHolder)return 1;
  return activeChip==="3xc"?3:2;
}

// Single source of truth for every live-scoring consumer. Official captaincy/chip data is used only
// after the deadline and only when it explicitly belongs to this event. Otherwise the local picks
// remain a clearly labelled estimate. This prevents a stale chip or a post-deadline local edit from
// silently changing the official live total.
export function resolveLiveScoring({xi,bench,localCaptainId,localViceId,eventId,deadlinePassed,official,finalizeAutosubs}:{xi:FplPlayer[];bench:FplPlayer[];localCaptainId:number;localViceId:number;eventId:number;deadlinePassed:boolean;official:OfficialScoringAuthority|null;finalizeAutosubs:boolean}):LiveScoringResult{
  const validXi=(id:number|null|undefined):id is number=>!!id&&xi.some(p=>p.id===id);
  const officialForEvent=deadlinePassed&&official?.event===eventId?official:null;
  const officialCaptaincy=!!officialForEvent&&validXi(officialForEvent.captainId)&&validXi(officialForEvent.viceCaptainId)&&officialForEvent.captainId!==officialForEvent.viceCaptainId;
  const captainId=officialCaptaincy?officialForEvent!.captainId!:validXi(localCaptainId)?localCaptainId:xi[0]?.id??0;
  let viceId=officialCaptaincy?officialForEvent!.viceCaptainId!:validXi(localViceId)?localViceId:xi.find(p=>p.id!==captainId)?.id??captainId;
  if(viceId===captainId)viceId=xi.find(p=>p.id!==captainId)?.id??captainId;
  const activeChip=officialForEvent?.chip??null;
  const autosub=finalizeAutosubs&&xi.length===11?simulateAutosubs(xi,bench,captainId,viceId):null;
  const effectiveXi=autosub?.effectiveXi??xi;
  const displayedBench=resolveBenchDisplay(bench,xi,effectiveXi);
  const effectiveCaptainId=autosub?autosub.effectiveCaptainId:captainId||null;
  const armbandHolder=effectiveXi.find(p=>p.id===effectiveCaptainId);
  const captainMultiplier=resolveCaptainMultiplier(!!armbandHolder,activeChip);
  const captainBonus=(armbandHolder?.eventPoints??0)*(captainMultiplier-1);
  const benchBoostPoints=activeChip==="bboost"?displayedBench.reduce((sum,p)=>sum+p.eventPoints,0):0;
  const liveTotal=effectiveXi.reduce((sum,p)=>sum+p.eventPoints,0)+captainBonus+benchBoostPoints;
  return{effectiveXi,displayedBench,effectiveCaptainId,captainId,viceId,captainMultiplier,activeChip,captainBonus,benchBoostPoints,liveTotal,armbandPassedToVice:autosub?.armbandPassedToVice??false,captaincyLost:autosub?.doubleLost??false,captaincySource:officialCaptaincy?"official":"local",swaps:autosub?.swaps??[]};
}

export function formation(players:FplPlayer[]){return ["DEF","MID","FWD"].map(pos=>players.filter(p=>p.positionShort===pos).length).join("-")}

// Tuple encoding keeps a full-season receipt archive inside practical browser-storage limits.
// Field order: id, price, status, prior source, current-event xPts, expected minutes, start
// probability, confidence, xG, xA, clean-sheet probability, horizon xPts[], team id, position,
// evidence group and low-PL-continuity-club flag.
// The first eleven fields preserve tuple-v1 compatibility; tuple-v2 appends the projection path;
// tuple-v3 freezes team/position; tuple-v4 freezes evidence class and club-continuity context.
export type ProjectionReceiptPlayer=[number,number,string,FplPlayer["priorSource"]|null,number,number,number,number,number,number,number,number[]?,number?,string?,PlayerCalibrationGroup?,boolean?];

export type ProjectionReceiptTransfer={
  rank:number;outId:number;outName:string;incomingId:number;incomingName:string;
  gain1:number;gain3:number;gain5:number;individualGain1?:number;individualGain3?:number;individualGain5:number;rankScore:number;
  netDifference:number;hitCost:number;startProbability:number;confidence:number;
  risk:Transfer["risk"];reviewRequired:boolean;anomalyCodes:string[];
  qualityStatus?:TransferQualityStatus;qualityScore?:number;qualityReasonCodes?:string[];
};

export type ProjectionReceiptRoute={
  rank:number;gain:number;netProjectedPoints:number;totalHitCost:number;totalTransfers:number;firstAction:string;confidence:number;risk:TransferRoute["risk"];
  weeks:{eventId:number;freeTransfersBefore:number;freeTransfersAfter:number;hitCost:number;bankAfter:number;projectedPoints:number;moves:[number,number,number,number][]}[];
};

export type ProjectionReceipt={
  schemaVersion:1|2|3|4|5|6|7|8;receiptId:string;modelVersion:string;event:number;eventIds:number[];
  // Disclosure only -- deliberately NOT folded into squad.predictedTotal (see createProjectionReceipt's
  // comment): whether a chip was planned when this receipt was locked, so a later "your plan vs what you
  // actually did" comparison is possible without corrupting evaluateProjectionReceipt's real-chip-based
  // adjustedProjectedTotal, which stays the only place a chip bonus is added to this receipt's numbers.
  plannedChip:Chip|null;
  deadline:string;capturedAt:string;dataUpdatedAt:string;dataSource:string;seasonStatsThrough:number;
  assumptions:{bank:number;freeTransfers:number;transferHorizon:number};
  squad:{squadIds:number[];xiIds:number[];benchIds?:number[];captainId:number;viceId:number;predictedTotal:number;captainXPts:number;viceXPts:number};
  playerEncoding:"tuple-v1"|"tuple-v2"|"tuple-v3"|"tuple-v4";players:ProjectionReceiptPlayer[];transfers:ProjectionReceiptTransfer[];routes?:ProjectionReceiptRoute[];
};

export const receiptNumber=(value:number,places=3)=>Number(value.toFixed(places));

export type LockRecord={event:number;lockedAt:string;dataUpdatedAt:string;predicted:number;squadIds:number[];xiIds:number[];benchIds?:number[];captainId:number;viceId:number;receipt?:ProjectionReceipt;source?:"manual"|"auto"};

export const average=(values:number[])=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0;

// Probabilistic Projection Simulator, Phase A: replaces the old linear xG/xA-only formula (which
// structurally could not represent a defender or goalkeeper haul -- it never looked at clean sheet,
// DC or bonus at all) with direct reads off the real points distribution. ret = 1 - blank
// probability (P(points<=2)); haul = P(points>=10), the same 0-100 percentage scale and semantic
// direction the old formula used, so captaincyRiskFraming's existing thresholds keep working
// unchanged. positionShort is now required (the old formula never took it -- part of why it was
// position-blind) since goal/clean-sheet/DC point values and applicability are position-specific.
export function captainReturnHaul(m:ProjectionMetrics,positionShort:FplPlayer["positionShort"]):{ret:number;haul:number}{
  const pmf=playerPointsDistribution(m,positionShort);
  return{ret:(1-blankProbability(pmf))*100,haul:haulProbability(pmf)*100};
}

export type CaptainCandidate={id:number;name:string;xPts:number;ret:number;haul:number;startProbability:number;selectedBy:number};

export type CaptaincyRiskFraming={defaultRole:"safe"|"differential"|"balanced";safeAlternative:CaptainCandidate|null;differentialAlternative:CaptainCandidate|null};

// "Safe" reuses this exact component's own existing "Risk: Low" threshold (startProbability>.8).
// "Differential" reuses the Players page's existing "Differential under 10%" ownership filter --
// neither threshold is invented fresh for this feature. An alternative only surfaces if it's a
// real tradeoff, not a free upgrade or rounding noise: a real edge on its own axis, and (for the
// differential specifically) a genuine cost in return probability.
// ret and haul are NOT the same scale under the Phase A distribution engine, so they get separate
// edge thresholds rather than one shared MEANINGFUL_EDGE (the pre-recalibration value, 10 for both).
// ret (1-blank probability) spans a wide real range among live starters (~24-94%), so 10 points
// stays well-calibrated there unchanged. haul (P(points>=10)) is far more compressed: pulling every
// live player through the real engine put the 99th percentile at 9.7% and the single highest value
// in the entire dataset at 23.1% (B.Fernandes) -- a 10-point haul edge over a strong default captain
// is effectively unreachable by construction, not just rare, which is why the differential path never
// fired against a real top-15-owned pool during the Phase C investigation. 5 is calibrated two ways:
// it's roughly the ~0.51x compression the Phase A report already measured for one elite forward
// (42.9%->22.0% under the old vs. new formula), and it sits meaningfully above the real p90 haul
// noise floor (2.5%) while actually being clearable by a genuine standout low-owned differential.
const SAFE_START_THRESHOLD=.8;

const DIFFERENTIAL_OWNERSHIP_THRESHOLD=10;

const MEANINGFUL_RET_EDGE=10;

const MEANINGFUL_HAUL_EDGE=5;

const MIN_RETURN_COST=5;

export function captaincyRiskFraming(candidates:CaptainCandidate[],defaultCaptainId:number):CaptaincyRiskFraming{
  const defaultCaptain=candidates.find(c=>c.id===defaultCaptainId);
  if(!defaultCaptain)return{defaultRole:"balanced",safeAlternative:null,differentialAlternative:null};
  const safeCandidates=candidates.filter(c=>c.startProbability>=SAFE_START_THRESHOLD);
  const safePick=safeCandidates.length?safeCandidates.reduce((best,c)=>c.ret>best.ret?c:best):null;
  const diffCandidates=candidates.filter(c=>c.selectedBy<DIFFERENTIAL_OWNERSHIP_THRESHOLD);
  const differentialPick=diffCandidates.length?diffCandidates.reduce((best,c)=>c.haul>best.haul?c:best):null;
  const defaultRole=safePick?.id===defaultCaptainId?"safe":differentialPick?.id===defaultCaptainId?"differential":"balanced";
  const safeAlternative=safePick&&safePick.id!==defaultCaptainId&&(safePick.ret-defaultCaptain.ret)>=MEANINGFUL_RET_EDGE?safePick:null;
  const differentialAlternative=differentialPick&&differentialPick.id!==defaultCaptainId&&(differentialPick.haul-defaultCaptain.haul)>=MEANINGFUL_HAUL_EDGE&&(defaultCaptain.ret-differentialPick.ret)>=MIN_RETURN_COST?differentialPick:null;
  return{defaultRole,safeAlternative,differentialAlternative};
}
