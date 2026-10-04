"use client";
import {decisionBadge,plainReason} from "../../lib/decision-badge";
import {FplMoveLink} from "../FplMoveLink";

import "../../styles/panel-transfers.css";
import {useMemo,useState,useEffect} from "react";
import TransferBreakdown from "../TransferBreakdown";
import DecisionConfidencePanel from "../DecisionConfidencePanel";
import RankEstimatePanel from "../RankEstimatePanel";
import TransferSensitivityPanel from "../TransferSensitivityPanel";
import {useTransferDecisionConfidence} from "../useTransferDecisionConfidence";
import {usePopulationPercentiles} from "../usePopulationPercentiles";
import {estimateRankDistribution} from "../../lib/rank-estimate-core";
import PersonalTransferPlace from "../PersonalTransferPlace";
import ReconnectFplPanel from "../ReconnectFplPanel";
import {readPlannedChips} from "../../lib/chip-portfolio";
import {FplData,savedSquad,futureEvents,FplPlayer,ProjectionMetrics,projectionMetrics,playerProjection,opponent} from "../../lib/fpl";
import {createOptimizer} from "../../lib/optimizer";
import {DoubleGameweek,nearestInHorizon,detectFixtureAnomalies} from "../../lib/dgw";
import {readFreeTransfers,persist} from "../../lib/persistence";
import {refreshConnectedTeamFromApi} from "../../lib/team-live-refresh";
import {solveTransferRoutes,RouteTransfer,TransferRoute} from "../../lib/transfer-routes";
import {playerPointsDistribution,pointsRange,blankProbability,haulProbability} from "../../lib/projection-distribution";
import {Transfer,selectPrimaryTransfer} from "../../lib/transfers";
import {formatNet} from "../../lib/weekly-decision";
import {scheduleDeferred} from "../../lib/transfer-engine/schedule";
import {deriveSandboxFinancialContext,isRankingFinanceUnavailable} from "../../lib/squad-comparison";
import {SeasonLocked} from "../SeasonLocked";
import {ConnectTeam,MEANINGFUL_PRICE_PRESSURE,PhoneSquadNav,analysis,authoritativeFreeTransfers,managerWildcardActive,priceOutlookSignal,useWeeklyDecision,useManager} from "./CoachCore";
import type {View} from "./CoachCore";
import {readIds} from "./PanelShared";

// Pure so the hold decision is directly unit-testable (tests/dgw.test.mts) without rendering.
// Only fires when rolling is already the recommendation -- this never argues for holding a
// transfer that would otherwise clear the action threshold, only reinforces a roll that's already correct.
export function transferHoldNote(nearestDoubles:DoubleGameweek[],rollRecommended:boolean):string|null{
  if(!rollRecommended||!nearestDoubles.length)return null;
  const eventId=nearestDoubles[0].eventId;
  const teamCount=new Set(nearestDoubles.map(d=>d.teamId)).size;
  return `A double gameweek is coming in GW${eventId} (${teamCount} team${teamCount>1?"s":""}) — consider banking this transfer.`;
}

