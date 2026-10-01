"use client";

import {track} from "../../lib/track";
import {useState,useEffect,useMemo} from "react";
import {FplData,FplPlayer,projectionMetrics,futureEvents,isCompleteSquad,bestXi,playerProjection,startPct,PriceOutlookDay} from "../../lib/fpl";
import {createOptimizer} from "../../lib/optimizer";
import {readFreeTransfers,writeAccountTeam} from "../../lib/persistence";
import {clearExampleSquadFlag} from "../../lib/example-squad";
import {resolveAuthoritativeFreeTransfers} from "../../lib/personal-fpl-transfer/ft-state";
import {isWildcardActive} from "../../lib/personal-fpl-transfer/chip-state";
import {useTeamLinkAuth} from "../team-link-auth";
import {BenchOrderResult,optimizeBenchOrder,modeledAppearanceProbability} from "../../lib/bench-order";
import {Transfer,sortTransfersByQuality,bestTransfers} from "../../lib/transfers";
import {ManagerMeta,deriveSandboxFinancialContext,isRankingFinanceUnavailable} from "../../lib/squad-comparison";
import {scheduleDeferred} from "../../lib/transfer-engine/schedule";
import {resolveCaptaincy} from "../../lib/captaincy";
import {buildWeeklyDecision,type WeeklyDecision} from "../../lib/weekly-decision";

// View name map (Kevin IA lock): Home=overview, My Squad=team, Final check=deadline,
// Players=players, Coach=coach. Desktop primary includes Transfers + Final check; phone nests
// Transfers under My Squad (see ia/phone-squad-transfers).
export type View="overview"|"team"|"transfers"|"league"|"draft"|"board"|"players"|"fixtures"|"news"|"deadline"|"chips"|"model"|"history"|"ownership"|"coach"|"squad-fixtures"|"season-stats";

export const clamp=(n:number,min=0,max=100)=>Math.max(min,Math.min(max,n));

// Phone-only My Squad context: Transfers is nested here (not a 6th tab). Deep-links go("transfers")
// land on the Transfers segment host; Final check stays in More (#62).
export function PhoneSquadNav({active,go}:{active:"team"|"transfers"|"squad-fixtures";go:(v:View)=>void}){
  return <nav className="phone-squad-nav" aria-label="My Squad"><button type="button" className={active==="team"?"active":""} onClick={()=>go("team")}>My team</button><button type="button" className={active==="transfers"?"active":""} onClick={()=>go("transfers")}>Transfers</button><button type="button" className={active==="squad-fixtures"?"active":""} onClick={()=>go("squad-fixtures")}>My Fixtures</button></nav>;
}

// revision is a required re-read trigger, not just an initial-mount read -- without it, a manager
// update made by one mounted component (e.g. TeamBar in the persistent sidebar) would never reach
// the independent useManager() instances Overview/Team/Transfers/FinalCheck each hold locally.
export function useManager(revision:number){const[meta,setMeta]=useState<ManagerMeta|null>(null);useEffect(()=>{try{setMeta(JSON.parse(localStorage.getItem("fpl-edge-manager")||"null"))}catch{}},[revision]);return[meta,setMeta] as const}

export function authoritativeFreeTransfers(meta:ManagerMeta|null|undefined):number{
  return resolveAuthoritativeFreeTransfers({
    freeTransferLimit:meta?.freeTransferLimit,
    transfersMade:meta?.transfersMade,
    bankSource:meta?.bankSource,
    fallbackFreeTransfers:readFreeTransfers(),
  });
}

export function managerWildcardActive(meta:ManagerMeta|null|undefined):boolean{
  return isWildcardActive({
    activeChip:meta?.chip,
    freeTransferLimit:meta?.freeTransferLimit,
    bankSource:meta?.bankSource,
  });
}

