"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FplData as Data, FplPlayer as Player, futureEvents, isCompleteSquad, playerCalibrationProfile, playerProjection, projectionMetrics } from "../lib/fpl";
import { HorizonMode, RiskMode, SquadEvaluation, SquadPhilosophy, createOptimizer, validateSquadEvaluation } from "../lib/optimizer";
import { persist, readFreeTransfers } from "../lib/persistence";
import { blankProbability, haulProbability, playerPointsDistribution, pointsRange } from "../lib/projection-distribution";
import { TRANSFER_ACTION_THRESHOLD, evaluateTransferQuality, transferHitCost } from "../lib/transfer-quality";
import { transferAnomalies } from "../lib/anomalies";
import { bestTransfers, evaluateTransfer, selectPrimaryTransfer } from "../lib/transfers";
import { ManagerMeta, SandboxFinancialContext, SandboxState, applySandboxTransfer, calculateSandboxFinances, createSandboxState, deriveSandboxFinancialContext, evaluateSandbox, resetSandbox, sandboxEconomics, undoSandboxTransfer } from "../lib/squad-comparison";
import Pitch from "./Pitch";
import SandboxImpactPanel from "./SandboxImpactPanel";

// Shared by the List tab (standalone) and the Report tab (alongside Budget/Strategy in the same
// optimizer-grid) so the XI/bench summary exists in exactly one place, not two copies of the same
// markup reading the same week.
function XiBenchCards({week}:{week:{xi:Player[];bench:Player[];formation:string;captain:Player;vice:Player}}){
  return <><article><span>GW1 STARTING XI</span><h3>{week.formation}</h3><p>{week.xi.map(p=>p.name).join(" · ")}</p><b>Captain: {week.captain.name}</b><small>Vice: {week.vice.name}</small></article><article><span>BENCH ORDER</span><h3>{week.bench.map((p,i)=>`${i+1}. ${p.name}`).join(" · ")}</h3><p>Bench utility is discounted by order; it is not valued like the XI.</p></article></>;
}

export function BuilderPitchPlayerCard({player,projectedPoints,complete,selected,swapTarget,showPin,pinned,onSelect,onTogglePin,onRemove}:{
  player:Player;projectedPoints:string;complete:boolean;selected:boolean;swapTarget:boolean;showPin:boolean;pinned:boolean;
  onSelect:()=>void;onTogglePin:()=>void;onRemove:()=>void;
}){
  return <article className={`${selected?"selected-player":""} ${swapTarget?"swap-target":""}`.trim()}><button type="button" className="player-transfer-select" aria-label={complete?`Select ${player.name} for transfer`:`Select ${player.name}`} onClick={onSelect}><div className="mini-shirt">{player.positionShort}</div><b>{player.name}</b><small>{player.teamShort} · £{player.price.toFixed(1)}m</small><span>{projectedPoints} xPts</span></button>{showPin&&<button type="button" className={`pin-toggle ${pinned?"active":""}`} aria-label={`${pinned?"Unpin":"Pin"} ${player.name}`} onClick={onTogglePin}>{pinned?"Pinned":"Pin"}</button>}<button type="button" className="remove-player" aria-label={`Remove ${player.name}`} onClick={onRemove}>×</button></article>;
}

// Search-space concern, not a scoring concern: optimize() and optimizeConstrained() both call the
// same evaluate() closure (which already bakes in horizonMode/riskMode/philosophy) -- these three
// modes only change WHICH candidate squads get generated and scored, never how a given squad is
// scored. Re-confirmed directly against the final optimizer.ts implementation, not just the
// design-checkpoint's intent, before wiring this up.
type ResultMode="Pure Optimum"|"Practical Upgrade"|"Keep Core";
// "2-3 player changes" from the original spec -- fixed at the top of that range rather than a user
// toggle. Phase 2 measured this as ~260ms/~773 evaluate() calls against a 20-item shortlist, well
// under what "Build best squad" already costs for Pure Optimum (~2.9s) -- no latency reason to
// default lower, and a fixed default keeps this round's scope to wiring, not a new settings control.
const PRACTICAL_UPGRADE_MAX_CHANGES=3;
// Keep Core's "no cap" from the design round is not literally achievable through this combinatorial
// engine (see optimizer.ts) -- 4 is the agreed pragmatic bound. Every UI string describing this mode
// says "up to 4 simultaneous changes", never "unlimited".
const KEEP_CORE_MAX_CHANGES=4;

// Unifies optimize()'s OptimizedResult and optimizeConstrained()'s ConstrainedOptimizeResult into one
// shape the rest of this component can read regardless of which search produced it. nearMisses is an
// empty array for Practical Upgrade/Keep Core, not computed -- it is a Pure Optimum-specific,
// expensive (thousands of evaluate() calls) affordance for "what did an exhaustive rebuild reject",
// a question that doesn't cleanly apply to a bounded, constrained search; the Report tab shows an
// explicit empty state rather than silently rendering nothing. explanations is always populated via
// optimizer.explainSquad(), which is cheap (15 metrics() lookups) and mode-agnostic.
type OptimizedState={squad:Player[];evaluation:SquadEvaluation;nearMisses:{player:Player;difference:number;reason:string}[];explanations:Record<number,string[]>};

// Snapshot of the four inputs optimized was actually built under, captured alongside it in
// buildBestSquad(). horizon/risk/philosophy used to invalidate optimized "for free" when it was a
// useMemo keyed on [optimizer] (which is itself rebuilt from these three) -- now that optimized is
// explicit state, changing any of the four leaves it silently frozen until the next click. That's
// the correct tradeoff for Result Mode (explicit recompute was the whole point), but a real
// regression for horizon/risk/philosophy, which used to update live. staleFields (below, at render)
// names exactly which of the four differ, rather than a generic "may be outdated".
type OptimizedSettings={horizonMode:HorizonMode;riskMode:RiskMode;philosophy:SquadPhilosophy;resultMode:ResultMode};

