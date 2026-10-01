"use client";

import "../../styles/panel-final.css";
import {useRef,useEffect,useMemo,useState} from "react";
import Pitch from "../Pitch";
import {Chip,ChipScores,chipScoresForEvent} from "../LiveIntelligence";
import {readPlannedChips,plannedChipFor} from "../../lib/chip-portfolio";
import {FplPlayer,FplData,projectionMetrics,playerProjection,playerCalibrationProfile,PROJECTION_MODEL_VERSION,savedSquad,startPct,opponent} from "../../lib/fpl";
import {createOptimizer} from "../../lib/optimizer";
import {readFreeTransfers,persist} from "../../lib/persistence";
import {modeledAppearanceProbability} from "../../lib/bench-order";
import {track} from "../../lib/track";
import {isExampleSquadActive} from "../../lib/example-squad";
import {TransferRoute,solveTransferRoutes} from "../../lib/transfer-routes";
import {Transfer,bestTransfers} from "../../lib/transfers";
import {deriveSandboxFinancialContext} from "../../lib/squad-comparison";
import {CaptaincyPicker,captainReturnHaul,captaincyRiskFraming,formation,receiptNumber,useCaptaincy} from "./PanelShared";
import type {CaptainCandidate,LockRecord,ProjectionReceipt,ProjectionReceiptPlayer,ProjectionReceiptRoute} from "./PanelShared";
import {ConnectTeam,analysis,useManager,withModelUtilityChange} from "./CoachCore";
import type {View} from "./CoachCore";

type ReceiptTransferInput=Pick<Transfer,"gain1"|"gain3"|"gain5"|"individualGain1"|"individualGain3"|"individualGain5"|"rankScore"|"netDifference"|"hitCost"|"startProbIn"|"confidenceIn"|"risk"|"reviewRequired"|"anomalies">&Partial<Pick<Transfer,"qualityStatus"|"qualityScore"|"qualityReasons">>&{out:Pick<FplPlayer,"id"|"name">;incoming:Pick<FplPlayer,"id"|"name">};

