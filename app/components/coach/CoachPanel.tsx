"use client";

import {useMemo,useState,ReactNode} from "react";
import {Chip,useConnectedChipHistory,chipScoresForEvent} from "../LiveIntelligence";
import {computeChipInventory,readPlannedChips} from "../../lib/chip-portfolio";
import {resolveCaptaincy} from "../../lib/captaincy";
import {FplData,savedSquad,futureEvents,projectionMetrics,liveScoringMovers} from "../../lib/fpl";
import {createOptimizer} from "../../lib/optimizer";
import {readFreeTransfers} from "../../lib/persistence";
import {useTeamLinkAuth} from "../team-link-auth";
import {bestTransfers,selectPrimaryTransfer} from "../../lib/transfers";
import {ManagerMeta,deriveSandboxFinancialContext} from "../../lib/squad-comparison";
import {rawDifferentialsByPosition} from "../../lib/ownership-radar";
import {narrateDifferentials,resolveChipLegality,narrateChipDecision,narrateLiveStatus,narrateCurrentRank,narrateCaptainChoice,narratePrimaryTransfer,narrateTransferForPlayer,narratePriceRisk,narrateSquadBuild} from "../../lib/coach-narration";
import {ConnectTeam,analysis,priceProtectionAlerts} from "./CoachCore";
import type {View} from "./CoachCore";
import {captainReturnHaul,captaincyRiskFraming,resolveCurrentXi,resolveLiveScoring} from "./PanelShared";
import type {CaptainCandidate,LockRecord,OfficialScoringAuthority} from "./PanelShared";

// Feature #10 v1 (Interactive FPL Coach). Non-negotiable design constraint: this page adds ZERO
// new reasoning. Every intent below routes to an existing, tested, real function and narrates its
// real output via coach-narration.ts (pure interpolation, never generation -- see that file's own
// header comment). A fixed intent picker, not free text: every entity picker below is built from a
// real, already-computed list (the XI, the squad, bestTransfers' own candidates), so an entity can
// never be "unresolved" -- it's simply not offered as an option if it isn't real. No LLM anywhere
// in this page (Option A from the Feature #10 investigation); intent parsing/narration via an LLM
// (Option B) is a real, disclosed possible future upgrade, gated on confirming this app's hosting
// platform can actually hold a secret at all -- not adopted here.
type CoachIntent="captain"|"transfer-best"|"transfer-for"|"price"|"chip"|"differentials"|"live"|"rank"|"build";

const COACH_INTENTS:readonly{id:CoachIntent;label:string}[]=[
  {id:"captain",label:"Should I captain X?"},
  {id:"transfer-best",label:"What transfer should I make?"},
  {id:"transfer-for",label:"Is X worth a transfer?"},
  {id:"price",label:"Should I sell X before the price drop?"},
  {id:"chip",label:"Should I play a chip this week?"},
  {id:"differentials",label:"What's the best differential right now?"},
  {id:"live",label:"How's my team doing right now?"},
  {id:"rank",label:"What's my rank looking like?"},
  {id:"build",label:"Build me a squad"},
];

// The same nine questions, grouped by topic so the list scans instead of reading as one wall of
// look-alike buttons. Pure presentation: every id still routes to the same intent handler.
const COACH_INTENT_GROUPS:readonly{title:string;ids:readonly CoachIntent[]}[]=[
  {title:"This gameweek",ids:["captain","chip","live"]},
  {title:"Transfers & prices",ids:["transfer-best","transfer-for","price"]},
  {title:"Squad & rank",ids:["differentials","rank","build"]},
];
const intentLabel=(id:CoachIntent)=>COACH_INTENTS.find(item=>item.id===id)?.label??id;