export function Transfers({data,go,revision,onTeamChange,fullDesk,onUpgrade}:{data:FplData;go:(v:View)=>void;revision:number;onTeamChange:()=>void;fullDesk:boolean;onUpgrade:()=>void}){
  const[meta,setMeta]=useManager(revision);
  // meta must be a squad dependency (matches Overview's pattern) -- connecting a team here persists
  // squad ids straight to localStorage via ConnectTeam's onConnected callback below, but savedSquad()
  // is only re-read when this memo's deps change. Without meta here, the page showed the "connected"
  // success message yet kept rendering the connect screen until an unrelated revision bump (e.g. a
  // full data refresh) happened to fire.
  const squad=useMemo(()=>savedSquad(data),[data,revision,meta]);
  const[tab,setTab]=useState<"routes"|"moves"|"watchlist">("moves");/* Single moves default + leftmost */const[fts,setFts]=useState(readFreeTransfers);
  const liveFtKnown=meta?.bankSource==="live-my-team"&&meta.freeTransferLimit!==undefined&&meta.freeTransferLimit!==null;
  const wildcardActive=managerWildcardActive(meta);
  useEffect(()=>{
    if(wildcardActive)return; // Unlimited WC — do not sync finite FT into normal ranking state
    if(!liveFtKnown||!meta)return;
    const next=authoritativeFreeTransfers(meta);
    setFts(next);
    try{localStorage.setItem("fpl-edge-free-transfers",String(next))}catch{}
  },[meta,liveFtKnown,wildcardActive,meta?.transfersMade,meta?.freeTransferLimit,meta?.bankSource]);
  const[routeHorizon,setRouteHorizon]=useState<3|5|8>(5);const[maxWeeklyHit,setMaxWeeklyHit]=useState<0|4|8>(4);
  const[watchIds,setWatchIds]=useState<number[]>([]);useEffect(()=>setWatchIds(readIds("fpl-edge-watchlist")),[]);
  const[expanded,setExpanded]=useState<Set<string>>(new Set());
  // Force live team refresh on Transfers mount, then bump revision so Actionable cannot first-paint
  // from stale £2.1 / old XI (cooldown must not win the race against first rank).
  useEffect(()=>{
    let cancelled=false;
    refreshConnectedTeamFromApi(data,{force:true}).then(live=>{
      if(cancelled||!live.updated)return;
      try{setMeta(JSON.parse(localStorage.getItem("fpl-edge-manager")||"null"))}catch{}
      onTeamChange();
    });
    return()=>{cancelled=true};
  },[data]);
  const a=analysis(data,squad);
  const optimizer=useMemo(()=>createOptimizer(data,"Balanced 5 GWs","Balanced","Maximum xPts"),[data]);
  // Keep bank + selling prices as one consistent finance snapshot. Mixing an official bank with
  // current-price selling fallbacks (when picks/selling prices are incomplete) overstates what a
  // sale raises and can surface transfers that FPL would reject as over budget.
  const finance=useMemo(()=>deriveSandboxFinancialContext(squad,data.rules.budget,meta),[squad,data.rules.budget,meta]);
  const rankingBlocked=finance.source==="unavailable"||isRankingFinanceUnavailable(meta);
  const bank=finance.baselineBank;
  const sellingPrices=finance.baselineSellingPrices;
  // Canonical weekly call: identical object to Home + Coach (useWeeklyDecision → rankTransfersForBestDecision).
  // Live FPL FT wins on every surface; otherwise the stored/manual FT (same key Home + Coach read).
  const weekly=useWeeklyDecision(data,squad,meta,wildcardActive||liveFtKnown?undefined:fts);
  const rows=weekly.status==="ready"?weekly.rows:[] as Transfer[];
  const wd=weekly.status==="ready"?weekly.decision:null;
  const routes=useMemo(()=>rankingBlocked?[]:solveTransferRoutes(data,squad,bank,{horizon:routeHorizon,freeTransfers:fts,maxWeeklyHit,sellingPrices,resultLimit:4,plannedChips:readPlannedChips()}),[data,squad,bank,fts,routeHorizon,maxWeeklyHit,sellingPrices,rankingBlocked]);
  const best=selectPrimaryTransfer(rows);const roll=!best;
  const decision=wd?.action==="MAKE"?wd.row:null;
  const decisionHold=!wd||wd.action==="HOLD";
  const bestAlt=decisionHold?rows.find(r=>!r.isHold&&r.classification!=="HOLD"&&r.classification!=="AVOID")??null:null;
  const decisionConfidence=useTransferDecisionConfidence({data,squad,optimizer,primary:tab==="moves"?best:null,freeTransfers:fts,selectedRoute:`${tab}:${routeHorizon}`});
  const populationPercentiles=usePopulationPercentiles();
  const primaryMain=decisionConfidence.primaryKey?decisionConfidence.state.results[decisionConfidence.primaryKey]?.main:undefined;
  // populationPercentiles===null means the population curve is still loading (renders nothing);
  // no meta means no real current rank exists to anchor from (a real, disclosed unavailable state,
  // not silently omitted); primaryMain not yet "available" just mirrors DecisionConfidencePanel's
  // own loading state rather than showing a second, redundant one.
  const primaryRankEstimate=useMemo(()=>{
    if(populationPercentiles===null)return null;
    if(!meta)return{status:"unavailable" as const,reason:"Connect your official FPL team to see a rank estimate."};
    if(!primaryMain||primaryMain.status!=="available")return null;
    if(!best)return null;
    return estimateRankDistribution({
      candidateScenarioTotals:primaryMain.result.candidateScenarioTotals,
      candidateAdditionalHitCost:best.hitCost,
      currentRealTotal:meta.overallPoints,
      currentRealRank:meta.overallRank,
      horizonWeeks:primaryMain.result.availableGameweeks,
      horizonTier:primaryMain.result.horizonTier,
      populationPercentiles,
    });
  },[populationPercentiles,meta,primaryMain,best]);
  if(!a)return <div className="coach-page"><PhoneSquadNav active="transfers" go={go}/><h1 className="screen-title">Transfers</h1><ConnectTeam data={data} onConnected={m=>{setMeta(m);onTeamChange()}}/><button className="wide-action" onClick={()=>go("draft")}>Build manually instead →</button></div>;
  if(rankingBlocked)return <div className="coach-page"><PhoneSquadNav active="transfers" go={go}/><h1 className="screen-title">Transfers</h1><ReconnectFplPanel errorHint={meta?.liveOverlayError??null} onReconnected={async()=>{const live=await refreshConnectedTeamFromApi(data,{force:true});try{setMeta(JSON.parse(localStorage.getItem("fpl-edge-manager")||"null"))}catch{}if(live.updated)onTeamChange()}}/></div>;
  const holdRows=rows.filter(row=>row.isHold||row.classification==="HOLD");
  const makeRows=rows.filter(row=>row.classification==="MAKE");
  const leanRows=rows.filter(row=>row.classification==="LEAN");
  const watchRows=rows.filter(row=>row.classification==="WATCH"||(!row.classification&&!row.isHold&&row.qualityStatus==="watchlist"));
  const avoidRows=rows.filter(row=>row.classification==="AVOID"||(!row.classification&&row.qualityStatus==="blocked"));
  // Preserve engine ranking (HOLD NET=0 sits among hit-adjusted moves when appropriate).
  const actionableRows=rows.filter(row=>row.classification==="MAKE"||row.classification==="LEAN"||row.isHold||row.classification==="HOLD");
  const watchlistRows=watchRows;
  const blockedRows=avoidRows;
  const holdNote=transferHoldNote(nearestInHorizon(detectFixtureAnomalies(data).doubles,futureEvents(data,5).map(e=>e.id)),roll);
  const setWatch=(id:number)=>{const next=watchIds.includes(id)?watchIds.filter(x=>x!==id):[...watchIds,id];setWatchIds(next);persist("fpl-edge-watchlist",JSON.stringify(next))};
  const toggleExpand=(key:string)=>setExpanded(x=>{const next=new Set(x);next.has(key)?next.delete(key):next.add(key);return next});
  // Phone nest (Mohamed A): opening Transfers / go("transfers") always lands on segment host.
  // Single moves default + leftmost. Free desk can open tabs but Route planner / Watchlist stay locked.
  const transferTab=tab;
  const selectTransferTab=(next:"routes"|"moves"|"watchlist")=>setTab(next);
  return <div className="coach-page">
    <PhoneSquadNav active="transfers" go={go}/>
    <section className="transfer-tabs" aria-label="Transfer segments"><button type="button" className={tab==="moves"?"active":""} onClick={()=>selectTransferTab("moves")}>Single moves</button><button type="button" className={tab==="routes"?"active":""} onClick={()=>selectTransferTab("routes")}>Route planner</button><button type="button" className={tab==="watchlist"?"active":""} onClick={()=>selectTransferTab("watchlist")}>Watchlist <b>{watchIds.length}</b></button>{fullDesk&&!wildcardActive&&<label>Free transfers <select value={fts} disabled={liveFtKnown} onChange={e=>{const next=Number(e.target.value);setFts(next);localStorage.setItem("fpl-edge-free-transfers",String(next))}}>{[0,1,2,3,4,5].map(x=><option key={x}>{x}</option>)}</select>{liveFtKnown&&<small className="ft-live-hint"> live FPL · {meta?.transfersMade??0} made this GW</small>}</label>}{fullDesk&&wildcardActive&&<span className="wildcard-mode-chip" aria-label="Wildcard optimization mode">Wildcard Optimization · unlimited until deadline</span>}</section>
    {transferTab==="routes"?(fullDesk?<TransferRoutePlanner routes={routes} horizon={routeHorizon} setHorizon={setRouteHorizon} maxWeeklyHit={maxWeeklyHit} setMaxWeeklyHit={setMaxWeeklyHit}/>:<SeasonLocked feature="Multi-week route planner is part of the season pass." onUpgrade={onUpgrade}/>):transferTab==="moves"?<>
      {wildcardActive&&<section className="wildcard-mode-banner" aria-label="Wildcard optimization mode"><div><span>WILDCARD ACTIVE</span><h2>Wildcard Optimization</h2><p>Your current squad is temporary. Unlimited changes until the deadline. Suggestions below are full-squad Wildcard swap candidates — not free transfers, not hits, and not NET vs HOLD banking.</p></div></section>}
      <section className="transfer-bank-strip" aria-label="Transfer bank used for rankings"><span>IN THE BANK</span><b>£{bank.toFixed(1)}m</b><small>{meta?.bankSource==="live-my-team"?"live FPL transfer bank":meta?.liveOverlayError?"live bank unavailable":meta?"official public data":"builder estimate"}</small>{wildcardActive?<><span>CHIP</span><b>Wildcard</b><small>unlimited swaps · temporary squad</small></>:<><span>FREE TRANSFERS</span><b>{fts}</b><small>{liveFtKnown?`live · ${meta?.transfersMade??0} already made`:"manual / stored"}</small></>}</section>
      {/* SHELL Phase 1 (transfers-presentation): one badge + metrics once + denser why chrome.
          Presentation only — do not change transfer-engine ranking / classification / NET math.
          Route planner card CONTENT frozen (E): TransferRoutePlanner body fields/solver copy untouched. */}
      <section className="recommended-move best-decision-hero" aria-label="Best decision">
        <div className="call-label"><span>{wildcardActive?"Wildcard best swap":"Best decision"}</span><b className={`decision-badge badge-${decisionBadge(decisionHold?"HOLD":"MAKE",decision?.classification).tone}`} title={decisionBadge(decisionHold?"HOLD":"MAKE",decision?.classification).meaning}>{decisionBadge(decisionHold?"HOLD":"MAKE",decision?.classification).text}</b></div>
        <h2>{!wd?"Calculating this week's call…":decisionHold?(wildcardActive?"Keep your temporary Wildcard squad":"Keep this week — do not transfer now"):`${decision!.out.name} → ${decision!.incoming.name}`}</h2>
        <p className="best-decision-lede">{plainReason(decisionHold
          ?(wildcardActive?"Should I swap on Wildcard? No strong full-squad upgrade clears the bar — keep iterating the temporary squad before the deadline.":fts<=0?"Should I transfer? No — with 0 FT, no move clears the hit-adjusted NET vs the type-B HOLD plan (bank FT, keep future free upgrades).":"Should I transfer? No — HOLD now, bank the free transfer, and keep future free upgrades available.")
          :(wildcardActive?`Should I swap on Wildcard? Yes — full-squad objective improves without using FT or hit logic.`:`Should I transfer? Yes — clears the risk-adjusted 5-GW NET vs HOLD bar.`))}</p>
        {wd&&!wildcardActive&&<FplMoveLink decision={wd} captainName={data.players.find(p=>p.id===wd.captainId)?.name??null} variant="secondary"/>}
        <div className="best-decision-metrics" aria-label="Decision metrics">
          <span><small>{wildcardActive?"MODE":"HIT"}</small><b>{wildcardActive?"Wildcard":(decisionHold?"Free":(decision!.hitLabel??(decision!.hitCost?`−${decision!.hitCost}`:"Free")))}</b></span>
          {!decisionHold&&decision&&<>
            <span><small>{wildcardActive?"5-GW SQUAD Δ":"5-GW NET vs HOLD"}</small><b>{formatNet(wd!.net5gw)}</b></span>
            <span><small>ADJUSTED 5-GW NET</small><b>{formatNet(wd!.riskAdjustedNet5gw)}</b></span>
            {!wildcardActive&&decision.nextGwGross!=null&&decision.holdNextGwGross!=null&&<span className="immediate-net-chip"><small>IMMEDIATE NET (THIS GW)</small><b>{((decision.nextGwGross-decision.holdNextGwGross)-decision.hitCost)>=0?"+":""}{((decision.nextGwGross-decision.holdNextGwGross)-decision.hitCost).toFixed(1)}</b></span>}
            <span><small>CONFIDENCE · RISK</small><b>{Math.round(decision.confidenceIn*100)}% · {decision.risk}</b></span>
          </>}
          {decisionHold&&<>
            <span><small>FT NOW → NEXT</small><b>{fts} → {Math.min(5,fts+1)}</b></span>
            <span><small>{wildcardActive?"SQUAD Δ":"NET vs HOLD"}</small><b>0.0</b></span>
          </>}
        </div>
        {!wildcardActive&&!decisionHold&&decision&&decision.nextGwGross!=null&&decision.holdNextGwGross!=null&&<p className="best-decision-immediate" aria-label="Immediate this-GW net">Immediate (this GW) net {(((decision.nextGwGross-decision.holdNextGwGross)-decision.hitCost)>=0)?"+":""}{((decision.nextGwGross-decision.holdNextGwGross)-decision.hitCost).toFixed(1)} — secondary to 5-GW NET above; expand any route for the full hit breakdown.</p>}
        <div className="engine-why" aria-label="Why">
          <span>WHY</span>
          <p className="engine-reason-hero">{plainReason(decisionHold?(decision?.engineReason??(wildcardActive?"Wildcard KEEP: no swap clears the full-squad bar; unlimited changes remain until the deadline.":"Type-B HOLD: no transfer now; future free transfers stay available.")):(decision?.engineReason??""))}</p>
        </div>
        {decisionHold&&bestAlt&&<aside className="best-decision-alt"><span>BEST ALTERNATIVE</span><b>{bestAlt.out.name} → {bestAlt.incoming.name}</b><small>{bestAlt.classification??"WATCH"} · {wildcardActive?"Wildcard":(bestAlt.hitLabel??(bestAlt.hitCost?`−${bestAlt.hitCost}`:"Free"))} · {wildcardActive?"5-GW squad Δ":"5-GW NET vs HOLD"} {(bestAlt.fiveGwNetVsHold??bestAlt.netEv5??0)>=0?"+":""}{(bestAlt.fiveGwNetVsHold??bestAlt.netEv5??0).toFixed(1)} · risk-adj {(bestAlt.riskAdjustedFiveGwNetVsHold??bestAlt.riskAdjustedNet5??0)>=0?"+":""}{(bestAlt.riskAdjustedFiveGwNetVsHold??bestAlt.riskAdjustedNet5??0).toFixed(1)}</small><p>{bestAlt.engineReason??""}</p></aside>}
        {!decisionHold&&a&&decision&&<PersonalTransferPlace elementOut={decision.out.id} elementIn={decision.incoming.id} event={a.first} purchasePrice={decision.incoming.price} outName={decision.out.name} inName={decision.incoming.name} note="Shortcut for the best decision — expand any ranked route below, or use Draft Lab sandbox, to place a different transfer."/>}
      </section>
      {!roll&&fullDesk&&<section className="primary-transfer-confidence" aria-label="Primary transfer Decision Confidence">
        <header><span>DECISION CONFIDENCE</span><h2>Primary transfer scenario analysis</h2><p>This analysis is separate from the Actionable / Watchlist / Blocked quality gate and does not change transfer ordering.</p></header>
        <DecisionConfidencePanel title="Primary transfer confidence" state={decisionConfidence.primaryKey&&decisionConfidence.state.results[decisionConfidence.primaryKey]?.main||{status:"pending"}} candidateLabel="Make transfer" baselineLabel="Keep current squad" metricDirection="Transfer minus current squad" metricLabel="transfer delta" />
        <TransferSensitivityPanel state={decisionConfidence.primaryKey&&decisionConfidence.state.results[decisionConfidence.primaryKey]?.sensitivity||{status:"pending"}} onRetry={decisionConfidence.retryPrimary} retryDisabled={decisionConfidence.state.activeKey!==null} />
        <RankEstimatePanel title="Estimated rank if this transfer plays out" result={primaryRankEstimate} />
      </section>}
      {fullDesk&&holdNote&&<p className="transfer-hold-note">{holdNote}</p>}
      {fullDesk&&<section className="quality-gate-summary engine-class-summary"><header><span>{wildcardActive?"WILDCARD SQUAD · CLASSIFICATION":"NET VS HOLD · CLASSIFICATION"}</span><h2>{wildcardActive?"Full-squad Wildcard objective Δ decides MAKE / LEAN / KEEP / WATCH / AVOID. No FT count, no hit cost, no NET vs HOLD banking. Confidence ≠ risk.":"Risk-adjusted 5-GW NET vs type-B HOLD decides MAKE / LEAN / HOLD / WATCH / AVOID. Confidence ≠ risk."}</h2></header><div><article><b>{makeRows.length}</b><span>MAKE</span><small>{wildcardActive?"Clear squad upgrade":"Clear NET edge after hit"}</small></article><article><b>{leanRows.length}</b><span>LEAN</span><small>{wildcardActive?"Positive but thinner squad edge":"Positive but thinner edge"}</small></article><article><b>{holdRows.length}</b><span>{wildcardActive?"KEEP":"HOLD"}</span><small>{wildcardActive?"No swap / temporary squad OK":"No transfer / NET 0"}</small></article><article><b>{watchlistRows.length}</b><span>WATCH</span><small>Incomplete evidence or timing</small></article><article><b>{blockedRows.length}</b><span>AVOID</span><small>{wildcardActive?"Negative squad objective":"Negative NET or weak role"}</small></article></div></section>}
      {fullDesk&&<TransferRouteList title={wildcardActive?"WILDCARD SWAP CANDIDATES · MAKE & LEAN":"MAKE & LEAN"} eyebrow={wildcardActive?"WILDCARD OPTIMIZATION":"SERIOUS MOVES"} rows={actionableRows.slice(0,10)} expanded={expanded} toggleExpand={toggleExpand} watchIds={watchIds} setWatch={setWatch} confidence={decisionConfidence} event={a.first} data={data} wildcardMode={wildcardActive}/>}
      {fullDesk&&<TransferRouteList title="WATCH" eyebrow={wildcardActive?"WILDCARD WATCH":"WATCH · IMPORTANT"} rows={watchlistRows.slice(0,6)} expanded={expanded} toggleExpand={toggleExpand} watchIds={watchIds} setWatch={setWatch} confidence={decisionConfidence} event={a.first} data={data} wildcardMode={wildcardActive}/>}
      {fullDesk&&<TransferRouteList title="AVOID" eyebrow={wildcardActive?"WILDCARD AVOID":"AVOID · COLLAPSED"} rows={blockedRows.slice(0,6)} expanded={expanded} toggleExpand={toggleExpand} watchIds={watchIds} setWatch={setWatch} confidence={decisionConfidence} event={a.first} data={data} wildcardMode={wildcardActive}/>}
      {fullDesk&&<PriceIntel rows={rows}/>}
      {fullDesk&&process.env.NODE_ENV!=="production"&&<TransferDebugTable rows={rows.slice(0,10)}/>}
      {!fullDesk&&<SeasonLocked feature="Safe and aggressive alternatives, and multi-week routes, are part of the season pass." onUpgrade={onUpgrade}/>}
    </>:transferTab==="watchlist"?(fullDesk?<Watchlist data={data} squad={squad} ids={watchIds} remove={setWatch} bank={bank}/>:<SeasonLocked feature="Transfer watchlist and alternatives are part of the season pass." onUpgrade={onUpgrade}/>):null}
  </div>;
}

