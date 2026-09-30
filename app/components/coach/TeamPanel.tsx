"use client";

import {useState,useEffect,useMemo,useRef} from "react";
import {usePopulationPercentiles} from "../usePopulationPercentiles";
import {LiveRankResult,estimateLiveRankResult} from "../../lib/rank-estimate-core";
import {chipScoresForEvent} from "../LiveIntelligence";
import {plannedChipFor,readPlannedChips} from "../../lib/chip-portfolio";
import {FplPlayer,FplEvent,displayedGameweekAverage,FplData,savedSquad,futureEvents,projectionMetrics,opponent,playerProjection,LiveMover,liveScoringMovers,bestXi} from "../../lib/fpl";
import {useTeamLinkAuth} from "../team-link-auth";
import {Transfer,bestTransfers} from "../../lib/transfers";
import {ManagerMeta} from "../../lib/squad-comparison";
import {SeasonLocked} from "../SeasonPass";
import {CaptaincyPicker,average,formation,resolveCurrentXi,resolveLiveScoring,useCaptaincy} from "./PanelShared";
import type {HistoryWeek,LiveScoringResult,LockRecord,OfficialScoringAuthority} from "./PanelShared";
import {ConnectTeam,EmptyDeskState,PhoneSquadNav,analysis,benchOrderForEvent,connectTeam,useManager} from "./CoachCore";
import type {View} from "./CoachCore";

export type OfficialRank={rank:number;asOfEvent:number};

function useGameweekHistory(entry:string|null){
  const[weeks,setWeeks]=useState<HistoryWeek[]|null>(null);
  const[officialRank,setOfficialRank]=useState<OfficialRank|null>(null);
  useEffect(()=>{
    if(!entry){setWeeks(null);setOfficialRank(null);return}
    let cancelled=false;
    fetch(`/api/fpl/history?entry=${entry}`,{cache:"no-store"}).then(r=>r.ok?r.json():null).then(json=>{
      if(cancelled)return;
      const fetchedWeeks=json?.weeks??null;
      setWeeks(fetchedWeeks);
      const lastFinished=fetchedWeeks&&fetchedWeeks.length?fetchedWeeks[fetchedWeeks.length-1].event:null;
      setOfficialRank(typeof json?.manager?.overallRank==="number"&&lastFinished!==null?{rank:json.manager.overallRank,asOfEvent:lastFinished}:null);
    }).catch(()=>{if(!cancelled){setWeeks(null);setOfficialRank(null)}});
    return()=>{cancelled=true};
  },[entry]);
  return{weeks,officialRank};
}

export type PastGameweekPlayer={player:FplPlayer;points:number;multiplier:number;isCaptain:boolean;isViceCaptain:boolean};

export type PastGameweekResult={source:"official"|"locked-prediction";totalPoints:number|null;predictedPoints:number|null;xi:PastGameweekPlayer[];bench:PastGameweekPlayer[];automaticSubs:{inName:string;outName:string}[]};

// Two possible sources for a past week, in preference order -- neither is invented. "official" is
// the real reconstructed result (connected accounts, via /api/fpl/history's picks+live data).
// "locked-prediction" is what the app itself recorded before that week's deadline (Final Check's
// Lock This Team) -- a real prediction, clearly not the actual outcome, so actual points stay null
// rather than being guessed. If neither exists, the caller shows "no snapshot recorded."
export function resolvePastGameweek(players:FplPlayer[],historyWeek:HistoryWeek|undefined,lock:LockRecord|undefined):PastGameweekResult|null{
  const byId=(id:number)=>players.find(p=>p.id===id);
  if(historyWeek&&!historyWeek.unavailable&&historyWeek.squad?.length){
    const rows=historyWeek.squad.map(pick=>({player:byId(pick.elementId),points:historyWeek.playerPoints?.[String(pick.elementId)]??0,multiplier:pick.multiplier,isCaptain:pick.isCaptain,isViceCaptain:pick.isViceCaptain,position:pick.position})).filter(row=>row.player) as (PastGameweekPlayer&{position:number})[];
    let xi=rows.filter(r=>r.position<=11).sort((a,b)=>a.position-b.position).map(({position,...rest})=>rest);
    let bench=rows.filter(r=>r.position>11).sort((a,b)=>a.position-b.position).map(({position,...rest})=>rest);
    // The nominal pick order (position 1-11 vs 12-15) is who was SELECTED, not who actually
    // contributed points -- FPL's own automatic_subs already tells us who really played. Reflect
    // those swaps in the display too, not just as a footnote, so the pitch shows the player whose
    // points actually counted rather than a 0-pointer who never got on.
    for(const sub of historyWeek.automaticSubs??[]){
      const comingOn=bench.find(r=>r.player.id===sub.elementIn);
      const goingOff=xi.find(r=>r.player.id===sub.elementOut);
      if(comingOn&&goingOff){
        xi=xi.map(r=>r.player.id===sub.elementOut?comingOn:r);
        bench=bench.map(r=>r.player.id===sub.elementIn?goingOff:r);
      }
    }
    const automaticSubs=(historyWeek.automaticSubs??[]).map(sub=>({inName:byId(sub.elementIn)?.name??"Unknown",outName:byId(sub.elementOut)?.name??"Unknown"}));
    return{source:"official",totalPoints:historyWeek.points,predictedPoints:null,xi,bench,automaticSubs};
  }
  if(lock){
    const toRow=(id:number):PastGameweekPlayer|null=>{const player=byId(id);return player?{player,points:0,multiplier:id===lock.captainId?2:1,isCaptain:id===lock.captainId,isViceCaptain:id===lock.viceId}:null};
    const xi=lock.xiIds.map(toRow).filter(Boolean) as PastGameweekPlayer[];
    const fallbackBenchIds=lock.squadIds.filter(id=>!lock.xiIds.includes(id));
    const bench=(lock.benchIds?.length===4?lock.benchIds:fallbackBenchIds).map(toRow).filter(Boolean) as PastGameweekPlayer[];
    return{source:"locked-prediction",totalPoints:null,predictedPoints:lock.predicted,xi,bench,automaticSubs:[]};
  }
  return null;
}