// Single source of truth for "connect a Team ID" -- fetch, validate, persist. ConnectTeam (the
// full-page first-connect prompt) and TeamBar (the always-reachable sidebar switch/reconnect) both
// call this rather than keeping their own copies that agree today and drift the next time either
// is touched independently -- exactly the failure class this project has caught repeatedly.
export async function connectTeam(id:string,data:FplData):Promise<ManagerMeta>{
  if(!/^\d+$/.test(id))throw new Error("Enter the numeric Team ID from your official FPL URL.");
  const response=await fetch(`/api/fpl/team?entry=${id}`,{cache:"no-store"});
  const json=await response.json();
  if(!response.ok)throw new Error(json.error||"Could not connect team");
  const ids=(json.playerIds as number[]).filter(pid=>data.players.some(p=>p.id===pid));
  if(ids.length!==15)throw new Error("FPL did not return a complete public squad.");
  clearExampleSquadFlag();
  const saved=await writeAccountTeam({squadIds:ids,entry:id,manager:json.manager});
  if(!saved.ok)throw new Error(saved.error);
  localStorage.setItem("fpl-edge-squad-saved-at",new Date().toISOString());
  return json.manager as ManagerMeta;
}

/**
 * Shared structure for the empty desk screens (Squad, Coach, History): a labelled card with a
 * one-line reason, the three steps that unlock the screen, and exactly ONE primary button.
 */
export function EmptyDeskState({eyebrow,title,lede,steps,actionLabel,onAction}:{eyebrow:string;title:string;lede:string;steps:readonly string[];actionLabel:string;onAction:()=>void}){
  return <section className="empty-desk-card" aria-label={title}>
    <span className="empty-desk-eyebrow">{eyebrow}</span>
    <h2>{title}</h2>
    <p>{lede}</p>
    <ol className="empty-desk-steps">{steps.map((step,i)=><li key={step}><b>{i+1}</b><span>{step}</span></li>)}</ol>
    <button type="button" className="empty-desk-action" onClick={onAction}>{actionLabel}</button>
  </section>;
}

export function ConnectTeam({data,onConnected}:{data:FplData;onConnected?:(m:ManagerMeta)=>void}){const teamAuth=useTeamLinkAuth();const[id,setId]=useState("");const[busy,setBusy]=useState(false);const[msg,setMsg]=useState("");const connect=async()=>{setBusy(true);setMsg("");try{const manager=await connectTeam(id,data);track("team_connected",{source:"real"});setMsg(`${manager.teamName} connected. Your coach is ready.`);onConnected?.(manager)}catch(e){setMsg(e instanceof Error?e.message:"Could not connect team")}finally{setBusy(false)}};if(teamAuth!=="in")return <section className="connect-hero"><div><span>START HERE</span><h2>Sign in to connect your team</h2><p>Your official FPL team id belongs to your email account. Sign in first, then connect it. The next time you sign in, on any browser, that team loads automatically.</p><small className="trust-note">Read-only. We never ask for your FPL password.</small></div></section>;return <section className="connect-hero"><div><span>START HERE</span><h2>Connect your official FPL team</h2><p>Enter the number in your FPL team URL. Read-only: we never ask for your password or make changes to your official team.</p></div><div><input value={id} onChange={e=>setId(e.target.value.replace(/\D/g,""))} placeholder="FPL Team ID" inputMode="numeric"/><button onClick={connect} disabled={busy}>{busy?"Connecting…":"Connect my team →"}</button><small>{msg||"Current public squad becomes available after its deadline."}</small></div></section>}

export function benchOrderForEvent(xi:FplPlayer[],bench:FplPlayer[],eventId:number,data:Pick<FplData,"fixtures">):BenchOrderResult{
  return optimizeBenchOrder(xi,bench,player=>{const metrics=projectionMetrics(player,eventId,data.fixtures,eventId);return{xPts:metrics.xPts,appearanceProbability:modeledAppearanceProbability(player,metrics)}});
}

export function analysis(data:FplData,squad:FplPlayer[]){const events=futureEvents(data,5);if(!events.length||!isCompleteSquad(squad,data))return null;const first=events[0].id;const xi=bestXi(squad,first,data.fixtures,first);const rawBench=squad.filter(p=>!xi.players.some(x=>x.id===p.id));const benchOrder=benchOrderForEvent(xi.players,rawBench,first,data);const bench=benchOrder.bench;const vice=[...xi.players].sort((a,b)=>playerProjection(b,first,data.fixtures,first)-playerProjection(a,first,data.fixtures,first))[1];const issues=squad.filter(p=>p.status!=="a"||startPct(p,first,data)<68).sort((a,b)=>startPct(a,first,data)-startPct(b,first,data));const cost=squad.reduce((s,p)=>s+p.price,0);return{events,first,xi,bench,benchOrder,vice,issues,cost,bank:Math.max(0,data.rules.budget-cost)}}