// Week-1-only: FPL's own price predictor reaches 3 days out at most (priceOutlookSignal below,
// declared later in this file but a hoisted function declaration, callable here) -- a route's
// later weeks execute 1-3 real weeks from now, genuinely outside what FPL's own data says anything
// honest about. Only a rise is ever a warning here -- a fall on a BUYING target is good news for
// the buyer, already priceTimingSignal's own framing elsewhere. Display-only: never read by
// solveTransferRoutes, never folds into route.gain/rankScore/confidence.
export function routeTransferPriceWarning(move:RouteTransfer,weekIndex:number):string|null{
  if(weekIndex!==0)return null;
  const outlook=priceOutlookSignal(move.incoming);
  const today=outlook.find(d=>d.offsetDays===0);
  if(!today||today.direction!=="rise")return null;
  const stillRisingTomorrow=outlook.some(d=>d.offsetDays===1&&d.direction==="rise");
  const pct=Math.round(move.incoming.priceProjectionToday);
  return stillRisingTomorrow
    ?`${pct}% rise pressure today, and still rising tomorrow — this route's buying price could move before you execute it.`
    :`${pct}% rise pressure today — this route's buying price could move before you execute it.`;
}

function TransferRoutePlanner({routes,horizon,setHorizon,maxWeeklyHit,setMaxWeeklyHit}:{routes:TransferRoute[];horizon:3|5|8;setHorizon:(value:3|5|8)=>void;maxWeeklyHit:0|4|8;setMaxWeeklyHit:(value:0|4|8)=>void}){
  const best=routes[0];
  const signed=(value:number)=>`${value>=0?"+":""}${value.toFixed(1)}`;
  if(!best)return <section className="route-planner-empty"><span>ROUTE SOLVER</span><h2>No legal route could be produced.</h2><p>Refresh official data and confirm that the saved squad contains 15 legal players.</p></section>;
  return <>
    {/* FREEZE (E): Route planner card CONTENT — body fields, solver copy, ranking internals — frozen.
        Below: chrome wrappers / spacing / typography classes only. */}
    <section className="route-planner-controls route-planner-chrome">
      <div><span>PLANNING HORIZON</span>{([3,5,8] as const).map(value=><button className={horizon===value?"active":""} onClick={()=>setHorizon(value)} key={value}>{value} GWs</button>)}</div>
      <div><span>MAX HIT IN ONE GW</span>{([0,4,8] as const).map(value=><button className={maxWeeklyHit===value?"active":""} onClick={()=>setMaxWeeklyHit(value)} key={value}>{value?`−${value}`:"No hits"}</button>)}</div>
      <p>The solver searches rolls, one-transfer and two-transfer combinations while preserving legal squads, exact selling values, bank and free transfers after every deadline.</p>
    </section>
    <section className="route-planner-hero route-planner-chrome">
      <div><span>BEST COMPLETE ROUTE</span><h2>{best.firstAction}</h2><p>{best.gain>.05?`${signed(best.gain)} net projected points versus making no transfers across ${horizon} gameweeks.`:`No legal transfer sequence currently beats rolling across ${horizon} gameweeks.`}</p></div>
      <strong className={best.gain>.05?"positive":"neutral"}>{signed(best.gain)}<small>NET EDGE</small></strong>
      <div className="route-hero-metrics"><p><span>Projected points</span><b>{best.netProjectedPoints.toFixed(1)}</b></p><p><span>Transfers</span><b>{best.totalTransfers}</b></p><p><span>Hit cost</span><b>{best.totalHitCost?`−${best.totalHitCost}`:"0"}</b></p><p><span>Final bank</span><b>£{best.finalBank.toFixed(1)}m</b></p><p><span>Route evidence</span><b>{Math.round(best.confidence*100)}%</b></p><p><span>Risk</span><b>{best.risk}</b></p></div>
    </section>
    <section className="route-options">
      <header><div><span>COMPLETE PLANS</span><h2>Best route and genuinely different alternatives.</h2></div><small>Ranked by net projected points after hits</small></header>
      {routes.map((route,index)=><article className={index===0?"primary":""} key={route.id}>
        <header><i>{index+1}</i><div><span>{index===0?"RECOMMENDED":"ALTERNATIVE"}</span><h3>{route.firstAction}</h3></div><p><b>{signed(route.gain)}</b><small>vs roll</small></p><em className={route.risk.toLowerCase()}>{route.risk} risk</em></header>
        <div className="route-week-grid">{route.weeks.map((week,weekIndex)=><section key={week.eventId}>
          <header><span>{week.eventName.replace("Gameweek ","GW")}</span><b>{week.freeTransfersBefore} FT → {week.freeTransfersAfter} FT</b></header>
          <div className={week.transfers.length?"has-moves":"roll"}>{week.transfers.length?week.transfers.map(move=>{const warning=routeTransferPriceWarning(move,weekIndex);return <p key={`${move.out.id}-${move.incoming.id}`}><span>{move.out.name}</span><i>→</i><b>{move.incoming.name}</b><small>{move.bankChange>=0?"+":"−"}£{Math.abs(move.bankChange).toFixed(1)}m</small>{warning&&<em className="route-price-warning">{warning}</em>}</p>}):<p><b>ROLL</b><small>Bank the transfer</small></p>}</div>
          <footer><p><span>Team xPts</span><b>{week.projectedPoints.toFixed(1)}</b></p><p><span>Hit</span><b>{week.hitCost?`−${week.hitCost}`:"0"}</b></p><p><span>Bank</span><b>£{week.bankAfter.toFixed(1)}m</b></p></footer>
        </section>)}</div>
        <footer>{route.explanation.map(line=><p key={line}>{line}</p>)}</footer>
      </article>)}
    </section>
    <p className="route-method-note">Route projections use the same team-quality, expected-minutes, availability and player-evidence model as the rest of FPL Edge. Players below the hard role-security floor cannot anchor a recommended route.</p>
  </>;
}

