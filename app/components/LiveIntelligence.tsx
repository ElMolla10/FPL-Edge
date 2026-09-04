"use client";

import { useEffect, useMemo, useState } from "react";
import { FplData, FplPlayer, bestXi, eventTotals, fetchFplData, futureEvents, isCompleteSquad, optimizeSquad, playerProjection, projectionMetrics, savedSquad } from "../lib/fpl";
import { detectFixtureAnomalies } from "../lib/dgw";
import { persist } from "../lib/persistence";
import { haulProbability, playerPointsDistribution } from "../lib/projection-distribution";
import { ChipAssignment, ChipPortfolioCandidate, HistoryChipEntry, PlannedChip, computeChipInventory, computeHalfBoundary, planChip, plannedChipFor, readPlannedChips, removePlannedChip, scheduleChipsWithPlans, writePlannedChips } from "../lib/chip-portfolio";
import { clearPlanChipTag, readPlans, writePlans } from "../lib/strategy-plans";

function useOfficialFpl(){const[data,setData]=useState<FplData|null>(null);const[error,setError]=useState("");const[loading,setLoading]=useState(true);const load=async()=>{setLoading(true);setError("");try{setData(await fetchFplData())}catch(e){setError(e instanceof Error?e.message:"Official FPL data unavailable")}finally{setLoading(false)}};useEffect(()=>{load();const id=window.setInterval(load,300000);return()=>window.clearInterval(id)},[]);return{data,error,loading,load}}
function Source({data,loading,onRefresh}:{data:FplData;loading:boolean;onRefresh:()=>void}){return <section className="live-source"><div><span className="live-dot"/><b>OFFICIAL FPL DATA</b><small>Auto-refreshes every 5 minutes · updated {new Date(data.updatedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</small></div><button onClick={onRefresh} disabled={loading}>{loading?"Refreshing…":"Refresh now"}</button></section>}
function State({loading,error,retry}:{loading:boolean;error:string;retry:()=>void}){return <div className={`live-state ${error?"error":""}`}>{loading&&!error?<><span className="live-spinner"/><b>Loading official FPL data…</b></>:<><b>Official data unavailable</b><p>{error}</p><button onClick={retry}>Try again</button></>}</div>}

const sortOptions:[keyof FplPlayer|string,string][]=[["projected","Projected points"],["price","Price"],["totalPoints","Points scored"],["eventPoints","Latest GW points"],["goals","Goals"],["assists","Assists"],["expectedGoals","Expected goals (xG)"],["expectedAssists","Expected assists (xA)"],["expectedGoalInvolvements","xGI"],["minutes","Minutes"],["starts","Starts"],["cleanSheets","Clean sheets"],["bonus","Bonus"],["form","Form"],["selectedBy","Ownership"],["ictIndex","ICT index"]];
export function LivePlayers(){
  const{data,error,loading,load}=useOfficialFpl();const[query,setQuery]=useState("");const[position,setPosition]=useState("ALL");const[team,setTeam]=useState("ALL");const[sort,setSort]=useState("projected");const[direction,setDirection]=useState<"desc"|"asc">("desc");
  const events=data?futureEvents(data,1):[];const first=events[0]?.id;
  const rows=useMemo(()=>data?data.players.filter(p=>(position==="ALL"||p.positionShort===position)&&(team==="ALL"||String(p.teamId)===team)&&(`${p.name} ${p.firstName} ${p.secondName}`).toLowerCase().includes(query.toLowerCase())).map(player=>({player,projected:first?playerProjection(player,first,data.fixtures,first):0})).sort((a,b)=>{const av=sort==="projected"?a.projected:Number(a.player[sort as keyof FplPlayer])||0;const bv=sort==="projected"?b.projected:Number(b.player[sort as keyof FplPlayer])||0;return direction==="desc"?bv-av:av-bv}):[],[data,position,team,query,sort,direction,first]);
  if(!data)return <State loading={loading} error={error} retry={load}/>;
  return <div className="live-builder"><Source data={data} loading={loading} onRefresh={load}/><section className="data-intro"><div><span>2026/27 PLAYER DATABASE</span><h2>{data.players.length} official players. Zero placeholders.</h2><p>{data.seasonStatsThrough?`Points, goals, assists, xG, xA and minutes are aggregated from official 2026/27 live data through GW${data.seasonStatsThrough}.`:`The new season has no started gameweeks yet, so 2026/27 points, goals, xG and xA correctly begin at zero.`} Prices, clubs and availability still update live.</p></div><strong>{rows.length}<small>players shown</small></strong></section><div className="advanced-filters"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search any player…"/><select value={position} onChange={e=>setPosition(e.target.value)}><option value="ALL">All positions</option>{data.rules.positions.map(p=><option key={p.id} value={p.short}>{p.short}</option>)}</select><select value={team} onChange={e=>setTeam(e.target.value)}><option value="ALL">All teams</option>{data.teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select><select value={sort} onChange={e=>setSort(e.target.value)}>{sortOptions.map(([value,label])=><option value={value} key={String(value)}>Sort: {label}</option>)}</select><button onClick={()=>setDirection(x=>x==="desc"?"asc":"desc")}>{direction==="desc"?"Highest first ↓":"Lowest first ↑"}</button></div><section className="mega-table"><div className="mega-head"><span>PLAYER</span><button onClick={()=>setSort("price")}>PRICE</button><button onClick={()=>setSort("projected")}>xPTS</button><button onClick={()=>setSort("totalPoints")}>PTS</button><button onClick={()=>setSort("goals")}>G</button><button onClick={()=>setSort("assists")}>A</button><button onClick={()=>setSort("expectedGoals")}>xG</button><button onClick={()=>setSort("expectedAssists")}>xA</button><button onClick={()=>setSort("minutes")}>MINS</button><button onClick={()=>setSort("bonus")}>BONUS</button><button onClick={()=>setSort("selectedBy")}>OWN%</button></div>{rows.map(({player,projected})=><div className="mega-row" key={player.id}><b>{player.name}<small>{player.teamShort} · {player.positionShort}</small></b><span>£{player.price.toFixed(1)}</span><strong>{projected.toFixed(1)}</strong><span>{player.totalPoints}</span><span>{player.goals}</span><span>{player.assists}</span><span>{player.expectedGoals.toFixed(2)}</span><span>{player.expectedAssists.toFixed(2)}</span><span>{player.minutes}</span><span>{player.bonus}</span><span>{player.selectedBy.toFixed(1)}</span></div>)}</section></div>
}

export function LiveFixtures(){
  const{data,error,loading,load}=useOfficialFpl();const[horizon,setHorizon]=useState(5);if(!data)return <State loading={loading} error={error} retry={load}/>;const events=futureEvents(data,horizon);const teamMap=new Map(data.teams.map(t=>[t.id,t]));
  const table=data.teams.map(team=>{const cells=events.map(event=>{const games=data.fixtures.filter(f=>f.event===event.id&&(f.teamH===team.id||f.teamA===team.id));return games.map(game=>{const home=game.teamH===team.id;const opponent=teamMap.get(home?game.teamA:game.teamH);return{label:`${opponent?.short??"—"} ${home?"H":"A"}`,difficulty:home?game.teamHDifficulty:game.teamADifficulty,kickoff:game.kickoff}})});const diffs=cells.flat().map(c=>c.difficulty);return{team,cells,average:diffs.length?diffs.reduce((a,b)=>a+b,0)/diffs.length:6}}).sort((a,b)=>a.average-b.average);
  const doubles=events.map(event=>({event,teams:data.teams.filter(t=>data.fixtures.filter(f=>f.event===event.id&&(f.teamH===t.id||f.teamA===t.id)).length>1)})).filter(x=>x.teams.length);const blanks=events.map(event=>({event,teams:data.teams.filter(t=>data.fixtures.filter(f=>f.event===event.id&&(f.teamH===t.id||f.teamA===t.id)).length===0)})).filter(x=>x.teams.length);
  const columns=`130px 65px repeat(${Math.max(1,events.length)},minmax(95px,1fr))`;
  return <div className="live-builder"><Source data={data} loading={loading} onRefresh={load}/><div className="fixture-controls"><div><span>HORIZON</span>{[3,5,8].map(n=><button className={horizon===n?"active":""} onClick={()=>setHorizon(n)} key={n}>{n} GW</button>)}</div><div><small>CONFIRMED DOUBLES</small><b>{doubles.length?doubles.map(x=>x.event.name).join(", "):"None in range"}</b></div><div><small>CONFIRMED BLANKS</small><b>{blanks.length?blanks.map(x=>x.event.name).join(", "):"None in range"}</b></div></div><section className="fixture-board"><header style={{gridTemplateColumns:columns}}><span>TEAM</span><span>AVG FDR</span>{events.map(e=><span key={e.id}>{e.name.replace("Gameweek ","GW")}</span>)}</header>{table.map(row=><div className="fixture-team-row" style={{gridTemplateColumns:columns}} key={row.team.id}><b>{row.team.short}<small>{row.team.name}</small></b><strong>{row.average===6?"—":row.average.toFixed(2)}</strong>{row.cells.map((games,i)=><div className="fixture-cell" key={events[i].id}>{games.length?games.map((game,n)=><span className={`fdr-${game.difficulty}`} key={n}>{game.label}<small>FDR {game.difficulty}</small></span>):<span className="blank">BLANK</span>}</div>)}</div>)}</section><section className="match-centre"><header><span>OFFICIAL FIXTURE LIST</span><h2>Every confirmed match and kickoff.</h2></header>{events.map(event=><div className="event-block" key={event.id}><b>{event.name}</b><small>Deadline {new Date(event.deadline).toLocaleString([],{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</small><div>{data.fixtures.filter(f=>f.event===event.id).map(f=><article key={f.id}><span>{teamMap.get(f.teamH)?.short}</span><b>{f.finished?`${f.teamHScore} – ${f.teamAScore}`:"vs"}</b><span>{teamMap.get(f.teamA)?.short}</span><time>{f.kickoff?new Date(f.kickoff).toLocaleString([],{weekday:"short",hour:"2-digit",minute:"2-digit"}):"TBC"}</time></article>)}</div></div>)}</section></div>
}

export function LiveNews(){
  const{data,error,loading,load}=useOfficialFpl();const[filter,setFilter]=useState("ALL");const[query,setQuery]=useState("");if(!data)return <State loading={loading} error={error} retry={load}/>;const owned=new Set(savedSquad(data).map(p=>p.id));const news=data.players.filter(p=>p.news||p.status!=="a").filter(p=>(filter==="ALL"||filter==="SQUAD"&&owned.has(p.id)||filter==="DOUBT"&&p.chance!==null||filter==="UNAVAILABLE"&&["i","s","u"].includes(p.status))&&(`${p.name} ${p.teamName} ${p.news}`).toLowerCase().includes(query.toLowerCase())).sort((a,b)=>(b.newsAdded?Date.parse(b.newsAdded):0)-(a.newsAdded?Date.parse(a.newsAdded):0)||b.selectedBy-a.selectedBy);const movers=[...data.players].sort((a,b)=>(b.transfersIn-b.transfersOut)-(a.transfersIn-a.transfersOut)).slice(0,5);
  return <div className="live-builder"><Source data={data} loading={loading} onRefresh={load}/><section className="news-command"><div><span>AVAILABILITY COMMAND CENTRE</span><h2>{news.length} official player updates require attention.</h2><p>Player flags and availability notes come directly from FPL. We never invent quotes or pretend an unsourced rumour is confirmed.</p></div><div><b>{data.players.filter(p=>p.status!=="a").length}</b><small>flagged players</small></div></section><div className="news-controls"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search player, club or update…"/>{[["ALL","All updates"],["SQUAD","My squad"],["DOUBT","Doubts"],["UNAVAILABLE","Unavailable"]].map(([id,label])=><button className={filter===id?"active":""} onClick={()=>setFilter(id)} key={id}>{label}</button>)}</div><section className="official-news-list">{news.length?news.map(player=><article key={player.id}><div className={`news-status status-${player.status}`}>{player.chance!==null?`${player.chance}%`:player.status==="a"?"OK":"!"}</div><div><span>{owned.has(player.id)?"YOUR SQUAD · ":""}{player.teamShort} · {player.positionShort}</span><h3>{player.name}</h3><p>{player.news||"Flagged by the official FPL player feed. No additional note has been published."}</p><small>{player.newsAdded?`Updated ${new Date(player.newsAdded).toLocaleString()}`:"Official status currently has no timestamp"}</small></div><aside><b>£{player.price.toFixed(1)}m</b><span>{player.selectedBy.toFixed(1)}% owned</span><small>{player.transfersOut.toLocaleString()} transfers out</small></aside></article>):<div className="empty-news">No official updates match this filter.</div>}</section><section className="market-watch"><header><span>TRANSFER MARKET SIGNAL</span><h2>Most-bought players right now.</h2></header><div>{movers.map(p=><article key={p.id}><b>{p.name}<small>{p.teamShort} · {p.positionShort}</small></b><span>+{Math.max(0,p.transfersIn-p.transfersOut).toLocaleString()}</span><small>net transfers</small></article>)}</div></section></div>
}

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
export function LiveChips(){
  const{data,error,loading,load}=useOfficialFpl();const[selected,setSelected]=useState<Chip>("Wildcard");if(!data)return <State loading={loading} error={error} retry={load}/>;const events=futureEvents(data,8);const stored=savedSquad(data);const hasSquad=isCompleteSquad(stored,data);const baseline=hasSquad?stored:optimizeSquad(data,events.slice(0,5).map(e=>e.id));
  const rows=events.map((event,index)=>({event,...chipScoresForEvent(data,baseline,event,events.slice(index,index+5).map(e=>e.id),hasSquad)}));const key=selected==="Wildcard"?"wildcard":selected==="Free Hit"?"freeHit":selected==="Bench Boost"?"benchBoost":"tripleCaptain";const best=[...rows].sort((a,b)=>b[key].score-a[key].score)[0];
  const anomalies=detectFixtureAnomalies(data);const doubleEventIds=new Set(anomalies.doubles.map(d=>d.eventId));const blankEventIds=new Set(anomalies.blanks.map(b=>b.eventId));
  return <div className="live-builder"><Source data={data} loading={loading} onRefresh={load}/><div className="chip-selector">{(["Wildcard","Free Hit","Bench Boost","Triple Captain"] as Chip[]).map(chip=><button className={selected===chip?"active":""} onClick={()=>setSelected(chip)} key={chip}><span>{chip}</span><b>{Math.max(...rows.map(r=>r[chip==="Wildcard"?"wildcard":chip==="Free Hit"?"freeHit":chip==="Bench Boost"?"benchBoost":"tripleCaptain"].score))}/10</b><small>best upcoming score</small></button>)}</div><section className="chip-recommendation"><div><span>BEST WINDOW</span><h2>{best?.event.name??"No confirmed window"}</h2><p>{best?.[key].detail}</p></div><strong>{best?.[key].score??"—"}<small>/10</small></strong></section><section className="chip-week-table"><header><span>GAMEWEEK</span><span>DEADLINE</span><span>SCORE</span><span>{selected==="Triple Captain"?"BEST PLAYER":"MODELED VALUE"}</span><span>VERDICT</span></header>{rows.map(row=><div key={row.event.id}><b>{row.event.name}{doubleEventIds.has(row.event.id)&&<em className="dgw-badge">DGW</em>}{blankEventIds.has(row.event.id)&&<em className="bgw-badge">BGW</em>}</b><time>{new Date(row.event.deadline).toLocaleDateString([],{day:"numeric",month:"short"})}</time><strong>{row[key].score}/10</strong><span>{row[key].detail}</span><em>{row[key].score>=8?"Excellent":row[key].score>=6?"Good":row[key].score>=4?"Average":"Avoid"}</em></div>)}</section><p className="model-note">Wildcard scores compare your saved 15-player squad against the best legal squad the model can construct for that five-gameweek window. Chip scores update whenever official fixtures, prices or player availability change.</p></div>
}

type ChipScheduleState={status:"loading"}|{status:"ready";first:readonly ChipAssignment[];second:readonly ChipAssignment[]};
const ALL_CHIP_TYPES:readonly Chip[]=["Wildcard","Free Hit","Bench Boost","Triple Captain"];

// Sibling to LiveChips (LiveChips itself is untouched) -- a real, measured cost drove one design
// choice here: scoring every remaining event this season via chipScoresForEvent (the same function
// LiveChips already uses, just across up to ~36 events instead of LiveChips' fixed 8) measured at
// ~950ms against real live data, entirely on the main thread. Computing that inline during render
// would visibly freeze the page on mount. The chip inventory itself (computeChipInventory) is cheap
// and renders immediately; the expensive schedule is deferred into a useEffect so the page paints
// first, with its own explicit loading state -- a real mitigation, not a full fix. A proper
// Web Worker offload (matching the Decision Confidence Engine's existing pattern) would remove the
// ~950ms freeze entirely rather than just delaying it past first paint, but that's new
// infrastructure beyond this round's approved scope -- flagged as a real follow-up, not silently
// added or silently ignored.
// Extracted so LiveDraftBuilder.tsx can reuse the exact same connected-entry/history-chips fetch
// instead of duplicating this effect a second time -- the fetch itself is already deliberately
// narrow (see app/api/fpl/chips/route.ts's own comment), so the alternative (each caller doing its
// own small fetch) would be exactly the two-copies-that-drift risk this project keeps guarding
// against, for no real benefit over one shared hook.
export function useConnectedChipHistory(){
  const[connectedEntry,setConnectedEntry]=useState<string|null>(null);
  const[historyChips,setHistoryChips]=useState<readonly HistoryChipEntry[]|null>(null);
  useEffect(()=>{
    const entry=localStorage.getItem("fpl-edge-entry");
    setConnectedEntry(entry);
    if(!entry){setHistoryChips(null);return}
    let cancelled=false;
    fetch(`/api/fpl/chips?entry=${entry}`,{cache:"no-store"}).then(async response=>{
      const json=await response.json();
      if(!response.ok)throw new Error(json.error||"Could not load your official chip history.");
      if(!cancelled)setHistoryChips(json.chips);
    }).catch(()=>{if(!cancelled)setHistoryChips(null)});
    return()=>{cancelled=true};
  },[]);
  return{connectedEntry,historyChips};
}

export function ChipPortfolioPanel(){
  const{data,error,loading,load}=useOfficialFpl();
  const{connectedEntry,historyChips}=useConnectedChipHistory();

  // The single source of truth chip-portfolio.ts's inventory, the captain picker (CoachApp.tsx) and
  // the Gameweek Navigator's future-week badge all read and write -- planning a chip here is
  // immediately visible everywhere else that reads PlannedChip, not a second, independent flag.
  const[plannedChips,setPlannedChips]=useState<readonly PlannedChip[]>(readPlannedChips);
  const[planError,setPlanError]=useState("");
  const plan=(chip:Chip,eventId:number)=>{
    const result=planChip(plannedChips,{event:eventId,chip});
    if(!result.ok){setPlanError(result.reason);return}
    setPlanError("");setPlannedChips(result.plannedChips);writePlannedChips(result.plannedChips);
  };
  // Symmetric with the Strategy Board's deletePlan -> removePlannedChip cascade (CoachApp.tsx):
  // removing a chip here must not leave a stale "🃏 Wildcard" tag on whichever plan committed it.
  const unplan=(chip:Chip)=>{
    const next=removePlannedChip(plannedChips,chip);
    setPlanError("");setPlannedChips(next);writePlannedChips(next);
    const plans=readPlans();const clearedPlans=clearPlanChipTag(plans,chip);
    if(clearedPlans!==plans)writePlans(clearedPlans);
  };

  const inventory=data?computeChipInventory(data.events,connectedEntry?historyChips:null,plannedChips):null;
  const unpersonalized=!inventory||inventory.status==="unavailable";

  const[schedule,setSchedule]=useState<ChipScheduleState>({status:"loading"});
  useEffect(()=>{
    if(!data||!inventory)return;
    setSchedule({status:"loading"});
    const timer=window.setTimeout(()=>{
      const remainingEvents=data.events.filter(e=>Date.parse(e.deadline)>Date.now()).sort((a,b)=>a.id-b.id);
      if(!remainingEvents.length){setSchedule({status:"ready",first:[],second:[]});return}
      const stored=savedSquad(data);const hasSquad=isCompleteSquad(stored,data);
      const baseline=hasSquad?stored:optimizeSquad(data,remainingEvents.slice(0,5).map(e=>e.id));
      const rows:ChipPortfolioCandidate[]=remainingEvents.map((event,index)=>{
        const window=remainingEvents.slice(index,index+5).map(e=>e.id);
        const scores=chipScoresForEvent(data,baseline,event,window,hasSquad);
        return{event,wildcard:scores.wildcard,freeHit:scores.freeHit,benchBoost:scores.benchBoost,tripleCaptain:scores.tripleCaptain};
      });
      const halfBoundary=inventory.status==="available"?inventory.halfBoundary:computeHalfBoundary(data.events);
      const chipsFor=(half:"first"|"second"):Chip[]=>inventory.status==="available"?inventory.remaining.filter(e=>e.half===half).map(e=>e.chip):[...ALL_CHIP_TYPES];
      const first=scheduleChipsWithPlans(chipsFor("first"),rows.filter(r=>r.event.id<=halfBoundary),plannedChips);
      const second=scheduleChipsWithPlans(chipsFor("second"),rows.filter(r=>r.event.id>halfBoundary),plannedChips);
      setSchedule({status:"ready",first,second});
    },0);
    return()=>window.clearTimeout(timer);
  },[data,connectedEntry,historyChips,plannedChips]);

  if(!data)return <State loading={loading} error={error} retry={load}/>;
  const halfBoundary=inventory&&inventory.status==="available"?inventory.halfBoundary:computeHalfBoundary(data.events);
  const boundaryEvent=data.events.find(e=>e.id===halfBoundary);
  const expiredUnused=inventory&&inventory.status==="available"?inventory.expiredUnused:[];

  const halfSection=(half:"first"|"second",label:string)=>{
    const remainingChips=inventory&&inventory.status==="available"?inventory.remaining.filter(e=>e.half===half).map(e=>e.chip):[...ALL_CHIP_TYPES];
    const assignments=schedule.status==="ready"?(half==="first"?schedule.first:schedule.second):[];
    return <section className="chip-portfolio-half" key={half}>
      <header><span>{label.toUpperCase()}</span><h3>{remainingChips.length?`${remainingChips.length} chip${remainingChips.length===1?"":"s"} to plan`:"No chips left to plan"}</h3></header>
      {schedule.status==="loading"&&<p className="chip-portfolio-loading">Calculating your season-long schedule…</p>}
      {schedule.status==="ready"&&remainingChips.map(chip=>{
        const assignment=assignments.find(a=>a.chip===chip);
        const plannedEvent=plannedChips.find(p=>p.chip===chip);
        const unmodeled=chip==="Wildcard"||chip==="Free Hit";
        return <article key={chip} className={assignment?.planned?"chip-portfolio-planned":""}>
          <b>{chip}</b>
          {assignment?<><span>{assignment.event.name}</span><strong>{assignment.score}/10</strong><small>{assignment.detail}</small>
            {unmodeled&&<small className="chip-portfolio-unmodeled">Not reflected in Overview, Transfers or Final Check — those still assume your current squad.</small>}
            {assignment.planned?<button className="chip-portfolio-unplan" onClick={()=>unplan(chip)}>Remove plan</button>:<button className="chip-portfolio-plan" onClick={()=>plan(chip,assignment.event.id)}>Plan for {assignment.event.name}</button>}
          </>:plannedEvent?<span className="chip-portfolio-unassigned">Planned for GW{plannedEvent.event}, but that week is no longer in range.</span>:<span className="chip-portfolio-unassigned">No legal remaining week found this half.</span>}
        </article>;
      })}
      {expiredUnused.filter(e=>e.half===half).length>0&&<p className="chip-portfolio-expired">Expired unused: {expiredUnused.filter(e=>e.half===half).map(e=>e.chip).join(", ")} — the deadline to play {expiredUnused.filter(e=>e.half===half).length===1?"it":"them"} this half has already passed.</p>}
    </section>;
  };

  return <div className="live-builder">
    <Source data={data} loading={loading} onRefresh={load}/>
    <section className="chip-portfolio-intro">
      <div><span>SEASON CHIP PORTFOLIO</span><h2>Your real remaining chips, scheduled across the rest of the season.</h2>
        {unpersonalized&&<p>{connectedEntry?"Your official chip history couldn't be loaded -- showing a general best-windows view assuming all 4 chips are still available, not your real inventory.":"Connect your official FPL team to see your real remaining chip inventory. Showing a general best-windows view assuming all 4 chips are still available instead."}</p>}
      </div>
    </section>
    {planError&&<p className="chip-portfolio-error">{planError}</p>}
    <p className="chip-portfolio-disclosure">First half runs through {boundaryEvent?.name??"the season's midpoint"}'s deadline — inferred as roughly half of this season's real {data.events.length} gameweeks; FPL's own data has no explicit half-boundary field.</p>
    <p className="chip-portfolio-disclosure">Each chip is scored independently against your current squad — this doesn't yet account for how playing a Wildcard would reshape your squad for a later Bench Boost or Triple Captain.</p>
    <div className="chip-portfolio-halves">
      {halfSection("first","First half")}
      {halfSection("second","Second half")}
    </div>
  </div>;
}

export function LivePointsModel(){
  const{data,error,loading,load}=useOfficialFpl();const[query,setQuery]=useState("");const[selected,setSelected]=useState<number|null>(null);if(!data)return <State loading={loading} error={error} retry={load}/>;const events=futureEvents(data,5);const candidates=data.players.filter(p=>(`${p.name} ${p.teamName}`).toLowerCase().includes(query.toLowerCase())).sort((a,b)=>b.epNext-a.epNext).slice(0,12);const player=data.players.find(p=>p.id===(selected??candidates[0]?.id))??data.players[0];const projections=events.map(e=>playerProjection(player,e.id,data.fixtures,events[0]?.id));const availabilityPct=Math.round((player.chance!==null?player.chance/100:player.status==="a"?1:.3)*100);const recent=Math.max(.7,player.pointsPerGame*.48+player.form*.28+player.epNext*.24);
  return <div className="live-builder"><Source data={data} loading={loading} onRefresh={load}/><section className="model-search"><div><span>LIVE PLAYER MODEL</span><h2>Inspect the inputs, not just the answer.</h2></div><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search a player…"/><div>{candidates.map(p=><button className={p.id===player.id?"active":""} onClick={()=>setSelected(p.id)} key={p.id}>{p.name}<small>{p.teamShort}</small></button>)}</div></section><section className="model-hero"><div><span>{player.teamName} · {player.position} · £{player.price.toFixed(1)}m</span><h2>{player.name}</h2><p>{player.news||"Available according to the official FPL feed."}</p></div><strong>{projections[0]?.toFixed(1)??"—"}<small>next GW xPts</small></strong></section><div className="model-real-grid"><article><span>2026/27 OUTPUT</span><b>{player.totalPoints}</b><small>current-season points through GW{data.seasonStatsThrough}</small></article><article><span>GOAL THREAT</span><b>{player.goals} G · {player.expectedGoals.toFixed(2)} xG</b><small>{player.threat.toFixed(1)} threat index</small></article><article><span>CREATION</span><b>{player.assists} A · {player.expectedAssists.toFixed(2)} xA</b><small>{player.creativity.toFixed(1)} creativity</small></article><article><span>MINUTES</span><b>{player.minutes}</b><small>{player.starts} starts · {availabilityPct}% availability</small></article><article><span>BONUS</span><b>{player.bonus}</b><small>{player.bps} BPS</small></article><article><span>ICT</span><b>{player.ictIndex.toFixed(1)}</b><small>{player.influence.toFixed(1)} influence</small></article></div><section className="projection-path"><header><span>FIVE-GAMEWEEK PROJECTION</span><small>Official fixtures + current form/availability · FPL Edge fixture model</small></header><div>{events.map((event,i)=><article key={event.id}><span>{event.name}</span><b>{projections[i].toFixed(1)}</b><small>xPts</small></article>)}</div></section><section className="model-breakdown-live"><div><span>BASE PERFORMANCE</span><b>{recent.toFixed(2)}</b><p>{data.seasonStatsThrough?"Uses current-season official PPG, form and next-gameweek expectation.":"Before GW1, last-season PPG is used only as a projection prior; every displayed 2026/27 performance total remains zero."}</p></div><div><span>AVAILABILITY</span><b>{availabilityPct}%</b><p>Uses the official status and chance-of-playing flag. Uncertain players are discounted.</p></div><div><span>FIXTURE ADJUSTMENT</span><b>FDR-aware</b><p>Each confirmed fixture is adjusted for venue and official FPL difficulty. Doubles add; blanks score zero.</p></div></section></div>
}

export type HistoryWeek={event:number;points:number;totalPoints:number;overallRank:number;gameweekRank:number;transfers:number;transferCost:number;pointsOnBench:number;value:number;bank:number;captain:string;captainRawPoints:number;captainContribution:number;viceCaptain:string;chip:string|null};

export type TeamValueSummary=Readonly<{baselineEvent:number;baselineValue:number;latestEvent:number;latestValue:number;delta:number;ownedPriceDrift:number|null}>;
// weeks[0]/weeks[weeks.length-1] rather than meta.squadValue -- LiveHistory's own connect flow
// (entering a Team ID here) never populates fpl-edge-manager at all, so meta.squadValue can be
// null even when history IS connected. Using the already-fetched weeks[] array end-to-end keeps
// both endpoints sourced from the exact same real data, always internally consistent, at real
// gameweek-deadline granularity -- deliberately NOT claiming to be "today's" live value.
// ownedPriceDrift is a partial, supplementary breakdown, not a reconciliation of delta: it only
// tracks players still owned since their own season start, and won't match delta if any transfers
// were made (transfers move value through selling/buying prices, a separate mechanism).
export function teamValueSummary(weeks:readonly HistoryWeek[],squad:readonly FplPlayer[]|null):TeamValueSummary|null{
  if(!weeks.length)return null;
  const first=weeks[0],latest=weeks[weeks.length-1];
  const ownedPriceDrift=squad&&squad.length?squad.reduce((s,p)=>s+p.priceChangeSinceStart,0):null;
  return{baselineEvent:first.event,baselineValue:first.value,latestEvent:latest.event,latestValue:latest.value,delta:latest.value-first.value,ownedPriceDrift};
}

// officialData is optional -- LiveHistory has two call sites: CoachApp.tsx's real coach shell
// (which has FplData in scope and can supply the ownedPriceDrift breakdown) and app/page.tsx's
// standalone demo shell (which never fetches a shared FplData at all, every Live* component there
// is independently self-contained). Without it, teamValueSummary still shows the real
// baseline/latest/delta from weeks[] -- only the owned-players breakdown needs a squad.
export function LiveHistory({officialData}:{officialData?:FplData}){
  const[entry,setEntry]=useState("");const[data,setData]=useState<{updatedAt:string;manager:{id:number;name:string;teamName:string;overallPoints:number;overallRank:number};weeks:HistoryWeek[]}|null>(null);const[error,setError]=useState("");const[loading,setLoading]=useState(false);useEffect(()=>{const saved=localStorage.getItem("fpl-edge-entry");if(saved){setEntry(saved);load(saved)}},[]);async function load(id=entry){if(!/^\d+$/.test(id.trim())){setError("Enter the number from your official FPL team URL.");return}setLoading(true);setError("");try{const response=await fetch(`/api/fpl/history?entry=${id.trim()}`,{cache:"no-store"});const json=await response.json();if(!response.ok)throw new Error(json.error||"Could not load history");setData(json);persist("fpl-edge-entry",id.trim())}catch(e){setError(e instanceof Error?e.message:"Could not load history")}finally{setLoading(false)}}const weeks=data?.weeks??[];const avg=weeks.length?weeks.reduce((s,w)=>s+w.points,0)/weeks.length:0;const captain=weeks.reduce((s,w)=>s+w.captainContribution,0);const bench=weeks.reduce((s,w)=>s+w.pointsOnBench,0);const hits=weeks.reduce((s,w)=>s+w.transferCost,0);const teamValue=teamValueSummary(weeks,officialData?savedSquad(officialData):null);
  return <div className="live-builder"><section className="history-connect"><div><span>OFFICIAL TEAM HISTORY</span><h2>Connect your FPL manager ID.</h2><p>Read-only. We use official finished-gameweek data and never ask for your password.</p></div><div><input value={entry} onChange={e=>setEntry(e.target.value.replace(/\D/g,""))} placeholder="e.g. 123456"/><button onClick={()=>load()} disabled={loading}>{loading?"Loading…":data?"Refresh history":"Connect history"}</button></div>{error&&<small>{error}</small>}</section>{data?<><section className="history-owner"><div><span>{data.manager.name}</span><h2>{data.manager.teamName}</h2><small>Manager ID {data.manager.id} · official data refreshed {new Date(data.updatedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</small></div><div><b>{data.manager.overallPoints??"—"}</b><small>total points</small></div><div><b>{data.manager.overallRank?.toLocaleString()??"—"}</b><small>overall rank</small></div></section>{teamValue&&<section className="team-value-panel"><div><span>TEAM VALUE</span><h2>{teamValue.delta>=0?"+":""}£{teamValue.delta.toFixed(1)}m through GW{teamValue.latestEvent}</h2><p>From £{teamValue.baselineValue.toFixed(1)}m at GW{teamValue.baselineEvent}'s deadline to £{teamValue.latestValue.toFixed(1)}m at GW{teamValue.latestEvent}'s deadline — reflects your value through that gameweek's deadline, not necessarily today's live prices.</p></div>{teamValue.ownedPriceDrift!==null&&<div><span>FROM PLAYERS YOU STILL OWN</span><b>{teamValue.ownedPriceDrift>=0?"+":""}£{teamValue.ownedPriceDrift.toFixed(1)}m</b><small>Price movement since each player's own season start — won't match the total above if you've made transfers.</small></div>}</section>}<div className="history-kpis"><article><span>AVG GW</span><b>{avg.toFixed(1)}</b></article><article><span>CAPTAIN POINTS</span><b>{captain}</b></article><article><span>BENCH POINTS</span><b>{bench}</b></article><article><span>POINTS SPENT</span><b>−{hits}</b></article></div>{weeks.length?<section className="history-live-table"><header><span>GW</span><span>POINTS</span><span>CAPTAIN</span><span>CAPTAIN PTS</span><span>BENCH</span><span>TRANSFERS</span><span>HIT</span><span>GW RANK</span><span>OVERALL RANK</span><span>CHIP</span></header>{[...weeks].reverse().map(w=><div key={w.event}><b>GW{w.event}</b><strong>{w.points}</strong><span>{w.captain}</span><span>{w.captainContribution}<small>{w.captainRawPoints} raw</small></span><span>{w.pointsOnBench}</span><span>{w.transfers}</span><span>{w.transferCost?`−${w.transferCost}`:"0"}</span><span>{w.gameweekRank?.toLocaleString()}</span><span>{w.overallRank?.toLocaleString()}</span><em>{w.chip||"—"}</em></div>)}</section>:<div className="history-empty"><b>No finished gameweeks yet.</b><p>Your official points, captain returns, bench points, transfers, hits, ranks and chips will appear automatically after FPL marks each gameweek finished.</p></div>}</>:<div className="history-empty"><b>No fake history.</b><p>Connect your official manager ID to replace the old demo rows with your real gameweek record.</p></div>}</div>
}