// Squad-level objective delta (bench utility, flexibility, risk-adjustment, role security) for a
// swap, kept as a distinct "Model Utility Change" metric — never merged into raw projected points.
export function withModelUtilityChange(rows:Transfer[],squad:FplPlayer[],optimizer:ReturnType<typeof createOptimizer>|null):Transfer[]{
  if(!optimizer||!squad.length)return rows;
  const baseline=optimizer.evaluate(squad).objective;
  const adjustedRows=rows.map(r=>{
    const index=squad.findIndex(p=>p.id===r.out.id);
    if(index<0)return r;
    const swapped=[...squad];swapped[index]=r.incoming;
    const utilityChange=optimizer.evaluate(swapped).objective-baseline;
    const adjusted=r.rankScore+clamp(utilityChange,-10,10)*.2;
    const rankScore=r.qualityStatus==="blocked"?Math.min(0,adjusted):r.qualityStatus==="watchlist"?Math.min(2.19,adjusted):adjusted;
    return{...r,utilityChange,rankScore};
  });
  return sortTransfersByQuality(adjustedRows);
}

/** Shared Transfers ranking pipeline before selectBestDecision: deep limit 60 + model utility.
 *  Overview deferred deep must call this (not hang-safe restricted budgets alone) so BEST DECISION matches. */
export function rankTransfersForBestDecision(
  data:FplData,
  squad:FplPlayer[],
  bank:number,
  freeTransfers:number,
  sellingPrices:Map<number,number>,
  optimizer:ReturnType<typeof createOptimizer>|null,
  options?:{wildcardActive?:boolean},
):Transfer[]{
  const base=bestTransfers(data,squad,bank,freeTransfers,60,sellingPrices,{
    mode:"deep",
    wildcardActive:options?.wildcardActive===true,
  });
  return withModelUtilityChange(base,squad,optimizer);
}

// FPL doesn't publish its price-change algorithm, and priceProjectionToday is FPL's own
// first-party end-of-day forecast (not a heuristic estimated from raw transfer counts here) --
// this threshold is only about noise reduction (most players sit under it every day), not an
// assertion about FPL's own undisclosed move-trigger threshold. Reused unchanged for every day of
// priceOutlook below -- no separate, invented threshold for the future days.
export const MEANINGFUL_PRICE_PRESSURE=15;

export type PriceOutlookDaySignal={offsetDays:number;direction:"rise"|"fall"|"stable"};

// likelihood is read but never displayed as a number or in copy -- FPL doesn't document what its
// magnitude means beyond its sign matching projectedPercent (confirmed against every live-sampled
// player this session). The one honest, disclosed use here: a defensive guard. If a day's
// likelihood sign ever disagrees with its projectedPercent sign, that day classifies as "stable"
// rather than trusting a possibly-inconsistent read -- never observed live, but not something to
// assume either.
function priceOutlookDays(player:FplPlayer|null|undefined):readonly PriceOutlookDay[]{
  if(!player)return[];
  const raw=player.priceOutlook;
  return Array.isArray(raw)?raw:[];
}

export function priceOutlookSignal(player:FplPlayer|null|undefined):readonly PriceOutlookDaySignal[]{
  if(!player)return[];
  return[...priceOutlookDays(player)].sort((a,b)=>a.offsetDays-b.offsetDays).map(day=>{
    const disagreement=day.projectedPercent!==0&&day.likelihood!==0&&Math.sign(day.likelihood)!==Math.sign(day.projectedPercent);
    if(disagreement)return{offsetDays:day.offsetDays,direction:"stable" as const};
    if(day.projectedPercent>=MEANINGFUL_PRICE_PRESSURE)return{offsetDays:day.offsetDays,direction:"rise" as const};
    if(day.projectedPercent<=-MEANINGFUL_PRICE_PRESSURE)return{offsetDays:day.offsetDays,direction:"fall" as const};
    return{offsetDays:day.offsetDays,direction:"stable" as const};
  });
}