// Pure, explicit and deliberately complete enough for later calibration. It snapshots every
// official player, not only the chosen squad, so future model-vs-reality work can evaluate the
// full prediction population without reconstructing what the model "must have meant" later.
// plannedChip is stored on the receipt as a label ONLY -- predictedTotal below deliberately stays
// the plain, no-chip baseline. evaluateProjectionReceipt already reconciles a receipt against the
// REAL chip (firstWeek.chip) after the fact via its own chipAdjustment; if this function also baked
// a bonus for an unconfirmed PLAN into predictedTotal, a plan that turned out to match reality would
// have its bonus counted twice. Real forward-projection call sites (Overview, Final Check's own
// `predicted`, transfers.ts, transfer-routes.ts) apply the plan's bonus directly; this receipt does not.
export function createProjectionReceipt({data,eventIds,deadline,capturedAt,squad,xiIds,benchIds,captainId,viceId,bank,freeTransfers,transferRows,routeRows=[],plannedChip=null}:{data:FplData;eventIds:number[];deadline:string;capturedAt:string;squad:FplPlayer[];xiIds:number[];benchIds?:number[];captainId:number;viceId:number;bank:number;freeTransfers:number;transferRows:ReceiptTransferInput[];routeRows?:TransferRoute[];plannedChip?:Chip|null}):ProjectionReceipt{
  if(!eventIds.length)throw new Error("A projection receipt requires at least one future event.");
  if(Date.parse(capturedAt)>=Date.parse(deadline))throw new Error("The deadline has passed; this receipt cannot be labelled pre-deadline.");
  const horizon=eventIds.slice(0,5),first=horizon[0];
  const players=data.players.map(player=>{const metrics=projectionMetrics(player,first,data.fixtures,first),path=horizon.map(eventId=>receiptNumber(playerProjection(player,eventId,data.fixtures,first))),calibration=playerCalibrationProfile(player);return[player.id,receiptNumber(player.price,1),player.status,player.priorSource??null,receiptNumber(metrics.xPts),receiptNumber(metrics.expectedMinutes),receiptNumber(metrics.startProbability),receiptNumber(metrics.confidence),receiptNumber(metrics.xG),receiptNumber(metrics.xA),receiptNumber(metrics.cleanSheetProbability),path,player.teamId,player.positionShort,calibration.group,calibration.lowPlContinuityClub] satisfies ProjectionReceiptPlayer}).sort((a,b)=>a[0]-b[0]);
  const byId=new Map(data.players.map(player=>[player.id,player]));
  const projected=(id:number)=>{const player=byId.get(id);return player?playerProjection(player,first,data.fixtures,first):0};
  const captainXPts=projected(captainId),viceXPts=projected(viceId);
  const predictedTotal=xiIds.reduce((sum,id)=>sum+projected(id),0)+captainXPts;
  const frozenBenchIds=benchIds?.length===4?[...benchIds]:squad.filter(player=>!xiIds.includes(player.id)).map(player=>player.id);
  const transfers=transferRows.slice(0,20).map((row,index)=>({rank:index+1,outId:row.out.id,outName:row.out.name,incomingId:row.incoming.id,incomingName:row.incoming.name,gain1:receiptNumber(row.gain1),gain3:receiptNumber(row.gain3),gain5:receiptNumber(row.gain5),individualGain1:receiptNumber(row.individualGain1),individualGain3:receiptNumber(row.individualGain3),individualGain5:receiptNumber(row.individualGain5),rankScore:receiptNumber(row.rankScore),netDifference:receiptNumber(row.netDifference),hitCost:row.hitCost,startProbability:receiptNumber(row.startProbIn),confidence:receiptNumber(row.confidenceIn),risk:row.risk,reviewRequired:row.reviewRequired,anomalyCodes:row.anomalies.map(flag=>flag.code),qualityStatus:row.qualityStatus??(row.reviewRequired?"blocked":"actionable"),qualityScore:row.qualityScore===undefined?undefined:receiptNumber(row.qualityScore,0),qualityReasonCodes:row.qualityReasons?.map(reason=>reason.code)??[]}));
  const routes=routeRows.slice(0,4).map((route,index):ProjectionReceiptRoute=>({rank:index+1,gain:receiptNumber(route.gain),netProjectedPoints:receiptNumber(route.netProjectedPoints),totalHitCost:route.totalHitCost,totalTransfers:route.totalTransfers,firstAction:route.firstAction,confidence:receiptNumber(route.confidence),risk:route.risk,weeks:route.weeks.map(week=>({eventId:week.eventId,freeTransfersBefore:week.freeTransfersBefore,freeTransfersAfter:week.freeTransfersAfter,hitCost:week.hitCost,bankAfter:receiptNumber(week.bankAfter,1),projectedPoints:receiptNumber(week.projectedPoints),moves:week.transfers.map(move=>[move.out.id,move.incoming.id,receiptNumber(move.sellingPrice,1),receiptNumber(move.buyingPrice,1)])}))}));
  return{schemaVersion:8,receiptId:`gw${first}-${Date.parse(capturedAt)}`,modelVersion:PROJECTION_MODEL_VERSION,event:first,eventIds:horizon,plannedChip,deadline,capturedAt,dataUpdatedAt:data.updatedAt,dataSource:data.source,seasonStatsThrough:data.seasonStatsThrough,assumptions:{bank:receiptNumber(bank,1),freeTransfers,transferHorizon:horizon.length},squad:{squadIds:squad.map(player=>player.id),xiIds:[...xiIds],benchIds:frozenBenchIds,captainId,viceId,predictedTotal:receiptNumber(predictedTotal),captainXPts:receiptNumber(captainXPts),viceXPts:receiptNumber(viceXPts)},playerEncoding:"tuple-v4",players,transfers,routes};
}

export type LockStatus="none"|"matches"|"mismatch";

// Pure so the mismatch detection is directly unit-testable (tests/finalcheck.test.mts) without
// rendering. Order-independent on xiIds since bestXi's internal ordering isn't semantically meaningful.
export function reconcileLock(existingLock:LockRecord|undefined,current:{xiIds:number[];benchIds?:number[];captainId:number;viceId:number}):LockStatus{
  if(!existingLock)return"none";
  const sameIds=(a:number[],b:number[])=>a.length===b.length&&[...a].sort((x,y)=>x-y).every((v,i)=>v===[...b].sort((x,y)=>x-y)[i]);
  const benchMatches=!existingLock.benchIds||!current.benchIds||existingLock.benchIds.length===current.benchIds.length&&existingLock.benchIds.every((id,index)=>id===current.benchIds![index]);
  return sameIds(existingLock.xiIds,current.xiIds)&&benchMatches&&existingLock.captainId===current.captainId&&existingLock.viceId===current.viceId?"matches":"mismatch";
}