function GameweekNav({event,branch,onBack,onForward,canBack,canForward}:{event:FplEvent;branch:"past"|"current"|"future";onBack:()=>void;onForward:()=>void;canBack:boolean;canForward:boolean}){
  return <section className="gw-nav">
    <button onClick={onBack} disabled={!canBack} aria-label="Previous gameweek">←</button>
    <div className={`gw-nav-label gw-${branch}`}>
      <span>{branch==="past"?"PAST RESULT":branch==="current"?"LIVE NOW":"UPCOMING · PROVISIONAL"}</span>
      <b>{event.name}</b>
    </div>
    <button onClick={onForward} disabled={!canForward} aria-label="Next gameweek">→</button>
  </section>;
}

export function GameweekAverage({events,eventId}:{events:readonly FplEvent[];eventId:number}){
  const average=displayedGameweekAverage(events,eventId);
  if(!average)return null;
  const status=average.provisional?"Live · provisional":"Official FPL average";
  return <div className="gw-average" aria-label={`GW Average: ${average.value}. ${status}`}>
    <span>GW Average</span>
    <b>{average.value}</b>
    <small>{status}</small>
  </div>;
}

export function Team({data,go,revision,onTeamChange,fullDesk,onUpgrade}:{data:FplData;go:(v:View)=>void;revision:number;onTeamChange:()=>void;fullDesk:boolean;onUpgrade:()=>void}){
  const teamAuth=useTeamLinkAuth();
  const[manager,setManager]=useManager(revision);
  let entry:string|null=null;
  try{entry=localStorage.getItem("fpl-edge-entry")}catch{}
  // "Refresh from official" is the only remaining way this squad's membership or the manager's
  // official captaincy/chip authority ever changes without an explicit user action -- the auto-
  // effect that used to run this same fetch on every mount and every background data refresh
  // (data.updatedAt) was deleted: it unconditionally overwrote a locally-planned Draft Lab squad
  // the moment this page was visited or simply left open, with no check against local edits and
  // no disclosure. connectTeam() (already the single source of truth for "Connect"/"Switch team")
  // is reused as-is -- no new fetch logic.
  const[refreshBusy,setRefreshBusy]=useState(false);
  const[refreshMsg,setRefreshMsg]=useState("");
  const refreshFromOfficial=async()=>{
    if(!entry)return;
    setRefreshBusy(true);setRefreshMsg("");
    try{const m=await connectTeam(entry,data);setManager(m);onTeamChange()}
    catch(e){setRefreshMsg(e instanceof Error?e.message:"Could not refresh from official")}
    finally{setRefreshBusy(false)}
  };
  const squad=useMemo(()=>savedSquad(data),[data,revision,manager]);
  const a=analysis(data,squad);

  // Critical: the LIVE/in-progress gameweek is data.events.find(e=>e.current), NOT
  // futureEvents()[0]. futureEvents() returns the next *planning* gameweek (the one a deadline
  // hasn't passed for yet) -- after the grace-window fix, that's deliberately different from
  // whichever gameweek's matches are actually being played right now. Getting this backwards here
  // would reintroduce a version of the original GW1-stuck bug inside this feature.
  const currentAnchor=useMemo(()=>data.events.find(e=>e.current)??null,[data]);
  const horizonEvents=useMemo(()=>futureEvents(data,8),[data]);
  const backwardBoundId=data.events[0]?.id??1;
  const forwardBoundId=horizonEvents.length?horizonEvents[horizonEvents.length-1].id:(currentAnchor?.id??data.events[data.events.length-1]?.id??backwardBoundId);
  const defaultEventId=currentAnchor?.id??horizonEvents[0]?.id??backwardBoundId;
  const[navEventId,setNavEventId]=useState<number>(()=>defaultEventId);
  // Real bug, found live: navEventId's initializer above only ever runs once, at mount -- if this
  // page stays mounted across the live gameweek actually advancing (e.g. a tab left open overnight
  // through a deadline, or one gameweek's matches finishing and the next becoming current), nothing
  // previously re-synced it, so the view kept showing the OLD anchor as "current" (and the new one
  // as stale "upcoming/provisional") until a full page reload. This only auto-advances navEventId
  // when it was still tracking the PREVIOUS anchor -- if the user manually navigated to a different
  // gameweek, a later poll must never yank them back to "current" out from under them. The
  // `previous!==undefined` guard means the very first anchor (mount, or the null-to-non-null
  // pre-season transition) is never treated as a change to auto-follow -- defaultEventId above
  // already resolves that case correctly on its own.
  const prevAnchorIdRef=useRef(currentAnchor?.id);
  useEffect(()=>{
    const previous=prevAnchorIdRef.current;
    prevAnchorIdRef.current=currentAnchor?.id;
    if(currentAnchor&&previous!==undefined&&currentAnchor.id!==previous){
      setNavEventId(current=>current===previous?currentAnchor.id:current);
    }
  },[currentAnchor]);
  const[tab,setTab]=useState<"Pitch"|"List">("Pitch");
  const[selected,setSelected]=useState<FplPlayer|null>(null);

  const event=data.events.find(e=>e.id===navEventId)??currentAnchor??horizonEvents[0]??data.events[0];
  // "Past" is decided by event.finished, not by comparing ids to currentAnchor -- a gameweek stays
  // current:true and finished:false for as long as its matches are still being played (including a
  // mid-gameweek state where some fixtures are done and others haven't kicked off), so this can't
  // prematurely read as "past" partway through.
  const branch:"past"|"current"|"future"=!event?"future":event.finished?"past":(currentAnchor&&event.id===currentAnchor.id)?"current":"future";

  const{weeks:history,officialRank}=useGameweekHistory(entry);

  // Hooks run unconditionally every render regardless of which branch is displayed -- the "current"
  // XI/captaincy is computed here even when a past or future week is what's actually shown.
  let locks:LockRecord[]=[];
  try{locks=JSON.parse(localStorage.getItem("fpl-edge-locks")||"[]")}catch{}
  const currentLock=currentAnchor?locks.find(l=>l.event===currentAnchor.id):undefined;
  const currentOfficialPicks=currentAnchor&&manager?.event===currentAnchor.id?manager.picks:undefined;
  const currentResolution=useMemo(()=>currentAnchor?resolveCurrentXi(squad,data.players,currentAnchor.id,data.fixtures,currentLock,currentOfficialPicks):null,[squad,data,currentAnchor,currentLock,currentOfficialPicks]);
  const currentXi=currentResolution?.xi??[];
  const currentBench=currentResolution?.bench??[];
  const currentCaptaincy=useCaptaincy(currentXi,currentAnchor?.id??0,currentResolution?.modelCaptain,currentResolution?.modelVice);

  if(!a&&teamAuth!=="in")return <div className="coach-page"><PhoneSquadNav active="team" go={go}/><div className="empty-desk-layout"><EmptyDeskState eyebrow="MY SQUAD" title="No squad yet" lede="Your XI, bench and captain show up here once a 15-man squad is saved." steps={["Build your 15 (or sign in to connect your FPL team)","See your XI, bench and captain on the pitch","Plan transfers from Transfers"]} actionLabel="Build a squad" onAction={()=>go("draft")}/><PitchOutline/></div></div>;if(!a)return <div className="coach-page"><PhoneSquadNav active="team" go={go}/><ConnectTeam data={data} onConnected={m=>{setManager(m);onTeamChange()}}/><button className="wide-action" onClick={()=>go("draft")}>Or build manually →</button></div>;

  const goBack=()=>setNavEventId(id=>Math.max(backwardBoundId,id-1));
  const goForward=()=>setNavEventId(id=>Math.min(forwardBoundId,id+1));

  return <div className="coach-page">
    <PhoneSquadNav active="team" go={go}/>
    <h1 className="screen-title squad-title">Squad</h1>
    <p className="template-lede">Pitch first — list view is secondary.</p>
    <GameweekNav event={event} branch={branch} onBack={goBack} onForward={goForward} canBack={event.id>backwardBoundId} canForward={event.id<forwardBoundId}/>
    {entry&&teamAuth==="in"&&<button onClick={refreshFromOfficial} disabled={refreshBusy}>{refreshBusy?"Refreshing…":"Refresh from official"}</button>}
    {refreshMsg&&<small>{refreshMsg}</small>}
    {branch==="past"&&<PastGameweekView data={data} event={event} history={history} officialRank={officialRank}/>}
    {branch==="current"&&<CurrentGameweekView data={data} event={event} squad={squad} xi={currentXi} bench={currentBench} captaincy={currentCaptaincy} manager={manager} tab={tab} setTab={setTab} selected={selected} setSelected={setSelected} bank={a.bank} go={go} officialRank={officialRank}/>}
    {branch==="future"&&(fullDesk?<FutureGameweekView data={data} event={event} squad={squad} tab={tab} setTab={setTab} selected={selected} setSelected={setSelected} bank={a.bank}/>:<SeasonLocked feature="Multi-week transfer planning is part of the season pass." onUpgrade={onUpgrade}/>)}
  </div>;
}