// Pure mapping from Result Mode (+ pins) to which optimizer function buildBestSquad() should call and
// with what arguments -- extracted so this dispatch can be unit tested directly (node:test has no
// React rendering harness in this project; every existing test imports pure functions straight out of
// a component file, e.g. tests/projection-engine.test.mts importing analysis/bestTransfers out of
// CoachApp.tsx), rather than only being exercised indirectly through a click handler.
export type ResultModeDispatch={kind:"optimize"}|{kind:"optimizeConstrained";maxChanges:number;lockedPlayerIds:Set<number>};
export function resolveResultModeDispatch(resultMode:ResultMode,pinnedIds:Set<number>):ResultModeDispatch{
  if(resultMode==="Practical Upgrade")return{kind:"optimizeConstrained",maxChanges:PRACTICAL_UPGRADE_MAX_CHANGES,lockedPlayerIds:new Set()};
  if(resultMode==="Keep Core")return{kind:"optimizeConstrained",maxChanges:KEEP_CORE_MAX_CHANGES,lockedPlayerIds:pinnedIds};
  return{kind:"optimize"};
}

// Pure validation core of a pitch-click swap, extracted so each rejection path is directly unit
// tested (not just exercised by clicking through the UI) -- same discipline already applied to
// resolveResultModeDispatch above and the optimizer's own validateSquadEvaluation/constrained tests.
// Checked against `rest` (squad with outPlayer already excluded), not the full squad, for club limit
// and budget -- checking against the full squad would wrongly block a same-club/at-cap swap, since
// the outgoing player would still be counted against their own replacement.
export type SwapValidation={ok:true}|{ok:false;reason:"position"|"owned"|"unavailable"|"club-limit"|"budget";message:string};
export function validateSwap(squad:Player[],outPlayer:Player,incoming:Player,rules:{budget:number;teamLimit:number},finance?:{baselineSquad:Player[];financialContext:SandboxFinancialContext}):SwapValidation{
  if(incoming.positionId!==outPlayer.positionId)return{ok:false,reason:"position",message:`${incoming.name} plays a different position and cannot replace ${outPlayer.name}.`};
  const rest=squad.filter(p=>p.id!==outPlayer.id);
  if(rest.some(p=>p.id===incoming.id))return{ok:false,reason:"owned",message:`${incoming.name} is already in your squad.`};
  if(incoming.status==="u")return{ok:false,reason:"unavailable",message:`${incoming.name} is unavailable and cannot be selected.`};
  if(rest.filter(p=>p.teamId===incoming.teamId).length>=rules.teamLimit)return{ok:false,reason:"club-limit",message:`Maximum ${rules.teamLimit} players from ${incoming.teamName}.`};
  const baselineSquad=finance?.baselineSquad??squad;
  const financialContext=finance?.financialContext??deriveSandboxFinancialContext(baselineSquad,rules.budget,null);
  const proposedSquad=squad.map(player=>player.id===outPlayer.id?incoming:player);
  const finances=calculateSandboxFinances(financialContext,baselineSquad,proposedSquad);
  if(!finances.affordable)return{ok:false,reason:"budget",message:`That final sandbox squad exceeds the available bank and selling value.`};
  return{ok:true};
}