export type ChipHorizonRow={eventId:number;scores:ChipScores};

export type ChipVerdictResult={label:string;ready:boolean;detail:string};

// Pure so "is a better chip window coming soon" is directly unit-testable (tests/dgw.test.mts)
// without rendering or the expensive chipScoresForEvent computation -- the caller runs that once
// per event in the horizon and passes the already-scored rows in. rows[0] is always the current
// event; a later event only overrides the verdict if it clears the SAME chip's score by a real
// margin (>1pt), not a rounding-noise difference.
export function chipVerdictAcrossHorizon(rows:ChipHorizonRow[]):ChipVerdictResult{
  if(!rows.length)return{label:"SAVE",ready:false,detail:"No upcoming gameweek data available."};
  const current=rows[0];
  const keys=["wildcard","freeHit","benchBoost","tripleCaptain"] as const;
  const labels={wildcard:"WILDCARD",freeHit:"FREE HIT",benchBoost:"BENCH BOOST",tripleCaptain:"TRIPLE CAPTAIN"};
  const bestKey=keys.reduce((best,k)=>current.scores[k].score>current.scores[best].score?k:best,"wildcard" as const);
  const bestLabel=labels[bestKey];
  const currentScore=current.scores[bestKey].score;
  const betterLater=rows.slice(1).filter(r=>r.scores[bestKey].score>currentScore+1).sort((a,b)=>b.scores[bestKey].score-a.scores[bestKey].score)[0];
  if(currentScore>=8&&!betterLater)return{label:bestLabel,ready:true,detail:`${bestLabel} scores ${currentScore}/10 this week`};
  if(betterLater)return{label:"SAVE",ready:false,detail:`A better ${bestLabel} window is coming in GW${betterLater.eventId} (${betterLater.scores[bestKey].score}/10 vs ${currentScore}/10 now)`};
  return{label:"SAVE",ready:false,detail:`${bestLabel} scores ${currentScore}/10 this week`};
}

export type CaptainRiskNote={message:string;captainStartPct:number;viceStartPct:number;pointsIfCaptainPlays:number;pointsIfArmbandPasses:number};

// Reuses the exact 68% risk threshold Final Check's own RISK FLAGS section and the flagged
// pitch-button styling already use (startPct(...)<68), rather than inventing a new number.
// Combines the vice-safety-net signal and the explicit FPL autosub-for-captaincy rule into one
// note: if the captain records zero minutes, the armband passes to vice and VICE's score is
// doubled instead -- not the captain's, and not triggered by merely playing a few minutes.
// startProbability is used as an approximate proxy for "risk of playing zero minutes" since the
// engine has no direct P(zero minutes) figure; the UI text says "if they don't play at all" rather
// than overclaiming precision the model doesn't have.
// Resolved (Feature #7 revision, PlannedChip): FinalCheck now passes the real multiplier in --
// x3 when the manager has explicitly planned Triple Captain for this event (PlannedChip, via
// plannedChipFor), x2 otherwise. Deliberately still not chipVerdictAcrossHorizon's *recommendation*
// -- that stays a suggestion, never silently assumed as the manager's actual decision. The multiplier
// only ever comes from a confirmed local plan or (after the deadline) real official data.
// multiplier defaults to the standard armband x2 -- a planned Triple Captain (see FinalCheck's own
// captainMultiplier, resolved from PlannedChip) passes 3 instead, since the multiplier belongs to
// whoever ends up holding the armband, not specifically to the captain: if the armband passes to
// vice under a planned Triple Captain, vice's total is tripled too, not just doubled.
export function captainRiskNote(captain:FplPlayer,vice:FplPlayer,captainStartPct:number,viceStartPct:number,captainXPts:number,viceXPts:number,multiplier=2):CaptainRiskNote|null{
  if(captainStartPct>=68)return null;
  const pointsIfCaptainPlays=captainXPts*multiplier;
  const pointsIfArmbandPasses=viceXPts*multiplier;
  const viceAlsoAtRisk=viceStartPct<68;
  const message=`${captain.name} carries real doubt this week (${captainStartPct}% start probability). If they don't play at all, the armband passes to ${vice.name} and your week swings from ${pointsIfCaptainPlays.toFixed(1)} to ${pointsIfArmbandPasses.toFixed(1)} captained points${viceAlsoAtRisk?` — and ${vice.name} isn't nailed either, at ${viceStartPct}% start probability`:""}.`;
  return{message,captainStartPct,viceStartPct,pointsIfCaptainPlays,pointsIfArmbandPasses};
}