function TransferRouteList({title,eyebrow,rows,expanded,toggleExpand,watchIds,setWatch,confidence,event,data,wildcardMode=false}:{title:string;eyebrow:string;rows:Transfer[];expanded:Set<string>;toggleExpand:(key:string)=>void;watchIds:number[];setWatch:(id:number)=>void;confidence:ReturnType<typeof useTransferDecisionConfidence>;event:number;data:FplData;wildcardMode?:boolean}){
  if(!rows.length)return null;
  const classKey=(r:Transfer)=>r.classification?.toLowerCase()??r.qualityStatus;
  const wc=Boolean(wildcardMode);
  return <section className={`ranked-moves quality-${rows[0].qualityStatus} engine-${classKey(rows[0])}${wc?" wildcard-mode":""}`}>
    <header><div><span>{eyebrow}</span><h2>{title}</h2></div><small>{wc?"Ranked by full-squad Wildcard objective Δ (not FT / NET vs HOLD)":"Ranked by risk-adjusted 5-GW NET vs HOLD"}</small></header>
    {rows.map((r,i)=>{const isHold=Boolean(r.isHold||r.classification==="HOLD");const key=isHold?"hold-no-transfer":`${r.out.id}-${r.incoming.id}`;const isOpen=expanded.has(key);const net3=r.netEv3??r.netDifference;const net5=r.netEv5??r.netDifference;const hit=wc?(r.hitLabel&&r.hitLabel!=="Free"?r.hitLabel:"Wildcard"):(r.hitLabel??(r.hitCost?`−${r.hitCost}`:"Free"));const cls=r.classification??(r.qualityStatus==="actionable"?"LEAN":r.qualityStatus==="watchlist"?"WATCH":"AVOID");const clsLabel=wc&&cls==="HOLD"?"KEEP":cls;return <article key={key} className={`quality-${r.qualityStatus} engine-${String(cls).toLowerCase()}${isHold?" engine-hold":""}`}>
      <i>{i+1}</i>
      <div>{isHold?<><span>{wc?"KEEP":"HOLD"}</span><b>→ {wc?"CURRENT SQUAD":"NO TRANSFER"}</b><small>{wc?"Temporary Wildcard squad · ":"Keep current squad · "}£{(r.bankAfter??0).toFixed(1)}m bank</small></>:<><span>{r.out.name}</span><b>→ {r.incoming.name}</b><small>{wc?"Wildcard swap candidate · ":""}{r.incoming.teamShort} · £{r.incoming.price.toFixed(1)}m · bank after £{(r.bankAfter??0).toFixed(1)}m</small></>}</div>
      <p><b>{hit}</b><small>{wc?"Mode":"Hit"}</small></p>
      <p><b>{(r.nextGwGross??r.gain1)>=0&&r.nextGwGross!==undefined?r.nextGwGross.toFixed(1):(r.gain1>=0?"+":"")+r.gain1.toFixed(1)}</b><small>Next GW gross</small></p>
      <p><b>{(r.threeGwNetVsHold??net3)>=0?"+":""}{(r.threeGwNetVsHold??net3).toFixed(1)}</b><small>{wc?"3-GW squad Δ":"3-GW NET vs HOLD"}</small></p>
      <p><b>{(r.fiveGwNetVsHold??net5)>=0?"+":""}{(r.fiveGwNetVsHold??net5).toFixed(1)}</b><small>{wc?"5-GW squad Δ":"5-GW NET vs HOLD"}</small></p>
      <em className={`quality-badge engine-badge ${String(cls).toLowerCase()}`}>{clsLabel}</em>
      <em className={r.risk.toLowerCase()}>{Math.round((r.confidenceIn??0)*100)}% projection evidence · {r.risk} risk</em>
      <button onClick={()=>toggleExpand(key)}>{isOpen?"Hide detail":"Show detail"}</button>
      <button onClick={()=>setWatch(r.incoming.id)}>{watchIds.includes(r.incoming.id)?"Watching ✓":"Watch"}</button>
      {isOpen&&<>
        <p className="engine-reason">{r.engineReason??r.qualityReasons[0]?.message??""}</p>
        <p className="confidence-risk-note"><small>Confidence is projection evidence strength; risk is minutes/start volatility — they are not the same.</small></p>
        {!isHold&&<section className="engine-net-detail">
          <header><span>{wc?"WILDCARD SQUAD · DETAIL":"NET VS HOLD · DETAIL"}</span></header>
          <p><span>{wc?"Raw 5-GW squad Δ":"Raw 5-GW NET vs HOLD"}</span><b>{(r.fiveGwNetVsHold??net5)>=0?"+":""}{(r.fiveGwNetVsHold??net5).toFixed(1)}</b></p>
          <p><span>Risk adjustment (points Δ)</span><b>{((r.riskAdjustmentPointsDelta??((r.riskAdjustedFiveGwNetVsHold??r.riskAdjustedNet5??net5)-(r.fiveGwNetVsHold??net5))))>=0?"+":""}{(r.riskAdjustmentPointsDelta??((r.riskAdjustedFiveGwNetVsHold??r.riskAdjustedNet5??net5)-(r.fiveGwNetVsHold??net5))).toFixed(1)}</b><small>×{(r.riskAdjustment??1).toFixed(2)} · confidence only</small></p>
          <p><span>{wc?"Adjusted squad objective Δ":"Adjusted 5-GW NET vs HOLD"}</span><b>{(r.riskAdjustedFiveGwNetVsHold??r.riskAdjustedNet5??net5)>=0?"+":""}{(r.riskAdjustedFiveGwNetVsHold??r.riskAdjustedNet5??net5).toFixed(1)}</b></p>
          {wc&&<div className="hit-detail-breakdown"><span>WILDCARD NOTES</span><p><span>Hit cost</span><b>None</b></p><p><span>FT constraint</span><b>Ignored</b></p><p><span>Bank after</span><b>£{(r.bankAfter??0).toFixed(1)}m</b></p><p><span>3-GW squad Δ</span><b>{(r.threeGwNetVsHold??net3)>=0?"+":""}{(r.threeGwNetVsHold??net3).toFixed(1)}</b></p><p><span>5-GW squad Δ</span><b>{(r.fiveGwNetVsHold??net5)>=0?"+":""}{(r.fiveGwNetVsHold??net5).toFixed(1)}</b></p></div>}
          {!wc&&r.hitCost>0&&<div className="hit-detail-breakdown">
            <span>HIT BREAKDOWN</span>
            <p><span>FT available</span><b>{r.freeTransfersBefore??0}</b></p>
            <p><span>Transfers required</span><b>1</b></p>
            <p><span>FT used / paid hit</span><b>{r.freeTransfersUsed??0} / −{r.hitCost}</b></p>
            <p><span>Next GW hold proj</span><b>{(r.holdNextGwGross??0).toFixed(1)}</b></p>
            <p><span>Next GW transfer proj</span><b>{(r.nextGwGross??0).toFixed(1)}</b></p>
            <p><span>Immediate net (gross−hit)</span><b>{((r.nextGwGross??0)-(r.holdNextGwGross??0)-r.hitCost)>=0?"+":""}{((r.nextGwGross??0)-(r.holdNextGwGross??0)-r.hitCost).toFixed(1)}</b></p>
            <p><span>3-GW NET vs HOLD</span><b>{(r.threeGwNetVsHold??net3)>=0?"+":""}{(r.threeGwNetVsHold??net3).toFixed(1)}</b></p>
            <p><span>5-GW NET vs HOLD</span><b>{(r.fiveGwNetVsHold??net5)>=0?"+":""}{(r.fiveGwNetVsHold??net5).toFixed(1)}</b></p>
            {r.timingEvVsWait!=null&&<p><span>Act-now vs wait 1 GW</span><b>{r.timingEvVsWait>=0?"+":""}{r.timingEvVsWait.toFixed(1)}</b><small>{r.timingEvVsWait>0?"Acting now modelled better than waiting one GW for a free move.":"Waiting one GW for a free move is modelled at least as good."}</small></p>}
          </div>}
          {!!r.riskDrivers?.length&&<div className="risk-drivers"><span>RISK DRIVERS</span>{r.riskDrivers.map(d=><p key={d.code}><b>{d.label}</b> {d.detail}</p>)}</div>}
          {!!(r.transferNowPathLegs?.length||r.transferNowPath?.length)&&<div className="future-paths"><span>WHY THIS FUTURE MOVE? · TRANSFER-NOW</span><ol>{(r.transferNowPathLegs??r.transferNowPath!.map((s,i)=>({summary:s,eventId:i,offset:i,action:"HOLD" as const,hitCost:0,freeTransfersBefore:0,freeTransfersAfter:0,weeklyGross:0,discountedEp:0,netEp:0}))).map((leg,i)=><li key={`${leg.eventId}-${i}`}><b>{leg.summary}</b>{("weeklyGross" in leg && leg.weeklyGross>0)&&<small> · {leg.weeklyGross.toFixed(1)} xPts · FT {leg.freeTransfersBefore}→{leg.freeTransfersAfter}</small>}</li>)}</ol></div>}
          {!!r.holdNowPath?.length&&<div className="future-paths"><span>{wc?"WILDCARD KEEP PATH":"HOLD-NOW PATH"}</span><ol>{r.holdNowPath.map(s=><li key={s}>{s}</li>)}</ol></div>}
        </section>}
        <TransferBreakdown r={r} data={data} decision={confidence.state.results[confidence.keyFor(r)]} analysisActive={confidence.state.activeKey===confidence.keyFor(r)} analysisBusy={confidence.state.activeKey!==null} onAnalyze={()=>confidence.analyzeAlternative(r)}/>
        {!isHold&&<PersonalTransferPlace elementOut={r.out.id} elementIn={r.incoming.id} event={event} purchasePrice={r.incoming.price} outName={r.out.name} inName={r.incoming.name} note="Places this ranked route — not limited to the top recommendation."/>}
      </>}
    </article>})}
  </section>;
}