export type PriceRiskAlert=Readonly<{player:FplPlayer;offsetDays:number;pct:number;message:string}>;

// Only falls matter for squad-value protection -- a rise in a squad player is good news, not a
// risk. Day 0 still reads priceProjectionToday directly (unchanged, zero drift risk on the
// already-tested path); days 1-2 are the real behavior change -- a player stable today but showing
// real fall pressure in FPL's own 3-day window was previously invisible here entirely. Reports the
// EARLIEST day that clears the threshold, sorted soonest-first (act before it happens), tied on
// pressure magnitude.
export function priceProtectionAlerts(squad:readonly FplPlayer[]):readonly PriceRiskAlert[]{
  return squad.map(player=>{
    if(!player)return null;
    if((player.priceProjectionToday??0)<=-MEANINGFUL_PRICE_PRESSURE){
      const pct=Math.abs(player.priceProjectionToday);
      return{player,offsetDays:0,pct,message:`carries ${Math.round(pct)}% fall pressure today — selling before the drop protects the standard £0.1m step.`};
    }
    const futureRisk=priceOutlookSignal(player).filter(d=>d.offsetDays>0&&d.direction==="fall").sort((a,b)=>a.offsetDays-b.offsetDays)[0];
    if(!futureRisk)return null;
    const rawDay=priceOutlookDays(player).find(d=>d.offsetDays===futureRisk.offsetDays);
    const pct=rawDay?Math.abs(rawDay.projectedPercent):0;
    return{player,offsetDays:futureRisk.offsetDays,pct,message:`is projected to fall in ${futureRisk.offsetDays} day${futureRisk.offsetDays>1?"s":""} — selling before then protects the standard £0.1m step.`};
  }).filter((x):x is PriceRiskAlert=>x!==null).sort((a,b)=>a.offsetDays-b.offsetDays||b.pct-a.pct);
}


// ---------------------------------------------------------------------------------------------
// Canonical weekly decision (Home / Transfers / Coach). One ranking pipeline, one cache, one object.
// The deep ranking is still deferred off first paint (OVERVIEW_HANG_HOTFIX) -- surfaces show a
// "calculating" state instead of a second, shallower call that could disagree.
// In-memory only: nothing here writes localStorage, so the demo squad never touches the real draft key.
// ---------------------------------------------------------------------------------------------

type DecisionRowsCacheEntry={key:string;rows:Transfer[]};
const decisionRowsCache:DecisionRowsCacheEntry[]=[];
const optimizerByData=new WeakMap<FplData,ReturnType<typeof createOptimizer>>();
function decisionOptimizer(data:FplData){let o=optimizerByData.get(data);if(!o){o=createOptimizer(data,"Balanced 5 GWs","Balanced","Maximum xPts");optimizerByData.set(data,o)}return o}

export function weeklyDecisionKey(data:FplData,squad:FplPlayer[],bank:number,freeTransfers:number,sellingPrices:Map<number,number>,wildcardActive:boolean):string{
  const sell=[...sellingPrices.entries()].sort((x,y)=>x[0]-y[0]).map(([id,p])=>`${id}:${p}`).join(",");
  return `${data.updatedAt??""}|${squad.map(p=>p.id).join(",")}|${bank.toFixed(1)}|${wildcardActive?"wc":freeTransfers}|${sell}`;
}

/** Ranked rows for the canonical decision (cached so every surface reads the identical rows). */
export function rankRowsForWeeklyDecision(data:FplData,squad:FplPlayer[],bank:number,freeTransfers:number,sellingPrices:Map<number,number>,wildcardActive:boolean,optimizer?:ReturnType<typeof createOptimizer>|null):Transfer[]{
  const key=weeklyDecisionKey(data,squad,bank,freeTransfers,sellingPrices,wildcardActive);
  const hit=decisionRowsCache.find(e=>e.key===key);
  if(hit)return hit.rows;
  const rows=rankTransfersForBestDecision(data,squad,bank,freeTransfers,sellingPrices,optimizer===undefined?decisionOptimizer(data):optimizer,{wildcardActive});
  decisionRowsCache.unshift({key,rows});
  if(decisionRowsCache.length>8)decisionRowsCache.length=8;
  return rows;
}
export function peekWeeklyDecisionRows(key:string):Transfer[]|null{return decisionRowsCache.find(e=>e.key===key)?.rows??null}