/** Runs once per GW when Final Check has a complete analysis — stores pre-deadline receipt if missing. */
function AutoProjectionSnapshot({enabled,run}:{enabled:boolean;run:()=>void}){
  const runRef=useRef(run);runRef.current=run;
  useEffect(()=>{
    if(!enabled)return;
    let cancelled=false;
    const kick=()=>{if(!cancelled)runRef.current()};
    const idle=typeof requestIdleCallback==="function"?requestIdleCallback(kick,{timeout:4000}):window.setTimeout(kick,800);
    return()=>{cancelled=true;if(typeof cancelIdleCallback==="function"&&typeof idle==="number"){try{cancelIdleCallback(idle as number)}catch{window.clearTimeout(idle as number)}}else window.clearTimeout(idle as number)};
  },[enabled]);
  return null;
}

export function FinalCheck({data,go,revision,onTeamChange}:{data:FplData;go:(v:View)=>void;revision:number;onTeamChange:()=>void}){
  const[meta,setMeta]=useManager(revision);
  const squad=useMemo(()=>savedSquad(data),[data,revision,meta]);
  const a=analysis(data,squad);
  const[lockVersion,setLockVersion]=useState(0);
  const[lockError,setLockError]=useState("");
  const players=a?.xi.players??[];
  const ranked=[...players].sort((x,y)=>a?playerProjection(y,a.first,data.fixtures,a.first)-playerProjection(x,a.first,data.fixtures,a.first):0);
  const captaincy=useCaptaincy(players,a?.first??0,a?.xi.captain??ranked[0],ranked[1]);
  if(!a)return <><ConnectTeam data={data} onConnected={m=>{setMeta(m);onTeamChange()}}/><button className="wide-action" onClick={()=>go("draft")}>Build a team first →</button></>;
  const{captain,vice,chooseCaptain,chooseVice}=captaincy;
  const plannedChips=readPlannedChips();
  const plannedChip=plannedChipFor(plannedChips,a.first);
  const xiBase=a.xi.players.reduce((s,p)=>s+playerProjection(p,a.first,data.fixtures,a.first),0);
  const captainTerm=playerProjection(captain,a.first,data.fixtures,a.first);
  const viceTerm=playerProjection(vice,a.first,data.fixtures,a.first);
  // Same chip-bonus reasoning as Overview's own `projected` -- one added term for a planned Triple
  // Captain/Bench Boost, matching evaluateProjectionReceipt's real-chip reconciliation formula.
  const chipBonus=plannedChip==="Triple Captain"?captainTerm:plannedChip==="Bench Boost"?a.bench.reduce((s,p)=>s+playerProjection(p,a.first,data.fixtures,a.first),0):0;
  const predicted=xiBase+captainTerm+chipBonus;
  // A planned Triple Captain makes the x3 branch of resolveCaptainMultiplier honestly reachable
  // pre-deadline -- the standing decision below (captainRiskNote always swinging at x2) is resolved
  // by this exact PlannedChip check, not by reaching for chipVerdictAcrossHorizon's recommendation.
  const captainMultiplier=plannedChip==="Triple Captain"?3:2;
  const xiIds=a.xi.players.map(p=>p.id);
  const benchIds=a.bench.map(p=>p.id);
  let existingLocks:LockRecord[]=[];try{existingLocks=JSON.parse(localStorage.getItem("fpl-edge-locks")||"[]")}catch{}
  const existingLock=existingLocks.find(l=>l.event===a.first);
  const lockStatus=reconcileLock(existingLock,{xiIds,benchIds,captainId:captain.id,viceId:vice.id});
  const locked=lockStatus==="matches";
  const fullReceiptSaved=locked&&existingLock?.receipt?.modelVersion===PROJECTION_MODEL_VERSION&&existingLock.receipt.schemaVersion===8&&existingLock.receipt.dataUpdatedAt===data.updatedAt;
  const lock=(source:"manual"|"auto"="manual")=>{
    setLockError("");
    const event=data.events.find(item=>item.id===a.first),capturedAt=new Date().toISOString();
    if(!event||Date.parse(capturedAt)>=Date.parse(event.deadline)){if(source==="manual")setLockError("The official deadline has passed. A pre-deadline receipt was not created.");return}
    let locksNow:LockRecord[]=[];try{locksNow=JSON.parse(localStorage.getItem("fpl-edge-locks")||"[]")}catch{}
    const currentLock=locksNow.find(item=>item.event===a.first);
    // Auto-snapshots only fill a missing current-model receipt; never overwrite a manual or existing receipt.
    if(source==="auto"&&currentLock?.receipt?.modelVersion===PROJECTION_MODEL_VERSION&&currentLock.receipt.schemaVersion===8)return;
    try{
      const freeTransfers=readFreeTransfers();
      const finance=deriveSandboxFinancialContext(squad,data.rules.budget,meta);
      const bank=finance.baselineBank;
      const baseRows=bestTransfers(data,squad,bank,freeTransfers,60,finance.baselineSellingPrices);
      const transferRows=withModelUtilityChange(baseRows,squad,createOptimizer(data,"Balanced 5 GWs","Balanced","Maximum xPts"));
      const routeRows=solveTransferRoutes(data,squad,bank,{horizon:5,freeTransfers,maxWeeklyHit:4,sellingPrices:finance.baselineSellingPrices,resultLimit:4,plannedChips});
      const receipt=createProjectionReceipt({data,eventIds:a.events.slice(0,5).map(item=>item.id),deadline:event.deadline,capturedAt,squad,xiIds,benchIds,captainId:captain.id,viceId:vice.id,bank,freeTransfers,transferRows,routeRows,plannedChip});
      const record:LockRecord={event:a.first,lockedAt:capturedAt,dataUpdatedAt:data.updatedAt,predicted:receipt.squad.predictedTotal,squadIds:squad.map(p=>p.id),xiIds,benchIds,captainId:captain.id,viceId:vice.id,receipt,source};
      persist("fpl-edge-locks",JSON.stringify([...locksNow.filter(item=>item.event!==a.first),record]));setLockVersion(v=>v+1);
      track("lock_created",{gw:a.first,mode:source,source:isExampleSquadActive()?"demo":"real"});
    }catch(error){if(source==="manual")setLockError(error instanceof Error?error.message:"Could not create the projection receipt.")}
  };

  const autoSnapshotEnabled=!fullReceiptSaved&&!!data.events.find(item=>item.id===a.first&&Date.parse(item.deadline)>Date.now());
  const runAutoSnapshot=()=>lock("auto");
  const modelCaptain=a.xi.captain;
  const captainDisagreement=modelCaptain&&modelCaptain.id!==captain.id?modelCaptain:null;
  const riskNote=captainRiskNote(captain,vice,startPct(captain,a.first,data),startPct(vice,a.first,data),captainTerm,viceTerm,captainMultiplier);
  const chipHorizon=a.events.slice(0,5);
  const chipRows=chipHorizon.map((event,index)=>({eventId:event.id,scores:chipScoresForEvent(data,squad,event,chipHorizon.slice(index,index+5).map(e=>e.id),true)}));
  const chip=chipVerdictAcrossHorizon(chipRows);
  return <div className="coach-page">
    <section className="lock-header"><div><span>LOCK-IN</span><h2>Your exact deadline plan.</h2><p>Generated from your saved squad and the latest official FPL feed.</p></div><div><b>{formation(a.xi.players)}</b><small>formation · {predicted.toFixed(1)} xPts{plannedChip==="Triple Captain"?" + Triple Captain":plannedChip==="Bench Boost"?" + Bench Boost":""}</small></div></section>
    {lockStatus==="mismatch"&&existingLock&&<div className="lock-mismatch-banner"><b>⚠ Your locked plan differs from the current recommendation.</b><p>Locked {new Date(existingLock.lockedAt).toLocaleString([],{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})} · projected {existingLock.predicted.toFixed(1)} pts. Review before the deadline, or press Lock This Team again to update it.</p></div>}
    <CaptaincyPicker players={a.xi.players} captain={captain} vice={vice} onCaptain={chooseCaptain} onVice={chooseVice} event={a.first} data={data}/>
    {captainDisagreement&&<p className="captain-model-note">Model recommends <b>{captainDisagreement.name}</b> ({playerProjection(captainDisagreement,a.first,data.fixtures,a.first).toFixed(1)} xPts) over your pick <b>{captain.name}</b> ({playerProjection(captain,a.first,data.fixtures,a.first).toFixed(1)} xPts).</p>}
    {riskNote&&<div className="captain-risk-note"><b>⚠ {riskNote.message}</b></div>}
    <Pitch players={a.xi.players} bench={a.bench} captain={captain} vice={vice} event={a.first} data={data} onSelect={()=>{}}/>
    <section className="bench-order-card"><header><div><span>AUTOSUB-AWARE BENCH</span><h2>Bench order chosen for what can actually come on.</h2></div><strong>{a.benchOrder.expectedAutosubPoints.toFixed(2)}<small>expected autosub pts</small></strong></header><div>{a.bench.map((player,index)=>{const metrics=projectionMetrics(player,a.first,data.fixtures,a.first),appearance=modeledAppearanceProbability(player,metrics);return <article key={player.id}><i>{player.positionShort==="GKP"?"GK":index+1}</i><div><b>{player.name}</b><small>{player.positionShort==="GKP"?"Separate goalkeeper replacement rule":`${Math.round(appearance*100)}% appearance proxy · ${metrics.xPts.toFixed(1)} xPts`}</small></div></article>})}</div><footer>All six outfield orders are tested across {a.benchOrder.scenarios.toLocaleString()} appearance combinations while enforcing at least 3 DEF, 2 MID and 1 FWD. {a.benchOrder.improvement>.005?`This order adds ${a.benchOrder.improvement.toFixed(2)} expected autosub points versus simple xPts sorting.`:"The simple xPts order already survives the formation and availability test."}</footer></section>
    <div className="lock-summary">
      <article><span>CAPTAIN</span><b>{captain.name}</b><small>{playerProjection(captain,a.first,data.fixtures,a.first).toFixed(1)} xPts</small></article>
      <article><span>VICE</span><b>{vice.name}</b><small>{playerProjection(vice,a.first,data.fixtures,a.first).toFixed(1)} xPts</small></article>
      <article><span>TRANSFER</span><b>Review Transfer Centre</b><small>never inferred without your FT count</small></article>
      <article><span>CHIP</span><b>{chip.ready?`PLAY ${chip.label}`:"SAVE"}</b><small>{chip.detail}</small></article>
    </div>
    <section className="deadline-grid"><article><span>LATEST TEAM NEWS</span>{squad.filter(p=>p.news||p.status!=="a").length?squad.filter(p=>p.news||p.status!=="a").map(p=><p key={p.id}><b>{p.name}</b> · {p.news||"Officially flagged"}</p>):<p>No official squad-specific news.</p>}</article><article><span>RISK FLAGS</span>{a.issues.length?a.issues.map(p=><p key={p.id}><b>{p.name}</b> · {startPct(p,a.first,data)}% start probability</p>):<p>No player is below the 68% start threshold.</p>}</article></section>
    <CaptainCompare xi={a.xi.players} captain={captain} vice={vice} data={data} event={a.first}/>
    {autoSnapshotEnabled&&<AutoProjectionSnapshot enabled={autoSnapshotEnabled} run={runAutoSnapshot}/>}{lockError&&<p className="lock-error">{lockError}</p>}
    <button className={`lock-button ${fullReceiptSaved?"locked":""}`} onClick={()=>lock("manual")}>{fullReceiptSaved?"FULL RECEIPT SAVED ✓":locked?"REFRESH FULL RECEIPT":"LOCK THIS TEAM"}<small>{fullReceiptSaved?`${existingLock!.receipt!.players.length} player projections · ${existingLock!.receipt!.transfers.length} single moves · ${existingLock!.receipt!.routes?.length??0} complete routes · ${existingLock!.receipt!.modelVersion}`:"Save the XI, captaincy, every player projection and complete transfer routes before the deadline. A background snapshot also runs automatically each GW when this page opens."}</small></button>
  </div>;
}