function TransferDebugTable({rows}:{rows:Transfer[]}){return <section className="transfer-debug-table"><header><span>DEV ONLY · TRANSFER ENGINE DEBUG</span><h2>Every number, traceable to its components.</h2></header><div className="debug-table-scroll"><table><thead><tr><th>OUT</th><th>IN</th><th>OUT GW1</th><th>IN GW1</th><th>GW1 Δ</th><th>OUT 3GW</th><th>IN 3GW</th><th>3GW Δ</th><th>OUT 5GW</th><th>IN 5GW</th><th>5GW Δ</th><th>xMins OUT/IN</th><th>Start% OUT/IN</th><th>Risk OUT/IN</th><th>Fixture adj.</th><th>DC IN</th><th>Attacking IN</th><th>Projection evidence IN</th><th>Optimizer utility Δ (NOT expected points; not /100)</th></tr></thead><tbody>{rows.map(r=><tr key={`${r.out.id}-${r.incoming.id}`}><td>{r.out.name}</td><td>{r.incoming.name}</td><td>{r.outGw1.toFixed(2)}</td><td>{r.inGw1.toFixed(2)}</td><td>{r.gain1.toFixed(2)}</td><td>{r.outGw3.toFixed(2)}</td><td>{r.inGw3.toFixed(2)}</td><td>{r.gain3.toFixed(2)}</td><td>{r.outGw5.toFixed(2)}</td><td>{r.inGw5.toFixed(2)}</td><td>{r.gain5.toFixed(2)}</td><td>{Math.round(r.expectedMinutesOut)}/{Math.round(r.expectedMinutesIn)}</td><td>{Math.round(r.startProbOut*100)}%/{Math.round(r.startProbIn*100)}%</td><td>{Math.round((1-r.startProbOut)*100)}%/{Math.round((1-r.startProbIn)*100)}%</td><td>{r.fixtureAdjustmentIn.toFixed(1)}</td><td>{r.dcIn.toFixed(2)}</td><td>{r.attackingIn.toFixed(2)}</td><td>{Math.round(r.confidenceIn*100)}%</td><td>{r.utilityChange===null?"—":r.utilityChange.toFixed(2)}</td></tr>)}</tbody></table></div></section>}