function PlayerPanel({player,data,first,replacements,close}:{player:FplPlayer;data:FplData;first:number;replacements:Transfer[];close:()=>void}){const events=futureEvents(data,5);const m=projectionMetrics(player,first,data.fixtures,first);return <div className="player-panel-backdrop" onClick={close}><aside className="player-panel" onClick={e=>e.stopPropagation()}><button className="panel-close" onClick={close}>×</button><span>{player.teamName} · {player.position}</span><h2>{player.name}</h2><div className="panel-price">£{player.price.toFixed(1)}m <small>{player.selectedBy.toFixed(1)}% owned</small></div><div className="panel-fixtures">{events.map(e=><div key={e.id}><b>{e.name.replace("Gameweek ","GW")}</b><span>{opponent(player,e.id,data)}</span><strong>{playerProjection(player,e.id,data.fixtures,first).toFixed(1)}</strong></div>)}</div><div className="panel-stats"><p><span>Expected minutes</span><b>{Math.round(m.expectedMinutes)}</b></p><p><span>Start probability</span><b>{Math.round(m.startProbability*100)}%</b></p><p><span>Season xG / xA</span><b>{player.expectedGoals.toFixed(2)} / {player.expectedAssists.toFixed(2)}</b></p><p><span>Form</span><b>{player.form.toFixed(1)}</b></p><p><span>Penalties</span><b>{m.penaltyRole?"First choice":"Not confirmed"}</b></p><p><span>Set pieces</span><b>{m.setPieceRole?"First choice":"Not confirmed"}</b></p></div><section><span>COACH VIEW</span><p>{m.startProbability>.8?`LIKELY starter with ${Math.round(m.expectedMinutes)} expected minutes.`:`UNCERTAIN minutes profile: only ${Math.round(m.startProbability*100)}% start probability.`} {m.penaltyRole?"First-choice penalties improve the ceiling.":"No confirmed penalty role is included."}</p></section><section><span>BEST REPLACEMENTS</span>{replacements.length?replacements.map(r=><p key={r.incoming.id}><b>{r.incoming.name}</b> · +{r.gain5.toFixed(1)} five-GW xPts · {r.risk} risk</p>):<p>No clearly stronger legal one-player route was found.</p>}</section></aside></div>}

