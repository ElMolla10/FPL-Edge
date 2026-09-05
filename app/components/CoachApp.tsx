"use client";

import { ReactNode, useEffect, useMemo, useState } from "react";
import LiveDraftBuilder from "./LiveDraftBuilder";
import MiniLeagueWarRoom from "./MiniLeagueWarRoom";
import TransferBreakdown from "./TransferBreakdown";
import DecisionConfidencePanel from "./DecisionConfidencePanel";
import RankEstimatePanel from "./RankEstimatePanel";
import TransferSensitivityPanel from "./TransferSensitivityPanel";
import { useTransferDecisionConfidence } from "./useTransferDecisionConfidence";
import { usePopulationPercentiles } from "./usePopulationPercentiles";
import { estimateRankDistribution, estimateLiveRankResult, LiveRankResult } from "../lib/rank-estimate-core";
import { clubLineupCandidates, LINEUP_POSITIONS, LineupCandidate } from "../lib/lineup-intelligence";
import Pitch from "./Pitch";
import { Chip, ChipPortfolioPanel, ChipScores, LiveChips, LiveHistory, chipScoresForEvent, useConnectedChipHistory } from "./LiveIntelligence";
import { PlannedChip, computeChipInventory, plannedChipFor, readPlannedChips, removePlannedChip, writePlannedChips } from "../lib/chip-portfolio";
import { CaptaincyResolution, resolveCaptainSwap, resolveCaptaincy } from "../lib/captaincy";
import { FplData, FplEvent, FplFixture, FplPlayer, LiveMover, PROJECTION_MODEL_VERSION, PlayerCalibrationGroup, ProjectionMetrics, ROLE_SECURITY_FLOOR, bestXi, displayedGameweekAverage, fetchFplData, futureEvents, isCompleteSquad, liveScoringMovers, opponent, playerCalibrationProfile, playerProjection, projectionMetrics, savedSquad, simulateAutosubs, startPct } from "../lib/fpl";
import { HorizonMode, RiskMode, SquadPhilosophy, createFiveWeekEvaluator, createOptimizer } from "../lib/optimizer";
import { FiveGwGainBand } from "../lib/anomalies";
import { DoubleGameweek, detectFixtureAnomalies, nearestInHorizon } from "../lib/dgw";
import { persist, readFreeTransfers, syncWithServer } from "../lib/persistence";
import { MODEL_RELEASES, comparableModelRows, groupByModelVersion, modelDisplayName, modelRelease } from "../lib/model-version";
import { BenchOrderResult, modeledAppearanceProbability, optimizeBenchOrder } from "../lib/bench-order";
import { RouteTransfer, TransferRoute, solveTransferRoutes } from "../lib/transfer-routes";
import { blankProbability, haulProbability, playerPointsDistribution, pointsRange } from "../lib/projection-distribution";
import { TransferQualityStatus } from "../lib/transfer-quality";
import { Transfer, bestTransfers, selectPrimaryTransfer, sortTransfersByQuality } from "../lib/transfers";
import { ManagerMeta, OfficialPick, evaluateSandbox, sellingPricesFor } from "../lib/squad-comparison";
import { LOAD_PLAN_SIGNAL_KEY, MAX_PLANS, PersistedPlan, createPlan, hydratePlanSandbox, readPlans, writePlans } from "../lib/strategy-plans";
import { DifferentialPosition, TemplatePosition, rawDifferentialsByPosition, templateByPosition } from "../lib/ownership-radar";
import { narrateCaptainChoice, narrateChipDecision, narrateCurrentRank, narrateDifferentials, narrateLiveStatus, narratePrimaryTransfer, narratePriceRisk, narrateSquadBuild, narrateTransferForPlayer, resolveChipLegality } from "../lib/coach-narration";
import { ClubFixtureRow, computeClubFixtureRows } from "../lib/fixture-difficulty";

type View="overview"|"team"|"transfers"|"league"|"draft"|"board"|"players"|"fixtures"|"news"|"deadline"|"chips"|"model"|"history"|"ownership"|"coach"|"squad-fixtures";
export type { ManagerMeta, OfficialPick } from "../lib/squad-comparison";

export{evaluateTransferQuality,TRANSFER_ACTION_THRESHOLD}from"../lib/transfer-quality";
export type{TransferQuality,TransferQualityInput,TransferQualityReason,TransferQualityStatus}from"../lib/transfer-quality";
export{bestTransfers,selectPrimaryTransfer,sortTransfersByQuality}from"../lib/transfers";
export type{Transfer}from"../lib/transfers";

// Grouped navigation (Home/Coach standalone, then 4 labeled sections) -- the single source of
// truth for both the desktop sidebar and the mobile nav/overlay below. No separate flat array is
// kept alongside this: nothing outside this file's own render sites ever consumed `nav`'s prior
// flat shape or its ordering (confirmed by auditing every go() call site -- every call passes a
// literal View id or an already-View-typed variable, never a position/index).
type NavGroup=Readonly<{label:string|null;items:readonly(readonly[View,string,string])[]}>;
const navGroups:readonly NavGroup[]=[
  {label:null,items:[["overview","Overview","⌂"]]},
  {label:null,items:[["coach","Coach","♟"]]},
  {label:"My Squad",items:[["team","My team","◫"],["deadline","Final check","✓"],["squad-fixtures","My Fixtures","▤"],["news","News","●"]]},
  {label:"Plan",items:[["transfers","Transfers","⇄"],["draft","Draft lab","◇"],["board","Strategy board","⊞"],["chips","Chips","★"]]},
  {label:"Research",items:[["players","Players","⌕"],["ownership","Ownership","◈"],["model","Points model","∑"],["fixtures","Fixtures","▦"]]},
  {label:"League & History",items:[["league","Mini-League","◎"],["history","History","↗"]]},
];
const titles:Record<View,string>={overview:"Your gameweek command centre",team:"My team",transfers:"Transfer centre",league:"Mini-League War Room",draft:"Draft & Wildcard lab",board:"Multi-Plan Strategy Board",players:"Player research",ownership:"Ownership radar",coach:"Ask your coach","squad-fixtures":"My Fixtures",fixtures:"Fixture intelligence",news:"Personalised news",deadline:"Deadline final check",chips:"Chip planner",model:"How the model thinks",history:"Decision history"};
const fmt=(n:number|null|undefined)=>n?Math.round(n).toLocaleString():"—";
// Tightened cadence while a gameweek is genuinely live (deadline passed, not yet finished). Note
// this only bounds the client's own added latency: /api/fpl's response and internal FPL fetches are
// both cached for ~5 minutes server-side, so real freshness is still floored there regardless of
// this value -- tightening that cache is a separate, app-wide change, deliberately out of scope here.
const LIVE_GAMEWEEK_REFRESH_MS=60000;
const clamp=(n:number,min=0,max=100)=>Math.max(min,Math.min(max,n));
const readIds=(key:string)=>{try{return JSON.parse(localStorage.getItem(key)||"[]") as number[]}catch{return[]}};
const certainty=(p:FplPlayer)=>p.status!=="a"?"CONFIRMED":projectionMetrics(p,0,[],0).startProbability>.72?"LIKELY":"UNCERTAIN";

export{opponent}from"../lib/fpl";
function freshness(updatedAt:string){const minutes=Math.max(0,Math.floor((Date.now()-Date.parse(updatedAt))/60000));return{minutes,label:minutes<2?"just now":`${minutes}m ago`,tone:minutes<=10?"fresh":minutes<=30?"aging":"stale"}}
function expectedMins(p:FplPlayer,event:number,data:FplData){return Math.round(projectionMetrics(p,event,data.fixtures,event).expectedMinutes)}

export default function CoachApp({onBack}:{onBack:()=>void}){
  const[view,setView]=useState<View>("overview");const[data,setData]=useState<FplData|null>(null);const[error,setError]=useState("");const[loading,setLoading]=useState(true);const[revision,setRevision]=useState(0);
  // Which group's item list the mobile overlay is currently showing ("My Squad"|"Plan"|"More"),
  // or null when closed -- replaces the old single `more:boolean`. My Squad and Plan are now real
  // multi-item groups on mobile too (not single destinations), so tapping either needs to open
  // its own item list the same way "More" already did, rather than three separate ad-hoc panels.
  const[mobileOverlay,setMobileOverlay]=useState<string|null>(null);
  const load=async()=>{setLoading(true);setError("");try{setData(await fetchFplData())}catch(e){setError(e instanceof Error?e.message:"Official FPL data unavailable")}finally{setLoading(false)}};
  useEffect(()=>{load()},[]);
  const currentEvent=data?.events.find(e=>e.current);
  const isLiveWindow=!!currentEvent&&!currentEvent.finished&&Date.parse(currentEvent.deadline)<=Date.now();
  useEffect(()=>{const id=window.setInterval(load,isLiveWindow?LIVE_GAMEWEEK_REFRESH_MS:300000);return()=>window.clearInterval(id)},[isLiveWindow]);
  const runSync=()=>{syncWithServer().then(changed=>{if(changed)setRevision(x=>x+1)})};
  useEffect(()=>{runSync()},[]);
  const go=(next:View)=>{setView(next);setRevision(x=>x+1);setMobileOverlay(null);window.scrollTo({top:0,behavior:"smooth"})};
  const fresh=data?freshness(data.updatedAt):null;
  const mySquadGroup=navGroups.find(g=>g.label==="My Squad")!,planGroup=navGroups.find(g=>g.label==="Plan")!;
  const inGroup=(group:NavGroup)=>group.items.some(([key])=>key===view);
  const toggleMobileOverlay=(label:string)=>setMobileOverlay(current=>current===label?null:label);
  return <main className="coach-shell">
    <aside className="coach-sidebar"><button className="brand sidebar-brand" onClick={onBack}><span className="brand-mark">E</span><span>FPL EDGE</span></button><nav>{navGroups.map((group,gi)=><div className="coach-nav-group" key={gi}>{group.label&&<span className="coach-nav-label">{group.label}</span>}{group.items.map(([key,label,icon])=><button key={key} className={view===key?"active":""} onClick={()=>go(key)}><i>{icon}</i><span>{label}</span></button>)}</div>)}</nav><div className="coach-data-note"><span className={`fresh-dot ${fresh?.tone||"stale"}`}/><div><b>{fresh?`Data ${fresh.label}`:"Connecting…"}</b><small>Official FPL feed</small></div></div><ThemeToggle/><button className="back-link" onClick={onBack}>← Back to site</button></aside>
    <section className="coach-main"><header className="coach-header"><div><p>FPL EDGE · DECISION ENGINE</p><h1>{titles[view]}</h1></div>{data&&<DeadlineClock data={data}/>}</header>
      {loading&&!data?<Loading label="Loading your FPL decision engine…"/>:error&&!data?<Loading label={error} retry={load}/>:data?<><Freshness data={data} onRefresh={load} loading={loading}/><Page view={view} data={data} go={go} revision={revision} onTeamChange={()=>setRevision(x=>x+1)}/><p className="truth-note">Official FPL supplies players, prices, fixtures, flags and results. FPL Edge projections and recommendations are estimates with uncertainty—not guarantees.</p><CoachDock data={data} go={go} revision={revision}/></>:null}
    </section>
    <footer className="coach-footer"><AccountBar onAuthChange={runSync}/><TeamBar data={data} revision={revision} onTeamChange={()=>setRevision(x=>x+1)}/></footer>
    <nav className="coach-mobile-nav"><button className={view==="overview"?"active":""} onClick={()=>go("overview")}><i>⌂</i>Home</button><button className={mobileOverlay==="My Squad"||inGroup(mySquadGroup)?"active":""} onClick={()=>toggleMobileOverlay("My Squad")}><i>◫</i>My Squad</button><button className={mobileOverlay==="Plan"||inGroup(planGroup)?"active":""} onClick={()=>toggleMobileOverlay("Plan")}><i>⇄</i>Plan</button><button className={view==="coach"?"active":""} onClick={()=>go("coach")}><i>♟</i>Coach</button><button className={mobileOverlay==="More"?"active":""} onClick={()=>toggleMobileOverlay("More")}><i>•••</i>More</button></nav>
    {mobileOverlay==="My Squad"&&<div className="mobile-more">{mySquadGroup.items.map(([key,label,icon])=><button key={key} onClick={()=>go(key)}><i>{icon}</i>{label}</button>)}</div>}
    {mobileOverlay==="Plan"&&<div className="mobile-more">{planGroup.items.map(([key,label,icon])=><button key={key} onClick={()=>go(key)}><i>{icon}</i>{label}</button>)}</div>}
    {mobileOverlay==="More"&&<div className="mobile-more">{navGroups.filter(g=>g.label==="Research"||g.label==="League & History").map(group=><div className="mobile-more-group" key={group.label}><span>{group.label}</span>{group.items.map(([key,label,icon])=><button key={key} onClick={()=>go(key)}><i>{icon}</i>{label}</button>)}</div>)}</div>}
  </main>
}

function Page({view,data,go,revision,onTeamChange}:{view:View;data:FplData;go:(v:View)=>void;revision:number;onTeamChange:()=>void}){
  if(view==="overview")return <Overview data={data} go={go} revision={revision} onTeamChange={onTeamChange}/>;
  if(view==="team")return <Team data={data} go={go} revision={revision} onTeamChange={onTeamChange}/>;
  if(view==="transfers")return <Transfers data={data} go={go} revision={revision} onTeamChange={onTeamChange}/>;
  if(view==="league")return <MiniLeagueWarRoom revision={revision} onGoToTeam={()=>go("team")}/>;
  if(view==="draft")return <LiveDraftBuilder/>;
  if(view==="board")return <StrategyBoard data={data} go={go} revision={revision}/>;
  if(view==="players")return <Players data={data} go={go} revision={revision}/>;
  if(view==="ownership")return <OwnershipRadar data={data}/>;
  if(view==="coach")return <Coach data={data} go={go} revision={revision} onTeamChange={onTeamChange}/>;
  if(view==="squad-fixtures")return <MyFixtures data={data} go={go} revision={revision} onTeamChange={onTeamChange}/>;
  if(view==="fixtures")return <div className="coach-page"><TeamQualityPanel data={data}/><TeamQualityFixtures data={data}/><LineupIntelligencePanel data={data}/></div>;
  if(view==="news")return <News data={data} go={go} revision={revision}/>;
  if(view==="deadline")return <FinalCheck data={data} go={go} revision={revision} onTeamChange={onTeamChange}/>;
  if(view==="chips")return <><LiveChips/><ChipPortfolioPanel/></>;
  if(view==="model")return <div className="coach-page"><ModelVersionPanel/><TeamQualityPanel data={data}/><PointsModel data={data}/></div>;
  return <div className="coach-page"><ModelAudit data={data} revision={revision}/><LiveHistory officialData={data}/></div>;
}