export type PriceTiming={direction:"rise"|"fall"|"stable";message:string};

export function priceTimingSignal(player:FplPlayer|null|undefined):PriceTiming{
  if(!player)return{direction:"stable",message:"No meaningful price pressure today."};
  const pct=player.priceProjectionToday??0;
  if(pct>=MEANINGFUL_PRICE_PRESSURE)return{direction:"rise",message:`${Math.round(pct)}% rise pressure today (FPL's own projection) — buying before a rise saves money.`};
  if(pct<=-MEANINGFUL_PRICE_PRESSURE)return{direction:"fall",message:`${Math.round(Math.abs(pct))}% fall pressure today — no rush, a drop may make this cheaper soon.`};
  return{direction:"stable",message:"No meaningful price pressure today."};
}

const outlookDayLabel=(offsetDays:number)=>offsetDays===0?"Today":offsetDays===1?"Tomorrow":"Day after";

function PriceIntel({rows}:{rows:Transfer[]}){const targets=rows.filter(r=>!r.isHold&&r.classification!=="HOLD"&&r.incoming?.id);if(!targets.length)return null;return <section className="price-intel"><header><span>PRICE-CHANGE INTELLIGENCE</span><h2>Market pressure, without chasing it.</h2></header>{targets.slice(0,4).map(r=>{const timing=priceTimingSignal(r.incoming);const outlook=priceOutlookSignal(r.incoming);return <article key={r.incoming.id}><b>{r.incoming.name}<small>£{r.incoming.price.toFixed(1)}m</small></b><span className={timing.direction}>{timing.direction==="rise"?"Rise pressure":timing.direction==="fall"?"Fall pressure":"Stable"}</span><p>{timing.message}</p><div className="price-outlook-strip">{outlook.map(day=><span key={day.offsetDays} className={day.direction}>{outlookDayLabel(day.offsetDays)}</span>)}</div></article>})}</section>}