function CaptainCompare({xi,captain,vice,data,event}:{xi:FplPlayer[];captain:FplPlayer;vice:FplPlayer;data:FplData;event:number}){
  const players=[captain,vice];
  const candidates:CaptainCandidate[]=xi.map(p=>{
    const m=projectionMetrics(p,event,data.fixtures,event);
    const{ret,haul}=captainReturnHaul(m,p.positionShort);
    return{id:p.id,name:p.name,xPts:m.xPts,ret,haul,startProbability:m.startProbability,selectedBy:p.selectedBy};
  });
  const framing=captaincyRiskFraming(candidates,captain.id);
  const defaultCandidate=candidates.find(c=>c.id===captain.id)!;
  const roleLabel=framing.defaultRole==="safe"?`${captain.name} is both your model pick and the safest option in your XI this week.`:framing.defaultRole==="differential"?`${captain.name} is both your model pick and the highest-ceiling differential in your XI this week.`:`${captain.name} is a balanced pick — not the safest floor or the highest ceiling in your XI, just the highest projected points.`;
  const sameAlternative=framing.safeAlternative&&framing.differentialAlternative&&framing.safeAlternative.id===framing.differentialAlternative.id;
  return <section className="captain-compare">
    <header><span>CAPTAIN COMPARISON</span><h2>{players.map(p=>p.name).join(" vs ")}</h2></header>
    <div>{players.map(p=>{const m=projectionMetrics(p,event,data.fixtures,event);const{ret,haul}=captainReturnHaul(m,p.positionShort);return <article key={p.id}><h3>{p.name}<small>{opponent(p,event,data)}</small></h3><p><span>xPts</span><b>{m.xPts.toFixed(1)}</b></p><p><span>Projected minutes</span><b>{Math.round(m.expectedMinutes)}</b></p><p><span>Return probability</span><b>{Math.round(ret)}%</b></p><p><span>Haul probability</span><b>{Math.round(haul)}%</b></p><p><span>Ownership</span><b>{p.selectedBy.toFixed(1)}%</b></p><p><span>Risk</span><b>{m.startProbability>.8?"Low":m.startProbability>.65?"Medium":"High"}</b></p></article>})}</div>
    <div className="captain-risk-framing">
      <span>RISK PROFILE</span>
      <p>{roleLabel}</p>
      {sameAlternative&&<p><b>{framing.safeAlternative!.name}</b> is worth weighing — both a safer floor ({Math.round(framing.safeAlternative!.ret)}% return probability vs {Math.round(defaultCandidate.ret)}%) and a higher-ceiling differential ({Math.round(framing.safeAlternative!.haul)}% haul probability vs {Math.round(defaultCandidate.haul)}%, owned by {framing.safeAlternative!.selectedBy.toFixed(1)}%).</p>}
      {!sameAlternative&&framing.safeAlternative&&<p><b>{framing.safeAlternative.name}</b> is a safer floor: {Math.round(framing.safeAlternative.ret)}% return probability vs {Math.round(defaultCandidate.ret)}% for {captain.name}, at {Math.round(framing.safeAlternative.startProbability*100)}% start probability.</p>}
      {!sameAlternative&&framing.differentialAlternative&&<p><b>{framing.differentialAlternative.name}</b> is a differential ceiling play: {Math.round(framing.differentialAlternative.haul)}% haul probability vs {Math.round(defaultCandidate.haul)}% for {captain.name}, owned by only {framing.differentialAlternative.selectedBy.toFixed(1)}% — at the cost of {Math.round(defaultCandidate.ret-framing.differentialAlternative.ret)} points lower return probability.</p>}
    </div>
  </section>;
}