export function Coach({data,go,revision,onTeamChange}:{data:FplData;go:(v:View)=>void;revision:number;onTeamChange:()=>void}){
  const teamAuth=useTeamLinkAuth();
  const squad=useMemo(()=>savedSquad(data),[data,revision]);
  const a=analysis(data,squad);
  let manager:ManagerMeta|null=null;try{manager=JSON.parse(localStorage.getItem("fpl-edge-manager")||"null")}catch{}
  const[intent,setIntent]=useState<CoachIntent|null>(null);
  const[captainChoice,setCaptainChoice]=useState<number|null>(null);
  const[transferTarget,setTransferTarget]=useState<number|null>(null);
  const[priceTarget,setPriceTarget]=useState<number|null>(null);
  const[chipChoice,setChipChoice]=useState<Chip|null>(null);
  const[diffPosition,setDiffPosition]=useState<number|"ALL">("ALL");
  const{connectedEntry,historyChips}=useConnectedChipHistory();

  // Differentials are the one intent that needs no squad at all -- global ownership data, same as
  // the Ownership Radar page. Computed here (not gated on `a`) so it stays available even without
  // a connected/built squad; every other intent below is gated behind `a` (a complete squad),
  // matching Overview's own established "no complete squad yet" precondition and its exact
  // decline UI, not a fresh one invented for this page.
  const differentialEventIds=useMemo(()=>futureEvents(data,5).map(e=>e.id),[data]);
  const differentials=useMemo(()=>rawDifferentialsByPosition(data.players,data.rules.positions,data.fixtures,differentialEventIds),[data,differentialEventIds.join(",")]);
  const differentialGroups=diffPosition==="ALL"?differentials:differentials.filter(g=>g.position.id===diffPosition);

  // Hooks below must run unconditionally (before the `!a` early return) even though their INPUTS
  // (bank, a.bank) are only meaningful once a squad exists -- bestTransfers/createOptimizer both
  // already degrade gracefully (bestTransfers returns [] for an incomplete squad; createOptimizer
  // doesn't need a squad at all), so it's safe to always call them, never conditionally skip the
  // hook itself.
  const finance=deriveSandboxFinancialContext(squad,data.rules.budget,manager);
  const bank=finance.baselineBank;
  const freeTransfers=readFreeTransfers();
  const moves=bestTransfers(data,squad,bank,freeTransfers,12,finance.baselineSellingPrices);
  const transferCandidates=useMemo(()=>{
    const seen=new Set<number>();const list:{id:number;name:string}[]=[];
    for(const move of moves){if(seen.has(move.incoming.id))continue;seen.add(move.incoming.id);list.push({id:move.incoming.id,name:move.incoming.name})}
    return list;
  },[moves]);
  const buildOptimizer=useMemo(()=>intent==="build"?createOptimizer(data,"Balanced 5 GWs","Balanced","Maximum xPts"):null,[data,intent]);
  const built=useMemo(()=>buildOptimizer?buildOptimizer.optimize():null,[buildOptimizer]);

  if(!a&&teamAuth!=="in")return <div className="coach-page"><h1 className="screen-title">Coach</h1><p className="coach-trust">Pick a question. Every answer is a real number from this app's own engines — no free text, no LLM.</p><p className="empty-why">A squad is required before these questions can be answered.</p><p className="pro-benefit-line">Free desk: ask once your squad is built. Season pass unlocks Draft Lab, route planner, and decision history beside Coach.</p><button type="button" className="wide-action" onClick={()=>go("draft")}>Build a squad</button><section className="coach-intent-picker is-dimmed">{COACH_INTENTS.map(item=><button type="button" disabled key={item.id}>{item.label}</button>)}</section></div>;if(!a)return <div className="coach-page"><h1 className="screen-title">Coach</h1><p className="coach-trust">Pick a question. Every answer is a real number from this app's own engines — no free text, no LLM.</p><ConnectTeam data={data} onConnected={()=>onTeamChange()}/><section className="empty-command"><span>MANUAL OPTION</span><h2>Already know your draft?</h2><p>Build and save it manually first -- most of the coach's questions need a complete squad.</p><button onClick={()=>go("draft")}>Build a squad →</button></section>{intent==="differentials"&&<CoachAnswerCard label="Best differentials">{differentialGroups.map(g=><p key={g.position.id}>{narrateDifferentials(g.position.name,g.players)}</p>)}</CoachAnswerCard>}</div>;

  // --- Should I captain X? ---
  const candidates:CaptainCandidate[]=a.xi.players.map(p=>{
    const m=projectionMetrics(p,a.first,data.fixtures,a.first);
    const{ret,haul}=captainReturnHaul(m,p.positionShort);
    return{id:p.id,name:p.name,xPts:m.xPts,ret,haul,startProbability:m.startProbability,selectedBy:p.selectedBy};
  });
  const storedCaptainId=Number(localStorage.getItem(`fpl-edge-captain-${a.first}`));
  const storedViceId=Number(localStorage.getItem(`fpl-edge-vice-${a.first}`));
  const modelCaptain=a.xi.captain??a.xi.players[0];
  const resolvedCaptaincy=resolveCaptaincy(a.xi.players,storedCaptainId,storedViceId,manager?.captainId,manager?.viceCaptainId,modelCaptain,undefined);
  const activeCaptainId=resolvedCaptaincy?.captainId??modelCaptain.id;
  const currentCandidate=candidates.find(c=>c.id===activeCaptainId)??candidates[0];
  const captaincyFraming=captaincyRiskFraming(candidates,activeCaptainId);
  const chosenCandidate=captainChoice!==null?candidates.find(c=>c.id===captainChoice):undefined;

  // --- What transfer should I make? / Is X worth a transfer? --- (moves/transferCandidates
  // computed above, before the `!a` early return -- see the hooks comment there)
  const primaryMove=selectPrimaryTransfer(moves);
  const transferMatchIndex=moves.findIndex(m=>m.incoming.id===transferTarget);
  const transferMatch=transferMatchIndex>=0?moves[transferMatchIndex]:undefined;
  const transferTargetName=data.players.find(p=>p.id===transferTarget)?.name??"";

  // --- Should I sell X before the price drop? ---
  const priceAlerts=priceProtectionAlerts(squad);
  const priceAlert=priceAlerts.find(alert=>alert.player.id===priceTarget);
  const priceTargetName=squad.find(p=>p.id===priceTarget)?.name??"";

  // --- Should I play a chip this week? --- (scoped to "this week" == a.first, matching the
  // question as asked; not a general week-picker, keeping this intent v1-minimal)
  const chipInventory=intent==="chip"?computeChipInventory(data.events,connectedEntry?historyChips:null,readPlannedChips()):null;
  const chipEventName=data.events.find(e=>e.id===a.first)?.name??`GW${a.first}`;
  let chipNarration:string|null=null;
  if(intent==="chip"&&chipChoice&&chipInventory){
    const legality=resolveChipLegality(chipInventory,chipChoice,a.first);
    const scores=legality.legal?chipScoresForEvent(data,squad,{id:a.first},a.events.map(e=>e.id),true):null;
    const scoreKey=chipChoice==="Wildcard"?"wildcard":chipChoice==="Free Hit"?"freeHit":chipChoice==="Bench Boost"?"benchBoost":"tripleCaptain";
    chipNarration=narrateChipDecision(chipChoice,legality,chipEventName,scores?scores[scoreKey]:null);
  }

  // --- How's my team doing right now? --- (duplicates CurrentGameweekView's real assembly rather
  // than extracting it -- an explicit, logged v1 tradeoff; see HANDOFF's follow-up list)
  let liveNarration:string|null=null;
  if(intent==="live"){
    const currentAnchor=data.events.find(e=>e.current)??null;
    const deadlinePassed=currentAnchor?Date.parse(currentAnchor.deadline)<=Date.now():false;
    if(!currentAnchor||!deadlinePassed)liveNarration="No gameweek is currently live.";
    else{
      const gwFixtures=data.fixtures.filter(f=>f.event===currentAnchor.id);
      const hasStarted=gwFixtures.some(f=>f.started);
      const allFixturesFinished=gwFixtures.length>0&&gwFixtures.every(f=>f.finished);
      let locks:LockRecord[]=[];try{locks=JSON.parse(localStorage.getItem("fpl-edge-locks")||"[]")}catch{}
      const currentLock=locks.find(l=>l.event===currentAnchor.id);
      const currentOfficialPicks=manager?.event===currentAnchor.id?manager.picks:undefined;
      const currentResolution=resolveCurrentXi(squad,data.players,currentAnchor.id,data.fixtures,currentLock,currentOfficialPicks);
      const liveStoredCaptainId=Number(localStorage.getItem(`fpl-edge-captain-${currentAnchor.id}`));
      const liveStoredViceId=Number(localStorage.getItem(`fpl-edge-vice-${currentAnchor.id}`));
      const liveResolved=resolveCaptaincy(currentResolution.xi,liveStoredCaptainId,liveStoredViceId,manager?.captainId,manager?.viceCaptainId,currentResolution.modelCaptain,currentResolution.modelVice);
      if(!liveResolved)liveNarration="Your current squad has no players to score live.";
      else{
        const official:OfficialScoringAuthority|null=manager?.event===currentAnchor.id?{event:manager.event,captainId:manager.captainId,viceCaptainId:manager.viceCaptainId,chip:manager.chip}:null;
        const scoring=resolveLiveScoring({xi:currentResolution.xi,bench:currentResolution.bench,localCaptainId:liveResolved.captainId,localViceId:liveResolved.viceId,eventId:currentAnchor.id,deadlinePassed,official,finalizeAutosubs:allFixturesFinished});
        const planningFirst=futureEvents(data,5)[0]?.id??currentAnchor.id;
        const countedForMovers=scoring.activeChip==="bboost"?[...scoring.effectiveXi,...scoring.displayedBench]:scoring.effectiveXi;
        const movers=hasStarted?liveScoringMovers(countedForMovers,scoring.effectiveCaptainId,scoring.captainMultiplier,currentAnchor.id,data.fixtures,planningFirst):{hurting:[],helping:[]};
        liveNarration=narrateLiveStatus(scoring,movers,currentAnchor.name);
      }
    }
  }

  // --- What's my rank looking like? --- (simplified for v1: real current official rank only, NOT
  // a Decision-Confidence-based forward projection -- that needs its own Web Worker integration,
  // the same category of real, logged follow-up as the chip-schedule Worker offload; see HANDOFF)
  const rankNarration=manager?narrateCurrentRank(manager):null;

  // --- Build me a squad --- (fixed defaults, not a full settings picker, to keep this one intent
  // v1-minimal -- the same real optimizer Draft Lab's "Build best squad" button already runs;
  // buildOptimizer/built computed above, before the `!a` early return)

  return <div className="coach-page">
    <h1 className="screen-title">Coach</h1>
    <p className="coach-trust">Pick a question. Every answer is a real number from this app's own engines — no free text, no LLM.</p>
    <div className="coach-intent-groups" aria-label="Coach questions">{COACH_INTENT_GROUPS.map(group=><section key={group.title} className="coach-intent-group" aria-label={group.title}><h2>{group.title}</h2><div className="coach-intent-picker">{group.ids.map(id=><button type="button" key={id} className={intent===id?"active":""} aria-pressed={intent===id} onClick={()=>setIntent(id)}>{intentLabel(id)}</button>)}</div></section>)}</div>
    <details className="coach-about"><summary>About these answers</summary><p>No free text in v1, no LLM anywhere on this page — pick a question and (if it needs one) a real player or chip from your own data. Can't answer: effective ownership / real captaincy rates (FPL doesn't publish them until after a gameweek's own deadline has passed), price moves beyond FPL's real 3-day window, or predicting an actual match result (this app projects player points, never a match winner).</p></details>

    {intent==="captain"&&<CoachAnswerCard label="Captaincy">
      <select value={captainChoice??""} onChange={e=>setCaptainChoice(Number(e.target.value))}><option value="" disabled>Choose a player from your XI…</option>{a.xi.players.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
      {chosenCandidate&&<p>{narrateCaptainChoice(chosenCandidate,currentCandidate,captaincyFraming)}</p>}
    </CoachAnswerCard>}

    {intent==="transfer-best"&&<CoachAnswerCard label="Transfer recommendation"><p>{narratePrimaryTransfer(primaryMove)}</p></CoachAnswerCard>}

    {intent==="transfer-for"&&<CoachAnswerCard label="Transfer target">
      <select value={transferTarget??""} onChange={e=>setTransferTarget(Number(e.target.value))}><option value="" disabled>Choose a real transfer candidate…</option>{transferCandidates.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
      {transferTarget!==null&&<p>{narrateTransferForPlayer(transferMatch,transferMatchIndex>=0?transferMatchIndex+1:null,12,transferTargetName)}</p>}
    </CoachAnswerCard>}

    {intent==="price"&&<CoachAnswerCard label="Price risk">
      <select value={priceTarget??""} onChange={e=>setPriceTarget(Number(e.target.value))}><option value="" disabled>Choose a player from your squad…</option>{squad.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
      {priceTarget!==null&&<p>{narratePriceRisk(priceAlert,priceTargetName)}</p>}
    </CoachAnswerCard>}

    {intent==="chip"&&<CoachAnswerCard label="Chip decision">
      <div className="chip-action-toggle">{(["Wildcard","Free Hit","Bench Boost","Triple Captain"] as Chip[]).map(chip=><button type="button" key={chip} className={chipChoice===chip?"active":""} onClick={()=>setChipChoice(chip)}>{chip}</button>)}</div>
      {chipNarration&&<p>{chipNarration}</p>}
    </CoachAnswerCard>}

    {intent==="differentials"&&<CoachAnswerCard label="Best differentials">
      <select value={diffPosition} onChange={e=>setDiffPosition(e.target.value==="ALL"?"ALL":Number(e.target.value))}><option value="ALL">All positions</option>{data.rules.positions.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
      {differentialGroups.map(g=><p key={g.position.id}>{narrateDifferentials(g.position.name,g.players)}</p>)}
    </CoachAnswerCard>}

    {intent==="live"&&<CoachAnswerCard label="Live status"><p>{liveNarration}</p></CoachAnswerCard>}

    {intent==="rank"&&<CoachAnswerCard label="Rank">{rankNarration?<p>{rankNarration}</p>:<p>Connect your official FPL team to see your real rank.</p>}</CoachAnswerCard>}

    {intent==="build"&&built&&<CoachAnswerCard label="Squad build"><p>{narrateSquadBuild(built.evaluation.weeks[0],"Balanced 5 GWs")}</p></CoachAnswerCard>}
  </div>;
}

function CoachAnswerCard({label,children}:{label:string;children:ReactNode}){return <section className="coach-answer-card"><span>{label.toUpperCase()}</span>{children}</section>}