function Loading({label,retry}:{label:string;retry?:()=>void}){return <div className="coach-loading"><span className="live-spinner"/><b>{label}</b>{retry&&<button onClick={retry}>Try again</button>}</div>}
function TeamQualityPanel({data}:{data:FplData}){
  const[dimension,setDimension]=useState<"attack"|"defence">("attack");
  const rows=data.teams.filter(team=>team.quality).map(team=>{const quality=team.quality!;const home=dimension==="attack"?quality.effectiveAttackHome:quality.effectiveDefenceHome,away=dimension==="attack"?quality.effectiveAttackAway:quality.effectiveDefenceAway;return{team,quality,home,away,overall:(home+away)/2}}).sort((a,b)=>b.overall-a.overall);
  if(!rows.length)return null;
  return <section className="team-quality-panel"><header><div><span>TEAM QUALITY MODEL</span><h2>Attack and defence are separate signals.</h2><p>League-normalized official priors update gradually from completed Premier League results. A single clean sheet or haul cannot rewrite a club's rating.</p></div><div className="segmented"><button className={dimension==="attack"?"active":""} onClick={()=>setDimension("attack")}>Attack</button><button className={dimension==="defence"?"active":""} onClick={()=>setDimension("defence")}>Defence</button></div></header><div className="team-quality-grid">{rows.map((row,index)=><article key={row.team.id}><i>{index+1}</i><b>{row.team.short}<small>{row.team.name}</small></b><p><span>HOME</span><strong>×{row.home.toFixed(2)}</strong></p><p><span>AWAY</span><strong>×{row.away.toFixed(2)}</strong></p><p><span>CONFIDENCE</span><strong>{Math.round(row.quality.confidence*100)}%</strong></p><em className={row.quality.lowPlContinuity?"provisional":"established"}>{row.quality.lowPlContinuity?"LOW-CONTINUITY PRIOR":`${row.quality.matches} PL MATCH${row.quality.matches===1?"":"ES"}`}</em></article>)}</div><footer>1.00 is league average. Ratings use genuine Premier League evidence only; promoted and low-continuity squads start conservatively and gain authority as completed top-flight matches accumulate.</footer></section>;
}
function DeadlineClock({data}:{data:FplData}){const next=futureEvents(data,1)[0];const[now,setNow]=useState(Date.now());useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id)},[]);if(!next)return <div className="deadline-chip"><small>NEXT DEADLINE</small><b>Season complete</b></div>;const total=Math.max(0,Date.parse(next.deadline)-now);const d=Math.floor(total/86400000),h=Math.floor(total/3600000)%24,m=Math.floor(total/60000)%60,s=Math.floor(total/1000)%60;return <div className="deadline-chip"><small>{next.name.toUpperCase()} DEADLINE</small><b>{d?`${d}d `:""}{String(h).padStart(2,"0")}:{String(m).padStart(2,"0")}:{String(s).padStart(2,"0")}</b><span>{new Date(next.deadline).toLocaleString([],{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</span></div>}
function Freshness({data,onRefresh,loading}:{data:FplData;onRefresh:()=>void;loading:boolean}){const f=freshness(data.updatedAt);const warnings=data.dataIntegrityWarnings??[];return <section className={`freshness-strip ${f.tone}`}><div><span className={`fresh-dot ${f.tone}`}/><b>FPL data updated {f.label}</b></div><span>News: official player feed</span><span>Projections recalculated with this refresh</span>{f.tone==="stale"&&<strong>Data is stale—verify before acting.</strong>}{warnings.length>0&&<strong className="integrity-warning">⚠ Data integrity issue: {warnings[0]}{warnings.length>1?` (+${warnings.length-1} more)`:""}</strong>}<button onClick={onRefresh} disabled={loading}>{loading?"Refreshing…":"Refresh"}</button></section>}

// Squad/watchlist/locks persist to the server (see app/lib/persistence.ts) when signed in via
// either method below; both resolve to the same account (see app/lib/auth.ts).
// No override stored means "follow prefers-color-scheme" (handled in CSS, not here) -- this toggle
// only ever writes an explicit "light"/"dark" override once the user actually clicks it.
function ThemeToggle(){
  const[theme,setTheme]=useState<"light"|"dark">("light");
  useEffect(()=>{const stored=document.documentElement.getAttribute("data-theme");setTheme(stored==="dark"||(!stored&&window.matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light")},[]);
  const toggle=()=>{const next=theme==="dark"?"light":"dark";setTheme(next);document.documentElement.setAttribute("data-theme",next);persist("fpl-edge-theme",next)};
  return <button className="theme-toggle" onClick={toggle}>{theme==="dark"?"☀ Light mode":"● Dark mode"}</button>;
}
function AccountBar({onAuthChange}:{onAuthChange:()=>void}){
  const[account,setAccount]=useState<{email:string;method:"password"|"chatgpt"}|null>(null);
  const[checked,setChecked]=useState(false);
  const[open,setOpen]=useState(false);
  const[mode,setMode]=useState<"signin"|"signup">("signin");
  const[form,setForm]=useState({email:"",password:""});
  const[busy,setBusy]=useState(false);
  const[msg,setMsg]=useState("");
  const refresh=()=>{fetch("/api/auth/me",{cache:"no-store"}).then(r=>r.json()).then(d=>{setAccount(d.user??null);setChecked(true)}).catch(()=>setChecked(true))};
  useEffect(()=>{refresh()},[]);
  const returnTo=typeof window!=="undefined"?encodeURIComponent(window.location.pathname):"%2F";
  const submit=async()=>{
    if(!form.email||!form.password){setMsg("Enter email and password.");return}
    setBusy(true);setMsg("");
    try{
      const res=await fetch(mode==="signup"?"/api/auth/signup":"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(form)});
      const json=await res.json();
      if(!res.ok)throw new Error(json.error||"Could not sign in.");
      setAccount({email:json.email,method:"password"});setOpen(false);setForm({email:"",password:""});onAuthChange();
    }catch(e){setMsg(e instanceof Error?e.message:"Could not sign in.")}
    finally{setBusy(false)}
  };
  const signOut=async()=>{await fetch("/api/auth/logout",{method:"POST"});setAccount(null);onAuthChange()};
  if(!checked)return <div className="account-bar"><small>Checking sign-in…</small></div>;
  if(account)return <div className="account-bar signed-in"><small>Signed in</small><b>{account.email}</b>{account.method==="chatgpt"?<a href={`/signout-with-chatgpt?return_to=${returnTo}`}>Sign out</a>:<button onClick={signOut}>Sign out</button>}</div>;
  return <div className="account-bar">{!open?<button className="account-open" onClick={()=>setOpen(true)}>Sign in / Sign up</button>:<div className="account-form"><div className="segmented">{(["signin","signup"] as const).map(m=><button key={m} className={mode===m?"active":""} onClick={()=>setMode(m)}>{m==="signin"?"Sign in":"Sign up"}</button>)}</div><input type="email" placeholder="Email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))}/><input type="password" placeholder="Password (min 8 chars)" value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))}/><button onClick={submit} disabled={busy}>{busy?"…":mode==="signin"?"Sign in":"Create account"}</button><a className="chatgpt-signin" href={`/signin-with-chatgpt?return_to=${returnTo}`}>Sign in with ChatGPT</a>{msg&&<small className="account-error">{msg}</small>}<button className="account-cancel" onClick={()=>setOpen(false)}>Cancel</button></div>}</div>;
}

// revision is a required re-read trigger, not just an initial-mount read -- without it, a manager
// update made by one mounted component (e.g. TeamBar in the persistent sidebar) would never reach
// the independent useManager() instances Overview/Team/Transfers/FinalCheck each hold locally.
function useManager(revision:number){const[meta,setMeta]=useState<ManagerMeta|null>(null);useEffect(()=>{try{setMeta(JSON.parse(localStorage.getItem("fpl-edge-manager")||"null"))}catch{}},[revision]);return[meta,setMeta] as const}
// Single source of truth for "connect a Team ID" -- fetch, validate, persist. ConnectTeam (the
// full-page first-connect prompt) and TeamBar (the always-reachable sidebar switch/reconnect) both
// call this rather than keeping their own copies that agree today and drift the next time either
// is touched independently -- exactly the failure class this project has caught repeatedly.
async function connectTeam(id:string,data:FplData):Promise<ManagerMeta>{
  if(!/^\d+$/.test(id))throw new Error("Enter the numeric Team ID from your official FPL URL.");
  const response=await fetch(`/api/fpl/team?entry=${id}`,{cache:"no-store"});
  const json=await response.json();
  if(!response.ok)throw new Error(json.error||"Could not connect team");
  const ids=(json.playerIds as number[]).filter(pid=>data.players.some(p=>p.id===pid));
  if(ids.length!==15)throw new Error("FPL did not return a complete public squad.");
  persist("fpl-edge-squad",JSON.stringify(ids));
  persist("fpl-edge-entry",id);
  persist("fpl-edge-manager",JSON.stringify(json.manager));
  localStorage.setItem("fpl-edge-squad-saved-at",new Date().toISOString());
  return json.manager as ManagerMeta;
}
export function ConnectTeam({data,onConnected}:{data:FplData;onConnected?:(m:ManagerMeta)=>void}){const[id,setId]=useState("");const[busy,setBusy]=useState(false);const[msg,setMsg]=useState("");const connect=async()=>{setBusy(true);setMsg("");try{const manager=await connectTeam(id,data);setMsg(`${manager.teamName} connected. Your coach is ready.`);onConnected?.(manager)}catch(e){setMsg(e instanceof Error?e.message:"Could not connect team")}finally{setBusy(false)}};return <section className="connect-hero"><div><span>START HERE</span><h2>Connect your official FPL team</h2><p>Enter the number in your FPL team URL. Read-only: we never ask for your password or make changes to your official team.</p></div><div><input value={id} onChange={e=>setId(e.target.value.replace(/\D/g,""))} placeholder="FPL Team ID" inputMode="numeric"/><button onClick={connect} disabled={busy}>{busy?"Connecting…":"Connect my team →"}</button><small>{msg||"Current public squad becomes available after its deadline."}</small></div></section>}

// Sidebar-resident sibling to ConnectTeam -- that component only renders when there's no usable
// squad yet (isCompleteSquad fails), so once a team is connected there is no way back to it. This
// stays mounted regardless of connection state so switching (or dropping) teams is always reachable.
// Captain/vice picks (fpl-edge-captain-*/vice-*) are deliberately left untouched on disconnect/
// reconnect: resolveCaptaincy already validates any stored id against the CURRENT squad's players
// on every read (see its `valid()` guard) and falls back through manager->model->first-player when
// the stored id isn't in that squad -- confirmed by reading its call sites, not assumed from the
// similar pattern elsewhere. A stale id is inert dead data, never a rendering risk.
function TeamBar({data,revision,onTeamChange}:{data:FplData|null;revision:number;onTeamChange:()=>void}){
  const[meta,setMeta]=useManager(revision);
  const[open,setOpen]=useState(false);
  const[id,setId]=useState("");
  const[busy,setBusy]=useState(false);
  const[msg,setMsg]=useState("");
  const connect=async()=>{
    if(!data){setMsg("Still loading official data -- try again in a moment.");return}
    setBusy(true);setMsg("");
    try{
      const manager=await connectTeam(id,data);
      setMeta(manager);setId("");setOpen(false);onTeamChange();
    }catch(e){setMsg(e instanceof Error?e.message:"Could not connect team")}
    finally{setBusy(false)}
  };
  const disconnect=()=>{
    if(!confirm("Disconnect this team? You can reconnect anytime with a Team ID."))return;
    localStorage.removeItem("fpl-edge-squad");
    localStorage.removeItem("fpl-edge-entry");
    localStorage.removeItem("fpl-edge-manager");
    setMeta(null);setOpen(false);onTeamChange();
  };
  return <div className="team-bar">{!open?<><small>FPL TEAM</small><b>{meta?meta.teamName:"Not connected"}</b><button className="team-open" onClick={()=>setOpen(true)}>{meta?"Switch team":"Connect team"}</button></>:<div className="team-form"><input value={id} onChange={e=>setId(e.target.value.replace(/\D/g,""))} placeholder="FPL Team ID" inputMode="numeric"/><button onClick={connect} disabled={busy}>{busy?"Connecting…":"Connect"}</button>{msg&&<small className="team-error">{msg}</small>}<button className="team-cancel" onClick={()=>{setOpen(false);setMsg("")}}>Cancel</button>{meta&&<button className="team-disconnect" onClick={disconnect}>Disconnect team</button>}</div>}</div>;
}

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

function Overview({data,go,revision,onTeamChange}:{data:FplData;go:(v:View)=>void;revision:number;onTeamChange:()=>void}){const[meta,setMeta]=useManager(revision);const squad=useMemo(()=>savedSquad(data),[data,revision,meta]);const a=analysis(data,squad);if(!a)return <><ConnectTeam data={data} onConnected={m=>{setMeta(m);onTeamChange()}}/><section className="empty-command"><span>MANUAL OPTION</span><h2>Already know your draft?</h2><p>Build and save it manually. Your recommendations, transfer centre and deadline check will activate immediately.</p><button onClick={()=>go("draft")}>Build a squad →</button></section></>;const moves=bestTransfers(data,squad,(meta?.bank??a.bank),1,12,sellingPricesFor(meta));const move=selectPrimaryTransfer(moves);const roll=!move;const issues=a.issues;const next=a.events[0];let manager:ManagerMeta|null=null;try{manager=JSON.parse(localStorage.getItem("fpl-edge-manager")||"null")}catch{}const storedCaptainId=Number(localStorage.getItem(`fpl-edge-captain-${a.first}`));const storedViceId=Number(localStorage.getItem(`fpl-edge-vice-${a.first}`));const modelCaptain=a.xi.captain??a.xi.players[0];const resolvedCaptaincy=resolveCaptaincy(a.xi.players,storedCaptainId,storedViceId,manager?.captainId,manager?.viceCaptainId,modelCaptain,undefined);const activeCaptain=(resolvedCaptaincy&&a.xi.players.find(p=>p.id===resolvedCaptaincy.captainId))??modelCaptain;const plannedChip=plannedChipFor(readPlannedChips(),a.first);const captainTerm=playerProjection(activeCaptain,a.first,data.fixtures,a.first);const chipBonus=plannedChip==="Triple Captain"?captainTerm:plannedChip==="Bench Boost"?a.bench.reduce((s,p)=>s+playerProjection(p,a.first,data.fixtures,a.first),0):0;const projected=a.xi.players.reduce((s,p)=>s+playerProjection(p,a.first,data.fixtures,a.first),0)+captainTerm+chipBonus;return <div className="coach-page"><section className="command-top"><div><span>NEXT DEADLINE</span><h2>{next.name}</h2><p>{new Date(next.deadline).toLocaleString([],{weekday:"long",day:"numeric",month:"long",hour:"2-digit",minute:"2-digit",timeZoneName:"short"})}</p></div><DeadlineClock data={data}/></section><section className="weekly-call"><div className="call-label"><span>THIS WEEK'S RECOMMENDATION</span><b>{roll?"LIKELY":"MODEL EDGE"}</b></div><h2>{roll?"ROLL TRANSFER":`${move.out.name} → ${move.incoming.name}`}</h2><ul>{roll?<><li>No risk-adjusted squad move clears the 2.2-point five-GW action threshold.</li><li>Your current XI keeps two future transfer routes open.</li><li>Recheck official flags before the deadline.</li></>:<><li>+{move.gain5.toFixed(1)} projected squad points across five gameweeks.</li><li>{move.minutes>=0?`${Math.round(move.minutes)} extra expected minutes this week.`:"The upside is fixture-led despite lower expected minutes."}</li><li>{move.risk} modelled minutes/availability risk.</li></>}</ul><button onClick={()=>go("transfers")}>Inspect the reasoning →</button></section><div className="command-metrics"><article><span>PROJECTED GW</span><b>{projected.toFixed(1)}</b><small>including {activeCaptain.name} captaincy{plannedChip==="Triple Captain"?" + Triple Captain":plannedChip==="Bench Boost"?" + Bench Boost":""}</small></article><article><span>SQUAD VALUE</span><b>£{(meta?.squadValue??a.cost).toFixed(1)}m</b><small>official when connected</small></article><article><span>IN THE BANK</span><b>£{(meta?.bank??a.bank).toFixed(1)}m</b><small>{meta?"official public data":"builder estimate"}</small></article><article><span>FREE TRANSFERS</span><b>Set in Transfers</b><small>not exposed publicly by FPL</small></article><article><span>OVERALL RANK</span><b>{fmt(meta?.overallRank)}</b><small>{meta?meta.teamName:"connect to reveal"}</small></article><article><span>GW RANK</span><b>{fmt(meta?.gameweekRank)}</b><small>{meta?.gameweekPoints??"—"} GW points</small></article><article><span>TOTAL POINTS</span><b>{meta?.overallPoints??"—"}</b><small>official account history</small></article></div><section className="urgent-card"><header><div><span>URGENT ISSUES</span><h2>{issues.length?`${issues.length} squad issue${issues.length>1?"s":""} to monitor`:"No urgent squad issues."}</h2></div><button onClick={()=>go("deadline")}>Open final check →</button></header>{issues.length>0&&<div>{issues.slice(0,5).map(p=><article key={p.id}><b>{p.name}</b><span className={p.status!=="a"?"bad":"warn"}>{p.status!=="a"?"CONFIRMED FLAG":"LIKELY MINUTES RISK"}</span><p>{p.news||`${startPct(p,a.first,data)}% modelled start probability.`}</p></article>)}</div>}</section><WhatChanged data={data} squad={squad}/><DgwAlert data={data}/><SquadValueAlert squad={squad}/></div>}
function WhatChanged({data,squad}:{data:FplData;squad:FplPlayer[]}){const flagged=squad.filter(p=>p.news||p.status!=="a");const market=[...data.players].filter(p=>p.transfersIn>p.transfersOut).sort((a,b)=>(b.transfersIn-b.transfersOut)-(a.transfersIn-a.transfersOut))[0];return <section className="changed-card"><div><span>SINCE YOUR LAST CHECK</span><h2>What changed?</h2></div><div>{flagged.slice(0,2).map(p=><p key={p.id}><i className="amber"/><b>{p.name}</b> {p.news||"remains flagged in the official feed"}</p>)}{market&&<p><i className="green"/><b>{market.name}</b> has the strongest net transfer-in pressure.</p>}{!flagged.length&&<p><i className="green"/>No new official flag affects your saved squad.</p>}</div><strong>Impact: {flagged.length?"Review the final-check risk flags.":"No forced transfer."}</strong></section>}

// Surfaces confirmed doubles/blanks within the same 8-GW horizon Chips/Fixtures already use, so a
// user doesn't have to notice a rearrangement by manually browsing the Fixtures page close to the
// deadline. Renders nothing on an ordinary week -- true for the whole 2026/27 season so far.
function DgwAlert({data}:{data:FplData}){
  const horizon=futureEvents(data,8).map(e=>e.id);
  const anomalies=detectFixtureAnomalies(data);
  const nextDoubles=nearestInHorizon(anomalies.doubles,horizon);
  const nextBlanks=nearestInHorizon(anomalies.blanks,horizon);
  if(!nextDoubles.length&&!nextBlanks.length)return null;
  const teamNames=(entries:{teamId:number}[])=>[...new Set(entries.map(e=>data.teams.find(t=>t.id===e.teamId)?.name??"Unknown"))];
  const eventLabel=(eventId:number)=>data.events.find(e=>e.id===eventId)?.name.replace("Gameweek ","GW")??`GW${eventId}`;
  const listTeams=(names:string[])=>names.length>3?`${names.slice(0,3).join(", ")} (+${names.length-3} more)`:names.join(", ");
  return <section className="dgw-alert">
    <div><span>FIXTURE PLANNER</span><h2>Plan ahead of the schedule, not the week of.</h2></div>
    <div>
      {nextDoubles.length>0&&<p><b>{eventLabel(nextDoubles[0].eventId)}</b> is a double gameweek for {listTeams(teamNames(nextDoubles))}.</p>}
      {nextBlanks.length>0&&<p><b>{eventLabel(nextBlanks[0].eventId)}</b> is a blank gameweek for {listTeams(teamNames(nextBlanks))}.</p>}
    </div>
  </section>;
}


function useCaptaincy(players:FplPlayer[],event:number,modelCaptain:FplPlayer|undefined,modelVice:FplPlayer|undefined){
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

function CaptaincyPicker({players,captain,vice,onCaptain,onVice,event,data,readOnly=false,status}:{players:FplPlayer[];captain:FplPlayer;vice:FplPlayer;onCaptain:(id:number)=>void;onVice:(id:number)=>void;event:number;data:FplData;readOnly?:boolean;status?:string}){return <section className={`captaincy-picker ${readOnly?"locked":""}`}><div><span>CAPTAIN</span><select value={captain.id} onChange={e=>onCaptain(Number(e.target.value))} disabled={readOnly}>{players.map(p=><option key={p.id} value={p.id}>{p.name} · {playerProjection(p,event,data.fixtures,event).toFixed(1)} xPts</option>)}</select><small>{readOnly?"Official selection from FPL.":"Scores double if they play."}</small></div><i>↔</i><div><span>VICE-CAPTAIN</span><select value={vice.id} onChange={e=>onVice(Number(e.target.value))} disabled={readOnly}>{players.map(p=><option key={p.id} value={p.id}>{p.name} · {playerProjection(p,event,data.fixtures,event).toFixed(1)} xPts</option>)}</select><small>Takes over if your captain does not play.</small></div><strong>{status??`Saved automatically for GW${event}`}</strong></section>}

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

function useGameweekHistory(entry:string|null){
  const[weeks,setWeeks]=useState<HistoryWeek[]|null>(null);
  useEffect(()=>{
    if(!entry){setWeeks(null);return}
    let cancelled=false;
    fetch(`/api/fpl/history?entry=${entry}`,{cache:"no-store"}).then(r=>r.ok?r.json():null).then(json=>{if(!cancelled)setWeeks(json?.weeks??null)}).catch(()=>{if(!cancelled)setWeeks(null)});
    return()=>{cancelled=true};
  },[entry]);
  return weeks;
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

function Team({data,go,revision,onTeamChange}:{data:FplData;go:(v:View)=>void;revision:number;onTeamChange:()=>void}){
  const[manager,setManager]=useManager(revision);
  let entry:string|null=null;
  try{entry=localStorage.getItem("fpl-edge-entry")}catch{}
  useEffect(()=>{
    if(!entry)return;
    let cancelled=false;
    fetch(`/api/fpl/team?entry=${entry}`,{cache:"no-store"}).then(async response=>{
      if(!response.ok)return null;
      return response.json();
    }).then(json=>{
      if(cancelled||!json?.manager)return;
      const ids=(json.playerIds as number[]).filter(id=>data.players.some(p=>p.id===id));
      if(ids.length!==15)return;
      persist("fpl-edge-squad",JSON.stringify(ids));
      persist("fpl-edge-manager",JSON.stringify(json.manager));
      localStorage.setItem("fpl-edge-squad-saved-at",new Date().toISOString());
      setManager(json.manager as ManagerMeta);
    }).catch(()=>{});
    return()=>{cancelled=true};
  },[entry,data.updatedAt]);
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
  const[tab,setTab]=useState<"Pitch"|"List">("Pitch");
  const[selected,setSelected]=useState<FplPlayer|null>(null);

  const event=data.events.find(e=>e.id===navEventId)??currentAnchor??horizonEvents[0]??data.events[0];
  // "Past" is decided by event.finished, not by comparing ids to currentAnchor -- a gameweek stays
  // current:true and finished:false for as long as its matches are still being played (including a
  // mid-gameweek state where some fixtures are done and others haven't kicked off), so this can't
  // prematurely read as "past" partway through.
  const branch:"past"|"current"|"future"=!event?"future":event.finished?"past":(currentAnchor&&event.id===currentAnchor.id)?"current":"future";

  const history=useGameweekHistory(entry);

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

  if(!a)return <><ConnectTeam data={data} onConnected={m=>{setManager(m);onTeamChange()}}/><button className="wide-action" onClick={()=>go("draft")}>Or build manually →</button></>;

  const goBack=()=>setNavEventId(id=>Math.max(backwardBoundId,id-1));
  const goForward=()=>setNavEventId(id=>Math.min(forwardBoundId,id+1));

  return <div className="coach-page">
    <GameweekNav event={event} branch={branch} onBack={goBack} onForward={goForward} canBack={event.id>backwardBoundId} canForward={event.id<forwardBoundId}/>
    {branch==="past"&&<PastGameweekView data={data} event={event} history={history}/>}
    {branch==="current"&&<CurrentGameweekView data={data} event={event} squad={squad} xi={currentXi} bench={currentBench} captaincy={currentCaptaincy} manager={manager} tab={tab} setTab={setTab} selected={selected} setSelected={setSelected} bank={a.bank} go={go}/>}
    {branch==="future"&&<FutureGameweekView data={data} event={event} squad={squad} tab={tab} setTab={setTab} selected={selected} setSelected={setSelected} bank={a.bank}/>}
  </div>;
}
function formation(players:FplPlayer[]){return ["DEF","MID","FWD"].map(pos=>players.filter(p=>p.positionShort===pos).length).join("-")}
function PlayerPanel({player,data,first,replacements,close}:{player:FplPlayer;data:FplData;first:number;replacements:Transfer[];close:()=>void}){const events=futureEvents(data,5);const m=projectionMetrics(player,first,data.fixtures,first);return <div className="player-panel-backdrop" onClick={close}><aside className="player-panel" onClick={e=>e.stopPropagation()}><button className="panel-close" onClick={close}>×</button><span>{player.teamName} · {player.position}</span><h2>{player.name}</h2><div className="panel-price">£{player.price.toFixed(1)}m <small>{player.selectedBy.toFixed(1)}% owned</small></div><div className="panel-fixtures">{events.map(e=><div key={e.id}><b>{e.name.replace("Gameweek ","GW")}</b><span>{opponent(player,e.id,data)}</span><strong>{playerProjection(player,e.id,data.fixtures,first).toFixed(1)}</strong></div>)}</div><div className="panel-stats"><p><span>Expected minutes</span><b>{Math.round(m.expectedMinutes)}</b></p><p><span>Start probability</span><b>{Math.round(m.startProbability*100)}%</b></p><p><span>Season xG / xA</span><b>{player.expectedGoals.toFixed(2)} / {player.expectedAssists.toFixed(2)}</b></p><p><span>Form</span><b>{player.form.toFixed(1)}</b></p><p><span>Penalties</span><b>{m.penaltyRole?"First choice":"Not confirmed"}</b></p><p><span>Set pieces</span><b>{m.setPieceRole?"First choice":"Not confirmed"}</b></p></div><section><span>COACH VIEW</span><p>{m.startProbability>.8?`LIKELY starter with ${Math.round(m.expectedMinutes)} expected minutes.`:`UNCERTAIN minutes profile: only ${Math.round(m.startProbability*100)}% start probability.`} {m.penaltyRole?"First-choice penalties improve the ceiling.":"No confirmed penalty role is included."}</p></section><section><span>BEST REPLACEMENTS</span>{replacements.length?replacements.map(r=><p key={r.incoming.id}><b>{r.incoming.name}</b> · +{r.gain5.toFixed(1)} five-GW xPts · {r.risk} risk</p>):<p>No clearly stronger legal one-player route was found.</p>}</section></aside></div>}
function PastGameweekView({data,event,history}:{data:FplData;event:FplEvent;history:HistoryWeek[]|null}){
  const historyWeek=history?.find(w=>w.event===event.id);
  let locks:LockRecord[]=[];
  try{locks=JSON.parse(localStorage.getItem("fpl-edge-locks")||"[]")}catch{}
  const lock=locks.find(l=>l.event===event.id);
  const resolved=resolvePastGameweek(data.players,historyWeek,lock);

  if(!resolved)return <section className="gw-empty">
    <span>NO RECORD</span>
    <h2>No snapshot recorded for this week.</h2>
    <p>{event.name} wasn't locked in Final Check before its deadline, and this account isn't connected to an official FPL Team ID. Connect a team on Overview to see full official history, or lock upcoming weeks in Final Check to build a record going forward.</p>
  </section>;

  return <div className="gw-past">
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
    <section className="coach-pitch"><div className="pitch-markings"/>{["GKP","DEF","MID","FWD"].map(pos=><div className={`coach-pitch-row ${pos.toLowerCase()}`} key={pos}>{resolved.xi.filter(r=>r.player.positionShort===pos).map(r=><button key={r.player.id} disabled><i>{pos}</i><b>{r.player.name}{r.isCaptain&&<em>C</em>}{r.isViceCaptain&&<em>V</em>}</b><span>{r.points}{r.multiplier>1?` × ${r.multiplier}`:""} pts</span></button>)}</div>)}</section>
    <section className="coach-bench"><span>BENCH</span>{resolved.bench.map((r,i)=><button key={r.player.id} disabled><i>{i+1}</i><b>{r.player.name}</b><small>{r.points} pts</small></button>)}</section>
  </div>;
}

function CurrentGameweekView({data,event,squad,xi,bench,captaincy,manager,tab,setTab,selected,setSelected,bank,go}:{data:FplData;event:FplEvent;squad:FplPlayer[];xi:FplPlayer[];bench:FplPlayer[];captaincy:{captain:FplPlayer;vice:FplPlayer;chooseCaptain:(id:number)=>void;chooseVice:(id:number)=>void};manager:ManagerMeta|null;tab:"Pitch"|"List";setTab:(t:"Pitch"|"List")=>void;selected:FplPlayer|null;setSelected:(p:FplPlayer|null)=>void;bank:number;go:(v:View)=>void}){
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
    <section className="team-toolbar"><div><span>FORMATION</span><b>{formation(scoring.effectiveXi)}</b></div><div><span>{hasStarted?"LIVE POINTS":"KICKOFF PENDING"}</span><b>{hasStarted?scoring.liveTotal:"—"}</b></div><GameweekAverage events={data.events} eventId={event.id}/>{scoring.activeChip&&<div><span>ACTIVE CHIP</span><b>{scoring.activeChip==="3xc"?"Triple Captain":scoring.activeChip==="bboost"?"Bench Boost":scoring.activeChip}</b></div>}<div className="segmented">{(["Pitch","List"] as const).map(x=><button className={tab===x?"active":""} onClick={()=>setTab(x)} key={x}>{x}</button>)}</div><button onClick={()=>go("draft")}>Edit squad</button></section>
    {!hasStarted&&<p className="gw-pending-note">{event.name}'s matches haven't kicked off yet -- live points will appear here once they do.</p>}
    {hasStarted&&!allFixturesFinished&&<p className="gw-pending-note">Some of this gameweek's matches are still in progress -- a player showing 0 minutes may not have played yet. Final XI and automatic substitutions appear once every match finishes.</p>}
    {allFixturesFinished&&!event.dataChecked&&<p className="gw-pending-note">Bonus points aren't final yet -- FPL confirms them a few hours after the last match of the gameweek.</p>}
    {scoring.swaps.length>0&&<section className="gw-autosub-note"><span>AUTOMATIC SUBSTITUTIONS</span>{scoring.swaps.map((s,i)=><p key={i}><b>{s.inName}</b> came on for <b>{s.outName}</b> (0 minutes)</p>)}</section>}
    {scoring.armbandPassedToVice&&<p className="gw-armband-note">{captain.name} didn't play -- the armband passed to {vice.name} ({vice.name}'s score is {multiplierWord}).</p>}
    {scoring.captaincyLost&&<p className="gw-armband-note">Neither {captain.name} nor {vice.name} played -- no captain multiplier applies this week.</p>}
    {scoring.activeChip==="bboost"&&<p className="gw-chip-note">Bench Boost is active · {scoring.benchBoostPoints} bench points are included in the live total.</p>}
    {liveRank&&<LiveRankCard result={liveRank}/>}
    {hasStarted&&(movers.hurting.length>0||movers.helping.length>0)&&<LiveMoversCard hurting={movers.hurting} helping={movers.helping}/>}
    <CaptaincyPicker players={xi} captain={captain} vice={vice} onCaptain={chooseCaptain} onVice={chooseVice} event={event.id} data={data} readOnly={officialLocked} status={captaincyStatus}/>
    {tab==="Pitch"&&<><section className="coach-pitch"><div className="pitch-markings"/>{["GKP","DEF","MID","FWD"].map(pos=><div className={`coach-pitch-row ${pos.toLowerCase()}`} key={pos}>{scoring.effectiveXi.filter(p=>p.positionShort===pos).map(p=>{const isArmband=p.id===scoring.effectiveCaptainId;const wasSubbedIn=scoring.swaps.some(s=>s.inId===p.id);return <button key={p.id} className={p.status!=="a"?"flagged":""} onClick={()=>setSelected(p)}><i>{pos}{wasSubbedIn?" · AUTO":""}</i><b>{p.name}{isArmband&&<em>C</em>}{p.id===scoring.viceId&&!isArmband&&<em>V</em>}</b><span>{hasStarted?`${p.eventPoints}${isArmband&&scoring.captainMultiplier>1?` × ${scoring.captainMultiplier}`:""} pts`:opponent(p,event.id,data)}</span><small>{hasStarted?`${p.eventMinutes} mins`:""}</small></button>})}</div>)}</section>
    <section className="coach-bench"><span>{scoring.activeChip==="bboost"?"BENCH BOOST":"BENCH"}</span>{scoring.displayedBench.map((p,i)=><button key={p.id} onClick={()=>setSelected(p)}><i>{i+1}</i><b>{p.name}</b><small>{hasStarted?`${p.eventPoints} pts · ${p.eventMinutes} mins${scoring.activeChip==="bboost"?" · COUNTED":""}`:opponent(p,event.id,data)}</small></button>)}</section></>}
    {tab==="List"&&<section className="team-list"><header><span>PLAYER</span><span>FIXTURE</span><span>PTS</span><span>MINS</span><span>STATUS</span></header>{[...scoring.effectiveXi,...scoring.displayedBench].map((p,i)=>{const isArmband=p.id===scoring.effectiveCaptainId;return <button key={p.id} onClick={()=>setSelected(p)}><b>{i<scoring.effectiveXi.length?"XI":"BENCH"} · {p.name}{isArmband?" (C)":p.id===scoring.viceId?" (V)":""}<small>{p.teamShort} · {p.positionShort}</small></b><span>{opponent(p,event.id,data)}</span><strong>{p.eventPoints}{isArmband&&scoring.captainMultiplier>1?` × ${scoring.captainMultiplier}`:""}</strong><span>{p.eventMinutes}</span><em className={p.status==="a"?"ok":"risk"}>{i>=scoring.effectiveXi.length&&scoring.activeChip==="bboost"?"COUNTED":p.status==="a"?"LIKELY":"FLAGGED"}</em></button>})}</section>}
    {selected&&hasStarted&&<LivePointsPanel player={selected} scoring={scoring} bonusFinal={!!allFixturesFinished&&event.dataChecked} close={()=>setSelected(null)}/>}
    {selected&&!hasStarted&&<PlayerPanel player={selected} data={data} first={planningFirst} replacements={replacement} close={()=>setSelected(null)}/>}
  </div>;
}

function LiveRankCard({result}:{result:LiveRankResult}){
  return <section className="gw-live-rank-card" aria-live="polite">
    <span>LIVE RANK ESTIMATE</span>
    {result.status==="unavailable"?<><h3>Unavailable</h3><p>{result.reason}</p></>:<>
      <h3>{Math.round(result.rank.rank).toLocaleString("en-GB")}</h3>
      {result.rank.clamped!=="none"&&<p className="gw-live-rank-clamped">{result.rank.clamped==="above-range"?"Better than the best real sampled score.":"Worse than the worst real sampled score."}</p>}
      <details><summary>Assumptions and disclosure</summary>{result.assumptions.map(a=><p key={a}>{a}</p>)}</details>
    </>}
  </section>;
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

function FutureGameweekView({data,event,squad,tab,setTab,selected,setSelected,bank}:{data:FplData;event:FplEvent;squad:FplPlayer[];tab:"Pitch"|"List";setTab:(t:"Pitch"|"List")=>void;selected:FplPlayer|null;setSelected:(p:FplPlayer|null)=>void;bank:number}){
  const xiResult=bestXi(squad,event.id,data.fixtures,event.id);
  const xi=xiResult.players;
  const bench=benchOrderForEvent(xi,squad.filter(p=>!xi.some(x=>x.id===p.id)),event.id,data).bench;
  const replacement=bestTransfers(data,squad,bank).filter(x=>selected&&x.out.id===selected.id&&x.qualityStatus!=="blocked").slice(0,3);
  const gwFixtures=data.fixtures.filter(f=>f.event===event.id);
  // No point total is ever shown on this page (just names/opponents/status), so there's no forward-
  // projection math to make chip-aware here -- this is purely a visible confirmation of intent,
  // keyed strictly on event.id, the same off-by-one discipline as every other plannedChipFor call site.
  const plannedChip=plannedChipFor(readPlannedChips(),event.id);

  return <div className="gw-future">
    <section className="gw-provisional-note"><span>PROVISIONAL</span><h2>Today's squad against {event.name}'s fixtures.</h2><p>No transfers have been made for this week yet -- this is where your squad stands right now, not a locked plan. Come back closer to the deadline as news and fixtures firm up.</p>{plannedChip&&<div className="gw-planned-chip"><span>PLANNED CHIP</span><b>{plannedChip}</b></div>}</section>
    <div className="segmented">{(["Pitch","List"] as const).map(x=><button className={tab===x?"active":""} onClick={()=>setTab(x)} key={x}>{x}</button>)}</div>
    {tab==="Pitch"&&<section className="coach-pitch"><div className="pitch-markings"/>{["GKP","DEF","MID","FWD"].map(pos=><div className={`coach-pitch-row ${pos.toLowerCase()}`} key={pos}>{xi.filter(p=>p.positionShort===pos).map(p=><button key={p.id} className={p.status!=="a"?"flagged":""} onClick={()=>setSelected(p)}><i>{pos}</i><b>{p.name}</b><span>{opponent(p,event.id,data)}</span><small>{p.status==="a"?"LIKELY":"FLAGGED"}</small></button>)}</div>)}</section>}
    {tab==="List"&&<section className="team-list"><header><span>PLAYER</span><span>FIXTURE</span><span>STATUS</span></header>{[...xi,...bench].map((p,i)=><button key={p.id} onClick={()=>setSelected(p)}><b>{i<11?"XI":"BENCH"} · {p.name}<small>{p.teamShort} · {p.positionShort}</small></b><span>{opponent(p,event.id,data)}</span><em className={p.status==="a"?"ok":"risk"}>{p.status==="a"?"LIKELY":"FLAGGED"}</em></button>)}</section>}
    {!gwFixtures.length&&<p className="gw-blank-note">No official fixtures are on the board yet for {event.name}, or this is a blank gameweek for part of your squad.</p>}
    {selected&&<PlayerPanel player={selected} data={data} first={event.id} replacements={replacement} close={()=>setSelected(null)}/>}
  </div>;
}

const bandLabel:Record<FiveGwGainBand,string>={negligible:"Negligible",modest:"Modest",strong:"Strong",exceptional:"Exceptional",anomaly:"Anomaly review"};

// Pure so the hold decision is directly unit-testable (tests/dgw.test.mts) without rendering.
// Only fires when rolling is already the recommendation -- this never argues for holding a
// transfer that would otherwise clear the action threshold, only reinforces a roll that's already correct.
export function transferHoldNote(nearestDoubles:DoubleGameweek[],rollRecommended:boolean):string|null{
  if(!rollRecommended||!nearestDoubles.length)return null;
  const eventId=nearestDoubles[0].eventId;
  const teamCount=new Set(nearestDoubles.map(d=>d.teamId)).size;
  return `A double gameweek is coming in GW${eventId} (${teamCount} team${teamCount>1?"s":""}) — consider banking this transfer.`;
}

function Transfers({data,go,revision,onTeamChange}:{data:FplData;go:(v:View)=>void;revision:number;onTeamChange:()=>void}){
  const[meta,setMeta]=useManager(revision);
  // meta must be a squad dependency (matches Overview's pattern) -- connecting a team here persists
  // squad ids straight to localStorage via ConnectTeam's onConnected callback below, but savedSquad()
  // is only re-read when this memo's deps change. Without meta here, the page showed the "connected"
  // success message yet kept rendering the connect screen until an unrelated revision bump (e.g. a
  // full data refresh) happened to fire.
  const squad=useMemo(()=>savedSquad(data),[data,revision,meta]);
  const[tab,setTab]=useState<"routes"|"moves"|"watchlist">("routes");const[fts,setFts]=useState(readFreeTransfers);
  const[routeHorizon,setRouteHorizon]=useState<3|5|8>(5);const[maxWeeklyHit,setMaxWeeklyHit]=useState<0|4|8>(4);
  const[watchIds,setWatchIds]=useState<number[]>([]);useEffect(()=>setWatchIds(readIds("fpl-edge-watchlist")),[]);
  const[expanded,setExpanded]=useState<Set<string>>(new Set());
  const a=analysis(data,squad);
  const optimizer=useMemo(()=>createOptimizer(data,"Balanced 5 GWs","Balanced","Maximum xPts"),[data]);
  const bank=meta?.bank??a?.bank??0;
  const sellingPrices=useMemo(()=>sellingPricesFor(meta),[meta]);
  const baseRows=useMemo(()=>a?bestTransfers(data,squad,bank,fts,60,sellingPricesFor(meta)):[],[data,squad,bank,fts,a,meta]);
  const rows=useMemo(()=>withModelUtilityChange(baseRows,squad,optimizer),[baseRows,squad,optimizer]);
  const routes=useMemo(()=>solveTransferRoutes(data,squad,bank,{horizon:routeHorizon,freeTransfers:fts,maxWeeklyHit,sellingPrices,resultLimit:4,plannedChips:readPlannedChips()}),[data,squad,bank,fts,routeHorizon,maxWeeklyHit,sellingPrices]);
  const best=selectPrimaryTransfer(rows);const roll=!best;
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
  if(!a)return <><ConnectTeam data={data} onConnected={m=>{setMeta(m);onTeamChange()}}/><button className="wide-action" onClick={()=>go("draft")}>Build manually instead →</button></>;
  const actionableRows=rows.filter(row=>row.qualityStatus==="actionable");
  const watchlistRows=rows.filter(row=>row.qualityStatus==="watchlist");
  const blockedRows=rows.filter(row=>row.qualityStatus==="blocked");
  const holdNote=transferHoldNote(nearestInHorizon(detectFixtureAnomalies(data).doubles,futureEvents(data,5).map(e=>e.id)),roll);
  const setWatch=(id:number)=>{const next=watchIds.includes(id)?watchIds.filter(x=>x!==id):[...watchIds,id];setWatchIds(next);persist("fpl-edge-watchlist",JSON.stringify(next))};
  const toggleExpand=(key:string)=>setExpanded(x=>{const next=new Set(x);next.has(key)?next.delete(key):next.add(key);return next});
  return <div className="coach-page">
    <section className="transfer-tabs"><button className={tab==="routes"?"active":""} onClick={()=>setTab("routes")}>Route planner</button><button className={tab==="moves"?"active":""} onClick={()=>setTab("moves")}>Single moves</button><button className={tab==="watchlist"?"active":""} onClick={()=>setTab("watchlist")}>Watchlist <b>{watchIds.length}</b></button><label>Free transfers <select value={fts} onChange={e=>{const next=Number(e.target.value);setFts(next);localStorage.setItem("fpl-edge-free-transfers",String(next))}}>{[0,1,2,3,4,5].map(x=><option key={x}>{x}</option>)}</select></label></section>
    {tab==="routes"?<TransferRoutePlanner routes={routes} horizon={routeHorizon} setHorizon={setRouteHorizon} maxWeeklyHit={maxWeeklyHit} setMaxWeeklyHit={setMaxWeeklyHit}/>:tab==="moves"?<>
      <section className="recommended-move">
        <div className="call-label"><span>RECOMMENDED MOVE</span><b>{roll?"SAVE":"QUALITY-GATED EDGE"}</b></div>
        <h2>{roll?"ROLL":`${best.out.name} → ${best.incoming.name}`}</h2>
        <p>{roll?"No actionable single transfer clears both the 2.2-point threshold and the projection-evidence, minutes and robustness gates.":`This is the highest-ranked legal route that passed every quality gate. ${best.risk} minutes risk.`}</p>
        {!roll&&<div>{[["GW","1",best.gain1],["NEXT","3",best.gain3],["NEXT","5",best.gain5]].map(([label,n,value])=><span key={String(n)}><small>{label} {n}</small><b>{Number(value)>=0?"+":""}{Number(value).toFixed(1)} pts</b></span>)}<span><small>PRICE DIFFERENCE</small><b>{`${best.price>=0?"+":"−"}£${Math.abs(best.price).toFixed(1)}m`}</b></span><span><small>EXPECTED MINUTES</small><b>{`${best.minutes>=0?"+":""}${Math.round(best.minutes)}`}</b></span><span><small>TRANSFER HIT</small><b>{best.hitCost?`−${best.hitCost}`:"None"}</b></span><span><small>NET (AFTER HIT)</small><b>{best.netDifference>=0?"+":""}{best.netDifference.toFixed(1)} pts</b></span>{best.utilityChange!==null&&<span><small>RISK-ADJUSTED OBJECTIVE</small><b>{best.utilityChange>=0?"+":""}{best.utilityChange.toFixed(1)}</b><em>Optimizer objective; not the /100 team rating</em></span>}</div>}
        <strong>{roll?"Recommendation: SAVE THE TRANSFER":best.gain1-best.hitCost>0?"Recommendation: MOVE NOW":"Recommendation: WAIT / RECHECK"}</strong>
      </section>
      {!roll&&<section className="primary-transfer-confidence" aria-label="Primary transfer Decision Confidence">
        <header><span>DECISION CONFIDENCE</span><h2>Primary transfer scenario analysis</h2><p>This analysis is separate from the Actionable / Watchlist / Blocked quality gate and does not change transfer ordering.</p></header>
        <DecisionConfidencePanel title="Primary transfer confidence" state={decisionConfidence.primaryKey&&decisionConfidence.state.results[decisionConfidence.primaryKey]?.main||{status:"pending"}} candidateLabel="Make transfer" baselineLabel="Keep current squad" metricDirection="Transfer minus current squad" metricLabel="transfer delta" />
        <TransferSensitivityPanel state={decisionConfidence.primaryKey&&decisionConfidence.state.results[decisionConfidence.primaryKey]?.sensitivity||{status:"pending"}} onRetry={decisionConfidence.retryPrimary} retryDisabled={decisionConfidence.state.activeKey!==null} />
        <RankEstimatePanel title="Estimated rank if this transfer plays out" result={primaryRankEstimate} />
      </section>}
      {holdNote&&<p className="transfer-hold-note">{holdNote}</p>}
      <section className="quality-gate-summary"><header><span>RECOMMENDATION QUALITY GATE</span><h2>Raw upside must earn the right to be ranked.</h2></header><div><article><b>{actionableRows.length}</b><span>Actionable</span><small>Can become the primary recommendation</small></article><article><b>{watchlistRows.length}</b><span>Watchlist</span><small>Promising, but evidence or timing is incomplete</small></article><article><b>{blockedRows.length}</b><span>Blocked</span><small>Fails a hard plausibility or role-security floor</small></article></div></section>
      <TransferRouteList title="Actionable routes" eyebrow="PASSED EVERY GATE" rows={actionableRows.slice(0,10)} expanded={expanded} toggleExpand={toggleExpand} watchIds={watchIds} setWatch={setWatch} confidence={decisionConfidence}/>
      <TransferRouteList title="Watchlist routes" eyebrow="NOT READY TO RECOMMEND" rows={watchlistRows.slice(0,6)} expanded={expanded} toggleExpand={toggleExpand} watchIds={watchIds} setWatch={setWatch} confidence={decisionConfidence}/>
      <TransferRouteList title="Blocked by the quality gate" eyebrow="VISIBLE FOR AUDIT · NEVER RANKED #1" rows={blockedRows.slice(0,6)} expanded={expanded} toggleExpand={toggleExpand} watchIds={watchIds} setWatch={setWatch} confidence={decisionConfidence}/>
      <PriceIntel rows={rows}/>
      {process.env.NODE_ENV!=="production"&&<TransferDebugTable rows={rows.slice(0,10)}/>}
    </>:<Watchlist data={data} squad={squad} ids={watchIds} remove={setWatch} bank={bank}/>}
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
    <section className="route-planner-controls">
      <div><span>PLANNING HORIZON</span>{([3,5,8] as const).map(value=><button className={horizon===value?"active":""} onClick={()=>setHorizon(value)} key={value}>{value} GWs</button>)}</div>
      <div><span>MAX HIT IN ONE GW</span>{([0,4,8] as const).map(value=><button className={maxWeeklyHit===value?"active":""} onClick={()=>setMaxWeeklyHit(value)} key={value}>{value?`−${value}`:"No hits"}</button>)}</div>
      <p>The solver searches rolls, one-transfer and two-transfer combinations while preserving legal squads, exact selling values, bank and free transfers after every deadline.</p>
    </section>
    <section className="route-planner-hero">
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

function TransferRouteList({title,eyebrow,rows,expanded,toggleExpand,watchIds,setWatch,confidence}:{title:string;eyebrow:string;rows:Transfer[];expanded:Set<string>;toggleExpand:(key:string)=>void;watchIds:number[];setWatch:(id:number)=>void;confidence:ReturnType<typeof useTransferDecisionConfidence>}){
  if(!rows.length)return null;
  return <section className={`ranked-moves quality-${rows[0].qualityStatus}`}>
    <header><div><span>{eyebrow}</span><h2>{title}</h2></div><small>{rows[0].qualityStatus==="actionable"?"Ranked by quality-adjusted squad impact":"Kept separate from the primary recommendation"}</small></header>
    {rows.map((r,i)=>{const key=`${r.out.id}-${r.incoming.id}`;const isOpen=expanded.has(key);return <article key={key} className={`quality-${r.qualityStatus}`}>
      <i>{i+1}</i>
      <div><span>{r.out.name}</span><b>→ {r.incoming.name}</b><small>{r.incoming.teamShort} · £{r.incoming.price.toFixed(1)}m</small></div>
      <p><b>{r.gain1>=0?"+":""}{r.gain1.toFixed(1)}</b><small>GW</small></p>
      <p><b>{r.gain3>=0?"+":""}{r.gain3.toFixed(1)}</b><small>3 GW</small></p>
      <p><b>{r.gain5>=0?"+":""}{r.gain5.toFixed(1)}</b><small>5 GW squad</small></p>
      <em className={`quality-badge ${r.qualityStatus}`}>{r.qualityStatus} · {r.qualityScore}/100</em>
      <em className={r.risk.toLowerCase()}>{r.risk} risk</em>
      <button onClick={()=>toggleExpand(key)}>{isOpen?"Hide detail":"Show detail"}</button>
      <button onClick={()=>setWatch(r.incoming.id)}>{watchIds.includes(r.incoming.id)?"Watching ✓":"Watch"}</button>
      {isOpen&&<TransferBreakdown r={r} decision={confidence.state.results[confidence.keyFor(r)]} analysisActive={confidence.state.activeKey===confidence.keyFor(r)} analysisBusy={confidence.state.activeKey!==null} onAnalyze={()=>confidence.analyzeAlternative(r)}/>}
    </article>})}
  </section>;
}

function TransferDebugTable({rows}:{rows:Transfer[]}){return <section className="transfer-debug-table"><header><span>DEV ONLY · TRANSFER ENGINE DEBUG</span><h2>Every number, traceable to its components.</h2></header><div className="debug-table-scroll"><table><thead><tr><th>OUT</th><th>IN</th><th>OUT GW1</th><th>IN GW1</th><th>GW1 Δ</th><th>OUT 3GW</th><th>IN 3GW</th><th>3GW Δ</th><th>OUT 5GW</th><th>IN 5GW</th><th>5GW Δ</th><th>xMins OUT/IN</th><th>Start% OUT/IN</th><th>Risk OUT/IN</th><th>Fixture adj.</th><th>DC IN</th><th>Attacking IN</th><th>Projection evidence IN</th><th>Risk-adjusted objective Δ (not /100 rating)</th></tr></thead><tbody>{rows.map(r=><tr key={`${r.out.id}-${r.incoming.id}`}><td>{r.out.name}</td><td>{r.incoming.name}</td><td>{r.outGw1.toFixed(2)}</td><td>{r.inGw1.toFixed(2)}</td><td>{r.gain1.toFixed(2)}</td><td>{r.outGw3.toFixed(2)}</td><td>{r.inGw3.toFixed(2)}</td><td>{r.gain3.toFixed(2)}</td><td>{r.outGw5.toFixed(2)}</td><td>{r.inGw5.toFixed(2)}</td><td>{r.gain5.toFixed(2)}</td><td>{Math.round(r.expectedMinutesOut)}/{Math.round(r.expectedMinutesIn)}</td><td>{Math.round(r.startProbOut*100)}%/{Math.round(r.startProbIn*100)}%</td><td>{Math.round((1-r.startProbOut)*100)}%/{Math.round((1-r.startProbIn)*100)}%</td><td>{r.fixtureAdjustmentIn.toFixed(1)}</td><td>{r.dcIn.toFixed(2)}</td><td>{r.attackingIn.toFixed(2)}</td><td>{Math.round(r.confidenceIn*100)}%</td><td>{r.utilityChange===null?"—":r.utilityChange.toFixed(2)}</td></tr>)}</tbody></table></div></section>}

// FPL doesn't publish its price-change algorithm, and priceProjectionToday is FPL's own
// first-party end-of-day forecast (not a heuristic estimated from raw transfer counts here) --
// this threshold is only about noise reduction (most players sit under it every day), not an
// assertion about FPL's own undisclosed move-trigger threshold. Reused unchanged for every day of
// priceOutlook below -- no separate, invented threshold for the future days.
export const MEANINGFUL_PRICE_PRESSURE=15;

export type PriceTiming={direction:"rise"|"fall"|"stable";message:string};
export function priceTimingSignal(player:FplPlayer):PriceTiming{
  const pct=player.priceProjectionToday;
  if(pct>=MEANINGFUL_PRICE_PRESSURE)return{direction:"rise",message:`${Math.round(pct)}% rise pressure today (FPL's own projection) — buying before a rise saves money.`};
  if(pct<=-MEANINGFUL_PRICE_PRESSURE)return{direction:"fall",message:`${Math.round(Math.abs(pct))}% fall pressure today — no rush, a drop may make this cheaper soon.`};
  return{direction:"stable",message:"No meaningful price pressure today."};
}

export type PriceOutlookDaySignal={offsetDays:number;direction:"rise"|"fall"|"stable"};
// likelihood is read but never displayed as a number or in copy -- FPL doesn't document what its
// magnitude means beyond its sign matching projectedPercent (confirmed against every live-sampled
// player this session). The one honest, disclosed use here: a defensive guard. If a day's
// likelihood sign ever disagrees with its projectedPercent sign, that day classifies as "stable"
// rather than trusting a possibly-inconsistent read -- never observed live, but not something to
// assume either.
export function priceOutlookSignal(player:FplPlayer):readonly PriceOutlookDaySignal[]{
  return[...player.priceOutlook].sort((a,b)=>a.offsetDays-b.offsetDays).map(day=>{
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
    if(player.priceProjectionToday<=-MEANINGFUL_PRICE_PRESSURE){
      const pct=Math.abs(player.priceProjectionToday);
      return{player,offsetDays:0,pct,message:`carries ${Math.round(pct)}% fall pressure today — selling before the drop protects the standard £0.1m step.`};
    }
    const futureRisk=priceOutlookSignal(player).filter(d=>d.offsetDays>0&&d.direction==="fall").sort((a,b)=>a.offsetDays-b.offsetDays)[0];
    if(!futureRisk)return null;
    const rawDay=player.priceOutlook.find(d=>d.offsetDays===futureRisk.offsetDays);
    const pct=rawDay?Math.abs(rawDay.projectedPercent):0;
    return{player,offsetDays:futureRisk.offsetDays,pct,message:`is projected to fall in ${futureRisk.offsetDays} day${futureRisk.offsetDays>1?"s":""} — selling before then protects the standard £0.1m step.`};
  }).filter((x):x is PriceRiskAlert=>x!==null).sort((a,b)=>a.offsetDays-b.offsetDays||b.pct-a.pct);
}

const outlookDayLabel=(offsetDays:number)=>offsetDays===0?"Today":offsetDays===1?"Tomorrow":"Day after";
function PriceIntel({rows}:{rows:Transfer[]}){return <section className="price-intel"><header><span>PRICE-CHANGE INTELLIGENCE</span><h2>Market pressure, without chasing it.</h2></header>{rows.slice(0,4).map(r=>{const timing=priceTimingSignal(r.incoming);const outlook=priceOutlookSignal(r.incoming);return <article key={r.incoming.id}><b>{r.incoming.name}<small>£{r.incoming.price.toFixed(1)}m</small></b><span className={timing.direction}>{timing.direction==="rise"?"Rise pressure":timing.direction==="fall"?"Fall pressure":"Stable"}</span><p>{timing.message}</p><div className="price-outlook-strip">{outlook.map(day=><span key={day.offsetDays} className={day.direction}>{outlookDayLabel(day.offsetDays)}</span>)}</div></article>})}</section>}

// Surfaces squad players at real risk of a price drop before it happens -- nothing today watches
// your own squad for this, only transfer targets. Renders nothing when no squad player clears the
// same MEANINGFUL_PRICE_PRESSURE bar used for targets, which is most days.
function SquadValueAlert({squad}:{squad:FplPlayer[]}){
  const atRisk=priceProtectionAlerts(squad);
  if(!atRisk.length)return null;
  return <section className="price-value-alert">
    <div><span>SQUAD VALUE</span><h2>Protect your squad value before it drops.</h2></div>
    <div>
      {atRisk.slice(0,3).map(a=><p key={a.player.id}><b>{a.player.name}</b> {a.message}</p>)}
    </div>
  </section>;
}
// Pure so the branching is directly unit-testable (tests/watchlist.test.mts) without rendering.
// close: true when the ONLY blocking factor is a small gap on that same metric — this is the
// single source the priority badge is derived from, so the badge can never disagree with the message.
export type BuyTrigger={message:string;ready:boolean;close:boolean;budgetNote:string|null};
export function buyTriggerMessage(target:FplPlayer,natural:FplPlayer|undefined,targetMetrics:ProjectionMetrics,naturalMetrics:ProjectionMetrics|undefined,targetFiveGw:number,naturalFiveGw:number,bank:number):BuyTrigger{
  if(!natural)return{message:"No same-position squad player to swap out yet — build your squad first.",ready:false,close:false,budgetNote:null};
  const priceDiff=target.price-natural.price;
  const shortfall=Math.max(0,priceDiff-bank);
  const budgetNote=shortfall>.001?`This route is currently £${shortfall.toFixed(1)}m outside your budget. That affects execution, not the player's football trigger.`:null;
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

function Watchlist({data,squad,ids,remove,bank}:{data:FplData;squad:FplPlayer[];ids:number[];remove:(id:number)=>void;bank:number}){
  const events=futureEvents(data,5),first=events[0]?.id;
  const players=ids.map(id=>data.players.find(p=>p.id===id)).filter(Boolean) as FplPlayer[];
  const[add,setAdd]=useState(""),[search,setSearch]=useState(""),[position,setPosition]=useState("ALL");
  const[expanded,setExpanded]=useState<Set<number>>(new Set());
  const candidates=useMemo(()=>watchlistCandidatePool(data.players,squad.map(player=>player.id),ids,search,position),[data.players,squad,ids,search,position]);
  const addPlayer=()=>{const id=Number(add);if(id)remove(id);setAdd("")};
  const toggleExpand=(id:number)=>setExpanded(x=>{const next=new Set(x);next.has(id)?next.delete(id):next.add(id);return next});
  return <><section className="watchlist-add"><div><span>PERMANENT WATCHLIST</span><h2>Search every official FPL player.</h2><p>{candidates.length} eligible player{candidates.length===1?"":"s"} match your filters.</p></div><div className="watchlist-player-search"><input value={search} onChange={event=>{setSearch(event.target.value);setAdd("")}} placeholder="Search player or club…"/><select value={position} onChange={event=>{setPosition(event.target.value);setAdd("")}}><option value="ALL">All positions</option>{data.rules.positions.map(rule=><option value={rule.short} key={rule.id}>{rule.short}</option>)}</select><select value={add} onChange={e=>setAdd(e.target.value)}><option value="">Choose from {candidates.length} players…</option>{candidates.map(p=><option key={p.id} value={p.id}>{p.name} · {p.teamShort} · {p.positionShort} · £{p.price.toFixed(1)}m</option>)}</select></div><button onClick={addPlayer} disabled={!add}>Add to watchlist</button></section>
  <section className="watchlist-grid">{players.length?players.map(p=>{
    const m=projectionMetrics(p,first,data.fixtures,first);
    const samePosition=squad.filter(player=>player.positionId===p.positionId).map(player=>({player,fiveGw:events.reduce((sum,event)=>sum+playerProjection(player,event.id,data.fixtures,first),0),shortfall:Math.max(0,p.price-player.price-bank)}));
    const naturalRoute=[...samePosition].sort((a,b)=>(a.shortfall===0?0:1)-(b.shortfall===0?0:1)||a.shortfall-b.shortfall||a.fiveGw-b.fiveGw)[0];
    const natural=naturalRoute?.player,naturalMetrics=natural?projectionMetrics(natural,first,data.fixtures,first):undefined;
    const gw1=playerProjection(p,first,data.fixtures,first);
    const threeGw=events.slice(0,3).reduce((s,e)=>s+playerProjection(p,e.id,data.fixtures,first),0);
    const fiveGw=events.reduce((s,e)=>s+playerProjection(p,e.id,data.fixtures,first),0);
    const naturalFiveGw=naturalRoute?.fiveGw??0;
    const trigger=buyTriggerMessage(p,natural,m,naturalMetrics,fiveGw,naturalFiveGw,bank);
    const priority=trigger.ready?"BUY":trigger.close?"BUILDING":"WATCH";
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
      <small>Compared route: {natural?`${natural.name} → ${p.name}`:"No same-position route yet"}</small>
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

function Players({data,go,revision}:{data:FplData;go:(v:View)=>void;revision:number}){const events=futureEvents(data,5),first=events[0]?.id;const realMaxPrice=Math.max(...data.players.map(p=>p.price));const[query,setQuery]=useState("");const[pos,setPos]=useState("ALL");const[club,setClub]=useState("ALL");const[maxPrice,setMaxPrice]=useState(realMaxPrice);const[minMins,setMinMins]=useState(0);const[special,setSpecial]=useState("ALL");const[sort,setSort]=useState("xPts5");const[direction,setDirection]=useState<"desc"|"asc">("desc");const[compare,setCompare]=useState<number[]>([]);const[watch,setWatch]=useState<number[]>([]);useEffect(()=>setWatch(readIds("fpl-edge-watchlist")),[revision]);const toggleWatch=(id:number)=>{const next=watch.includes(id)?watch.filter(x=>x!==id):[...watch,id];setWatch(next);persist("fpl-edge-watchlist",JSON.stringify(next))};const rows=useMemo(()=>data.players.map(p=>{const metrics=first?projectionMetrics(p,first,data.fixtures,first):null;const xPts3=events.slice(0,3).reduce((s,e)=>s+playerProjection(p,e.id,data.fixtures,first),0),xPts5=events.reduce((s,e)=>s+playerProjection(p,e.id,data.fixtures,first),0);const xgi90=p.minutes?p.expectedGoalInvolvements/p.minutes*90:0;const fdr=events.length?events.reduce((s,e)=>{const games=data.fixtures.filter(x=>x.event===e.id&&(x.teamH===p.teamId||x.teamA===p.teamId));const difficulties=games.map(f=>f.teamH===p.teamId?f.teamHDifficulty:f.teamADifficulty);return s+(difficulties.length?difficulties.reduce((a,b)=>a+b,0)/difficulties.length:5)},0)/events.length:5;return{p,metrics,xPts3,xPts5,xgi90,fdr,value:xPts5/Math.max(3.5,p.price)}}).filter(r=>(pos==="ALL"||r.p.positionShort===pos)&&(club==="ALL"||String(r.p.teamId)===club)&&r.p.price<=maxPrice&&(r.metrics?.expectedMinutes||0)>=minMins&&(`${r.p.name} ${r.p.teamName}`).toLowerCase().includes(query.toLowerCase())&&(special==="ALL"||special==="DIFF"&&r.p.selectedBy<10||special==="PEN"&&r.metrics?.penaltyRole||special==="SET"&&r.metrics?.setPieceRole||special==="WATCH"&&watch.includes(r.p.id))).sort((a,b)=>{const val=(r:typeof a)=>sort==="xPts3"?r.xPts3:sort==="xPts5"?r.xPts5:sort==="xgi90"?r.xgi90:sort==="fdr"?-r.fdr:sort==="value"?r.value:sort==="expectedMinutes"?(r.metrics?.expectedMinutes||0):sort==="start"?(r.metrics?.startProbability||0):Number(r.p[sort as keyof FplPlayer])||0;return direction==="desc"?val(b)-val(a):val(a)-val(b)}),[data,events.map(e=>e.id).join(","),first,query,pos,club,maxPrice,minMins,special,sort,direction,watch.join(",")]);return <div className="coach-page"><section className="research-intro"><div><span>LIVE 2026/27 RESEARCH</span><h2>Every decision variable, one player database.</h2><p>{data.seasonStatsThrough?`Current-season totals through GW${data.seasonStatsThrough}.`:`No 2026/27 gameweek has finished, so new-season totals correctly start at zero.`} Prices and availability are live.</p></div><strong>{rows.length}<small>matching players</small></strong></section><section className="research-filters"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search player or club…"/><select value={pos} onChange={e=>setPos(e.target.value)}><option value="ALL">All positions</option>{data.rules.positions.map(p=><option key={p.id}>{p.short}</option>)}</select><select value={club} onChange={e=>setClub(e.target.value)}><option value="ALL">All clubs</option>{data.teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select><select value={special} onChange={e=>setSpecial(e.target.value)}><option value="ALL">All roles</option><option value="DIFF">Differential under 10%</option><option value="PEN">Penalties</option><option value="SET">Set pieces</option><option value="WATCH">Watchlist</option></select><label>Max £{maxPrice.toFixed(1)}m<input type="range" min="4" max={realMaxPrice} step=".5" value={maxPrice} onChange={e=>setMaxPrice(Number(e.target.value))}/></label><label>Min xMins {minMins}<input type="range" min="0" max="90" step="10" value={minMins} onChange={e=>setMinMins(Number(e.target.value))}/></label><select value={sort} onChange={e=>setSort(e.target.value)}>{[["xPts5","5-GW xPts"],["xPts3","3-GW xPts"],["price","Price"],["selectedBy","Ownership"],["totalPoints","Total points"],["pointsPerGame","Points per match"],["expectedGoals","xG"],["expectedAssists","xA"],["xgi90","xGI/90"],["goals","Goals"],["assists","Assists"],["cleanSheets","Clean sheets"],["defensiveContribution","Defensive contribution"],["expectedMinutes","Expected minutes"],["start","Start probability"],["fdr","Fixture rating"],["value","Value"]].map(x=><option value={x[0]} key={x[0]}>Sort: {x[1]}</option>)}</select><button onClick={()=>setDirection(x=>x==="desc"?"asc":"desc")}>{direction==="desc"?"High → low":"Low → high"}</button></section>{compare.length>=2&&<Compare data={data} ids={compare} close={()=>setCompare([])}/>}<section className="research-table"><header>{["Player","£","Own","Pts","PPM","xG","xA","xGI/90","G","A","CS","DC","xMins","Start","Next","3GW","5GW","FDR","Value","Actions"].map(x=><span key={x}>{x}</span>)}</header>{rows.slice(0,120).map(r=><article key={r.p.id}><b>{r.p.name}<small>{r.p.teamShort} · {r.p.positionShort}</small></b><span>{r.p.price.toFixed(1)}</span><span>{r.p.selectedBy.toFixed(1)}%</span><span>{r.p.totalPoints}</span><span>{r.p.pointsPerGame.toFixed(1)}</span><span>{r.p.expectedGoals.toFixed(2)}</span><span>{r.p.expectedAssists.toFixed(2)}</span><span>{r.xgi90.toFixed(2)}</span><span>{r.p.goals}</span><span>{r.p.assists}</span><span>{r.p.cleanSheets}</span><span>{r.p.defensiveContribution}</span><span>{Math.round(r.metrics?.expectedMinutes||0)}</span><span>{Math.round((r.metrics?.startProbability||0)*100)}%</span><span>{first?opponent(r.p,first,data):"—"}</span><strong>{r.xPts3.toFixed(1)}</strong><strong>{r.xPts5.toFixed(1)}</strong><span>{r.fdr.toFixed(1)}</span><span>{r.value.toFixed(2)}</span><div><button className={compare.includes(r.p.id)?"active":""} disabled={!compare.includes(r.p.id)&&compare.length>=4} onClick={()=>setCompare(x=>x.includes(r.p.id)?x.filter(id=>id!==r.p.id):[...x,r.p.id])}>Compare</button><button className={watch.includes(r.p.id)?"active":""} onClick={()=>toggleWatch(r.p.id)}>Watch</button><button onClick={()=>go("transfers")}>Transfer</button></div></article>)}</section></div>}
// Feature #9 v1: global template ownership + raw differentials, both off already-fetched data
// (selectedBy is real and first-party; xPts5 reuses the same playerProjection every other page
// already uses). Deliberately does NOT attempt effective ownership (captaincy-adjusted) -- FPL
// blocks per-manager picks (and even its own single-winner most_captained field) for any
// gameweek until AFTER that gameweek's deadline has passed, confirmed live against the real API,
// so a live captaincy-adjusted number is a genuine timing wall, not a cost tradeoff, the same
// category as Feature #5's declined formation-shape claim. A retrospective (already-locked-
// gameweek) version is real and buildable but logged as its own separate, smaller, deferred item
// -- not folded in here.
function OwnershipRadar({data}:{data:FplData}){
  const events=futureEvents(data,5);
  const eventIds=events.map(e=>e.id);
  const template=useMemo(()=>templateByPosition(data.players,data.rules.positions),[data]);
  const differentials=useMemo(()=>rawDifferentialsByPosition(data.players,data.rules.positions,data.fixtures,eventIds),[data,eventIds.join(",")]);
  return <div className="coach-page">
    <section className="research-intro"><div><span>OWNERSHIP RADAR</span><h2>Who the population owns, and who they're missing.</h2><p>Ownership shown is raw selection % from the live FPL feed, not effective ownership — FPL doesn't publish real per-player captaincy rates for a gameweek until after its own deadline has passed, so a live captaincy-adjusted number can't be sourced honestly here. Prices and availability are live.</p></div></section>
    <section className="ownership-radar-group"><header><span>TEMPLATE OWNERSHIP</span><h3>The most-owned players, by position.</h3><p>A live ownership snapshot, not a squad recommendation — budget and the 3-per-club limit aren't checked here, so these players aren't guaranteed to fit together into one legal squad.</p></header>
      <div className="ownership-position-grid">{template.map(group=><article key={group.position.id}><h4>{group.position.name}</h4>{group.players.map(p=><p key={p.id}><b>{p.name}</b><small>{p.teamShort}</small><span>{p.selectedBy.toFixed(1)}%</span></p>)}{!group.players.length&&<small className="ownership-empty">No players fetched for this position.</small>}</article>)}</div>
    </section>
    <section className="ownership-radar-group"><header><span>RAW DIFFERENTIALS</span><h3>Low-owned players with real projected upside, by position.</h3><p>Ranked by each player's real standing on two axes together — projected points and ownership — not a fixed ownership cutoff, so a moderately-owned player with a genuinely strong projection can rank above a barely-owned player with a weak one.</p></header>
      <div className="ownership-position-grid">{differentials.map(group=><article key={group.position.id}><h4>{group.position.name}</h4>{group.players.map(({player,xPts5})=><p key={player.id}><b>{player.name}</b><small>{player.teamShort}</small><span>{player.selectedBy.toFixed(1)}% owned</span><strong>{xPts5.toFixed(1)} xPts</strong></p>)}{!group.players.length&&<small className="ownership-empty">No players fetched for this position.</small>}</article>)}</div>
    </section>
  </div>;
}
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
function Coach({data,go,revision,onTeamChange}:{data:FplData;go:(v:View)=>void;revision:number;onTeamChange:()=>void}){
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
  const bank=manager?.bank??a?.bank??0;
  const freeTransfers=readFreeTransfers();
  const moves=bestTransfers(data,squad,bank,freeTransfers,12,sellingPricesFor(manager));
  const transferCandidates=useMemo(()=>{
    const seen=new Set<number>();const list:{id:number;name:string}[]=[];
    for(const move of moves){if(seen.has(move.incoming.id))continue;seen.add(move.incoming.id);list.push({id:move.incoming.id,name:move.incoming.name})}
    return list;
  },[moves]);
  const buildOptimizer=useMemo(()=>intent==="build"?createOptimizer(data,"Balanced 5 GWs","Balanced","Maximum xPts"):null,[data,intent]);
  const built=useMemo(()=>buildOptimizer?buildOptimizer.optimize():null,[buildOptimizer]);

  if(!a)return <div className="coach-page"><ConnectTeam data={data} onConnected={()=>onTeamChange()}/><section className="empty-command"><span>MANUAL OPTION</span><h2>Already know your draft?</h2><p>Build and save it manually first -- most of the coach's questions need a complete squad.</p><button onClick={()=>go("draft")}>Build a squad →</button></section>{intent==="differentials"&&<CoachAnswerCard label="Best differentials">{differentialGroups.map(g=><p key={g.position.id}>{narrateDifferentials(g.position.name,g.players)}</p>)}</CoachAnswerCard>}</div>;

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
    <section className="research-intro"><div><span>ASK YOUR COACH</span><h2>Pick a question. Every answer is a real number from this app's own engines.</h2><p>No free text in v1, no LLM anywhere on this page -- pick a question and (if it needs one) a real player or chip from your own data. Can't answer: effective ownership / real captaincy rates (FPL doesn't publish them until after a gameweek's own deadline has passed), price moves beyond FPL's real 3-day window, or predicting an actual match result (this app projects player points, never a match winner).</p></div></section>
    <section className="coach-intent-picker">{COACH_INTENTS.map(item=><button key={item.id} className={intent===item.id?"active":""} onClick={()=>setIntent(item.id)}>{item.label}</button>)}</section>

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

function Compare({data,ids,close}:{data:FplData;ids:number[];close:()=>void}){const players=ids.map(id=>data.players.find(p=>p.id===id)).filter(Boolean) as FplPlayer[],events=futureEvents(data,5),first=events[0]?.id;const best=[...players].sort((a,b)=>events.reduce((s,e)=>s+playerProjection(b,e.id,data.fixtures,first),0)-events.reduce((s,e)=>s+playerProjection(a,e.id,data.fixtures,first),0))[0];const secure=[...players].sort((a,b)=>projectionMetrics(b,first,data.fixtures,first).startProbability-projectionMetrics(a,first,data.fixtures,first).startProbability)[0];return <section className="compare-drawer"><header><div><span>PLAYER COMPARISON</span><h2>{players.map(p=>p.name).join(" vs ")}</h2></div><button onClick={close}>Close</button></header><div>{players.map(p=>{const m=projectionMetrics(p,first,data.fixtures,first),xgi90=p.minutes?p.expectedGoalInvolvements/p.minutes*90:0;return <article key={p.id}><h3>{p.name}<small>{p.teamShort} · £{p.price.toFixed(1)}m</small></h3><p><span>Next 5</span><b>{events.map(e=>opponent(p,e.id,data)).join(" · ")}</b></p><p><span>5-GW xPts</span><b>{events.reduce((s,e)=>s+playerProjection(p,e.id,data.fixtures,first),0).toFixed(1)}</b></p><p><span>xMins / start</span><b>{Math.round(m.expectedMinutes)} / {Math.round(m.startProbability*100)}%</b></p><p><span>xG90 / xA90</span><b>{p.minutes?(p.expectedGoals/p.minutes*90).toFixed(2):"—"} / {p.minutes?(p.expectedAssists/p.minutes*90).toFixed(2):"—"}</b></p><p><span>xGI/90</span><b>{xgi90.toFixed(2)}</b></p><p><span>Roles</span><b>{m.penaltyRole?"Pens · ":""}{m.setPieceRole?"Set pieces":"No confirmed role"}</b></p><p><span>Ownership / rotation</span><b>{p.selectedBy.toFixed(1)}% / {Math.round(m.rotationRisk*100)}%</b></p></article>})}</div><footer><span>MODEL VERDICT</span><p><b>{best.name}</b> has the highest five-gameweek projection. <b>{secure.name}</b> has the safest minutes profile. Choose upside only if its minutes uncertainty fits your risk tolerance.</p></footer></section>}

function TeamQualityFixtures({data}:{data:FplData}){
  const[horizon,setHorizon]=useState(8);
  const[sort,setSort]=useState<"attack"|"defence">("attack");
  const events=futureEvents(data,horizon);
  const rows=[...computeClubFixtureRows(data,horizon)].sort((a,b)=>sort==="attack"?a.attack-b.attack:a.defence-b.defence);
  const attack=[...rows].sort((a,b)=>a.attack-b.attack).slice(0,3),defence=[...rows].sort((a,b)=>a.defence-b.defence).slice(0,3),avoid=[...rows].sort((a,b)=>b.attack-a.attack).slice(0,3),swings=[...rows].sort((a,b)=>b.swing-a.swing).slice(0,3);
  return <div className="team-quality-fixtures"><section className="fixture-summary"><div><span>QUALITY-AWARE FIXTURE TICKER</span><h2>Opponent difficulty and each club's own quality now move together.</h2><p>Lower scores are better. Attack rankings compare a club's attack with the opponent's defence; clean-sheet rankings compare its defence with the opponent's attack.</p></div><div>{[3,5,8].map(value=><button className={horizon===value?"active":""} onClick={()=>setHorizon(value)} key={value}>{value} GW</button>)}</div></section><div className="schedule-ranks"><Rank title="Best attacking schedules" rows={attack} keyName="attack"/><Rank title="Best defensive schedules" rows={defence} keyName="defence"/><Rank title="Fixture swings" rows={swings} keyName="swing"/><Rank title="Teams to avoid" rows={avoid} keyName="attack" bad/></div><section className="fixture-ticker"><header><div><span>TEAM</span><button className={sort==="attack"?"active":""} onClick={()=>setSort("attack")}>ATTACK</button><button className={sort==="defence"?"active":""} onClick={()=>setSort("defence")}>DEFENCE</button></div>{events.map(event=><span key={event.id}>{event.name.replace("Gameweek ","GW")}</span>)}</header>{rows.map(row=><FixtureTickerRow row={row} events={events} sort={sort} key={row.team.id}/>)}</section></div>;
}
function FixtureTickerRow({row,events,sort}:{row:ClubFixtureRow;events:FplEvent[];sort:"attack"|"defence"}){
  return <article><div><b>{row.team.short}<small>{row.team.name}</small></b><span>{row.attack.toFixed(2)} ATK</span><span>{row.defence.toFixed(2)} DEF</span></div>{row.cells.map((cell,index)=>{const value=sort==="attack"?cell.attack:cell.defence,multiplier=sort==="attack"?cell.attackMultiplier:cell.defenceMultiplier;return <span className={`fdr-${Math.round(value)}`} key={events[index].id}><b>{cell.label}</b><small>{cell.label==="BLANK"?"—":`${value.toFixed(1)} · ×${multiplier.toFixed(2)}`}</small></span>})}</article>;
}
// My Squad's fixtures view -- the same real computeClubFixtureRows every club in the full Fixtures
// page uses, filtered to the clubs the squad's players actually belong to. Genuinely per-club, not
// per-player -- every player at a club shares that club's real fixture difficulty (see
// fixture-difficulty.ts's own header comment) -- so this never recomputes anything per player, it
// only narrows which of the 20 already-computed real rows are shown. Precondition is deliberately
// "any saved squad players at all" (not a complete 15-man squad, unlike analysis()'s gate
// elsewhere) -- a partial squad still has real owned clubs worth showing here.
function MyFixtures({data,go,revision,onTeamChange}:{data:FplData;go:(v:View)=>void;revision:number;onTeamChange:()=>void}){
  const squad=useMemo(()=>savedSquad(data),[data,revision]);
  const[horizon,setHorizon]=useState(8);
  const[sort,setSort]=useState<"attack"|"defence">("attack");
  const events=futureEvents(data,horizon);
  if(!squad.length)return <div className="coach-page"><ConnectTeam data={data} onConnected={()=>onTeamChange()}/><section className="empty-command"><span>MANUAL OPTION</span><h2>Already know your draft?</h2><p>Build and save it manually first -- this view shows real fixture difficulty for the clubs your own squad's players belong to.</p><button onClick={()=>go("draft")}>Build a squad →</button></section></div>;
  const ownedTeamIds=new Set(squad.map(p=>p.teamId));
  const rows=[...computeClubFixtureRows(data,horizon)].filter(row=>ownedTeamIds.has(row.team.id)).sort((a,b)=>sort==="attack"?a.attack-b.attack:a.defence-b.defence);
  return <div className="team-quality-fixtures"><section className="fixture-summary"><div><span>MY SQUAD'S FIXTURES</span><h2>Real fixture difficulty for the clubs you actually own players at.</h2><p>The same club-level difficulty model as the full Fixtures page, narrowed to your own squad -- every player at a club shares that club's real fixture list, so this is per club, not per player.</p></div><div>{[3,5,8].map(value=><button className={horizon===value?"active":""} onClick={()=>setHorizon(value)} key={value}>{value} GW</button>)}</div></section><section className="fixture-ticker"><header><div><span>TEAM</span><button className={sort==="attack"?"active":""} onClick={()=>setSort("attack")}>ATTACK</button><button className={sort==="defence"?"active":""} onClick={()=>setSort("defence")}>DEFENCE</button></div>{events.map(event=><span key={event.id}>{event.name.replace("Gameweek ","GW")}</span>)}</header>{rows.map(row=><FixtureTickerRow row={row} events={events} sort={sort} key={row.team.id}/>)}</section></div>;
}

function Rank({title,rows,keyName,bad}:{title:string;rows:any[];keyName:string;bad?:boolean}){return <article className={bad?"avoid":""}><span>{title.toUpperCase()}</span>{rows.map((r,i)=><p key={r.team.id}><i>{i+1}</i><b>{r.team.name}</b><strong>{keyName==="swing"?`BUY LATER +${r.swing.toFixed(1)}`:Number(r[keyName]).toFixed(2)}</strong></p>)}</article>}

const lineupStatusTag=(p:FplPlayer)=>p.status==="s"?"SUSPENSION":p.status==="i"||p.status==="d"?"INJURY":"FLAGGED";
const lineupCompetitionLine=(candidate:LineupCandidate)=>{
  if(!candidate.closestCompetitorName)return"No listed competition at this club in this position.";
  const points=Math.round(Math.abs(candidate.competitionGap)*100);
  if(candidate.competitionGap>0)return`Leads ${candidate.closestCompetitorName} by ${points} points.`;
  if(candidate.competitionGap<0)return`Trails ${candidate.closestCompetitorName} by ${points} points.`;
  return`Tied with ${candidate.closestCompetitorName}.`;
};
// Fixtures is already this app's per-club research page (TeamQualityFixtures above is itself a
// 20-team grid) -- lineup intelligence is another per-club concern and belongs here rather than a
// new top-level nav item, which the mobile nav would just bury under "More" anyway.
function LineupIntelligencePanel({data}:{data:FplData}){
  const[expandedTeamId,setExpandedTeamId]=useState<number|null>(null);
  const planningEvent=futureEvents(data,1)[0]?.id;
  if(!planningEvent)return null;
  return <section className="lineup-intelligence">
    <header><span>LINEUP INTELLIGENCE</span><h2>Most likely XI, ranked by real modeled start probability.</h2><p>Ranked by this app's own modeled start probability, not an official or confirmed lineup. Clubs don't confirm their starting XI until close to kickoff.</p></header>
    <div className="lineup-clubs">{data.teams.map(team=>{
      const open=expandedTeamId===team.id;
      const candidates=open?clubLineupCandidates(data.players,team.id,planningEvent,data.fixtures,planningEvent):null;
      return <article key={team.id} className={`lineup-club${open?" open":""}`}>
        <button className="lineup-club-head" onClick={()=>setExpandedTeamId(open?null:team.id)}><b>{team.short}</b><span>{team.name}</span><i>{open?"−":"+"}</i></button>
        {open&&candidates&&<div className="lineup-club-body">
          <p className="lineup-position-note">Grouped by FPL's own goalkeeper/defender/midfielder/forward categories -- this is not a stated tactical formation.</p>
          {LINEUP_POSITIONS.map(position=><div className="lineup-position-group" key={position}>
            <span>{position}</span>
            {candidates[position].length?candidates[position].map(candidate=><article key={candidate.player.id} className="lineup-candidate">
              <div><b>{candidate.player.name}</b><small>{Math.round(candidate.startProbability*100)}% start · {Math.round(candidate.expectedMinutes)} mins</small></div>
              <div className="lineup-candidate-tags">{candidate.penaltyRole&&<em>PENALTIES</em>}{candidate.setPieceRole&&<em>SET PIECES</em>}{candidate.player.status!=="a"&&<em className="flag">{lineupStatusTag(candidate.player)}</em>}</div>
              <p className="lineup-candidate-competition">{lineupCompetitionLine(candidate)}</p>
              {candidate.player.status!=="a"&&<p className="lineup-candidate-news">{candidate.player.news||"Official FPL flag has no published detail."}</p>}
            </article>):<p className="lineup-position-empty">No listed players.</p>}
          </div>)}
        </div>}
      </article>;
    })}</div>
    <p className="lineup-disclosure-footer">Official FPL status only. No invented quotes, predicted lineups or unsupported rumours.</p>
  </section>;
}

// Compare/manage only -- no in-board transfer editor. Editing a plan's actual squad happens in
// Draft Lab, which already has a complete transfer-picker UI; duplicating that here was the
// higher-risk option in the design checkpoint. "Edit in Draft Lab" writes LOAD_PLAN_SIGNAL_KEY and
// navigates; LiveDraftBuilder.tsx's own load() consumes and clears it on mount.
function StrategyBoard({data,go,revision}:{data:FplData;go:(v:View)=>void;revision:number}){
  const[plans,setPlans]=useState<readonly PersistedPlan[]>([]);
  const[horizonMode,setHorizonMode]=useState<HorizonMode>("Balanced 5 GWs");
  const[riskMode,setRiskMode]=useState<RiskMode>("Balanced");
  const[philosophy,setPhilosophy]=useState<SquadPhilosophy>("Maximum xPts");
  useEffect(()=>setPlans(readPlans()),[revision]);
  const squad=useMemo(()=>savedSquad(data),[data,revision]);
  const complete=isCompleteSquad(squad,data);
  // One optimizer instance, shared across every row -- the whole point of the Board is comparing
  // plans under one consistent evaluator, not whatever settings happened to be active when each
  // plan was individually saved (see PlanRow's settingsStale disclosure for that).
  const optimizer=useMemo(()=>createOptimizer(data,horizonMode,riskMode,philosophy),[data,horizonMode,riskMode,philosophy]);
  const addPlan=()=>{
    if(plans.length>=MAX_PLANS||!complete)return;
    const name=window.prompt("Name this plan:","")?.trim();
    if(!name)return;
    const plan=createPlan(name,squad,{horizonMode,riskMode,philosophy});
    const next=[...plans,plan];
    writePlans(next);setPlans(next);
  };
  const renamePlan=(id:string)=>{
    const target=plans.find(p=>p.id===id);if(!target)return;
    const name=window.prompt("Rename this plan:",target.name)?.trim();
    if(!name)return;
    const next=plans.map(p=>p.id===id?{...p,name}:p);
    writePlans(next);setPlans(next);
  };
  const deletePlan=(id:string)=>{
    const target=plans.find(p=>p.id===id);if(!target)return;
    if(!confirm(`Delete plan "${target.name}"? This can't be undone.`))return;
    const next=plans.filter(p=>p.id!==id);
    writePlans(next);setPlans(next);
    // Symmetric with ChipPortfolioPanel's own unplan -> clearPlanChipTag cascade: deleting a
    // chip-tagged plan must not leave chip-portfolio.ts's PlannedChip store pointing at a rebuild
    // that no longer exists.
    if(target.plannedChip)writePlannedChips(removePlannedChip(readPlannedChips(),target.plannedChip.chip));
  };
  const editInDraftLab=(id:string)=>{localStorage.setItem(LOAD_PLAN_SIGNAL_KEY,id);go("draft")};
  return <div className="coach-page">
    <section className="board-intro"><div><span>MULTI-PLAN STRATEGY BOARD</span><h2>Compare up to {MAX_PLANS} saved transfer plans side by side.</h2><p>Every plan below is scored live under the Time Horizon / Risk Profile / Squad Philosophy settings selected here — a genuine apples-to-apples comparison, not whatever settings happened to be active in Draft Lab when each plan was saved.</p></div><button onClick={addPlan} disabled={plans.length>=MAX_PLANS||!complete}>{plans.length>=MAX_PLANS?`${MAX_PLANS} plans saved (maximum)`:!complete?"Complete your squad first":"New plan"}</button></section>
    <section className="optimizer-controls"><div><span>TIME HORIZON</span>{(["GW1 Attack","Next 3 GWs","Balanced 5 GWs","Long-term 8 GWs"] as HorizonMode[]).map(mode=><button className={horizonMode===mode?"active":""} onClick={()=>setHorizonMode(mode)} key={mode}>{mode}</button>)}</div><div><span>RISK PROFILE</span>{(["Safe","Balanced","Aggressive"] as RiskMode[]).map(mode=><button className={riskMode===mode?"active":""} onClick={()=>setRiskMode(mode)} key={mode}>{mode}</button>)}</div><div><span>SQUAD PHILOSOPHY</span>{(["Maximum xPts","Flexible","Strong Bench","Premium Heavy","Differential"] as SquadPhilosophy[]).map(mode=><button className={philosophy===mode?"active":""} onClick={()=>setPhilosophy(mode)} key={mode}>{mode}</button>)}</div></section>
    {!plans.length?<div className="empty-watch"><b>No saved plans yet.</b><p>Build a scenario in Draft Lab, make at least one sandbox transfer, then press "Save as plan" to bring it here.</p></div>:<section className="board-plans">{plans.map(plan=><PlanRow key={plan.id} plan={plan} data={data} optimizer={optimizer} horizonMode={horizonMode} riskMode={riskMode} philosophy={philosophy} onRename={()=>renamePlan(plan.id)} onDelete={()=>deletePlan(plan.id)} onEdit={()=>editInDraftLab(plan.id)}/>)}</section>}
  </div>;
}
function PlanRow({plan,data,optimizer,horizonMode,riskMode,philosophy,onRename,onDelete,onEdit}:{plan:PersistedPlan;data:FplData;optimizer:ReturnType<typeof createOptimizer>;horizonMode:HorizonMode;riskMode:RiskMode;philosophy:SquadPhilosophy;onRename:()=>void;onDelete:()=>void;onEdit:()=>void}){
  // Recomputed whenever plan or the live player pool changes -- never cached across a data refresh,
  // so a plan can never silently show stale prices/projections from an earlier fetch.
  const hydration=useMemo(()=>hydratePlanSandbox(plan,data.players),[plan,data.players]);
  // "5-GW POINTS" must come from a real fixed-5-GW evaluator, not whatever the Board's own
  // horizonMode selector currently is -- optimizer.evaluate alone would silently mislabel a 3- or
  // 8-week total as "5-GW" whenever horizonMode isn't "Balanced 5 GWs". Same shared helper Draft Lab
  // uses, not a second hand-rolled "Balanced 5 GWs" optimizer.
  const fiveWeekEvaluate=useMemo(()=>createFiveWeekEvaluator(data,riskMode,philosophy),[data,riskMode,philosophy]);
  const comparison=hydration.status!=="failed"?evaluateSandbox(hydration.sandbox,optimizer.evaluate,fiveWeekEvaluate??optimizer.evaluate):null;
  const settingsStale=[
    plan.savedUnder.horizonMode!==horizonMode?`Time Horizon (saved with ${plan.savedUnder.horizonMode}, now ${horizonMode})`:null,
    plan.savedUnder.riskMode!==riskMode?`Risk Profile (saved with ${plan.savedUnder.riskMode}, now ${riskMode})`:null,
    plan.savedUnder.philosophy!==philosophy?`Squad Philosophy (saved with ${plan.savedUnder.philosophy}, now ${philosophy})`:null,
  ].filter((x):x is string=>x!==null);
  return <article className="board-plan-row">
    <header><div><b>{plan.name}</b>{plan.plannedChip&&<em className="board-plan-chip-tag">🃏 {plan.plannedChip.chip.toUpperCase()} — GW{plan.plannedChip.event}</em>}<small>Saved {new Date(plan.createdAt).toLocaleDateString()}</small></div><div><button onClick={onEdit}>Edit in Draft Lab</button><button onClick={onRename}>Rename</button><button onClick={onDelete} className="danger">Delete</button></div></header>
    {(hydration.status==="failed"||hydration.status==="partial")&&<p className="integrity-warning optimizer-consistency-warning">⚠ {hydration.reason}</p>}
    {settingsStale.length>0&&<p className="integrity-warning optimizer-consistency-warning">⚠ This plan was saved under different settings: {settingsStale.join("; ")}.</p>}
    {hydration.status!=="failed"&&!comparison&&<p className="board-plan-empty">No changes yet — make a transfer for this plan in Draft Lab to see a comparison.</p>}
    {comparison&&<div className="board-plan-stats">
      <article><span>RATING</span><b>{comparison.cumulative.rating.after}<small className={comparison.cumulative.rating.delta>=0?"positive":"negative"}>{comparison.cumulative.rating.delta>=0?"+":""}{comparison.cumulative.rating.delta}</small></b></article>
      <article><span>5-GW POINTS</span><b>{comparison.cumulative.expectedPoints.nextFive.after.toFixed(1)}<small className={comparison.cumulative.expectedPoints.nextFive.delta>=0?"positive":"negative"}>{comparison.cumulative.expectedPoints.nextFive.delta>=0?"+":""}{comparison.cumulative.expectedPoints.nextFive.delta.toFixed(1)}</small></b></article>
      <article><span>SQUAD CHANGES</span><b>{comparison.requiredTransferCount}</b></article>
    </div>}
  </article>;
}
function News({data,go,revision}:{data:FplData;go:(v:View)=>void;revision:number}){const squad=useMemo(()=>savedSquad(data),[data,revision]);const watch=readIds("fpl-edge-watchlist");const owned=new Set(squad.map(p=>p.id)),watched=new Set(watch);const[filter,setFilter]=useState("PRIORITY");const items=data.players.filter(p=>p.news||p.status!=="a").map(p=>({p,priority:owned.has(p.id)?0:watched.has(p.id)?1:p.selectedBy>=10?2:3})).filter(x=>filter==="ALL"||filter==="PRIORITY"&&x.priority<3||filter==="SQUAD"&&owned.has(x.p.id)||filter==="WATCHLIST"&&watched.has(x.p.id)).sort((a,b)=>a.priority-b.priority||(b.p.newsAdded?Date.parse(b.p.newsAdded):0)-(a.p.newsAdded?Date.parse(a.p.newsAdded):0));const tag=(p:FplPlayer)=>p.status==="s"?"SUSPENSION":p.status==="i"||p.status==="d"?"INJURY":p.news.toLowerCase().includes("transfer")?"TRANSFER":p.news.toLowerCase().includes("international")?"LINEUP":"PRESS CONFERENCE";const impact=(p:FplPlayer)=>{if(owned.has(p.id))return p.status!=="a"?`Your player is officially flagged. Review ${p.name}'s start probability and bench cover before transferring.`:`Your squad is affected. Recheck the player panel before lock-in.`;if(watched.has(p.id))return`Watchlist target: ${p.status!=="a"?"do not buy until availability improves":"keep monitoring role and expected minutes before buying"}.`;return`High-ownership FPL relevance. This update does not automatically create a transfer recommendation.`};return <div className="coach-page"><section className="news-lead"><div><span>PERSONALISED NEWS</span><h2>{items.filter(x=>x.priority<2).length} updates affect your squad or watchlist.</h2><p>Official FPL status only. No invented quotes, predicted lineups or unsupported rumours.</p></div><button onClick={()=>go("deadline")}>See deadline impact →</button></section><div className="news-tabs">{["PRIORITY","SQUAD","WATCHLIST","ALL"].map(x=><button className={filter===x?"active":""} onClick={()=>setFilter(x)} key={x}>{x}</button>)}</div><section className="impact-news">{items.length?items.map(({p,priority})=><article key={p.id}><header><div><span className="news-tag">{tag(p)}</span><span className={`certainty ${p.status!=="a"?"confirmed":priority<2?"likely":"uncertain"}`}>{p.status!=="a"?"CONFIRMED":priority<2?"LIKELY":"UNCERTAIN"}</span></div><time>{p.newsAdded?new Date(p.newsAdded).toLocaleString():"No official timestamp"}</time></header><h3>{p.name} · {p.teamShort}</h3><p>{p.news||"Official FPL flag has no published detail."}</p><aside><span>FPL IMPACT</span><b>{impact(p)}</b></aside><footer><span>{owned.has(p.id)?"MY SQUAD":watched.has(p.id)?"WATCHLIST":`${p.selectedBy.toFixed(1)}% OWNED`}</span><span>{p.transfersOut.toLocaleString()} transfers out</span></footer></article>):<div className="empty-watch"><b>No official updates match this filter.</b><p>That is good news. We will not manufacture a story to fill the page.</p></div>}</section></div>}

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
type ReceiptTransferInput=Pick<Transfer,"gain1"|"gain3"|"gain5"|"individualGain1"|"individualGain3"|"individualGain5"|"rankScore"|"netDifference"|"hitCost"|"startProbIn"|"confidenceIn"|"risk"|"reviewRequired"|"anomalies">&Partial<Pick<Transfer,"qualityStatus"|"qualityScore"|"qualityReasons">>&{out:Pick<FplPlayer,"id"|"name">;incoming:Pick<FplPlayer,"id"|"name">};
const receiptNumber=(value:number,places=3)=>Number(value.toFixed(places));

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

export type LockRecord={event:number;lockedAt:string;dataUpdatedAt:string;predicted:number;squadIds:number[];xiIds:number[];benchIds?:number[];captainId:number;viceId:number;receipt?:ProjectionReceipt};
export type LockStatus="none"|"matches"|"mismatch";
// Pure so the mismatch detection is directly unit-testable (tests/finalcheck.test.mts) without
// rendering. Order-independent on xiIds since bestXi's internal ordering isn't semantically meaningful.
export function reconcileLock(existingLock:LockRecord|undefined,current:{xiIds:number[];benchIds?:number[];captainId:number;viceId:number}):LockStatus{
  if(!existingLock)return"none";
  const sameIds=(a:number[],b:number[])=>a.length===b.length&&[...a].sort((x,y)=>x-y).every((v,i)=>v===[...b].sort((x,y)=>x-y)[i]);
  const benchMatches=!existingLock.benchIds||!current.benchIds||existingLock.benchIds.length===current.benchIds.length&&existingLock.benchIds.every((id,index)=>id===current.benchIds![index]);
  return sameIds(existingLock.xiIds,current.xiIds)&&benchMatches&&existingLock.captainId===current.captainId&&existingLock.viceId===current.viceId?"matches":"mismatch";
}

export type ProjectionTransferEvaluation={
  rank:number;outId:number;outName:string;incomingId:number;incomingName:string;completedEvents:number;horizonEvents:number;
  projectedPlayerSwing:number|null;actualPlayerSwing:number|null;actualNetAfterHit:number|null;
  projectedFive:number;hitCost:number;reviewRequired:boolean;
};
export type ProjectionConfidenceBand="High"|"Medium"|"Low";
export type ProjectionPlayerEvaluationRow={
  event:number;playerId:number;teamId:number|null;positionShort:string|null;
  projectedPoints:number;actualPoints:number;error:number;signedError:number;
  expectedMinutes:number;actualMinutes:number;startProbability:number;started:boolean;
  confidence:number;confidenceBand:ProjectionConfidenceBand;calibrationGroup:PlayerCalibrationGroup|null;lowPlContinuityClub:boolean|null;
};
export type ProjectionEvaluation={
  event:number;modelVersion:string|null;status:"pending"|"unavailable"|"legacy"|"evaluated";completedEvents:number;horizonEvents:number;
  managerActual:number|null;actualBeforeHits:number|null;transferCost:number;officialPlanMatch:boolean|null;projectedTotal:number;
  chip:string|null;adjustedProjectedTotal:number;signedSquadError:number|null;absoluteSquadError:number|null;
  captain:{receiptCaptainId:number;officialCaptainId:number|null;effectiveCaptainId:number|null;matched:boolean|null;projectedRaw:number;actualRaw:number|null;officialContribution:number|null}|null;
  population:{rows:number;activeRows:number;allPlayerPointsMae:number;activePlayerPointsMae:number;pointsBias:number;withinTwoPct:number;minutesMae:number;startBrier:number}|null;
  playerRows:ProjectionPlayerEvaluationRow[];
  transfers:ProjectionTransferEvaluation[];
};

const average=(values:number[])=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0;
export const projectionConfidenceBand=(confidence:number):ProjectionConfidenceBand=>confidence>=.75?"High":confidence>=.5?"Medium":"Low";
const sameIdSet=(a:number[],b:number[])=>a.length===b.length&&[...a].sort((x,y)=>x-y).every((value,index)=>value===[...b].sort((x,y)=>x-y)[index]);
const historyPlayerStats=(week:HistoryWeek|undefined,id:number):HistoryPlayerStats|null=>{
  const stats=week?.playerStats?.[String(id)];
  if(stats)return stats;
  const points=week?.playerPoints?.[String(id)];
  return points===undefined?null:{points,minutes:0,starts:0,goals:0,assists:0,cleanSheets:0,bonus:0};
};

// Turns a frozen pre-deadline receipt into a deterministic post-gameweek audit. Official results
// stay authoritative and derived evaluations are intentionally not persisted: every refresh can
// reproduce them from the immutable receipt plus FPL's finished-event data. A squad-total error is
// only reported when the official submitted squad/XI/captaincy matches the receipt; otherwise the
// UI labels the divergence instead of grading the model against a different plan.
export function evaluateProjectionReceipt(lock:LockRecord,weeks:HistoryWeek[]):ProjectionEvaluation{
  const receipt=lock.receipt,firstWeek=weeks.find(week=>week.event===lock.event);
  if(!receipt){const managerActual=firstWeek&&!firstWeek.unavailable?Number(firstWeek.points):null,transferCost=firstWeek?.transferCost??0,scoringTotal=firstWeek?.squad?.reduce((sum,pick)=>sum+(historyPlayerStats(firstWeek,pick.elementId)?.points??0)*pick.multiplier,0)??managerActual;return{event:lock.event,modelVersion:null,status:"legacy",completedEvents:firstWeek&&!firstWeek.unavailable?1:0,horizonEvents:1,managerActual,actualBeforeHits:scoringTotal,transferCost,officialPlanMatch:null,projectedTotal:lock.predicted,chip:firstWeek?.chip??null,adjustedProjectedTotal:lock.predicted,signedSquadError:null,absoluteSquadError:null,captain:null,population:null,playerRows:[],transfers:[]}}
  if(firstWeek?.unavailable)return{event:receipt.event,modelVersion:receipt.modelVersion,status:"unavailable",completedEvents:0,horizonEvents:receipt.eventIds.length,managerActual:null,actualBeforeHits:null,transferCost:0,officialPlanMatch:null,projectedTotal:receipt.squad.predictedTotal,chip:null,adjustedProjectedTotal:receipt.squad.predictedTotal,signedSquadError:null,absoluteSquadError:null,captain:null,population:null,playerRows:[],transfers:[]};
  if(!firstWeek)return{event:receipt.event,modelVersion:receipt.modelVersion,status:"pending",completedEvents:0,horizonEvents:receipt.eventIds.length,managerActual:null,actualBeforeHits:null,transferCost:0,officialPlanMatch:null,projectedTotal:receipt.squad.predictedTotal,chip:null,adjustedProjectedTotal:receipt.squad.predictedTotal,signedSquadError:null,absoluteSquadError:null,captain:null,population:null,playerRows:[],transfers:[]};

  const weekByEvent=new Map(weeks.filter(week=>!week.unavailable).map(week=>[week.event,week]));
  let completedEvents=0;
  for(const eventId of receipt.eventIds){if(!weekByEvent.get(eventId)?.playerStats)break;completedEvents++}
  const officialSquad=firstWeek.squad?.map(pick=>pick.elementId)??[];
  const officialXi=firstWeek.squad?.filter(pick=>pick.position<=11).map(pick=>pick.elementId)??[];
  const officialBench=firstWeek.squad?.filter(pick=>pick.position>11).sort((a,b)=>a.position-b.position).map(pick=>pick.elementId)??[];
  const officialCaptainId=firstWeek.captainId??firstWeek.squad?.find(pick=>pick.isCaptain)?.elementId??null;
  const officialViceId=firstWeek.viceCaptainId??firstWeek.squad?.find(pick=>pick.isViceCaptain)?.elementId??null;
  const effectiveCaptainId=firstWeek.squad?.find(pick=>pick.multiplier>1)?.elementId??officialCaptainId;
  const receiptBench=receipt.squad.benchIds;
  const benchOrderMatch=!receiptBench||receiptBench.length===officialBench.length&&receiptBench.every((id,index)=>id===officialBench[index]);
  const officialPlanMatch=officialSquad.length===receipt.squad.squadIds.length&&sameIdSet(officialSquad,receipt.squad.squadIds)&&sameIdSet(officialXi,receipt.squad.xiIds)&&benchOrderMatch&&officialCaptainId===receipt.squad.captainId&&officialViceId===receipt.squad.viceId;
  const tupleById=new Map(receipt.players.map(player=>[player[0],player]));
  const currentProjection=(id:number)=>tupleById.get(id)?.[4]??0;
  const chip=firstWeek.chip??null;
  const benchIds=receipt.squad.squadIds.filter(id=>!receipt.squad.xiIds.includes(id));
  const chipAdjustment=chip==="3xc"?receipt.squad.captainXPts:chip==="bboost"?benchIds.reduce((sum,id)=>sum+currentProjection(id),0):0;
  const adjustedProjectedTotal=receiptNumber(receipt.squad.predictedTotal+chipAdjustment);
  const managerActual=Number(firstWeek.points),transferCost=firstWeek.transferCost??0;
  const officialScoringTotal=firstWeek.squad?.reduce((sum,pick)=>sum+(historyPlayerStats(firstWeek,pick.elementId)?.points??0)*pick.multiplier,0);
  const actualBeforeHits=officialScoringTotal??managerActual;
  const signedSquadError=officialPlanMatch?receiptNumber(actualBeforeHits-adjustedProjectedTotal):null;
  const captainStats=historyPlayerStats(firstWeek,receipt.squad.captainId);
  const captain={receiptCaptainId:receipt.squad.captainId,officialCaptainId,effectiveCaptainId,matched:officialCaptainId===null?null:officialCaptainId===receipt.squad.captainId,projectedRaw:receipt.squad.captainXPts,actualRaw:captainStats?.points??null,officialContribution:firstWeek.captainContribution??null};

  const allPointErrors:number[]=[],activePointErrors:number[]=[],activeBias:number[]=[],minuteErrors:number[]=[],startErrors:number[]=[];
  let withinTwo=0;
  for(let eventIndex=0;eventIndex<completedEvents;eventIndex++){
    const week=weekByEvent.get(receipt.eventIds[eventIndex]);
    for(const player of receipt.players){
      const stats=historyPlayerStats(week,player[0]);if(!stats)continue;
      const projected=player[11]?.[eventIndex]??(eventIndex===0?player[4]:null);if(projected===null)continue;
      const error=Math.abs(stats.points-projected);allPointErrors.push(error);
      if(projected>=.5||stats.minutes>0){activePointErrors.push(error);activeBias.push(stats.points-projected);if(error<=2)withinTwo++}
      if(eventIndex===0){minuteErrors.push(Math.abs(stats.minutes-player[5]));startErrors.push(Math.pow((stats.starts>0?1:0)-player[6],2))}
    }
  }
  const population=allPointErrors.length?{rows:allPointErrors.length,activeRows:activePointErrors.length,allPlayerPointsMae:receiptNumber(average(allPointErrors)),activePlayerPointsMae:receiptNumber(average(activePointErrors)),pointsBias:receiptNumber(average(activeBias)),withinTwoPct:receiptNumber(activePointErrors.length?withinTwo/activePointErrors.length*100:0,1),minutesMae:receiptNumber(average(minuteErrors),1),startBrier:receiptNumber(average(startErrors))}:null;
  const playerRows:ProjectionPlayerEvaluationRow[]=receipt.players.flatMap(player=>{
    const stats=historyPlayerStats(firstWeek,player[0]);
    if(!stats)return[];
    const projected=player[4],actual=stats.points,confidence=player[7];
    return[{event:receipt.event,playerId:player[0],teamId:player[12]??null,positionShort:player[13]??null,projectedPoints:projected,actualPoints:actual,error:receiptNumber(Math.abs(actual-projected)),signedError:receiptNumber(actual-projected),expectedMinutes:player[5],actualMinutes:stats.minutes,startProbability:player[6],started:stats.starts>0,confidence,confidenceBand:projectionConfidenceBand(confidence),calibrationGroup:player[14]??null,lowPlContinuityClub:player[15]??null}];
  });

  const transfers=receipt.transfers.slice(0,5).map(row=>{
    let actualPlayerSwing=0,projectedPlayerSwing=0,paired=0,projectionPairs=0;
    const incoming=tupleById.get(row.incomingId),outgoing=tupleById.get(row.outId);
    for(let eventIndex=0;eventIndex<completedEvents;eventIndex++){
      const week=weekByEvent.get(receipt.eventIds[eventIndex]),incomingStats=historyPlayerStats(week,row.incomingId),outgoingStats=historyPlayerStats(week,row.outId);
      if(!incomingStats||!outgoingStats)break;
      actualPlayerSwing+=incomingStats.points-outgoingStats.points;
      const incomingProjected=incoming?.[11]?.[eventIndex]??(eventIndex===0?incoming?.[4]:null),outgoingProjected=outgoing?.[11]?.[eventIndex]??(eventIndex===0?outgoing?.[4]:null);
      if(incomingProjected!==null&&incomingProjected!==undefined&&outgoingProjected!==null&&outgoingProjected!==undefined){projectedPlayerSwing+=incomingProjected-outgoingProjected;projectionPairs++}
      paired++;
    }
    return{rank:row.rank,outId:row.outId,outName:row.outName,incomingId:row.incomingId,incomingName:row.incomingName,completedEvents:paired,horizonEvents:receipt.eventIds.length,projectedPlayerSwing:paired&&projectionPairs===paired?receiptNumber(projectedPlayerSwing):null,actualPlayerSwing:paired?actualPlayerSwing:null,actualNetAfterHit:paired?actualPlayerSwing-row.hitCost:null,projectedFive:row.individualGain5,hitCost:row.hitCost,reviewRequired:row.reviewRequired};
  });
  return{event:receipt.event,modelVersion:receipt.modelVersion,status:"evaluated",completedEvents,horizonEvents:receipt.eventIds.length,managerActual,actualBeforeHits,transferCost,officialPlanMatch,projectedTotal:receipt.squad.predictedTotal,chip,adjustedProjectedTotal,signedSquadError,absoluteSquadError:signedSquadError===null?null:Math.abs(signedSquadError),captain,population,playerRows,transfers};
}

export type AccuracyMetric={rows:number;activeRows:number;pointsMae:number|null;pointsBias:number|null;withinTwoPct:number|null;minutesMae:number|null;startBrier:number|null};
export function aggregateAccuracy(rows:ProjectionPlayerEvaluationRow[]):AccuracyMetric{
  const active=rows.filter(row=>row.projectedPoints>=.5||row.actualMinutes>0);
  return{rows:rows.length,activeRows:active.length,pointsMae:active.length?receiptNumber(average(active.map(row=>row.error))):null,pointsBias:active.length?receiptNumber(average(active.map(row=>row.signedError))):null,withinTwoPct:active.length?receiptNumber(active.filter(row=>row.error<=2).length/active.length*100,1):null,minutesMae:rows.length?receiptNumber(average(rows.map(row=>Math.abs(row.actualMinutes-row.expectedMinutes))),1):null,startBrier:rows.length?receiptNumber(average(rows.map(row=>Math.pow((row.started?1:0)-row.startProbability,2)))):null};
}

export type TransferAccuracyMetric={rows:number;projectedAverage:number|null;actualAverage:number|null;netAfterHitAverage:number|null;positivePct:number|null};
export function aggregateTransferAccuracy(rows:ProjectionTransferEvaluation[]):TransferAccuracyMetric{
  const completed=rows.filter(row=>row.completedEvents>0&&row.actualPlayerSwing!==null&&row.actualNetAfterHit!==null);
  const projected=completed.filter(row=>row.projectedPlayerSwing!==null);
  return{rows:completed.length,projectedAverage:projected.length?receiptNumber(average(projected.map(row=>row.projectedPlayerSwing!))):null,actualAverage:completed.length?receiptNumber(average(completed.map(row=>row.actualPlayerSwing!))):null,netAfterHitAverage:completed.length?receiptNumber(average(completed.map(row=>row.actualNetAfterHit!))):null,positivePct:completed.length?receiptNumber(completed.filter(row=>row.actualNetAfterHit!>0).length/completed.length*100,1):null};
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

function FinalCheck({data,go,revision,onTeamChange}:{data:FplData;go:(v:View)=>void;revision:number;onTeamChange:()=>void}){
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
  const lock=()=>{
    setLockError("");
    const event=data.events.find(item=>item.id===a.first),capturedAt=new Date().toISOString();
    if(!event||Date.parse(capturedAt)>=Date.parse(event.deadline)){setLockError("The official deadline has passed. A pre-deadline receipt was not created.");return}
    try{
      const freeTransfers=readFreeTransfers(),bank=meta?.bank??a.bank;
      const baseRows=bestTransfers(data,squad,bank,freeTransfers,60,sellingPricesFor(meta));
      const transferRows=withModelUtilityChange(baseRows,squad,createOptimizer(data,"Balanced 5 GWs","Balanced","Maximum xPts"));
      const routeRows=solveTransferRoutes(data,squad,bank,{horizon:5,freeTransfers,maxWeeklyHit:4,sellingPrices:sellingPricesFor(meta),resultLimit:4,plannedChips});
      const receipt=createProjectionReceipt({data,eventIds:a.events.slice(0,5).map(item=>item.id),deadline:event.deadline,capturedAt,squad,xiIds,benchIds,captainId:captain.id,viceId:vice.id,bank,freeTransfers,transferRows,routeRows,plannedChip});
      const record:LockRecord={event:a.first,lockedAt:capturedAt,dataUpdatedAt:data.updatedAt,predicted:receipt.squad.predictedTotal,squadIds:squad.map(p=>p.id),xiIds,benchIds,captainId:captain.id,viceId:vice.id,receipt};
      persist("fpl-edge-locks",JSON.stringify([...existingLocks.filter(item=>item.event!==a.first),record]));setLockVersion(v=>v+1);
    }catch(error){setLockError(error instanceof Error?error.message:"Could not create the projection receipt.")}
  };
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
    {lockError&&<p className="lock-error">{lockError}</p>}
    <button className={`lock-button ${fullReceiptSaved?"locked":""}`} onClick={lock}>{fullReceiptSaved?"FULL RECEIPT SAVED ✓":locked?"REFRESH FULL RECEIPT":"LOCK THIS TEAM"}<small>{fullReceiptSaved?`${existingLock!.receipt!.players.length} player projections · ${existingLock!.receipt!.transfers.length} single moves · ${existingLock!.receipt!.routes?.length??0} complete routes · ${existingLock!.receipt!.modelVersion}`:"Save the XI, captaincy, every player projection and complete transfer routes before the deadline."}</small></button>
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

function ModelVersionPanel(){
  const current=modelRelease(PROJECTION_MODEL_VERSION);
  return <section className="model-version-panel">
    <header><div><span>MODEL VERSION</span><h2>{current?`${current.short} · ${current.title}`:PROJECTION_MODEL_VERSION}</h2><p>Every pre-deadline receipt keeps the exact model version that produced it. Historical accuracy is calculated within that version only—never pooled across changed formulas.</p></div><b>CURRENT</b></header>
    <div className="model-release-grid">{MODEL_RELEASES.map(release=><article className={release.version===PROJECTION_MODEL_VERSION?"current":""} key={release.version}><div><span>{release.short}</span><small>{release.released}</small></div><h3>{release.title}</h3><ul>{release.changes.map(change=><li key={change}>{change}</li>)}</ul><code>{release.version}</code></article>)}</div>
  </section>;
}

function PointsModel({data}:{data:FplData}){
  const events=futureEvents(data,5),first=events[0]?.id;const[q,setQ]=useState("");const[selected,setSelected]=useState<number|null>(null);const[technical,setTechnical]=useState(false);
  const players=data.players.filter(p=>(`${p.name} ${p.teamName}`).toLowerCase().includes(q.toLowerCase())).sort((a,b)=>b.epNext-a.epNext).slice(0,10),p=data.players.find(x=>x.id===(selected??players[0]?.id))??data.players[0],m=projectionMetrics(p,first,data.fixtures,first),calibration=playerCalibrationProfile(p);
  const appearance=(1-m.sixtyProbability)*m.startProbability+m.sixtyProbability*2,goalPts=m.xG*(p.positionShort==="FWD"?4:p.positionShort==="MID"?5:6),assistPts=m.xA*3,cleanPts=m.cleanSheetProbability*(p.positionShort==="MID"?1:["GKP","DEF"].includes(p.positionShort)?4:0)*m.sixtyProbability,other=Math.max(0,m.xPts-appearance-goalPts-assistPts-cleanPts-m.bonus),confidence=projectionConfidenceBand(m.confidence);
  let locks:any[]=[];try{locks=JSON.parse(localStorage.getItem("fpl-edge-locks")||"[]")}catch{}
  return <div className="coach-page">
    <section className="model-trust"><div><span>HOW PROJECTIONS WORK</span><h2>Transparent by default. Technical when you want it.</h2><p>Expected points combine expected minutes, team and opponent strength, xG/xA, penalties and set pieces, clean-sheet probability, defensive contributions, home advantage, role and official availability.</p></div><button onClick={()=>setTechnical(x=>!x)}>{technical?"Hide technical detail":"Open technical detail"}</button>{technical&&<div className="technical-note"><b>Technical method</b><p>Players are assigned to an explicit Premier League evidence group. Established PL history uses normal shrinkage; limited history receives stronger shrinkage; players with no genuine PL prior start from a position baseline and learn more slowly from early current-season matches.</p><p>Club-level PL continuity lowers the projection-evidence ceiling when a roster has little proven top-flight evidence. It never substitutes Championship output as Premier League data.</p></div>}</section>
    <section className="model-picker"><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search a player…"/><div>{players.map(x=><button className={x.id===p.id?"active":""} onClick={()=>setSelected(x.id)} key={x.id}>{x.name}<small>{x.teamShort}</small></button>)}</div></section>
    <section className="projection-explainer"><header><div><span>{p.teamName} · {p.position} · £{p.price.toFixed(1)}m</span><h2>{p.name} — {m.xPts.toFixed(1)} xPts</h2></div><b className={confidence.toLowerCase()}>Projection evidence: {confidence}</b></header><div>{[["Appearance",appearance],["Goals",goalPts],["Assists",assistPts],["Clean sheet",cleanPts],["Bonus",m.bonus],["Other",other]].map(([label,value])=><article key={String(label)}><span>{label}</span><b>{Number(value).toFixed(2)}</b><i><em style={{width:`${clamp(Number(value)/Math.max(.1,m.xPts)*100)}%`}}/></i></article>)}</div><footer><span>{Math.round(m.expectedMinutes)} xMins</span><span>{Math.round(m.startProbability*100)}% start</span><span>{m.penaltyRole?"Penalties":"No confirmed pens"}</span><span>{m.setPieceRole?"Set pieces":"No confirmed set pieces"}</span></footer></section>
    <section className="calibration-card"><header><div><span>PLAYER EVIDENCE CLASS</span><h2>{calibration.label}</h2></div><b>{Math.round(m.confidence*100)}% projection evidence</b></header><div><p><span>Prior PL sample</span><b>{p.priorMinutes.toLocaleString()} min</b><small>{calibration.hasPremierLeaguePrior?`${p.priorSeason??"Prior season"} · ${p.priorCompetition??"Premier League"}`:"No non-PL statistics substituted"}</small></p><p><span>Current PL sample</span><b>{p.minutes.toLocaleString()} min</b><small>{Math.round((m.currentEvidenceWeight??0)*100)}% current-rate weight</small></p><p><span>Projection-evidence ceiling</span><b>{Math.round((m.confidenceCap??1)*100)}%</b><small>rises only when real PL evidence supports it</small></p><p><span>Club PL continuity</span><b>{Math.round((p.teamPlPriorCoverage??0)*100)}%</b><small>{calibration.lowPlContinuityClub?"Promoted / low-continuity context":"Established roster context"}</small></p></div>{calibration.group!=="established-pl"&&<footer>This player is deliberately prevented from receiving established-player certainty. The transfer rank consumes the lower projection evidence; warnings explain the evidence gap.</footer>}</section>
    <section className="model-reality"><header><div><span>MODEL VS REALITY</span><h2>Every locked plan becomes an audit trail.</h2></div><strong>{locks.length}<small>projection snapshots</small></strong></header>{locks.length?<div>{locks.slice(-5).reverse().map((l:any)=><article key={l.event}><b>GW{l.event}</b><span>Projected {l.predicted} pts</span><em>Actual result appears after the gameweek is finished</em></article>)}</div>:<p>Lock a team in Final Check to start tracking projected points, actual points, error and rolling model accuracy. No backtest numbers are fabricated.</p>}</section>
  </div>;
}

type EvaluationRow={lock:LockRecord;evaluation:ProjectionEvaluation};
function ModelAudit({data,revision}:{data:FplData;revision:number}){
  const[rows,setRows]=useState<{lock:LockRecord;evaluation:ProjectionEvaluation}[]>([]);
  const[loading,setLoading]=useState(false);const[error,setError]=useState("");const[refreshToken,setRefreshToken]=useState(0);
  useEffect(()=>{let cancelled=false;const run=async()=>{let locks:LockRecord[]=[];try{locks=JSON.parse(localStorage.getItem("fpl-edge-locks")||"[]")}catch{}const entry=localStorage.getItem("fpl-edge-entry");let weeks:HistoryWeek[]=[];setLoading(!!entry);setError("");if(entry)try{const response=await fetch(`/api/fpl/history?entry=${entry}`,{cache:"no-store"});const json=await response.json();if(!response.ok)throw new Error(json.error||"Could not load official history");weeks=json.weeks||[]}catch(e){if(!cancelled)setError(e instanceof Error?e.message:"Could not load official history")}finally{if(!cancelled)setLoading(false)}const mapped=locks.map(lock=>({lock,evaluation:evaluateProjectionReceipt(lock,weeks)})).sort((a,b)=>b.lock.event-a.lock.event);if(!cancelled)setRows(mapped)};run();return()=>{cancelled=true}},[revision,refreshToken]);
  const refresh=()=>setRefreshToken(value=>value+1);
  return <><AccuracyDashboard data={data} rows={rows}/><DecisionSnapshots data={data} rows={rows} loading={loading} error={error} refresh={refresh}/></>;
}

function AccuracyDashboard({data,rows}:{data:FplData;rows:EvaluationRow[]}){
  const allEvaluated=rows.filter(row=>row.evaluation.status==="evaluated");
  const[selectedVersion,setSelectedVersion]=useState(PROJECTION_MODEL_VERSION);
  const groupedVersions=groupByModelVersion(allEvaluated,row=>row.evaluation.modelVersion);
  const availableVersions=[PROJECTION_MODEL_VERSION,...[...groupedVersions.keys()].filter(version=>version!==PROJECTION_MODEL_VERSION)];
  const evaluated=comparableModelRows(allEvaluated,selectedVersion,row=>row.evaluation.modelVersion);
  const playerRows=evaluated.flatMap(row=>row.evaluation.playerRows);
  const overall=aggregateAccuracy(playerRows);
  const captainPairs=evaluated.flatMap(row=>{const captain=row.evaluation.captain;return captain?.actualRaw===null||captain?.actualRaw===undefined?[]:[{event:row.evaluation.event,projected:captain.projectedRaw,actual:captain.actualRaw,error:Math.abs(captain.actualRaw-captain.projectedRaw)}]});
  const captainMae=captainPairs.length?average(captainPairs.map(row=>row.error)):null;
  const transferRows=evaluated.flatMap(row=>row.evaluation.transfers);
  const transfer=aggregateTransferAccuracy(transferRows),topTransfer=aggregateTransferAccuracy(transferRows.filter(row=>row.rank===1));
  const grouped=(keyOf:(row:ProjectionPlayerEvaluationRow)=>string,labelOf:(key:string)=>string)=>{
    const map=new Map<string,ProjectionPlayerEvaluationRow[]>();
    playerRows.forEach(row=>{const key=keyOf(row);map.set(key,[...(map.get(key)??[]),row])});
    return[...map].map(([key,values])=>({key,label:labelOf(key),metric:aggregateAccuracy(values)}));
  };
  const byPosition=grouped(row=>row.positionShort??"LEGACY",key=>key==="LEGACY"?"Legacy / unknown":key).sort((a,b)=>["GKP","DEF","MID","FWD","LEGACY"].indexOf(a.key)-["GKP","DEF","MID","FWD","LEGACY"].indexOf(b.key));
  const byConfidence=grouped(row=>row.confidenceBand,key=>key).sort((a,b)=>["High","Medium","Low"].indexOf(a.key)-["High","Medium","Low"].indexOf(b.key));
  const calibrationLabels:Record<string,string>={"established-pl":"Established PL prior","limited-pl":"Limited PL prior","no-pl-prior":"No genuine PL prior","current-pl-established":"Established this PL season","LEGACY":"Legacy / unknown"};
  const byCalibration=grouped(row=>row.calibrationGroup??"LEGACY",key=>calibrationLabels[key]??key).sort((a,b)=>["established-pl","limited-pl","no-pl-prior","current-pl-established","LEGACY"].indexOf(a.key)-["established-pl","limited-pl","no-pl-prior","current-pl-established","LEGACY"].indexOf(b.key));
  const teamName=new Map(data.teams.map(team=>[String(team.id),team.name]));
  const byClub=grouped(row=>row.teamId===null?"LEGACY":String(row.teamId),key=>key==="LEGACY"?"Legacy / unknown":teamName.get(key)??`Team ${key}`).sort((a,b)=>b.metric.activeRows-a.metric.activeRows||((b.metric.pointsMae??0)-(a.metric.pointsMae??0)));
  const byEvent=grouped(row=>String(row.event),key=>`GW${key}`).sort((a,b)=>Number(a.key)-Number(b.key));
  const fmtMetric=(value:number|null,places=2)=>value===null?"—":value.toFixed(places);
  const versionSummaries=availableVersions.map(version=>{
    const versionRows=groupedVersions.get(version)??[];
    const metric=aggregateAccuracy(versionRows.flatMap(row=>row.evaluation.playerRows));
    const captains=versionRows.flatMap(row=>{const captain=row.evaluation.captain;return captain?.actualRaw===null||captain?.actualRaw===undefined?[]:[Math.abs(captain.actualRaw-captain.projectedRaw)]});
    const top=aggregateTransferAccuracy(versionRows.flatMap(row=>row.evaluation.transfers.filter(route=>route.rank===1)));
    return{version,rows:versionRows.length,metric,captainMae:captains.length?average(captains):null,topGain:top.netAfterHitAverage};
  });
  const SliceTable=({title,items}:{title:string;items:ReturnType<typeof grouped>})=><section className="accuracy-slice"><header><span>{title}</span><small>xPts uses active rows · minutes/start use all rows</small></header><div className="accuracy-table"><div><b>GROUP</b><b>N</b><b>xPTS MAE</b><b>BIAS</b><b>±2 PTS</b><b>xMINS MAE</b><b>BRIER</b></div>{items.map(item=><div key={item.key}><strong>{item.label}</strong><span>{item.metric.activeRows}<small> / {item.metric.rows}</small></span><span>{fmtMetric(item.metric.pointsMae)}</span><span>{item.metric.pointsBias!==null&&item.metric.pointsBias>0?"+":""}{fmtMetric(item.metric.pointsBias)}</span><span>{item.metric.withinTwoPct===null?"—":`${item.metric.withinTwoPct.toFixed(1)}%`}</span><span>{fmtMetric(item.metric.minutesMae,1)}</span><span>{fmtMetric(item.metric.startBrier,3)}</span></div>)}</div></section>;
  return <section className="accuracy-dashboard">
    <header><div><span>MODEL ACCURACY</span><h2>Measured forecasts, not a marketing score.</h2><p>One-gameweek-ahead player forecasts are compared with official finished-event data. Lower MAE and Brier scores are better; positive bias means actual points exceeded the forecast.</p></div><strong>{evaluated.length}<small>evaluated gameweeks</small></strong></header>
    <nav className="model-version-tabs" aria-label="Accuracy model version">{availableVersions.map(version=><button className={selectedVersion===version?"active":""} onClick={()=>setSelectedVersion(version)} key={version}><span>{modelDisplayName(version)}</span><small>{groupedVersions.get(version)?.length??0} evaluated GW</small></button>)}</nav>
    <p className="model-comparability-note"><b>{modelDisplayName(selectedVersion)}</b> only. Metrics below never combine forecasts made by different model generations.</p>
    {versionSummaries.length>1&&<section className="version-comparison"><header><span>VERSION COMPARISON</span><small>Separate cohorts · lower error is better · fewer than 5 GWs is early evidence</small></header><div>{versionSummaries.map(summary=><button className={selectedVersion===summary.version?"active":""} onClick={()=>setSelectedVersion(summary.version)} key={summary.version}><strong>{modelDisplayName(summary.version)}</strong><span>{summary.rows} GW{summary.rows===1?"":"s"}{summary.rows<5?" · early sample":""}</span><dl><div><dt>xPts MAE</dt><dd>{fmtMetric(summary.metric.pointsMae)}</dd></div><div><dt>Start Brier</dt><dd>{fmtMetric(summary.metric.startBrier,3)}</dd></div><div><dt>Captain MAE</dt><dd>{fmtMetric(summary.captainMae)}</dd></div><div><dt>Top route</dt><dd>{summary.topGain===null?"—":`${summary.topGain>=0?"+":""}${summary.topGain.toFixed(2)}`}</dd></div></dl></button>)}</div></section>}
    {!playerRows.length?<div className="accuracy-empty"><b>No calibration sample yet.</b><p>Lock a full projection receipt before a deadline and connect your FPL Team ID. This dashboard activates after FPL publishes the finished gameweek.</p></div>:<>
      <div className="accuracy-kpis">
        <article><span>xPTS MAE</span><b>{fmtMetric(overall.pointsMae)}</b><small>{overall.activeRows} active player forecasts</small></article>
        <article><span>START BRIER</span><b>{fmtMetric(overall.startBrier,3)}</b><small>0 is perfect · {overall.rows} probabilities</small></article>
        <article><span>xMINS MAE</span><b>{fmtMetric(overall.minutesMae,1)}</b><small>minutes per player</small></article>
        <article><span>CAPTAIN MAE</span><b>{captainMae===null?"—":captainMae.toFixed(2)}</b><small>{captainPairs.length} raw-points forecasts</small></article>
        <article><span>TOP ROUTE GAIN</span><b>{topTransfer.netAfterHitAverage===null?"—":`${topTransfer.netAfterHitAverage>=0?"+":""}${topTransfer.netAfterHitAverage.toFixed(2)}`}</b><small>{topTransfer.rows} completed #1 routes</small></article>
        <article><span>ALL ROUTES POSITIVE</span><b>{transfer.positivePct===null?"—":`${transfer.positivePct.toFixed(1)}%`}</b><small>{transfer.rows} frozen route observations</small></article>
      </div>
      {evaluated.length<5&&<p className="accuracy-warning"><b>Small sample:</b> {evaluated.length} evaluated gameweek{evaluated.length===1?"":"s"}. Treat these measurements as early calibration evidence, not proof of long-run accuracy.</p>}
      <SliceTable title="GAMEWEEK TREND" items={byEvent}/>
      <SliceTable title="BY PRIOR-EVIDENCE GROUP" items={byCalibration}/>
      <div className="accuracy-breakdowns"><SliceTable title="BY POSITION" items={byPosition}/><SliceTable title="BY PROJECTION EVIDENCE" items={byConfidence}/></div>
      <SliceTable title="BY CLUB" items={byClub}/>
      <section className="accuracy-transfer"><header><div><span>TRANSFER RECOMMENDATION GAINS</span><h3>Frozen routes through completed horizon weeks</h3></div><small>Recommendations are evaluated as scenarios, not claimed as transfers the manager made.</small></header><div><p><span>All-route forecast</span><b>{transfer.projectedAverage===null?"—":`${transfer.projectedAverage>=0?"+":""}${transfer.projectedAverage.toFixed(2)}`}</b></p><p><span>All-route actual</span><b>{transfer.actualAverage===null?"—":`${transfer.actualAverage>=0?"+":""}${transfer.actualAverage.toFixed(2)}`}</b></p><p><span>After-hit actual</span><b>{transfer.netAfterHitAverage===null?"—":`${transfer.netAfterHitAverage>=0?"+":""}${transfer.netAfterHitAverage.toFixed(2)}`}</b></p><p><span>Top-route positive</span><b>{topTransfer.positivePct===null?"—":`${topTransfer.positivePct.toFixed(1)}%`}</b></p></div></section>
    </>}
  </section>;
}

function DecisionSnapshots({data,rows,loading,error,refresh}:{data:FplData;rows:EvaluationRow[];loading:boolean;error:string;refresh:()=>void}){
  const allEvaluated=rows.filter(row=>row.evaluation.status==="evaluated");
  const evaluated=allEvaluated.filter(row=>row.evaluation.modelVersion===PROJECTION_MODEL_VERSION);
  const archivedEvaluated=allEvaluated.length-evaluated.length;
  const squadErrors=evaluated.flatMap(row=>row.evaluation.absoluteSquadError===null?[]:[row.evaluation.absoluteSquadError]);
  const playerMaes=evaluated.flatMap(row=>row.evaluation.population?[row.evaluation.population.activePlayerPointsMae]:[]);
  const captainErrors=evaluated.flatMap(row=>{const captain=row.evaluation.captain;return captain?.actualRaw===null||captain?.actualRaw===undefined?[]:[Math.abs(captain.actualRaw-captain.projectedRaw)]});
  const squadMae=squadErrors.length?average(squadErrors):null,playerMae=playerMaes.length?average(playerMaes):null,captainMae=captainErrors.length?average(captainErrors):null;
  const nameOf=(id:number|null|undefined)=>data.players.find(player=>player.id===id)?.name??(id?`Player ${id}`:"—");
  return <section className="decision-snapshots">
    <header><div><span>AUTOMATIC POST-GW EVALUATION</span><h2>Every forecast is graded against official results.</h2><p>Evaluations appear after FPL marks the gameweek finished. Changed official teams are flagged instead of being scored against a plan you did not submit.</p></div><button onClick={refresh} disabled={loading}>{loading?"Checking…":"Refresh evaluations"}</button></header>
    <div className="evaluation-kpis">
      <article><span>CURRENT MODEL</span><b>{evaluated.length}</b><small>evaluated · {archivedEvaluated} archived separately</small></article>
      <article><span>SQUAD MAE</span><b>{squadMae===null?"—":squadMae.toFixed(1)}</b><small>matching official plans only</small></article>
      <article><span>ACTIVE-PLAYER MAE</span><b>{playerMae===null?"—":playerMae.toFixed(2)}</b><small>xPts error per player-event</small></article>
      <article><span>CAPTAIN MAE</span><b>{captainMae===null?"—":captainMae.toFixed(2)}</b><small>raw points vs forecast</small></article>
    </div>
    <p className="model-comparability-note"><b>{modelDisplayName(PROJECTION_MODEL_VERSION)}</b> only in the summary above. All archived receipts remain visible below with their original version label.</p>
    {error&&<p className="evaluation-error">Official evaluation refresh failed: {error}</p>}
    {rows.length?<div className="evaluation-list">{rows.map(({lock,evaluation})=>{
      const receipt=lock.receipt,population=evaluation.population,captain=evaluation.captain;
      const statusLabel=evaluation.status==="evaluated"?evaluation.officialPlanMatch?"OFFICIAL PLAN MATCHED":"OFFICIAL PLAN CHANGED":evaluation.status==="pending"?"WAITING FOR FINAL RESULT":evaluation.status==="unavailable"?"OFFICIAL RESULT UNAVAILABLE":"LEGACY SNAPSHOT";
      const statusTone=evaluation.status==="evaluated"&&evaluation.officialPlanMatch?"matched":evaluation.status==="evaluated"&&!evaluation.officialPlanMatch?"changed":"pending";
      const captainOutcome=!captain||captain.actualRaw===null?"No result":`${captain.actualRaw} raw · ${captain.officialContribution??"—"} official contribution${captain.matched===false?` · official captain ${nameOf(captain.officialCaptainId)}`:""}${captain.effectiveCaptainId!==captain.officialCaptainId?` · armband passed to ${nameOf(captain.effectiveCaptainId)}`:""}`;
      return <article className="evaluation-card" key={`${lock.event}-${lock.lockedAt}`}>
        <header><div><span>GW{lock.event} · {receipt?.modelVersion??"legacy"}</span><h3>{evaluation.status==="evaluated"?`Forecast review for GW${lock.event}`:`GW${lock.event} receipt`}</h3></div><b className={statusTone}>{statusLabel}</b></header>
        <div className="evaluation-scoreline">
          <p><span>Projected</span><b>{evaluation.adjustedProjectedTotal.toFixed(1)}</b><small>{evaluation.chip?`${evaluation.chip} adjustment included`:"standard scoring"}</small></p>
          <i>→</i>
          <p><span>Official points</span><b>{evaluation.managerActual??"—"}</b><small>{evaluation.status==="pending"?"pending":evaluation.officialPlanMatch===false?"different submitted plan":evaluation.transferCost?`${evaluation.actualBeforeHits} before −${evaluation.transferCost} transfer hit`:"finished result"}</small></p>
          <p><span>Signed error</span><b>{evaluation.signedSquadError===null?"—":`${evaluation.signedSquadError>0?"+":""}${evaluation.signedSquadError.toFixed(1)}`}</b><small>{evaluation.signedSquadError===null?"not graded":evaluation.signedSquadError>0?"model underprojected":"model overprojected"}</small></p>
        </div>
        {evaluation.status==="evaluated"&&evaluation.officialPlanMatch===false&&<p className="plan-divergence">The official squad, XI or captaincy differed from this receipt. Official points are shown for context, but no squad-total model error is calculated.</p>}
        {evaluation.status==="evaluated"&&<div className="evaluation-detail-grid">
          <p><span>Captain forecast</span><b>{captain?`${nameOf(captain.receiptCaptainId)} · ${captain.projectedRaw.toFixed(1)} xPts`:"—"}</b><small>{captainOutcome}</small></p>
          <p><span>Active-player MAE</span><b>{population?.activePlayerPointsMae.toFixed(2)??"—"}</b><small>{population?`${population.activeRows} meaningful player-events`:"No player data"}</small></p>
          <p><span>Expected-minutes MAE</span><b>{population?.minutesMae.toFixed(1)??"—"}</b><small>first-event minutes forecast</small></p>
          <p><span>Start Brier</span><b>{population?.startBrier.toFixed(3)??"—"}</b><small>lower is better · 0 is perfect</small></p>
          <p><span>Within ±2 points</span><b>{population?`${population.withinTwoPct.toFixed(1)}%`:"—"}</b><small>active player-event forecasts</small></p>
          <p><span>Points bias</span><b>{population?`${population.pointsBias>0?"+":""}${population.pointsBias.toFixed(2)}`:"—"}</b><small>{population?.pointsBias&&population.pointsBias>0?"underprojecting":"negative means overprojecting"}</small></p>
        </div>}
        {evaluation.transfers.length>0&&<section className="route-evaluation"><header><span>FROZEN TRANSFER ROUTES</span><small>{evaluation.completedEvents}/{evaluation.horizonEvents} horizon gameweeks complete</small></header>{evaluation.transfers.slice(0,3).map(route=><div key={`${route.rank}-${route.outName}-${route.incomingName}`}><b>#{route.rank} {route.outName} → {route.incomingName}</b><span>Forecast through {route.completedEvents}: <strong>{route.projectedPlayerSwing===null?"—":`${route.projectedPlayerSwing>=0?"+":""}${route.projectedPlayerSwing.toFixed(1)}`}</strong></span><span>Actual through {route.completedEvents}: <strong>{route.actualPlayerSwing===null?"—":`${route.actualPlayerSwing>=0?"+":""}${route.actualPlayerSwing}`}</strong></span><span>After hit: <strong>{route.actualNetAfterHit===null?"—":`${route.actualNetAfterHit>=0?"+":""}${route.actualNetAfterHit}`}</strong></span><small>Original 5-GW player-swing forecast {route.projectedFive>=0?"+":""}{route.projectedFive.toFixed(1)}{route.reviewRequired?" · review was required":""}</small></div>)}</section>}
        <footer>{receipt?`${receipt.players.length} frozen players · ${receipt.transfers.length} routes · ${receipt.squad.benchIds?.length===4?"bench order frozen · ":""}${receipt.playerEncoding} · locked ${new Date(lock.lockedAt).toLocaleString()}`:`Legacy lock from ${new Date(lock.lockedAt).toLocaleString()} — detailed calibration was not captured.`}</footer>
      </article>})}</div>:<div className="history-empty"><b>No projection receipts yet.</b><p>Use Final Check and lock your team before the deadline. After the gameweek finishes, this page will automatically grade the squad forecast, player projections, captaincy and transfer routes.</p></div>}
  </section>
}

function CoachDock({data,go,revision}:{data:FplData;go:(v:View)=>void;revision:number}){const[open,setOpen]=useState(false);const squad=useMemo(()=>savedSquad(data),[data,revision]),a=analysis(data,squad);let title="Connect your team to activate the coach.",detail="Once connected, I will summarise the strongest action using the same live data as every page.",target:View="team";let manager:ManagerMeta|null=null;try{manager=JSON.parse(localStorage.getItem("fpl-edge-manager")||"null")}catch{}if(a){const moves=bestTransfers(data,squad,manager?.bank??a.bank,1,12,sellingPricesFor(manager)),move=selectPrimaryTransfer(moves);if(a.issues.length){title=`Your biggest concern is ${a.issues[0].name}.`;detail=`${startPct(a.issues[0],a.first,data)}% modelled start probability. Review late news before acting.`;target="deadline"}else if(move){title=`${move.out.name} → ${move.incoming.name} is your leading route.`;detail=`+${move.gain5.toFixed(1)} projected squad points over five gameweeks, before any hit cost.`;target="transfers"}else{title="You do not need to force a transfer.";detail="No risk-adjusted squad move currently clears the action threshold. Rolling preserves flexibility.";target="transfers"}}return <aside className={`coach-dock ${open?"open":""}`}><button className="coach-orb" onClick={()=>setOpen(x=>!x)}><i>E</i><span>FPL Coach</span></button>{open&&<div><span>FPL COACH · LIVE SUMMARY</span><h3>{title}</h3><p>{detail}</p><button onClick={()=>{go(target);setOpen(false)}}>Inspect the evidence →</button></div>}</aside>}