function PastGameweekView({data,event,history,officialRank}:{data:FplData;event:FplEvent;history:HistoryWeek[]|null;officialRank:OfficialRank|null}){
  const historyWeek=history?.find(w=>w.event===event.id);
  let locks:LockRecord[]=[];
  try{locks=JSON.parse(localStorage.getItem("fpl-edge-locks")||"[]")}catch{}
  const lock=locks.find(l=>l.event===event.id);
  const resolved=resolvePastGameweek(data.players,historyWeek,lock);

  if(!resolved)return <><OfficialRankCard officialRank={officialRank}/><section className="gw-empty">
    <span>NO RECORD</span>
    <h2>No snapshot recorded for this week.</h2>
    <p>{event.name} wasn't locked in Final Check before its deadline, and this account isn't connected to an official FPL Team ID. Connect a team on Overview to see full official history, or lock upcoming weeks in Final Check to build a record going forward.</p>
  </section></>;

  return <div className="gw-past">
    <section className="coach-pitch"><div className="pitch-markings"/>{["GKP","DEF","MID","FWD"].map(pos=><div className={`coach-pitch-row ${pos.toLowerCase()}`} key={pos}>{resolved.xi.filter(r=>r.player.positionShort===pos).map(r=><button key={r.player.id} disabled><i>{pos}</i><b>{r.player.name}{r.isCaptain&&<em>C</em>}{r.isViceCaptain&&<em>V</em>}</b><span>{r.points}{r.multiplier>1?` × ${r.multiplier}`:""} pts</span></button>)}</div>)}</section>
    <section className="coach-bench"><span>BENCH</span>{resolved.bench.map((r,i)=><button key={r.player.id} disabled><i>{i+1}</i><b>{r.player.name}</b><small>{r.points} pts</small></button>)}</section>
    <OfficialRankCard officialRank={officialRank}/>
    <section className="gw-past-summary">
      <div className="gw-past-scoreline">
        <div>
          <span>{resolved.source==="official"?"OFFICIAL RESULT":"YOUR LOCKED PLAN"}</span>
          <h2>{resolved.totalPoints!==null?`${resolved.totalPoints} points`:resolved.predictedPoints!==null?`${resolved.predictedPoints} projected`:"—"}</h2>
        </div>
        <GameweekAverage events={data.events} eventId={event.id}/>
      </div>
      {resolved.source==="locked-prediction"&&<p className="gw-pending-note">This is the plan you locked before the deadline, not the confirmed result -- connect an official FPL Team ID to see the real outcome for this week.</p>}
    </section>
    {resolved.automaticSubs.length>0&&<section className="gw-autosub-note"><span>AUTOMATIC SUBSTITUTIONS</span>{resolved.automaticSubs.map((s,i)=><p key={i}><b>{s.inName}</b> came on for <b>{s.outName}</b></p>)}</section>}
  </div>;
}