// Pure so the branching is directly unit-testable (tests/watchlist.test.mts) without rendering.
// close: true when the ONLY blocking factor is a small gap on that same metric — this is the
// single source the priority badge is derived from, so the badge can never disagree with the message.
export type BuyTrigger={message:string;ready:boolean;close:boolean;budgetNote:string|null};

// comparisonOwned distinguishes a REAL prospective sale (natural is actually in the squad -- the
// default, matching every existing call site/test) from a manually-picked reference player who
// isn't owned. In the second case there is no sale to fund the purchase from, so the shortfall
// must be target's own price against the bank alone, never target-minus-natural's price -- doing
// the old subtraction here would silently credit "sale proceeds" from a player never actually being
// sold, understating how much budget buying target outright would really need.
export function buyTriggerMessage(target:FplPlayer,natural:FplPlayer|undefined,targetMetrics:ProjectionMetrics,naturalMetrics:ProjectionMetrics|undefined,targetFiveGw:number,naturalFiveGw:number,bank:number,comparisonOwned=true):BuyTrigger{
  if(!natural)return{message:"No same-position squad player to swap out yet — build your squad first.",ready:false,close:false,budgetNote:null};
  const shortfall=comparisonOwned?Math.max(0,target.price-natural.price-bank):Math.max(0,target.price-bank);
  const budgetNote=shortfall<=.001?null:comparisonOwned
    ?`This route is currently £${shortfall.toFixed(1)}m outside your budget. That affects execution, not the player's football trigger.`
    :`You'd need £${shortfall.toFixed(1)}m more in the bank to buy ${target.name} outright — this comparison doesn't assume selling ${natural.name}.`;
  const naturalStart=Math.round((naturalMetrics?.startProbability??0)*100),targetStart=Math.round(targetMetrics.startProbability*100);
  if(targetMetrics.startProbability<.7||targetMetrics.expectedMinutes<60){
    return{message:`Wait for a secure role: ${target.name} is at ${targetStart}% start probability and ${Math.round(targetMetrics.expectedMinutes)} expected minutes versus ${natural.name} at ${naturalStart}%.`,ready:false,close:targetMetrics.startProbability>=.6&&targetMetrics.expectedMinutes>=50,budgetNote};
  }
  const gain5=targetFiveGw-naturalFiveGw;
  if(gain5<2){
    return{message:`Wait for ${target.name} to build a real five-gameweek edge over ${natural.name}; the current gap is only ${gain5>=0?"+":""}${gain5.toFixed(1)} points.`,ready:false,close:gain5>=1,budgetNote};
  }
  if(target.starts<2){
    const nextStart=target.starts===0?"a confirmed start":"a second confirmed start";
    return{message:`Wait for ${nextStart}. ${target.name}'s role projects well (${targetStart}% start chance) and the model edge is ${gain5>=0?"+":""}${gain5.toFixed(1)} points, but one match is not enough performance evidence.`,ready:false,close:target.starts===1,budgetNote};
  }
  const naturalHasSample=natural.starts>=2||natural.minutes>=150;
  const targetPpg=target.pointsPerGame,naturalPpg=natural.pointsPerGame;
  if(naturalHasSample&&targetPpg+.25<naturalPpg){
    return{message:`Wait until recent output supports the move. ${target.name} is averaging ${targetPpg.toFixed(1)} points per appearance versus ${natural.name}'s ${naturalPpg.toFixed(1)}, despite the fixture projection.`,ready:false,close:targetPpg+.75>=naturalPpg,budgetNote};
  }
  const performanceMessage=`Performance case met: ${target.name} has a secure ${targetStart}% projected start chance, ${targetPpg.toFixed(1)} points per appearance and a ${gain5>=0?"+":""}${gain5.toFixed(1)}-point five-GW edge over ${natural.name}.`;
  if(shortfall>.001)return{message:performanceMessage,ready:false,close:false,budgetNote};
  return{message:performanceMessage,ready:true,close:false,budgetNote:null};
}

export function watchlistCandidatePool(players:FplPlayer[],ownedIds:number[],watchedIds:number[],query="",position="ALL"):FplPlayer[]{
  const owned=new Set(ownedIds),watched=new Set(watchedIds),needle=query.trim().toLowerCase();
  return players.filter(player=>!owned.has(player.id)&&!watched.has(player.id)&&player.status!=="u"&&(position==="ALL"||player.positionShort===position)&&(!needle||`${player.name} ${player.teamName} ${player.teamShort}`.toLowerCase().includes(needle))).sort((a,b)=>a.positionId-b.positionId||a.name.localeCompare(b.name));
}

// Manual comparison overrides are a display/analysis preference, not squad state -- kept plain
// client-local (matching fpl-edge-locks/fpl-edge-captain-* elsewhere in this file), not routed
// through persist()/collectSyncPayload's cross-device sync, which only knows a fixed, explicit set
// of keys (squadIds/watchlist/entry/manager/plans/plannedChips) that this was never added to.
const WATCHLIST_COMPARE_KEY="fpl-edge-watchlist-compare";

const readCompareOverrides=():Record<number,number>=>{try{return JSON.parse(localStorage.getItem(WATCHLIST_COMPARE_KEY)||"{}")}catch{return{}}};