export default function LiveDraftBuilder({ explorer = false }: { explorer?: boolean }) {
  const [data,setData]=useState<Data|null>(null); const [error,setError]=useState(""); const [loading,setLoading]=useState(true);
  const [squad,setSquad]=useState<Player[]>([]); const [query,setQuery]=useState(""); const [position,setPosition]=useState("ALL"); const [team,setTeam]=useState("ALL");
  const [message,setMessage]=useState("Start from an empty squad or let the model build all 15 players.");
  const [teamId,setTeamId]=useState(""); const [importing,setImporting]=useState(false); const [savedAt,setSavedAt]=useState<string|null>(null);
  const [horizonMode,setHorizonMode]=useState<HorizonMode>("Balanced 5 GWs"); const [riskMode,setRiskMode]=useState<RiskMode>("Balanced"); const [philosophy,setPhilosophy]=useState<SquadPhilosophy>("Maximum xPts"); const [selectedInsight,setSelectedInsight]=useState<number|null>(null);
  const [resultTab,setResultTab]=useState<"pitch"|"list"|"report">("pitch");
  const [resultMode,setResultMode]=useState<ResultMode>("Pure Optimum");
  const [managerMeta,setManagerMeta]=useState<ManagerMeta|null>(null);
  // Session-level editing state, not a saved preference -- deliberately not persisted alongside
  // squad/free-transfers. Only read when resultMode is "Keep Core".
  const [pinnedIds,setPinnedIds]=useState<Set<number>>(new Set());
  const togglePin=(id:number)=>setPinnedIds(prev=>{const next=new Set(prev);next.has(id)?next.delete(id):next.add(id);return next});
  // Which pitch player is currently being replaced (null = no swap in progress). Only settable once
  // the squad is complete -- optimizer.evaluate()'s before/after utility comparison in swap() below
  // needs both squads to be complete to mean anything, matching manualEvaluation's own complete gate.
  const [swapOutId,setSwapOutId]=useState<number|null>(null);
  // Session-only sandbox state. It stores squad snapshots and transfer pairs, never copied score
  // numbers; all latest/cumulative evaluations below are recalculated through the active optimizer.
  const [sandbox,setSandbox]=useState<SandboxState|null>(null);
  const poolRef=useRef<HTMLElement>(null);
  const searchRef=useRef<HTMLInputElement>(null);
  const load = async () => { setLoading(true); setError(""); try { const response=await fetch(`/api/fpl?refresh=${Date.now()}`,{cache:"no-store"}); const json=await response.json(); if(!response.ok) throw new Error(json.error||"Could not load FPL data"); let restored:Player[]=[];let restoredManager:ManagerMeta|null=null;try{const ids:number[]=JSON.parse(localStorage.getItem("fpl-edge-squad")||"[]");restored=ids.map(id=>json.players.find((p:Player)=>p.id===id)).filter(Boolean);restoredManager=JSON.parse(localStorage.getItem("fpl-edge-manager")||"null");const stamp=localStorage.getItem("fpl-edge-squad-saved-at");if(stamp)setSavedAt(new Date(stamp).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}))}catch{} setSquad(restored);setManagerMeta(restoredManager);setSandbox(null);setSwapOutId(null);setData(json); } catch(e){setError(e instanceof Error?e.message:"Could not load FPL data");} finally{setLoading(false);} };
  useEffect(()=>{load();},[]);
  const events=useMemo(()=>data?futureEvents(data,horizonMode==="Long-term 8 GWs"?8:horizonMode==="Next 3 GWs"?3:5):[],[data,horizonMode]);
  const eventIds=useMemo(()=>events.map(e=>e.id),[events]);
  const optimizer=useMemo(()=>data&&eventIds.length?createOptimizer(data,horizonMode,riskMode,philosophy):null,[data,horizonMode,riskMode,philosophy,eventIds]);
  // Rating/component comparisons must match the visible active-horizon evaluation, while the impact
  // panel must still show all of the next five actually available GWs when "Next 3 GWs" is selected.
  // A second instance of the SAME optimizer supplies only those full-horizon week plans; no alternate
  // projection or rating formula is introduced.
  const fiveWeekOptimizer=useMemo(()=>data&&futureEvents(data,5).length?createOptimizer(data,"Balanced 5 GWs",riskMode,philosophy):null,[data,riskMode,philosophy]);
  const freeTransfers=readFreeTransfers();
  // Not a useMemo keyed on [optimizer] anymore -- Practical Upgrade/Keep Core take the CURRENT squad
  // as a search input, which optimize() never needed (it always starts from cheapest()). Recomputing
  // reactively on every squad edit would be expensive (Pure Optimum alone runs up to ~12.5k evaluate()
  // calls) and semantically odd for a constrained search reacting to its own output. Computed
  // explicitly from a squad snapshot inside buildBestSquad()'s "Build best squad" click handler;
  // switching horizon/risk/philosophy/Result Mode alone does not recompute it.
  const [optimized,setOptimized]=useState<OptimizedState|null>(null);
  const [optimizedSettings,setOptimizedSettings]=useState<OptimizedSettings|null>(null);
  const modelSquad=optimized?.squad??[];
  const staleFields=optimized&&optimizedSettings?[
    optimizedSettings.horizonMode!==horizonMode?`Time Horizon (built with ${optimizedSettings.horizonMode}, now ${horizonMode})`:null,
    optimizedSettings.riskMode!==riskMode?`Risk Profile (built with ${optimizedSettings.riskMode}, now ${riskMode})`:null,
    optimizedSettings.philosophy!==philosophy?`Squad Philosophy (built with ${optimizedSettings.philosophy}, now ${philosophy})`:null,
    optimizedSettings.resultMode!==resultMode?`Result Mode (built with ${optimizedSettings.resultMode}, now ${resultMode})`:null,
  ].filter((x):x is string=>x!==null):[];
  // isCompleteSquad, not the stricter isValidSquad -- a squad imported here via "Fetch my squad"
  // (a real, live account) can legitimately be worth more than £100m today due to price rises since
  // it was assembled. Manual construction can never exceed budget in the first place (add() below
  // already blocks that at add-time), so relaxing this check only affects imported real squads, which
  // is exactly the case that needs it.
  const complete=!!data&&isCompleteSquad(squad,data); const cost=squad.reduce((sum,p)=>sum+p.price,0);
  const financialContext=useMemo(()=>data?(sandbox?.financialContext??deriveSandboxFinancialContext(squad,data.rules.budget,managerMeta)):null,[data,sandbox,squad,managerMeta]);
  const currentFinances=financialContext?calculateSandboxFinances(financialContext,sandbox?.baselineSquad??squad,squad):null;
  const bank=Math.max(0,currentFinances?.finalBank??0);
  const buildBestSquad=()=>{
    if(!optimizer)return;
    if(resultMode!=="Pure Optimum"&&!complete){setMessage(`${resultMode} builds from your current squad — complete all 15 slots first, or switch to Pure Optimum.`);return;}
    const snapshot=squad;
    const dispatch=resolveResultModeDispatch(resultMode,pinnedIds);
    let nextOptimized:OptimizedState;let modeLabel:string;
    if(dispatch.kind==="optimizeConstrained"){
      const result=optimizer.optimizeConstrained(snapshot,{maxChanges:dispatch.maxChanges,lockedPlayerIds:dispatch.lockedPlayerIds});
      nextOptimized={squad:result.squad,evaluation:result.evaluation,nearMisses:[],explanations:optimizer.explainSquad(result.squad)};
      modeLabel=resultMode==="Keep Core"?`Keep Core protected ${pinnedIds.size} pinned player${pinnedIds.size===1?"":"s"} and searched up to ${dispatch.maxChanges} simultaneous changes among the rest (${result.changes.length} applied).`:`Practical Upgrade searched up to ${dispatch.maxChanges} simultaneous changes from your current squad (${result.changes.length} applied).`;
    }else{
      const result=optimizer.optimize();
      nextOptimized={squad:result.squad,evaluation:result.evaluation,nearMisses:result.nearMisses,explanations:result.explanations};
      modeLabel=`${horizonMode} · ${riskMode} · ${philosophy} squad built with a coordinated near-exact search.`;
    }
    setOptimized(nextOptimized);setOptimizedSettings({horizonMode,riskMode,philosophy,resultMode});setSquad(nextOptimized.squad);setSavedAt(null);setSelectedInsight(nextOptimized.squad[0]?.id??null);setSwapOutId(null);setSandbox(null);setMessage(`${modeLabel} Press Save squad to keep it.`);
  };
  const manualEvaluation=useMemo(()=>complete&&optimizer?optimizer.evaluate(squad):null,[complete,optimizer,squad]);
  const sandboxComparisons=useMemo(()=>sandbox&&optimizer?evaluateSandbox(sandbox,optimizer.evaluate,fiveWeekOptimizer?.evaluate??optimizer.evaluate):null,[sandbox,optimizer,fiveWeekOptimizer]);
  const latestSandboxTransfer=useMemo(()=>{
    const entry=sandbox?.history.at(-1);
    if(!data||!entry||!sandboxComparisons||!eventIds.length)return null;
    const economics=sandboxEconomics(sandboxComparisons,freeTransfers);
    const transfer=evaluateTransfer(data,entry.beforeSquad,entry.out,entry.incoming,freeTransfers,economics.incrementalHitChange);
    return{...transfer,utilityChange:sandboxComparisons.latest.objective.delta};
  },[data,sandbox,sandboxComparisons,freeTransfers,eventIds]);
  // Reuses the Transfers page's own single-transfer engine (whole-squad re-optimized ranking, the
  // full quality gate, real hit cost) instead of deriving a single "best move" from the diff-based
  // recommendedChanges mechanism below, which has no cheap way to re-run squad-level XI optimization
  // per candidate swap and falls back to an individual-player gain. Draft Lab has no manager
  // connection, so sellingPrices defaults to empty (falls back to p.price on both legs) -- the same
  // simplification recommendedChanges already has; this still gains everything else bestTransfers
  // offers for free, and would pick up real selling prices automatically if Draft Lab ever becomes
  // manager-connection-aware.
  const bestTransferMoves=useMemo(()=>data&&complete?bestTransfers(data,squad,bank,freeTransfers):[],[data,complete,squad,bank,freeTransfers]);
  const bestTransferRightNow=selectPrimaryTransfer(bestTransferMoves);
  const totals=manualEvaluation?.weeks.slice(0,5).map(week=>week.points)??[];
  const rating=manualEvaluation?.scores.overall??null;
  const consistencyWarnings=useMemo(()=>{if(!data)return[];const warnings:string[]=[];if(manualEvaluation)validateSquadEvaluation(manualEvaluation,squad,data).forEach(w=>warnings.push(`Your squad — ${w}`));if(optimized)validateSquadEvaluation(optimized.evaluation,optimized.squad,data).forEach(w=>warnings.push(`Model suggestion — ${w}`));return warnings;},[manualEvaluation,optimized,squad,data]);
  // Diff between squad and optimized.squad, paired by position (both share the same per-position
  // quota via isCompleteSquad, so this pairing is exact, not approximate). A different computation
  // from solveTransferRoutes -- that's a forward multi-week search from a known starting squad;
  // this is a one-time diff between two already-fully-known squads.
  const recommendedChanges=useMemo(()=>{
    if(!data||!manualEvaluation||!optimized)return null;
    const incomingPlayers=optimized.squad.filter(p=>!squad.some(x=>x.id===p.id));
    const outgoingPlayers=squad.filter(p=>!optimized.squad.some(x=>x.id===p.id));
    const changes=data.rules.positions.flatMap(rule=>{
      const inAtPos=incomingPlayers.filter(p=>p.positionId===rule.id);
      const outAtPos=outgoingPlayers.filter(p=>p.positionId===rule.id);
      return inAtPos.map((incoming,i)=>{
        const out=outAtPos[i];
        if(!out)return null;
        const projected=(player:Player,eventId:number)=>playerProjection(player,eventId,data.fixtures,eventIds[0]);
        const gain1=projected(incoming,eventIds[0])-projected(out,eventIds[0]);
        const gain3=eventIds.slice(0,3).reduce((s,e)=>s+projected(incoming,e)-projected(out,e),0);
        const weeklyGains=eventIds.slice(0,5).map(e=>projected(incoming,e)-projected(out,e));
        const gain5=weeklyGains.reduce((a,b)=>a+b,0);
        const om=projectionMetrics(out,eventIds[0],data.fixtures,eventIds[0]);
        const im=projectionMetrics(incoming,eventIds[0],data.fixtures,eventIds[0]);
        const calibration=playerCalibrationProfile(incoming);
        // gain5 passed to transferAnomalies here is this individual swap's own player-level gain,
        // not a whole-squad re-optimized delta like bestTransfers() on the Transfers page uses --
        // there is no cheap way to re-run the squad-level XI optimization per candidate swap here.
        // The >15pt five-GW anomaly threshold was calibrated against the squad-level number, so it
        // may fire at a different effective rate here; disclosed, not silently assumed equivalent.
        const anomalyCodes=transferAnomalies(out,incoming,gain5,om,im).map(f=>f.code);
        const quality=evaluateTransferQuality({gain1,gain3,gain5,weeklyGains,expectedMinutes:im.expectedMinutes,startProbability:im.startProbability,confidence:im.confidence,calibrationGroup:calibration.group,lowPlContinuityClub:calibration.lowPlContinuityClub,anomalyCodes});
        return{out,incoming,gain5,quality};
      }).filter((x):x is{out:Player;incoming:Player;gain5:number;quality:ReturnType<typeof evaluateTransferQuality>}=>x!==null);
    });
    const rawGain=optimized.evaluation.fiveWeekPoints-manualEvaluation.fiveWeekPoints;
    const hitCost=transferHitCost(changes.length,freeTransfers);
    const netGain=rawGain-hitCost;
    return{changes,rawGain,hitCost,netGain,worthIt:netGain>=TRANSFER_ACTION_THRESHOLD};
  },[data,manualEvaluation,optimized,squad,eventIds,freeTransfers]);
  const teams=useMemo(()=>data?[...new Map(data.players.map(p=>[p.teamId,p.teamName])).entries()].sort((a,b)=>a[1].localeCompare(b[1])):[],[data]);
  const swapOut=squad.find(player=>player.id===swapOutId)??null;
  const poolPosition=swapOut?.positionShort??position;
  const filtered=useMemo(()=>data?.players.filter(p=>(poolPosition==="ALL"||p.positionShort===poolPosition)&&(team==="ALL"||String(p.teamId)===team)&&(`${p.name} ${p.firstName} ${p.secondName}`).toLowerCase().includes(query.toLowerCase())).sort((a,b)=>b.epNext-a.epNext||b.pointsPerGame-a.pointsPerGame).slice(0,explorer?100:60)??[],[data,poolPosition,team,query,explorer]);
  useEffect(()=>{if(!swapOutId)return;searchRef.current?.focus({preventScroll:true});poolRef.current?.scrollIntoView({behavior:"smooth",block:"start"});},[swapOutId]);
  const beginSwap=(player:Player)=>{if(!complete)return;setSelectedInsight(player.id);setPosition(player.positionShort);setQuery("");setTeam("ALL");setSwapOutId(player.id);setMessage(`${player.name} selected. The replacement pool is locked to ${player.positionShort}.`);};
  const add=(player:Player)=>{ if(!data)return; if(squad.some(p=>p.id===player.id))return; const rule=data.rules.positions.find(r=>r.id===player.positionId)!; if(squad.filter(p=>p.positionId===player.positionId).length>=rule.squad){setMessage(`Remove a ${rule.short} before adding another.`);return;} if(squad.filter(p=>p.teamId===player.teamId).length>=data.rules.teamLimit){setMessage(`Maximum ${data.rules.teamLimit} players from ${player.teamName}.`);return;} if(cost+player.price>data.rules.budget+.001){setMessage(`That selection exceeds the £${data.rules.budget.toFixed(1)}m budget.`);return;} setSquad(x=>[...x,player]);setSavedAt(null);setSwapOutId(null);setSandbox(null);setMessage(`${player.name} added from the official FPL list.`); };
  const remove=(id:number)=>{const player=squad.find(p=>p.id===id);setSquad(x=>x.filter(p=>p.id!==id));setSavedAt(null);setPinnedIds(prev=>prev.has(id)?new Set([...prev].filter(x=>x!==id)):prev);setSwapOutId(prev=>prev===id?null:prev);setSandbox(null);if(player)setMessage(`${player.name} removed. Choose a replacement below.`);};
  // Applies a pitch-click swap in one atomic setSquad call (not remove() then add()) so club-limit
  // and budget are validated against the squad with the OUTGOING player already excluded -- checking
  // against the full current squad would wrongly block a same-club swap at the 3-per-club cap, since
  // the outgoing player would still be counted against their own replacement. complete is required
  // (checked by the caller via swapOutId only being settable when complete) so optimizer.evaluate()'s
  // before/after comparison is meaningful on both sides.
  const swap=(outId:number,incoming:Player)=>{
    if(!data||!optimizer)return;
    const outPlayer=squad.find(p=>p.id===outId);
    if(!outPlayer)return;
    const swapFinancialContext=sandbox?.financialContext??deriveSandboxFinancialContext(squad,data.rules.budget,managerMeta);
    const baselineSquad=sandbox?.baselineSquad??squad;
    const validation=validateSwap(squad,outPlayer,incoming,data.rules,{baselineSquad,financialContext:swapFinancialContext});
    if(!validation.ok){setMessage(validation.message);return;}
    if(!eventIds.length){setMessage("No upcoming gameweek to evaluate this swap against.");return;}
    const activeSandbox=sandbox??createSandboxState(squad,swapFinancialContext);
    const nextSandbox=applySandboxTransfer(activeSandbox,outPlayer,incoming);
    const transfer=evaluateTransfer(data,squad,outPlayer,incoming,1);
    setSandbox(nextSandbox);setSquad(nextSandbox.currentSquad);setSavedAt(null);setSwapOutId(null);setSelectedInsight(incoming.id);
    setMessage(`${outPlayer.name} → ${incoming.name}: ${transfer.qualityStatus==="actionable"?"model edge":transfer.qualityStatus==="watchlist"?"watchlist swap":"quality gate flagged this swap"} — see the breakdown below.`);
  };
  const undoLastTransfer=()=>{if(!sandbox?.history.length)return;const undone=sandbox.history.at(-1)!;const next=undoSandboxTransfer(sandbox);setSandbox(next);setSquad(next.currentSquad);setSavedAt(null);setSwapOutId(null);setSelectedInsight(undone.out.id);setMessage(`${undone.out.name} restored. ${next.history.length} sandbox action${next.history.length===1?"":"s"} remain.`);};
  const resetAllTransfers=()=>{if(!sandbox)return;const next=resetSandbox(sandbox);setSandbox(next);setSquad(next.currentSquad);setSavedAt(null);setSwapOutId(null);setSelectedInsight(next.currentSquad[0]?.id??null);setMessage("Sandbox reset to the original baseline squad.");};
  const saveSquad=()=>{if(!data)return;persist("fpl-edge-squad",JSON.stringify(squad.map(p=>p.id)));localStorage.setItem("fpl-edge-squad-saved-at",new Date().toISOString());setSavedAt(new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}));setSandbox(null);setMessage(`Squad saved${squad.length===data.rules.squadSize?" and ready for chip and wildcard analysis":" as a draft"}. Sandbox comparison cleared.`)};
  const importTeam=async()=>{if(!data)return;if(!/^\d+$/.test(teamId)){setMessage("Enter the numeric Team ID from your official FPL URL.");return}setImporting(true);try{const response=await fetch(`/api/fpl/team?entry=${teamId}`,{cache:"no-store"});const json=await response.json();if(!response.ok)throw new Error(json.error||"Could not import team");const imported:Player[]=json.playerIds.map((id:number)=>data.players.find(p=>p.id===id)).filter(Boolean);if(imported.length!==data.rules.squadSize)throw new Error("FPL did not return a complete 15-player squad.");setSquad(imported);setManagerMeta(json.manager);persist("fpl-edge-manager",JSON.stringify(json.manager));persist("fpl-edge-entry",teamId);setSavedAt(null);setSwapOutId(null);setSandbox(null);setMessage(`${json.manager.teamName} imported from GW${json.event}. Review it, then press Save squad.`)}catch(e){setMessage(e instanceof Error?e.message:"Could not import that FPL team.")}finally{setImporting(false)}};
  if(loading&&!data)return <div className="live-state"><span className="live-spinner"/><b>Loading the official FPL player list and prices…</b></div>;
  if(error&&!data)return <div className="live-state error"><b>Official data unavailable</b><p>{error}</p><button onClick={load}>Try again</button></div>;
  if(!data)return null;
  return <div className="live-builder">
    <section className="live-source"><div><span className="live-dot"/><b>OFFICIAL FPL DATA</b><small>{data.players.length} current players · prices refresh every 5 minutes · updated {new Date(data.updatedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</small></div><button onClick={load} disabled={loading}>{loading?"Refreshing…":"Refresh now"}</button></section>
    {!explorer&&<><section className="team-import"><div><span>IMPORT OFFICIAL TEAM</span><b>Enter your FPL Team ID</b><small>Found in your official team URL. Public picks can be imported after the gameweek deadline.</small></div><div><input value={teamId} onChange={e=>setTeamId(e.target.value.replace(/\D/g,""))} placeholder="FPL Team ID"/><button onClick={importTeam} disabled={importing}>{importing?"Importing…":"Fetch my squad"}</button></div></section><section className="optimizer-controls"><div><span>TIME HORIZON</span>{(["GW1 Attack","Next 3 GWs","Balanced 5 GWs","Long-term 8 GWs"] as HorizonMode[]).map(mode=><button className={horizonMode===mode?"active":""} onClick={()=>setHorizonMode(mode)} key={mode}>{mode}</button>)}</div><div><span>RISK PROFILE</span>{(["Safe","Balanced","Aggressive"] as RiskMode[]).map(mode=><button className={riskMode===mode?"active":""} onClick={()=>setRiskMode(mode)} key={mode}>{mode}</button>)}</div><div><span>SQUAD PHILOSOPHY</span>{(["Maximum xPts","Flexible","Strong Bench","Premium Heavy","Differential"] as SquadPhilosophy[]).map(mode=><button className={philosophy===mode?"active":""} onClick={()=>setPhilosophy(mode)} key={mode}>{mode}</button>)}</div><div className="structure-presets"><span>QUICK STRUCTURES</span><button onClick={()=>{setRiskMode("Balanced");setPhilosophy("Maximum xPts")}}>Maximum Expected Points</button><button onClick={()=>{setRiskMode("Safe");setPhilosophy("Flexible")}}>Safer</button><button onClick={()=>{setRiskMode("Aggressive");setPhilosophy("Differential")}}>Higher Upside</button></div><div className="result-mode-group"><span>RESULT MODE</span>{(["Pure Optimum","Practical Upgrade","Keep Core"] as ResultMode[]).map(mode=><button className={resultMode===mode?"active":""} onClick={()=>setResultMode(mode)} key={mode}>{mode}</button>)}</div><p className="mode-help">{horizonMode==="GW1 Attack"?"Heavily prioritises the immediate gameweek.":horizonMode==="Next 3 GWs"?"Attacks the short fixture run with limited future weight.":horizonMode==="Balanced 5 GWs"?"Balances immediate points with five-gameweek planning.":"Keeps eight-gameweek structure and flexibility in view."} {riskMode==="Safe"?"Minutes security is prioritised.":riskMode==="Aggressive"?"Volatility and ceiling receive more weight.":"Risk and upside are balanced."} {philosophy} shapes the squad structure. {resultMode==="Practical Upgrade"?`Practical Upgrade searches up to ${PRACTICAL_UPGRADE_MAX_CHANGES} simultaneous changes from your current squad.`:resultMode==="Keep Core"?`Keep Core protects ${pinnedIds.size} pinned player${pinnedIds.size===1?"":"s"} and searches up to ${KEEP_CORE_MAX_CHANGES} simultaneous changes among the rest — pin players on the pitch below.`:"Pure Optimum rebuilds the squad from the entire player pool, with no constraint from your current picks."}</p></section><section className="builder-toolbar"><div><small>SQUAD</small><b>{squad.length} / {data.rules.squadSize}</b></div><div><small>SPENT</small><b>£{cost.toFixed(1)}m</b></div><div><small>REMAINING</small><b>£{Math.max(0,data.rules.budget-cost).toFixed(1)}m</b></div><button className="clear-squad" onClick={()=>{setSquad([]);setSavedAt(null);setSelectedInsight(null);setPinnedIds(new Set());setSwapOutId(null);setSandbox(null);setMessage("Squad cleared. Build it your way.");}}>Clear squad</button><button className="best-squad" onClick={buildBestSquad}>Build best squad</button><button className="save-squad" onClick={saveSquad}>{savedAt?`Saved ${savedAt} ✓`:"Save squad"}</button></section>
    <div className="builder-message">{message}</div>
    {complete&&<section className={`sandbox-toolbar ${swapOutId?"active":""}`}><div><span>TRANSFER SANDBOX</span><b>{swapOut?`${swapOut.name} selected for transfer`:`Click any owned player on the pitch to compare a live replacement.`}</b><small>The pool locks to the same position; every legal move immediately recalculates XI, bench, formation, captaincy, rating and bank.</small></div><div><strong>{sandbox?.history.length??0} sandbox action{sandbox?.history.length===1?"":"s"}</strong><button type="button" onClick={undoLastTransfer} disabled={!sandbox?.history.length}>Undo last</button><button type="button" onClick={resetAllTransfers} disabled={!sandbox?.history.length}>Reset all</button></div></section>}
    <section className="builder-pitch" aria-label={complete?"Transfer Sandbox interactive squad pitch":"Squad builder pitch"}><div className="pitch-box"/>{data.rules.positions.map(rule=><div className={`builder-pitch-row row-${rule.short.toLowerCase()}`} key={rule.id}>{[...squad.filter(p=>p.positionId===rule.id),...Array.from({length:Math.max(0,rule.squad-squad.filter(p=>p.positionId===rule.id).length)},()=>null)].map((player,i)=>player?<BuilderPitchPlayerCard key={player.id} player={player} projectedPoints={eventIds.length?playerProjection(player,eventIds[0],data.fixtures,eventIds[0]).toFixed(1):"—"} complete={complete} selected={selectedInsight===player.id} swapTarget={swapOutId===player.id} showPin={resultMode==="Keep Core"} pinned={pinnedIds.has(player.id)} onSelect={()=>complete?beginSwap(player):setSelectedInsight(player.id)} onTogglePin={()=>togglePin(player.id)} onRemove={()=>remove(player.id)}/>:<button type="button" className="pitch-empty" key={`empty-${i}`} onClick={()=>setPosition(rule.short)}><i>+</i><span>Add {rule.short}</span></button>)}</div>)}</section>
    {swapOut&&<div className="builder-message swap-banner">Outgoing player: <b>{swapOut.name}</b>. The pool below is locked to {swapOut.positionShort}; illegal replacements are disabled. <button type="button" onClick={()=>setSwapOutId(null)}>Cancel</button></div>}
    <section className={`squad-score ${complete?"complete":""}`}><div><span>SQUAD QUALITY RATING</span><strong>{rating??"—"}<small>/100</small></strong><p>{complete?"Independent quality score—not 100 merely because the optimizer selected it.":"Complete a valid 15-player squad to unlock its rating and projections."}</p>{complete&&optimized&&<small className="efficiency-label">Optimization efficiency: {Math.min(100,manualEvaluation!.objective/optimized.evaluation.objective*100).toFixed(1)}%</small>}</div><div className="gw-projections">{Array.from({length:5},(_,i)=><article key={i}><span>{events[i]?.name??`GW${i+1}`}</span><b>{totals[i]?.toFixed(1)??"—"}</b><small>predicted pts</small></article>)}</div></section>
    {sandboxComparisons&&latestSandboxTransfer&&<SandboxImpactPanel comparison={sandboxComparisons} latestTransfer={latestSandboxTransfer} freeTransfers={freeTransfers} onUndo={undoLastTransfer} onReset={resetAllTransfers}/>}
    {complete&&manualEvaluation&&<>
      {consistencyWarnings.length>0&&<p className="integrity-warning optimizer-consistency-warning">⚠ Consistency check failed: {consistencyWarnings[0]}{consistencyWarnings.length>1?` (+${consistencyWarnings.length-1} more)`:""}</p>}
      <section className="recommended-move best-transfer-now">
        <div className="call-label"><span>BEST TRANSFER RIGHT NOW</span><b>{bestTransferRightNow?"MODEL EDGE":"SAVE"}</b></div>
        <h2>{bestTransferRightNow?`${bestTransferRightNow.out.name} → ${bestTransferRightNow.incoming.name}`:"No actionable single transfer"}</h2>
        <p>{bestTransferRightNow?`The single highest-ranked legal swap right now — not a full squad rebuild. ${bestTransferRightNow.risk} modelled minutes/availability risk.`:`No individual swap clears the ${TRANSFER_ACTION_THRESHOLD}-point action threshold and every quality gate right now.`}</p>
        {bestTransferRightNow&&<div>{([["GW","1",bestTransferRightNow.gain1],["NEXT","3",bestTransferRightNow.gain3],["NEXT","5",bestTransferRightNow.gain5]] as const).map(([label,n,value])=><span key={n}><small>{label} {n}</small><b>{value>=0?"+":""}{value.toFixed(1)} pts</b></span>)}<span><small>TRANSFER HIT</small><b>{bestTransferRightNow.hitCost?`−${bestTransferRightNow.hitCost}`:"None"}</b></span><span><small>NET (AFTER HIT)</small><b>{bestTransferRightNow.netDifference>=0?"+":""}{bestTransferRightNow.netDifference.toFixed(1)} pts</b></span></div>}
      </section>
      {!optimized&&<div className="builder-message">Press "Build best squad" above to run {resultMode} against your current squad and see a full recommendation, result pitch and report.</div>}
      {optimized&&<>
      {staleFields.length>0&&<p className="integrity-warning optimizer-consistency-warning">⚠ This result is stale: {staleFields.join("; ")} since it was built. Press "Build best squad" to refresh.</p>}
      {recommendedChanges&&<section className="recommended-move draft-recommended-changes">
        <div className="call-label"><span>RECOMMENDED CHANGES</span><b>{recommendedChanges.changes.length===0?"ALREADY OPTIMAL":recommendedChanges.worthIt?"MAKE THE CHANGES":"KEEP CURRENT SQUAD"}</b></div>
        <h2>{recommendedChanges.changes.length?`${recommendedChanges.changes.length} change${recommendedChanges.changes.length===1?"":"s"} to reach the model squad`:"Your squad already matches the model suggestion"}</h2>
        {recommendedChanges.changes.length>0&&<>
          <p>Net of the real hit cost for making {recommendedChanges.changes.length} change{recommendedChanges.changes.length===1?"":"s"} at once, using the free transfers set on the Transfers page.</p>
          <div>
            <span><small>RAW GAIN</small><b>+{recommendedChanges.rawGain.toFixed(1)}</b></span>
            <span><small>HIT COST</small><b>{recommendedChanges.hitCost?`-${recommendedChanges.hitCost}`:"0"}</b></span>
            <span><small>NET</small><b>{recommendedChanges.netGain>=0?"+":""}{recommendedChanges.netGain.toFixed(1)}</b></span>
          </div>
          <strong>{recommendedChanges.worthIt?"WORTH IT":"NOT WORTH IT"}</strong>
          <div className="squad-diff-rows">{recommendedChanges.changes.map(c=><article key={`${c.out.id}-${c.incoming.id}`}>
            <div><b>{c.out.name} → {c.incoming.name}</b><small>{c.incoming.teamShort} · £{c.incoming.price.toFixed(1)}m</small></div>
            <em className={`quality-badge ${c.quality.status}`}>{c.quality.status}</em>
            <strong>{c.gain5>=0?"+":""}{c.gain5.toFixed(1)} pts</strong>
          </article>)}</div>
        </>}
      </section>}
      <div className="result-tabs">{(["pitch","list","report"] as const).map(t=><button key={t} className={resultTab===t?"active":""} onClick={()=>setResultTab(t)}>{t==="pitch"?"Pitch":t==="list"?"List":"Report"}</button>)}</div>
      {resultTab==="pitch"&&<Pitch players={manualEvaluation.weeks[0].xi} bench={manualEvaluation.weeks[0].bench} captain={manualEvaluation.weeks[0].captain} vice={manualEvaluation.weeks[0].vice} event={eventIds[0]} data={data} onSelect={beginSwap}/>}
      {resultTab==="list"&&<div className="optimizer-grid"><XiBenchCards week={manualEvaluation.weeks[0]}/></div>}
      {resultTab==="report"&&<section className="optimizer-report"><header><div><span>OPTIMIZER REPORT</span><h2>{manualEvaluation.strategy.formation} · {horizonMode} · {riskMode} · {resultMode}</h2><p>Starting XI, captaincy, bench utility, flexibility and uncertainty are optimized together.</p></div><strong>{manualEvaluation.scores.overall}<small>/100 overall</small></strong></header><div className="rating-breakdown">{[["Projected points",manualEvaluation.scores.projectedPoints],["Captaincy",manualEvaluation.scores.captaincy],["Fixtures",manualEvaluation.scores.fixtures],["Minutes security",manualEvaluation.scores.minutesSecurity],["Bench",manualEvaluation.scores.bench],["Flexibility",manualEvaluation.scores.flexibility],["Value",manualEvaluation.scores.value],["Risk resilience",manualEvaluation.scores.risk]].map(([label,score])=><article key={String(label)}><span>{label}</span><b>{score}</b><i><em style={{width:`${score}%`}}/></i></article>)}</div><div className="optimizer-grid"><XiBenchCards week={manualEvaluation.weeks[0]}/><article><span>BUDGET ALLOCATION</span><h3>{Object.entries(manualEvaluation.strategy.budget).map(([pos,value])=>`${pos} £${Number(value).toFixed(1)}m`).join(" · ")}</h3><p>Bench spend £{manualEvaluation.strategy.benchSpend.toFixed(1)}m · Bank £{manualEvaluation.bank.toFixed(1)}m</p></article><article><span>STRATEGY</span><h3>{manualEvaluation.strategy.premiums.length?manualEvaluation.strategy.premiums.join(" + "):"Value-led structure"}</h3><p>Main targets: {manualEvaluation.strategy.targets.join(", ")} · Main captain: {manualEvaluation.strategy.captain}</p></article></div><div className="comparison-grid"><article><span>YOUR SQUAD VS OPTIMUM</span><h3>{(optimized.evaluation.weeks[0].points-manualEvaluation.weeks[0].points).toFixed(1)} pts GW1 gap</h3><p>{(optimized.evaluation.fiveWeekPoints-manualEvaluation.fiveWeekPoints).toFixed(1)} projected points over five GWs · {(optimized.evaluation.flexibility-manualEvaluation.flexibility).toFixed(0)} flexibility difference.</p><small>Key swaps: {optimized.squad.filter(p=>!squad.some(x=>x.id===p.id)).slice(0,3).map(p=>p.name).join(", ")||"None"}</small></article><article className="warnings"><span>STRUCTURAL CHECKS</span>{manualEvaluation.warnings.length?manualEvaluation.warnings.map(w=><p key={w}>! {w}</p>):<p>✓ No major structural warnings.</p>}</article></div><div className="explain-grid"><article><span>WHY THIS PLAYER?</span>{(()=>{const player=squad.find(p=>p.id===selectedInsight)??squad[0];const explanation=optimized.explanations[player.id]??["Selected in your manual squad. Compare its role and projections with the optimized result."];const metrics=eventIds.length?projectionMetrics(player,eventIds[0],data.fixtures,eventIds[0]):null;const dist=metrics?playerPointsDistribution(metrics,player.positionShort):null;const range=dist?pointsRange(dist):null;return <><h3>{player.name} — £{player.price.toFixed(1)}m</h3>{explanation.map(reason=><p key={reason}>• {reason}</p>)}{dist&&range&&<div className="draft-insight-distribution"><span><small>FLOOR</small><b>{range.floor}</b></span><span><small>MEDIAN</small><b>{range.median}</b></span><span><small>CEILING</small><b>{range.ceiling}</b></span><span><small>BLANK RISK (≤2)</small><b>{Math.round(blankProbability(dist)*100)}%</b></span><span><small>HAUL CHANCE (10+)</small><b>{Math.round(haulProbability(dist)*100)}%</b></span></div>}</>})()}</article><article><span>TOP 5 NEAR MISSES</span>{optimized.nearMisses.length?optimized.nearMisses.map(item=><div key={item.player.id}><b>{item.player.name} · £{item.player.price.toFixed(1)}m</b><small>{item.reason}</small></div>):<p>Not computed for {resultMode} — this mode searches a bounded set of legal swaps directly, rather than ranking every player in the pool against the final squad.</p>}</article></div></section>}
      </>}
    </>}</>}
      <section ref={poolRef} className={`official-pool ${swapOut?"swap-mode":""}`}><header><div><span>{explorer?"OFFICIAL PLAYER EXPLORER":swapOut?"CHOOSE A REPLACEMENT":"CHOOSE A PLAYER"}</span><h2>{explorer?"Every current FPL player and price.":swapOut?`Replacing ${swapOut.name} · ${swapOut.positionShort} locked.`:"Add or replace anyone."}</h2></div><small>Predictions are FPL Edge estimates, not official FPL forecasts.</small></header><div className="pool-filters"><input ref={searchRef} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search by player name…"/><select value={poolPosition} disabled={!!swapOut} aria-label={swapOut?`Position locked to ${swapOut.positionShort}`:"Position filter"} onChange={e=>setPosition(e.target.value)}><option value="ALL">All positions</option>{data.rules.positions.map(p=><option value={p.short} key={p.id}>{p.short}</option>)}</select><select value={team} onChange={e=>setTeam(e.target.value)}><option value="ALL">All clubs</option>{teams.map(([id,name])=><option value={id} key={id}>{name}</option>)}</select></div><div className="pool-table"><div className="pool-head"><span>PLAYER</span><span>PRICE</span><span>NEXT GW</span><span>STATUS</span><span>{explorer?"FORM":swapOut?"REPLACE":"ACTION"}</span></div>{filtered.map(player=>{const validation=swapOut&&financialContext?validateSwap(squad,swapOut,player,data.rules,{baselineSquad:sandbox?.baselineSquad??squad,financialContext}):null;const disabled=validation!==null&&!validation.ok;const disabledLabel=!disabled?"":validation&&!validation.ok?validation.reason==="owned"?"Owned":validation.reason==="unavailable"?"Unavailable":validation.reason==="budget"?"Over budget":validation.reason==="position"?"Wrong position":"Club limit":"";return <div className={`pool-row ${disabled?"invalid-replacement":""}`} key={player.id}><b>{player.name}<small>{player.teamShort} · {player.positionShort}</small></b><span>£{player.price.toFixed(1)}m</span><span>{eventIds.length?playerProjection(player,eventIds[0],data.fixtures,eventIds[0]).toFixed(1):"—"}</span><span className={player.status==="a"?"available":"flagged"}>{player.status==="a"?"Available":player.chance!==null?`${player.chance}% chance`:"Flagged"}</span>{explorer?<span>{player.form.toFixed(1)}</span>:swapOut?<button type="button" disabled={disabled} title={validation&&!validation.ok?validation.message:undefined} onClick={()=>swap(swapOut.id,player)}>{disabled?disabledLabel:"Swap in →"}</button>:<button type="button" disabled={squad.some(p=>p.id===player.id)} onClick={()=>add(player)}>{squad.some(p=>p.id===player.id)?"Selected":"Add +"}</button>}</div>})}</div></section>
  </div>;
}