function CurrentGameweekView({data,event,squad,xi,bench,captaincy,manager,tab,setTab,selected,setSelected,bank,go,officialRank}:{data:FplData;event:FplEvent;squad:FplPlayer[];xi:FplPlayer[];bench:FplPlayer[];captaincy:{captain:FplPlayer;vice:FplPlayer;chooseCaptain:(id:number)=>void;chooseVice:(id:number)=>void};manager:ManagerMeta|null;tab:"Pitch"|"List";setTab:(t:"Pitch"|"List")=>void;selected:FplPlayer|null;setSelected:(p:FplPlayer|null)=>void;bank:number;go:(v:View)=>void;officialRank:OfficialRank|null}){
  const{chooseCaptain,chooseVice}=captaincy;
  const gwFixtures=data.fixtures.filter(f=>f.event===event.id);
  const hasStarted=gwFixtures.some(f=>f.started);
  // A 0-minute reading mid-gameweek doesn't mean a player won't play -- they may just not have been
  // brought on yet while their match is still live. Autosub only becomes trustworthy once every
  // fixture in the gameweek has actually finished (which can be true before the event-level
  // `finished`/`data_checked` flags catch up, since those wait on bonus-point confirmation too).
  const allFixturesFinished=gwFixtures.length>0&&gwFixtures.every(f=>f.finished);
  const deadlinePassed=Date.parse(event.deadline)<=Date.now();
  const official:OfficialScoringAuthority|null=manager?.event?{event:manager.event,captainId:manager.captainId,viceCaptainId:manager.viceCaptainId,chip:manager.chip}:null;
  const scoring=resolveLiveScoring({xi,bench,localCaptainId:captaincy.captain.id,localViceId:captaincy.vice.id,eventId:event.id,deadlinePassed,official,finalizeAutosubs:allFixturesFinished});
  const captain=xi.find(p=>p.id===scoring.captainId)??captaincy.captain;
  const vice=xi.find(p=>p.id===scoring.viceId)??captaincy.vice;
  const officialLocked=scoring.captaincySource==="official";
  const captaincyStatus=officialLocked?"Official locked captaincy":deadlinePassed?"Local estimate · connect your FPL Team ID for the official locked captaincy":`Saved automatically for GW${event.id}`;
  const multiplierWord=scoring.captainMultiplier===3?"tripled":"doubled";
  const replacement=bestTransfers(data,squad,bank).filter(x=>selected&&x.out.id===selected.id&&x.qualityStatus!=="blocked").slice(0,3);
  const planningFirst=futureEvents(data,5)[0]?.id??event.id;
  const populationPercentiles=usePopulationPercentiles();
  // Gated on hasStarted: before kickoff there's no live total to estimate a rank from that would
  // differ meaningfully from the official rank already shown elsewhere (Overview).
  const liveRank:LiveRankResult|null=!hasStarted?null:populationPercentiles===null?null:!manager?{status:"unavailable",reason:"Connect your official FPL team to see a live rank estimate."}:estimateLiveRankResult(populationPercentiles,manager.overallPoints);
  // Bench Boost bench players genuinely count toward liveTotal too (see resolveLiveScoring above) --
  // movers must be scoped to the same "counted" set, not just the XI, or a boosted bench player's
  // real swing on the live total would be invisible here.
  const countedForMovers=scoring.activeChip==="bboost"?[...scoring.effectiveXi,...scoring.displayedBench]:scoring.effectiveXi;
  const movers:{hurting:readonly LiveMover[];helping:readonly LiveMover[]}=hasStarted?liveScoringMovers(countedForMovers,scoring.effectiveCaptainId,scoring.captainMultiplier,event.id,data.fixtures,planningFirst):{hurting:[],helping:[]};

  return <div className="gw-current">
    <section className="team-toolbar"><div><span>FORMATION</span><b>{formation(scoring.effectiveXi)}</b></div><div><span>{hasStarted?"LIVE POINTS":"KICKOFF PENDING"}</span><b>{hasStarted?scoring.liveTotal:"—"}</b></div><GameweekAverage events={data.events} eventId={event.id}/>{scoring.activeChip&&<div><span>ACTIVE CHIP</span><b>{scoring.activeChip==="3xc"?"Triple Captain":scoring.activeChip==="bboost"?"Bench Boost":scoring.activeChip}</b></div>}<div className="segmented pitch-first" role="tablist" aria-label="Squad view">{(["Pitch","List"] as const).map(x=><button type="button" role="tab" aria-selected={tab===x} className={tab===x?"active":""} onClick={()=>setTab(x)} key={x}>{x}</button>)}</div><button onClick={()=>go("draft")}>Edit squad</button></section>
    {!hasStarted&&<p className="gw-pending-note">{event.name}'s matches haven't kicked off yet -- live points will appear here once they do.</p>}
    {hasStarted&&!allFixturesFinished&&<p className="gw-pending-note">Some of this gameweek's matches are still in progress -- a player showing 0 minutes may not have played yet. Final XI and automatic substitutions appear once every match finishes.</p>}
    {allFixturesFinished&&!event.dataChecked&&<p className="gw-pending-note">Bonus points aren't final yet -- FPL confirms them a few hours after the last match of the gameweek.</p>}
    {tab==="Pitch"&&<><section className="coach-pitch"><div className="pitch-markings"/>{["GKP","DEF","MID","FWD"].map(pos=><div className={`coach-pitch-row ${pos.toLowerCase()}`} key={pos}>{scoring.effectiveXi.filter(p=>p.positionShort===pos).map(p=>{const isArmband=p.id===scoring.effectiveCaptainId;const wasSubbedIn=scoring.swaps.some(s=>s.inId===p.id);return <button key={p.id} className={p.status!=="a"?"flagged":""} onClick={()=>setSelected(p)}><i>{pos}{wasSubbedIn?" · AUTO":""}</i><b>{p.name}{isArmband&&<em>C</em>}{p.id===scoring.viceId&&!isArmband&&<em>V</em>}</b><span>{hasStarted?`${p.eventPoints}${isArmband&&scoring.captainMultiplier>1?` × ${scoring.captainMultiplier}`:""} pts`:opponent(p,event.id,data)}</span><small>{hasStarted?`${p.eventMinutes} mins`:""}</small></button>})}</div>)}</section>
    <section className="coach-bench"><span>{scoring.activeChip==="bboost"?"BENCH BOOST":"BENCH"}</span>{scoring.displayedBench.map((p,i)=><button key={p.id} onClick={()=>setSelected(p)}><i>{i+1}</i><b>{p.name}</b><small>{hasStarted?`${p.eventPoints} pts · ${p.eventMinutes} mins${scoring.activeChip==="bboost"?" · COUNTED":""}`:opponent(p,event.id,data)}</small></button>)}</section></>}
    {tab==="List"&&<section className="team-list"><header><span>PLAYER</span><span>FIXTURE</span><span>PTS</span><span>MINS</span><span>STATUS</span></header>{[...scoring.effectiveXi,...scoring.displayedBench].map((p,i)=>{const isArmband=p.id===scoring.effectiveCaptainId;return <button key={p.id} onClick={()=>setSelected(p)}><b>{i<scoring.effectiveXi.length?"XI":"BENCH"} · {p.name}{isArmband?" (C)":p.id===scoring.viceId?" (V)":""}<small>{p.teamShort} · {p.positionShort}</small></b><span>{opponent(p,event.id,data)}</span><strong>{p.eventPoints}{isArmband&&scoring.captainMultiplier>1?` × ${scoring.captainMultiplier}`:""}</strong><span>{p.eventMinutes}</span><em className={p.status==="a"?"ok":"risk"}>{i>=scoring.effectiveXi.length&&scoring.activeChip==="bboost"?"COUNTED":p.status==="a"?"LIKELY":"FLAGGED"}</em></button>})}</section>}
    {scoring.swaps.length>0&&<section className="gw-autosub-note"><span>AUTOMATIC SUBSTITUTIONS</span>{scoring.swaps.map((s,i)=><p key={i}><b>{s.inName}</b> came on for <b>{s.outName}</b> (0 minutes)</p>)}</section>}
    {scoring.armbandPassedToVice&&<p className="gw-armband-note">{captain.name} didn't play -- the armband passed to {vice.name} ({vice.name}'s score is {multiplierWord}).</p>}
    {scoring.captaincyLost&&<p className="gw-armband-note">Neither {captain.name} nor {vice.name} played -- no captain multiplier applies this week.</p>}
    {scoring.activeChip==="bboost"&&<p className="gw-chip-note">Bench Boost is active · {scoring.benchBoostPoints} bench points are included in the live total.</p>}
    <OfficialRankCard officialRank={officialRank}/>
    {liveRank&&<LiveRankCard result={liveRank}/>}
    {hasStarted&&(movers.hurting.length>0||movers.helping.length>0)&&<LiveMoversCard hurting={movers.hurting} helping={movers.helping}/>}
    <CaptaincyPicker players={xi} captain={captain} vice={vice} onCaptain={chooseCaptain} onVice={chooseVice} event={event.id} data={data} readOnly={officialLocked} status={captaincyStatus}/>
    {selected&&hasStarted&&<LivePointsPanel player={selected} scoring={scoring} bonusFinal={!!allFixturesFinished&&event.dataChecked} close={()=>setSelected(null)}/>}
    {selected&&!hasStarted&&<PlayerPanel player={selected} data={data} first={planningFirst} replacements={replacement} close={()=>setSelected(null)}/>}
  </div>;
}

function OfficialRankCard({officialRank}:{officialRank:OfficialRank|null}){
  if(!officialRank)return null;
  return <section className="gw-official-rank-card">
    <span>OFFICIAL OVERALL RANK</span>
    <h3>{officialRank.rank.toLocaleString("en-GB")}</h3>
    <p>As of GW{officialRank.asOfEvent} (last finished gameweek) -- does not include any points from a gameweek still in progress.</p>
  </section>;
}

function LiveRankCard({result}:{result:LiveRankResult}){
  return <details className="gw-live-rank-card">
    <summary>Live rank estimate (not official)</summary>
    {result.status==="unavailable"?<><h3>Unavailable</h3><p>{result.reason}</p></>:<>
      <h3>{Math.round(result.rank.rank).toLocaleString("en-GB")}</h3>
      {result.rank.clamped!=="none"&&<p className="gw-live-rank-clamped">{result.rank.clamped==="above-range"?"Better than the best real sampled score.":"Worse than the worst real sampled score."}</p>}
      <details><summary>Assumptions and disclosure</summary>{result.assumptions.map(a=><p key={a}>{a}</p>)}</details>
    </>}
  </details>;
}

function LiveMoversCard({hurting,helping}:{hurting:readonly LiveMover[];helping:readonly LiveMover[]}){
  return <section className="gw-live-movers-card">
    <span>MOVERS</span><h3>Currently hurting or helping your live total</h3>
    <div className="gw-live-movers-columns">
      <div><b>HELPING</b>{helping.length?helping.map(m=><p key={m.player.id}>{m.player.name}<small>+{m.delta.toFixed(1)}</small></p>):<p className="gw-live-movers-empty">None yet.</p>}</div>
      <div><b>HURTING</b>{hurting.length?hurting.map(m=><p key={m.player.id}>{m.player.name}<small>{m.delta.toFixed(1)}</small></p>):<p className="gw-live-movers-empty">None yet.</p>}</div>
    </div>
  </section>;
}

function LivePointsPanel({player,scoring,bonusFinal,close}:{player:FplPlayer;scoring:LiveScoringResult;bonusFinal:boolean;close:()=>void}){
  const inXi=scoring.effectiveXi.some(p=>p.id===player.id);
  const onBoostedBench=scoring.activeChip==="bboost"&&scoring.displayedBench.some(p=>p.id===player.id);
  const multiplier=player.id===scoring.effectiveCaptainId?scoring.captainMultiplier:1;
  const counted=inXi||onBoostedBench;
  const countedPoints=counted?player.eventPoints*multiplier:0;
  return <div className="player-panel-backdrop" onClick={close}><aside className="player-panel live-points-panel" onClick={e=>e.stopPropagation()}><button className="panel-close" onClick={close}>×</button><span>OFFICIAL LIVE POINTS</span><h2>{player.name}</h2><div className="panel-price">{countedPoints} counted points <small>{player.eventMinutes} minutes</small></div><div className="panel-stats"><p><span>Official raw points</span><b>{player.eventPoints}</b></p><p><span>Multiplier</span><b>×{multiplier}</b></p><p><span>Captain bonus</span><b>+{player.id===scoring.effectiveCaptainId?scoring.captainBonus:0}</b></p><p><span>Bonus points{!bonusFinal?" (provisional)":""}</span><b>{player.eventBonus}</b></p><p><span>Defensive contribution</span><b>{player.eventDefensiveContribution}</b></p><p><span>Global ownership</span><b>{player.selectedBy.toFixed(1)}%</b></p><p><span>Squad role</span><b>{inXi?"Starting XI":onBoostedBench?"Bench Boost":"Bench"}</b></p><p><span>Active chip</span><b>{scoring.activeChip==="3xc"?"Triple Captain":scoring.activeChip==="bboost"?"Bench Boost":"None"}</b></p><p><span>Included in total</span><b>{counted?"Yes":"No"}</b></p></div><section><span>COUNTING RULE</span><p>{player.id===scoring.effectiveCaptainId?`${player.eventPoints} raw points × ${multiplier} = ${countedPoints}.`:onBoostedBench?`${player.eventPoints} bench points are included because Bench Boost is active.`:inXi?`${player.eventPoints} official points count once in the starting XI.`:"This bench player's points are not included without Bench Boost or an automatic substitution."}</p></section></aside></div>;
}

export function FutureGameweekView({data,event,squad,tab,setTab,selected,setSelected,bank}:{data:FplData;event:FplEvent;squad:FplPlayer[];tab:"Pitch"|"List";setTab:(t:"Pitch"|"List")=>void;selected:FplPlayer|null;setSelected:(p:FplPlayer|null)=>void;bank:number}){
  const xiResult=bestXi(squad,event.id,data.fixtures,event.id);
  const xi=xiResult.players;
  const bench=benchOrderForEvent(xi,squad.filter(p=>!xi.some(x=>x.id===p.id)),event.id,data).bench;
  const replacement=bestTransfers(data,squad,bank).filter(x=>selected&&x.out.id===selected.id&&x.qualityStatus!=="blocked").slice(0,3);
  const gwFixtures=data.fixtures.filter(f=>f.event===event.id);
  // No point total is ever shown on this page (just names/opponents/status), so there's no forward-
  // projection math to make chip-aware here -- this is purely a visible confirmation of intent,
  // keyed strictly on event.id, the same off-by-one discipline as every other plannedChipFor call site.
  const plannedChip=plannedChipFor(readPlannedChips(),event.id);
  // Single-event call, not chipVerdictAcrossHorizon -- tripleCaptain's score/detail only ever read
  // event.id internally (window only affects the wildcard score, which this view never displays),
  // so there's no horizon to build. Memoized because this view's own selected/tab state changes far
  // more often than the values this depends on, unlike FinalCheck's identical unmemoized call.
  const chipVerdict=useMemo(()=>chipScoresForEvent(data,squad,event,[event.id],true),[data,squad,event.id]);

  return <div className="gw-future">
    <section className="gw-provisional-note"><span>PROVISIONAL</span><h2>Today's squad against {event.name}'s fixtures.</h2><p>No transfers have been made for this week yet -- this is where your squad stands right now, not a locked plan. Come back closer to the deadline as news and fixtures firm up.</p>{plannedChip&&<div className="gw-planned-chip"><span>PLANNED CHIP</span><b>{plannedChip}</b></div>}</section>
    {plannedChip!=="Triple Captain"&&chipVerdict.tripleCaptain.score>=8&&<p className="gw-chip-note">This looks like a good week for Triple Captain · {chipVerdict.tripleCaptain.detail}</p>}
    <div className="segmented pitch-first" role="tablist" aria-label="Squad view">{(["Pitch","List"] as const).map(x=><button type="button" role="tab" aria-selected={tab===x} className={tab===x?"active":""} onClick={()=>setTab(x)} key={x}>{x}</button>)}</div>
    {tab==="Pitch"&&<><section className="coach-pitch"><div className="pitch-markings"/>{["GKP","DEF","MID","FWD"].map(pos=><div className={`coach-pitch-row ${pos.toLowerCase()}`} key={pos}>{xi.filter(p=>p.positionShort===pos).map(p=><button key={p.id} className={p.status!=="a"?"flagged":""} onClick={()=>setSelected(p)}><i>{pos}</i><b>{p.name}{p.id===xiResult.captain?.id&&<em>C</em>}</b><span>{opponent(p,event.id,data)}</span><small>{p.status==="a"?"LIKELY":"FLAGGED"}</small></button>)}</div>)}</section><section className="coach-bench"><span>{plannedChip==="Bench Boost"?"BENCH BOOST":"BENCH"}</span>{bench.map((p,i)=><button key={p.id} onClick={()=>setSelected(p)}><i>{i+1}</i><b>{p.name}</b><small>{opponent(p,event.id,data)}</small></button>)}</section></>}
    {tab==="List"&&<section className="team-list"><header><span>PLAYER</span><span>FIXTURE</span><span>STATUS</span></header>{[...xi,...bench].map((p,i)=><button key={p.id} onClick={()=>setSelected(p)}><b>{i<11?"XI":"BENCH"} · {p.name}<small>{p.teamShort} · {p.positionShort}</small></b><span>{opponent(p,event.id,data)}</span><em className={p.status==="a"?"ok":"risk"}>{p.status==="a"?"LIKELY":"FLAGGED"}</em></button>)}</section>}
    {!gwFixtures.length&&<p className="gw-blank-note">No official fixtures are on the board yet for {event.name}, or this is a blank gameweek for part of your squad.</p>}
    {selected&&<PlayerPanel player={selected} data={data} first={event.id} replacements={replacement} close={()=>setSelected(null)}/>}
  </div>;
}

// My Squad's fixtures view -- the same real computeClubFixtureRows every club in the full Fixtures
// page uses, filtered to the clubs the squad's players actually belong to. Genuinely per-club, not
// per-player -- every player at a club shares that club's real fixture difficulty (see
// fixture-difficulty.ts's own header comment) -- so this never recomputes anything per player, it
// only narrows which of the 20 already-computed real rows are shown. Precondition is deliberately
// "any saved squad players at all" (not a complete 15-man squad, unlike analysis()'s gate
// elsewhere) -- a partial squad still has real owned clubs worth showing here.

function PitchOutline(){
  const rows=[["GKP",1],["DEF",4],["MID",4],["FWD",2]] as const;
  return <section className="coach-pitch pitch-outline" aria-label="Empty pitch preview"><div className="pitch-markings"/>{rows.map(([pos,count])=><div className={`coach-pitch-row ${pos.toLowerCase()}`} key={pos}>{Array.from({length:count},(_,i)=><span className="pitch-slot" key={i}/>)}</div>)}</section>;
}