function Watchlist({data,squad,ids,remove,bank}:{data:FplData;squad:FplPlayer[];ids:number[];remove:(id:number)=>void;bank:number}){
  const events=futureEvents(data,5),first=events[0]?.id;
  const players=ids.map(id=>data.players.find(p=>p.id===id)).filter(Boolean) as FplPlayer[];
  const[add,setAdd]=useState(""),[search,setSearch]=useState(""),[position,setPosition]=useState("ALL");
  const[expanded,setExpanded]=useState<Set<number>>(new Set());
  const[compareOverrides,setCompareOverrides]=useState<Record<number,number>>(readCompareOverrides);
  const squadIds=useMemo(()=>new Set(squad.map(player=>player.id)),[squad]);
  // Grouped once per render (not once per watchlisted player) -- squad players float to the top of
  // each position's list since they're the only real, budget-real "route" option; anyone else is a
  // free stats-only comparison, per the explicit design decision that the picker is not restricted
  // to the squad.
  const playersByPosition=useMemo(()=>{
    const map=new Map<number,FplPlayer[]>();
    data.players.forEach(player=>{if(player.status!=="u")map.set(player.positionId,[...(map.get(player.positionId)??[]),player])});
    for(const list of map.values())list.sort((a,b)=>(squadIds.has(b.id)?1:0)-(squadIds.has(a.id)?1:0)||a.name.localeCompare(b.name));
    return map;
  },[data.players,squadIds]);
  const setCompareOverride=(targetId:number,comparisonId:number|null)=>setCompareOverrides(current=>{
    const next={...current};
    if(comparisonId)next[targetId]=comparisonId;else delete next[targetId];
    localStorage.setItem(WATCHLIST_COMPARE_KEY,JSON.stringify(next));
    return next;
  });
  const candidates=useMemo(()=>watchlistCandidatePool(data.players,squad.map(player=>player.id),ids,search,position),[data.players,squad,ids,search,position]);
  const addPlayer=()=>{const id=Number(add);if(id)remove(id);setAdd("")};
  const toggleExpand=(id:number)=>setExpanded(x=>{const next=new Set(x);next.has(id)?next.delete(id):next.add(id);return next});
  return <><section className="watchlist-add"><div><span>PERMANENT WATCHLIST</span><h2>Search every official FPL player.</h2><p>{candidates.length} eligible player{candidates.length===1?"":"s"} match your filters.</p></div><div className="watchlist-player-search"><input value={search} onChange={event=>{setSearch(event.target.value);setAdd("")}} placeholder="Search player or club…"/><select value={position} onChange={event=>{setPosition(event.target.value);setAdd("")}}><option value="ALL">All positions</option>{data.rules.positions.map(rule=><option value={rule.short} key={rule.id}>{rule.short}</option>)}</select><select value={add} onChange={e=>setAdd(e.target.value)}><option value="">Choose from {candidates.length} players…</option>{candidates.map(p=><option key={p.id} value={p.id}>{p.name} · {p.teamShort} · {p.positionShort} · £{p.price.toFixed(1)}m</option>)}</select></div><button onClick={addPlayer} disabled={!add}>Add to watchlist</button></section>
  <section className="watchlist-grid">{players.length?players.map(p=>{
    const m=projectionMetrics(p,first,data.fixtures,first);
    // Auto pick: among your OWN squad at this position, the affordable-first, weakest-projected
    // player -- i.e. who you'd actually drop. Always computed (feeds the select's "Auto" option and
    // is the fallback when no override is set or the stored override no longer resolves).
    const samePositionSquad=squad.filter(player=>player.positionId===p.positionId).map(player=>({player,fiveGw:events.reduce((sum,event)=>sum+playerProjection(player,event.id,data.fixtures,first),0),shortfall:Math.max(0,p.price-player.price-bank)}));
    const autoNaturalRoute=[...samePositionSquad].sort((a,b)=>(a.shortfall===0?0:1)-(b.shortfall===0?0:1)||a.shortfall-b.shortfall||a.fiveGw-b.fiveGw)[0];
    const autoNatural=autoNaturalRoute?.player;
    const overrideId=compareOverrides[p.id];
    const overridePlayer=overrideId?data.players.find(player=>player.id===overrideId&&player.positionId===p.positionId):undefined;
    const natural=overridePlayer??autoNatural;
    const comparisonOwned=natural?squadIds.has(natural.id):true;
    const naturalMetrics=natural?projectionMetrics(natural,first,data.fixtures,first):undefined;
    const gw1=playerProjection(p,first,data.fixtures,first);
    const threeGw=events.slice(0,3).reduce((s,e)=>s+playerProjection(p,e.id,data.fixtures,first),0);
    const fiveGw=events.reduce((s,e)=>s+playerProjection(p,e.id,data.fixtures,first),0);
    const naturalFiveGw=natural?events.reduce((sum,event)=>sum+playerProjection(natural,event.id,data.fixtures,first),0):0;
    const trigger=buyTriggerMessage(p,natural,m,naturalMetrics,fiveGw,naturalFiveGw,bank,comparisonOwned);
    const priority=trigger.ready?"BUY":trigger.close?"BUILDING":"WATCH";
    const compareOptions=(playersByPosition.get(p.positionId)??[]).filter(player=>player.id!==p.id);
    const isOpen=expanded.has(p.id);
    const dist=isOpen?playerPointsDistribution(m,p.positionShort):null;
    const range=dist?pointsRange(dist):null;
    return <article key={p.id}>
      <header><div><span>{p.teamShort} · {p.positionShort}</span><h3>{p.name}</h3></div><b className={priority.toLowerCase()}>{priority}</b></header>
      <div className="watch-kpis">
        <span><small>PRICE</small><b>£{p.price.toFixed(1)}m</b></span>
        <span><small>GW1 xPTS</small><b>{gw1.toFixed(1)}</b></span>
        <span><small>3-GW xPTS</small><b>{threeGw.toFixed(1)}</b></span>
        <span><small>5-GW xPTS</small><b>{fiveGw.toFixed(1)}</b></span>
        <span><small>xMINS</small><b>{Math.round(m.expectedMinutes)}</b></span>
        <span><small>START%</small><b>{Math.round(m.startProbability*100)}%</b></span>
        <span><small>xG90</small><b>{m.xG90.toFixed(2)}</b></span>
        <span><small>xA90</small><b>{m.xA90.toFixed(2)}</b></span>
        <span><small>PROJECTION EVIDENCE</small><b>{Math.round(m.confidence*100)}%</b></span>
      </div>
      <p><b>Role:</b> {p.positionShort}{m.penaltyRole?" · first-choice penalties":""}{m.setPieceRole?" · set-piece role":""}{!m.penaltyRole&&!m.setPieceRole?" · no confirmed set-piece role":""}</p>
      <p className={trigger.ready?"trigger-ready":""}><b>Performance trigger:</b> {trigger.message}</p>
      {trigger.budgetNote&&<p className="watch-budget-note"><b>Budget:</b> {trigger.budgetNote}</p>}
      <div className="watch-compare-control">
        <small>{natural?comparisonOwned?`Compared route: ${natural.name} → ${p.name}`:`Comparing against: ${natural.name}`:"No same-position player to compare yet"}</small>
        <select aria-label={`Choose who to compare ${p.name} against`} value={overridePlayer?String(overridePlayer.id):""} onChange={e=>setCompareOverride(p.id,e.target.value?Number(e.target.value):null)}>
          <option value="">{autoNatural?`Auto (${autoNatural.name})`:"Auto (no squad option)"}</option>
          {compareOptions.map(player=><option key={player.id} value={player.id}>{player.name} · {player.teamShort}{squadIds.has(player.id)?" · Squad":""}</option>)}
        </select>
      </div>
      {isOpen&&dist&&range&&<div className="watch-distribution">
        <span><small>FLOOR</small><b>{range.floor}</b></span>
        <span><small>MEDIAN</small><b>{range.median}</b></span>
        <span><small>CEILING</small><b>{range.ceiling}</b></span>
        <span><small>BLANK RISK (≤2)</small><b>{Math.round(blankProbability(dist)*100)}%</b></span>
        <span><small>HAUL CHANCE (10+)</small><b>{Math.round(haulProbability(dist)*100)}%</b></span>
      </div>}
      <footer>
        <div>{events.map(e=>{const games=data.fixtures.filter(f=>f.event===e.id&&(f.teamH===p.teamId||f.teamA===p.teamId));const difficulties=games.map(f=>f.teamH===p.teamId?f.teamHDifficulty:f.teamADifficulty);const difficulty=difficulties.length?Math.round(difficulties.reduce((s,d)=>s+d,0)/difficulties.length):3;return <i key={e.id} className={`fdr-${difficulty}`}>{opponent(p,e.id,data)}<small>{difficulties.length?difficulties.join(", "):3}</small></i>})}</div>
        <button onClick={()=>toggleExpand(p.id)}>{isOpen?"Hide distribution":"Show distribution"}</button>
        <button onClick={()=>remove(p.id)}>Remove</button>
      </footer>
    </article>
  }):<div className="empty-watch"><b>Your watchlist is empty.</b><p>Add a transfer target above or from the ranked transfer list.</p></div>}</section></>;
}