/** Captain used everywhere for the decision + projected GW total (stored → manager → model). */
export function decisionCaptainId(a:NonNullable<ReturnType<typeof analysis>>,manager:ManagerMeta|null|undefined):number|null{
  let storedC=0,storedV=0;
  try{storedC=Number(localStorage.getItem(`fpl-edge-captain-${a.first}`));storedV=Number(localStorage.getItem(`fpl-edge-vice-${a.first}`))}catch{}
  const model=a.xi.captain??a.xi.players[0];
  return resolveCaptaincy(a.xi.players,storedC,storedV,manager?.captainId,manager?.viceCaptainId,model,undefined)?.captainId??model?.id??null;
}

export type WeeklyDecisionState=
  |{status:"empty"}
  |{status:"blocked"}
  |{status:"pending";freeTransfers:number;freeTransferSource:"live"|"assumed"}
  |{status:"ready";decision:WeeklyDecision;rows:Transfer[]};

/** The single hook Home, Transfers and Coach use. `freeTransfersOverride` lets Transfers pass its
 *  manual selector value (which it also persists to the same stored key Home/Coach read). */
export function useWeeklyDecision(data:FplData,squad:FplPlayer[],meta:ManagerMeta|null|undefined,freeTransfersOverride?:number):WeeklyDecisionState{
  const a=analysis(data,squad);
  const finance=useMemo(()=>deriveSandboxFinancialContext(squad,data.rules.budget,meta??null),[squad,data.rules.budget,meta]);
  const blocked=finance.source==="unavailable"||isRankingFinanceUnavailable(meta);
  const wildcardActive=managerWildcardActive(meta);
  const liveFt=meta?.bankSource==="live-my-team"&&meta.freeTransferLimit!==undefined&&meta.freeTransferLimit!==null;
  const freeTransfers=freeTransfersOverride??authoritativeFreeTransfers(meta);
  const freeTransferSource:"live"|"assumed"=liveFt?"live":"assumed";
  const bank=finance.baselineBank;
  const key=a&&!blocked?weeklyDecisionKey(data,squad,bank,freeTransfers,finance.baselineSellingPrices,wildcardActive):null;
  const[computed,setRows]=useState<{key:string;rows:Transfer[]}|null>(null);
  // Another surface may already have ranked these exact inputs -- read the shared cache in render.
  const cachedNow=key?peekWeeklyDecisionRows(key):null;
  const rows=cachedNow&&key?{key,rows:cachedNow}:computed;
  useEffect(()=>{
    if(!key||peekWeeklyDecisionRows(key))return;
    let cancelled=false;
    const handle=scheduleDeferred(()=>{
      if(cancelled)return;
      let next:Transfer[]=[];
      try{next=rankRowsForWeeklyDecision(data,squad,bank,freeTransfers,finance.baselineSellingPrices,wildcardActive)}catch{next=[]}
      if(!cancelled)setRows({key,rows:next});
    },{timeout:600,delayMs:16});
    return()=>{cancelled=true;handle.cancel()};
  },[key]);
  const captainId=a?decisionCaptainId(a,meta):null;
  return useMemo<WeeklyDecisionState>(()=>{
    if(!a)return{status:"empty"};
    if(blocked)return{status:"blocked"};
    if(!rows||rows.key!==key)return{status:"pending",freeTransfers,freeTransferSource};
    return{status:"ready",rows:rows.rows,decision:buildWeeklyDecision(rows.rows,{gameweek:a.first,freeTransfers,freeTransferSource,bank,captainId,wildcardActive})};
  },[a?.first,blocked,rows?.rows,rows?.key,key,freeTransfers,freeTransferSource,bank,captainId,wildcardActive]);
}
