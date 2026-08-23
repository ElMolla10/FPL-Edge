"use client";

import { useEffect, useMemo, useState } from "react";
import LiveDraftBuilder from "./LiveDraftBuilder";
import { ChipScores, LiveChips, LiveHistory, chipScoresForEvent } from "./LiveIntelligence";
import { FplData, FplEvent, FplFixture, FplPlayer, PROJECTION_MODEL_VERSION, PlayerCalibrationGroup, ProjectionMetrics, bestXi, fetchFplData, futureEvents, isValidSquad, playerCalibrationProfile, playerProjection, projectionMetrics, savedSquad, simulateAutosubs } from "../lib/fpl";
import { createOptimizer } from "../lib/optimizer";
import { AnomalyFlag, FiveGwGainBand, classifyFiveGwGain, transferAnomalies } from "../lib/anomalies";
import { DoubleGameweek, detectFixtureAnomalies, nearestInHorizon } from "../lib/dgw";
import { persist, syncWithServer } from "../lib/persistence";
import { MODEL_RELEASES, comparableModelRows, groupByModelVersion, modelDisplayName, modelRelease } from "../lib/model-version";
import { BenchOrderResult, modeledAppearanceProbability, optimizeBenchOrder } from "../lib/bench-order";

type View="overview"|"team"|"transfers"|"draft"|"players"|"fixtures"|"news"|"deadline"|"chips"|"model"|"history";
export type OfficialPick={elementId:number;position:number;multiplier:number;isCaptain:boolean;isViceCaptain:boolean;sellingPrice?:number|null};
type ManagerMeta={id:number;name:string;teamName:string;overallPoints:number;overallRank:number;gameweekPoints:number;gameweekRank:number;squadValue:number|null;bank:number|null;transfersMade:number;transferCost:number;captainId:number|null;viceCaptainId:number|null;chip:string|null;event?:number;picks?:OfficialPick[]};
export type Transfer={
  out:FplPlayer;incoming:FplPlayer;
  gain1:number;gain3:number;gain5:number;
  individualGain1:number;individualGain3:number;individualGain5:number;
  outGw1:number;inGw1:number;outGw3:number;inGw3:number;outGw5:number;inGw5:number;
  price:number;minutes:number;expectedMinutesOut:number;expectedMinutesIn:number;
  startProbOut:number;startProbIn:number;
  dcOut:number;dcIn:number;attackingOut:number;attackingIn:number;
  fixtureAdjustmentIn:number;confidenceOut:number;confidenceIn:number;
  teamAttackIn:number;teamDefenceIn:number;opponentDefenceIn:number;opponentAttackIn:number;fixtureAttackMultiplierIn:number;fixtureDefenceMultiplierIn:number;
  gainBand:FiveGwGainBand;anomalies:AnomalyFlag[];
  hitCost:number;netDifference:number;utilityChange:number|null;
  rankScore:number;reviewRequired:boolean;
  weeklyGains:number[];positiveWeeks:number;gainWithoutBestWeek:number;
  qualityStatus:TransferQualityStatus;qualityScore:number;qualityReasons:TransferQualityReason[];
  risk:"Low"|"Medium"|"High";
};

export type TransferQualityStatus="actionable"|"watchlist"|"blocked";
export type TransferQualityReason={code:string;message:string};
export type TransferQualityInput={
  gain1:number;gain3:number;gain5:number;weeklyGains:number[];
  expectedMinutes:number;startProbability:number;confidence:number;
  calibrationGroup:PlayerCalibrationGroup;lowPlContinuityClub:boolean;
  anomalyCodes:string[];
};
export type TransferQuality={
  status:TransferQualityStatus;score:number;reasons:TransferQualityReason[];
  positiveWeeks:number;gainWithoutBestWeek:number;
};

const qualityOrder:Record<TransferQualityStatus,number>={actionable:0,watchlist:1,blocked:2};
const clamp01=(value:number)=>Math.max(0,Math.min(1,value));

// A projection can be numerically attractive without being credible enough to act on. This pure
// gate makes that distinction before ranking, rather than attaching warnings after a row is #1.
export function evaluateTransferQuality(input:TransferQualityInput):TransferQuality{
  const positiveWeeks=input.weeklyGains.filter(gain=>gain>.05).length;
  const bestWeek=input.weeklyGains.length?Math.max(...input.weeklyGains):0;
  const gainWithoutBestWeek=input.gain5-bestWeek;
  const evidence=input.calibrationGroup==="established-pl"?1:input.calibrationGroup==="current-pl-established"?.9:input.calibrationGroup==="limited-pl"?.55:.35;
  const continuity=input.lowPlContinuityClub?.8:1;
  const robustness=.65*(positiveWeeks/Math.max(1,input.weeklyGains.length))+.35*clamp01((gainWithoutBestWeek+1)/3);
  const rawScore=Math.round(100*(.30*clamp01(input.startProbability)+.25*clamp01(input.confidence)+.20*clamp01(input.expectedMinutes/90)+.15*robustness+.10*evidence*continuity));
  const reasons:TransferQualityReason[]=[];
  const hard=(code:string,message:string)=>reasons.push({code,message});
  const watch=(code:string,message:string)=>reasons.push({code,message});
  const severe=new Set(["five-gw-gain-anomaly","low-certainty-elite-projection","high-risk-top-recommendation"]);
  const severeFlags=input.anomalyCodes.filter(code=>severe.has(code));
  if(severeFlags.length)hard("projection-plausibility",`Projection failed ${severeFlags.length} hard plausibility check${severeFlags.length===1?"":"s"}: ${severeFlags.join(", ")}.`);
  if(input.startProbability<.55)hard("insufficient-start-probability",`Only ${Math.round(input.startProbability*100)}% start probability; this cannot be an actionable transfer.`);
  if(input.expectedMinutes<45)hard("insufficient-expected-minutes",`Only ${Math.round(input.expectedMinutes)} expected minutes; role security is below the action floor.`);
  if(input.confidence<.35)hard("insufficient-model-confidence",`Model confidence is only ${Math.round(input.confidence*100)}%, below the hard safety floor.`);
  const hasHard=reasons.length>0;
  if(!hasHard){
    if(input.startProbability<.70)watch("start-probability-watch",`${Math.round(input.startProbability*100)}% start probability needs confirmation before acting.`);
    if(input.expectedMinutes<60)watch("minutes-watch",`${Math.round(input.expectedMinutes)} expected minutes makes the route too role-sensitive for the primary recommendation.`);
    if(input.confidence<.60)watch("confidence-watch",`${Math.round(input.confidence*100)}% model confidence is below the actionable threshold.`);
    if(input.calibrationGroup==="no-pl-prior")watch("no-pl-evidence",`No genuine prior-season Premier League evidence; wait for a stable top-flight sample.`);
    if(input.calibrationGroup==="limited-pl")watch("limited-pl-evidence",`Limited prior-season Premier League evidence; recommendation remains provisional.`);
    if(input.lowPlContinuityClub)watch("low-club-continuity",`The incoming player's club has limited roster-level Premier League continuity.`);
    if(input.gain5<=0)watch("no-projected-gain",`The route does not improve the optimized squad across the five-gameweek horizon.`);
    if(positiveWeeks<2||gainWithoutBestWeek<=0)watch("single-week-dependence",`The five-gameweek gain does not remain positive after removing its single best gameweek.`);
    if(input.gain5>0&&input.gain3<=0)watch("timing-not-ready",`The route is positive over five gameweeks but not over the next three; monitor rather than move now.`);
  }
  const status:TransferQualityStatus=hasHard?"blocked":reasons.length?"watchlist":"actionable";
  const score=status==="blocked"?Math.min(rawScore,39):status==="watchlist"?Math.min(rawScore,69):rawScore;
  return{status,score,reasons,positiveWeeks,gainWithoutBestWeek};
}

export function sortTransfersByQuality(rows:Transfer[]):Transfer[]{
  return [...rows].sort((a,b)=>qualityOrder[a.qualityStatus]-qualityOrder[b.qualityStatus]||b.rankScore-a.rankScore||b.netDifference-a.netDifference);
}

export function selectPrimaryTransfer(rows:Transfer[],threshold=2.2):Transfer|null{
  return sortTransfersByQuality(rows).find(row=>row.qualityStatus==="actionable"&&row.rankScore>=threshold)??null;
}

const nav:[View,string,string][]=[
  ["overview","Overview","⌂"],["team","My team","◫"],["transfers","Transfers","⇄"],["draft","Draft lab","◇"],["players","Players","⌕"],["fixtures","Fixtures","▦"],["news","News","●"],["deadline","Final check","✓"],["chips","Chips","★"],["model","Points model","∑"],["history","History","↗"],
];
const titles:Record<View,string>={overview:"Your gameweek command centre",team:"My team",transfers:"Transfer centre",draft:"Draft & Wildcard lab",players:"Player research",fixtures:"Fixture intelligence",news:"Personalised news",deadline:"Deadline final check",chips:"Chip planner",model:"How the model thinks",history:"Decision history"};
const fmt=(n:number|null|undefined)=>n?Math.round(n).toLocaleString():"—";
const clamp=(n:number,min=0,max=100)=>Math.max(min,Math.min(max,n));
const readIds=(key:string)=>{try{return JSON.parse(localStorage.getItem(key)||"[]") as number[]}catch{return[]}};
const readFreeTransfers=()=>{try{const value=Number(localStorage.getItem("fpl-edge-free-transfers"));return Number.isInteger(value)&&value>=0&&value<=5?value:1}catch{return 1}};
const certainty=(p:FplPlayer)=>p.status!=="a"?"CONFIRMED":projectionMetrics(p,0,[],0).startProbability>.72?"LIKELY":"UNCERTAIN";

export function opponent(player:FplPlayer,eventId:number,data:FplData){const games=data.fixtures.filter(f=>f.event===eventId&&(f.teamH===player.teamId||f.teamA===player.teamId));if(!games.length)return"BLANK";return games.map(fixture=>{const home=fixture.teamH===player.teamId;const id=home?fixture.teamA:fixture.teamH;return`${data.teams.find(t=>t.id===id)?.short??"—"} ${home?"H":"A"}`}).join(", ")}
function freshness(updatedAt:string){const minutes=Math.max(0,Math.floor((Date.now()-Date.parse(updatedAt))/60000));return{minutes,label:minutes<2?"just now":`${minutes}m ago`,tone:minutes<=10?"fresh":minutes<=30?"aging":"stale"}}
function startPct(p:FplPlayer,event:number,data:FplData){return Math.round(projectionMetrics(p,event,data.fixtures,event).startProbability*100)}
function expectedMins(p:FplPlayer,event:number,data:FplData){return Math.round(projectionMetrics(p,event,data.fixtures,event).expectedMinutes)}

export default function CoachApp({onBack}:{onBack:()=>void}){
  const[view,setView]=useState<View>("overview");const[data,setData]=useState<FplData|null>(null);const[error,setError]=useState("");const[loading,setLoading]=useState(true);const[revision,setRevision]=useState(0);const[more,setMore]=useState(false);
  const load=async()=>{setLoading(true);setError("");try{setData(await fetchFplData())}catch(e){setError(e instanceof Error?e.message:"Official FPL data unavailable")}finally{setLoading(false)}};
  useEffect(()=>{load();const id=window.setInterval(load,300000);return()=>window.clearInterval(id)},[]);
  const runSync=()=>{syncWithServer().then(changed=>{if(changed)setRevision(x=>x+1)})};
  useEffect(()=>{runSync()},[]);
  const go=(next:View)=>{setView(next);setRevision(x=>x+1);setMore(false);window.scrollTo({top:0,behavior:"smooth"})};
  const fresh=data?freshness(data.updatedAt):null;
  return <main className="coach-shell">
    <aside className="coach-sidebar"><button className="brand sidebar-brand" onClick={onBack}><span className="brand-mark">E</span><span>FPL EDGE</span></button><nav>{nav.map(([key,label,icon],i)=><button key={key} className={view===key?"active":""} onClick={()=>go(key)}><i>{icon}</i><span><small>{String(i+1).padStart(2,"0")}</small>{label}</span></button>)}</nav><div className="coach-data-note"><span className={`fresh-dot ${fresh?.tone||"stale"}`}/><div><b>{fresh?`Data ${fresh.label}`:"Connecting…"}</b><small>Official FPL feed</small></div></div><AccountBar onAuthChange={runSync}/><button className="back-link" onClick={onBack}>← Back to site</button></aside>
    <section className="coach-main"><header className="coach-header"><div><p>FPL EDGE · DECISION ENGINE</p><h1>{titles[view]}</h1></div>{data&&<DeadlineClock data={data}/>}</header>
      {loading&&!data?<Loading label="Loading your FPL decision engine…"/>:error&&!data?<Loading label={error} retry={load}/>:data?<><Freshness data={data} onRefresh={load} loading={loading}/><Page view={view} data={data} go={go} revision={revision}/><p className="truth-note">Official FPL supplies players, prices, fixtures, flags and results. FPL Edge projections and recommendations are estimates with uncertainty—not guarantees.</p><CoachDock data={data} go={go} revision={revision}/></>:null}
    </section>
    <nav className="coach-mobile-nav"><button className={view==="overview"?"active":""} onClick={()=>go("overview")}><i>⌂</i>Home</button><button className={view==="team"?"active":""} onClick={()=>go("team")}><i>◫</i>Team</button><button className={view==="transfers"?"active":""} onClick={()=>go("transfers")}><i>⇄</i>Transfers</button><button className={view==="players"?"active":""} onClick={()=>go("players")}><i>⌕</i>Players</button><button className={more?"active":""} onClick={()=>setMore(x=>!x)}><i>•••</i>More</button></nav>
    {more&&<div className="mobile-more">{nav.slice(3).filter(x=>x[0]!=="players").map(([key,label,icon])=><button key={key} onClick={()=>go(key)}><i>{icon}</i>{label}</button>)}</div>}
  </main>
}

function Page({view,data,go,revision}:{view:View;data:FplData;go:(v:View)=>void;revision:number}){
  if(view==="overview")return <Overview data={data} go={go} revision={revision}/>;
  if(view==="team")return <Team data={data} go={go} revision={revision}/>;
  if(view==="transfers")return <Transfers data={data} go={go} revision={revision}/>;
  if(view==="draft")return <LiveDraftBuilder/>;
  if(view==="players")return <Players data={data} go={go} revision={revision}/>;
  if(view==="fixtures")return <div className="coach-page"><TeamQualityPanel data={data}/><TeamQualityFixtures data={data}/></div>;
  if(view==="news")return <News data={data} go={go} revision={revision}/>;
  if(view==="deadline")return <FinalCheck data={data} go={go} revision={revision}/>;
  if(view==="chips")return <LiveChips/>;
  if(view==="model")return <div className="coach-page"><ModelVersionPanel/><TeamQualityPanel data={data}/><PointsModel data={data}/></div>;
  return <div className="coach-page"><ModelAudit data={data} revision={revision}/><LiveHistory/></div>;
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

function useManager(){const[meta,setMeta]=useState<ManagerMeta|null>(null);useEffect(()=>{try{setMeta(JSON.parse(localStorage.getItem("fpl-edge-manager")||"null"))}catch{}},[]);return[meta,setMeta] as const}
const sellingPricesFor=(meta:ManagerMeta|null)=>new Map((meta?.picks??[]).flatMap(pick=>pick.sellingPrice!==null&&pick.sellingPrice!==undefined?[[pick.elementId,pick.sellingPrice] as [number,number]]:[]));
function ConnectTeam({data,onConnected}:{data:FplData;onConnected?:(m:ManagerMeta)=>void}){const[id,setId]=useState("");const[busy,setBusy]=useState(false);const[msg,setMsg]=useState("");const connect=async()=>{if(!/^\d+$/.test(id)){setMsg("Enter the numeric Team ID from your official FPL URL.");return}setBusy(true);setMsg("");try{const response=await fetch(`/api/fpl/team?entry=${id}`,{cache:"no-store"});const json=await response.json();if(!response.ok)throw new Error(json.error||"Could not connect team");const ids=(json.playerIds as number[]).filter(pid=>data.players.some(p=>p.id===pid));if(ids.length!==15)throw new Error("FPL did not return a complete public squad.");persist("fpl-edge-squad",JSON.stringify(ids));persist("fpl-edge-entry",id);persist("fpl-edge-manager",JSON.stringify(json.manager));localStorage.setItem("fpl-edge-squad-saved-at",new Date().toISOString());setMsg(`${json.manager.teamName} connected. Your coach is ready.`);onConnected?.(json.manager)}catch(e){setMsg(e instanceof Error?e.message:"Could not connect team")}finally{setBusy(false)}};return <section className="connect-hero"><div><span>START HERE</span><h2>Connect your official FPL team</h2><p>Enter the number in your FPL team URL. Read-only: we never ask for your password or make changes to your official team.</p></div><div><input value={id} onChange={e=>setId(e.target.value.replace(/\D/g,""))} placeholder="FPL Team ID" inputMode="numeric"/><button onClick={connect} disabled={busy}>{busy?"Connecting…":"Connect my team →"}</button><small>{msg||"Current public squad becomes available after its deadline."}</small></div></section>}

export function benchOrderForEvent(xi:FplPlayer[],bench:FplPlayer[],eventId:number,data:Pick<FplData,"fixtures">):BenchOrderResult{
  return optimizeBenchOrder(xi,bench,player=>{const metrics=projectionMetrics(player,eventId,data.fixtures,eventId);return{xPts:metrics.xPts,appearanceProbability:modeledAppearanceProbability(player,metrics)}});
}
export function analysis(data:FplData,squad:FplPlayer[]){const events=futureEvents(data,5);if(!events.length||!isValidSquad(squad,data))return null;const first=events[0].id;const xi=bestXi(squad,first,data.fixtures,first);const rawBench=squad.filter(p=>!xi.players.some(x=>x.id===p.id));const benchOrder=benchOrderForEvent(xi.players,rawBench,first,data);const bench=benchOrder.bench;const vice=[...xi.players].sort((a,b)=>playerProjection(b,first,data.fixtures,first)-playerProjection(a,first,data.fixtures,first))[1];const issues=squad.filter(p=>p.status!=="a"||startPct(p,first,data)<68).sort((a,b)=>startPct(a,first,data)-startPct(b,first,data));const cost=squad.reduce((s,p)=>s+p.price,0);return{events,first,xi,bench,benchOrder,vice,issues,cost,bank:Math.max(0,data.rules.budget-cost)}}
export function bestTransfers(data:FplData,squad:FplPlayer[],bank:number,freeTransfers=1,limit=12,sellingPrices=new Map<number,number>()):Transfer[]{
  const events=futureEvents(data,5);if(!events.length||!isValidSquad(squad,data))return[];
  const first=events[0].id;const owned=new Set(squad.map(p=>p.id));
  const clubCount=new Map<number,number>();squad.forEach(p=>clubCount.set(p.teamId,(clubCount.get(p.teamId)||0)+1));
  const hitCost=freeTransfers>=1?0:4;
  const projectionCache=new Map<string,number>();
  const projected=(player:FplPlayer,eventId:number)=>{const key=`${player.id}:${eventId}`;if(!projectionCache.has(key))projectionCache.set(key,playerProjection(player,eventId,data.fixtures,first));return projectionCache.get(key)!};
  const squadWeekTotal=(players:FplPlayer[],eventId:number)=>{let best=0;const score=(p:FplPlayer)=>projected(p,eventId);const keepers=players.filter(p=>p.positionShort==="GKP").sort((a,b)=>score(b)-score(a));for(let def=3;def<=5;def++)for(let mid=2;mid<=5;mid++){const fwd=10-def-mid;if(fwd<1||fwd>3)continue;const xi=[keepers[0],...players.filter(p=>p.positionShort==="DEF").sort((a,b)=>score(b)-score(a)).slice(0,def),...players.filter(p=>p.positionShort==="MID").sort((a,b)=>score(b)-score(a)).slice(0,mid),...players.filter(p=>p.positionShort==="FWD").sort((a,b)=>score(b)-score(a)).slice(0,fwd)].filter(Boolean);if(xi.length!==11)continue;const captain=[...xi].sort((a,b)=>score(b)-score(a))[0];best=Math.max(best,xi.reduce((sum,p)=>sum+score(p),0)+score(captain))}return best};
  const baselineSquadByEvent=events.map(event=>squadWeekTotal(squad,event.id));
  const rows:Transfer[]=[];
  for(const out of squad){
    const om=projectionMetrics(out,first,data.fixtures,first);
    const outByEvent=events.map(e=>projected(out,e.id));
    const outGw1=outByEvent[0]||0,outGw3=outByEvent.slice(0,3).reduce((a,b)=>a+b,0),outGw5=outByEvent.reduce((a,b)=>a+b,0);
    for(const incoming of data.players){
      const saleValue=sellingPrices.get(out.id)??out.price;
      if(owned.has(incoming.id)||incoming.positionId!==out.positionId||incoming.status==="u"||incoming.price>saleValue+bank+.001)continue;
      if(incoming.teamId!==out.teamId&&(clubCount.get(incoming.teamId)||0)>=3)continue;
      const im=projectionMetrics(incoming,first,data.fixtures,first);
      const inByEvent=events.map(e=>projected(incoming,e.id));
      const inGw1=inByEvent[0]||0,inGw3=inByEvent.slice(0,3).reduce((a,b)=>a+b,0),inGw5=inByEvent.reduce((a,b)=>a+b,0);
      const individualGain1=inGw1-outGw1,individualGain3=inGw3-outGw3,individualGain5=inGw5-outGw5;
      const swapped=squad.map(player=>player.id===out.id?incoming:player);
      const swappedSquadByEvent=events.map(event=>squadWeekTotal(swapped,event.id));
      const squadDeltas=swappedSquadByEvent.map((total,index)=>total-baselineSquadByEvent[index]);
      const gain1=squadDeltas[0]||0,gain3=squadDeltas.slice(0,3).reduce((a,b)=>a+b,0),gain5=squadDeltas.reduce((a,b)=>a+b,0);
      const risk=im.startProbability>.8&&im.startProbability>=om.startProbability?"Low":im.startProbability>.62?"Medium":"High";
      const perEventDifficultyIn=events.map(e=>{const games=data.fixtures.filter(f=>f.event===e.id&&(f.teamH===incoming.teamId||f.teamA===incoming.teamId));return games.length?games.reduce((s,f)=>s+(f.teamH===incoming.teamId?f.teamHDifficulty:f.teamADifficulty),0)/games.length:null}).filter((v):v is number=>v!==null);
      const fixtureAdjustmentIn=perEventDifficultyIn.length?perEventDifficultyIn.reduce((a,b)=>a+b,0)/perEventDifficultyIn.length:3;
      const gainBand=classifyFiveGwGain(gain5);
      const anomalies=transferAnomalies(out,incoming,gain5,om,im);
      const calibration=playerCalibrationProfile(incoming);
      const quality=evaluateTransferQuality({gain1,gain3,gain5,weeklyGains:squadDeltas,expectedMinutes:im.expectedMinutes,startProbability:im.startProbability,confidence:im.confidence,calibrationGroup:calibration.group,lowPlContinuityClub:calibration.lowPlContinuityClub,anomalyCodes:anomalies.map(flag=>flag.code)});
      const reviewRequired=quality.status==="blocked";
      const confidenceMultiplier=clamp(.55+im.startProbability*.25+im.confidence*.2,.55,1);
      const riskAdjustedGain=(gain5>0?gain5*confidenceMultiplier:gain5)-hitCost;
      const qualityAdjustedGain=riskAdjustedGain*(.7+quality.score*.003);
      const rankScore=quality.status==="blocked"?Math.min(0,qualityAdjustedGain):quality.status==="watchlist"?Math.min(2.19,qualityAdjustedGain):qualityAdjustedGain;
      rows.push({
        out,incoming,gain1,gain3,gain5,individualGain1,individualGain3,individualGain5,
        outGw1,inGw1,outGw3,inGw3,outGw5,inGw5,
        price:incoming.price-out.price,minutes:im.expectedMinutes-om.expectedMinutes,
        expectedMinutesOut:om.expectedMinutes,expectedMinutesIn:im.expectedMinutes,
        startProbOut:om.startProbability,startProbIn:im.startProbability,
        dcOut:om.defensiveContribution,dcIn:im.defensiveContribution,
        attackingOut:om.xG+om.xA,attackingIn:im.xG+im.xA,
        fixtureAdjustmentIn,confidenceOut:om.confidence,confidenceIn:im.confidence,
        teamAttackIn:im.teamAttackFactor??1,teamDefenceIn:im.teamDefenceFactor??1,opponentDefenceIn:im.opponentDefenceFactor??1,opponentAttackIn:im.opponentAttackFactor??1,fixtureAttackMultiplierIn:im.fixtureAttackMultiplier??1,fixtureDefenceMultiplierIn:im.fixtureDefenceMultiplier??1,
        gainBand,anomalies,hitCost,netDifference:gain5-hitCost,utilityChange:null,rankScore,reviewRequired,
        weeklyGains:squadDeltas,positiveWeeks:quality.positiveWeeks,gainWithoutBestWeek:quality.gainWithoutBestWeek,
        qualityStatus:quality.status,qualityScore:quality.score,qualityReasons:quality.reasons,
        risk,
      });
    }
  }
  return sortTransfersByQuality(rows).slice(0,limit);
}

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

function Overview({data,go,revision}:{data:FplData;go:(v:View)=>void;revision:number}){const[meta,setMeta]=useManager();const squad=useMemo(()=>savedSquad(data),[data,revision,meta]);const a=analysis(data,squad);if(!a)return <><ConnectTeam data={data} onConnected={setMeta}/><section className="empty-command"><span>MANUAL OPTION</span><h2>Already know your draft?</h2><p>Build and save it manually. Your recommendations, transfer centre and deadline check will activate immediately.</p><button onClick={()=>go("draft")}>Build a squad →</button></section></>;const moves=bestTransfers(data,squad,(meta?.bank??a.bank),1,12,sellingPricesFor(meta));const move=moves[0];const roll=!move||move.reviewRequired||move.rankScore<2.2;const issues=a.issues;const next=a.events[0];let manager:ManagerMeta|null=null;try{manager=JSON.parse(localStorage.getItem("fpl-edge-manager")||"null")}catch{}const storedCaptainId=Number(localStorage.getItem(`fpl-edge-captain-${a.first}`));const storedViceId=Number(localStorage.getItem(`fpl-edge-vice-${a.first}`));const modelCaptain=a.xi.captain??a.xi.players[0];const resolvedCaptaincy=resolveCaptaincy(a.xi.players,storedCaptainId,storedViceId,manager?.captainId,manager?.viceCaptainId,modelCaptain,undefined);const activeCaptain=(resolvedCaptaincy&&a.xi.players.find(p=>p.id===resolvedCaptaincy.captainId))??modelCaptain;const projected=a.xi.players.reduce((s,p)=>s+playerProjection(p,a.first,data.fixtures,a.first),0)+playerProjection(activeCaptain,a.first,data.fixtures,a.first);return <div className="coach-page"><section className="command-top"><div><span>NEXT DEADLINE</span><h2>{next.name}</h2><p>{new Date(next.deadline).toLocaleString([],{weekday:"long",day:"numeric",month:"long",hour:"2-digit",minute:"2-digit",timeZoneName:"short"})}</p></div><DeadlineClock data={data}/></section><section className="weekly-call"><div className="call-label"><span>THIS WEEK'S RECOMMENDATION</span><b>{roll?"LIKELY":"MODEL EDGE"}</b></div><h2>{roll?"ROLL TRANSFER":`${move.out.name} → ${move.incoming.name}`}</h2><ul>{roll?<><li>No risk-adjusted squad move clears the 2.2-point five-GW action threshold.</li><li>Your current XI keeps two future transfer routes open.</li><li>Recheck official flags before the deadline.</li></>:<><li>+{move.gain5.toFixed(1)} projected squad points across five gameweeks.</li><li>{move.minutes>=0?`${Math.round(move.minutes)} extra expected minutes this week.`:"The upside is fixture-led despite lower expected minutes."}</li><li>{move.risk} modelled minutes/availability risk.</li></>}</ul><button onClick={()=>go("transfers")}>Inspect the reasoning →</button></section><div className="command-metrics"><article><span>PROJECTED GW</span><b>{projected.toFixed(1)}</b><small>including {activeCaptain.name} captaincy</small></article><article><span>SQUAD VALUE</span><b>£{(meta?.squadValue??a.cost).toFixed(1)}m</b><small>official when connected</small></article><article><span>IN THE BANK</span><b>£{(meta?.bank??a.bank).toFixed(1)}m</b><small>{meta?"official public data":"builder estimate"}</small></article><article><span>FREE TRANSFERS</span><b>Set in Transfers</b><small>not exposed publicly by FPL</small></article><article><span>OVERALL RANK</span><b>{fmt(meta?.overallRank)}</b><small>{meta?meta.teamName:"connect to reveal"}</small></article><article><span>GW RANK</span><b>{fmt(meta?.gameweekRank)}</b><small>{meta?.gameweekPoints??"—"} GW points</small></article><article><span>TOTAL POINTS</span><b>{meta?.overallPoints??"—"}</b><small>official account history</small></article></div><section className="urgent-card"><header><div><span>URGENT ISSUES</span><h2>{issues.length?`${issues.length} squad issue${issues.length>1?"s":""} to monitor`:"No urgent squad issues."}</h2></div><button onClick={()=>go("deadline")}>Open final check →</button></header>{issues.length>0&&<div>{issues.slice(0,5).map(p=><article key={p.id}><b>{p.name}</b><span className={p.status!=="a"?"bad":"warn"}>{p.status!=="a"?"CONFIRMED FLAG":"LIKELY MINUTES RISK"}</span><p>{p.news||`${startPct(p,a.first,data)}% modelled start probability.`}</p></article>)}</div>}</section><WhatChanged data={data} squad={squad}/><DgwAlert data={data}/><SquadValueAlert squad={squad}/></div>}
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

export type CaptaincyResolution={captainId:number;viceId:number};
// Pure so the exact same resolution useCaptaincy() uses (Team, Final Check) can also be called
// directly by Overview -- guarantees all three screens agree on captain/vice, rather than Overview
// maintaining its own separate, incomplete copy of this priority chain (the bug this fixes: Overview
// previously skipped the manager-captainId tier entirely).
export function resolveCaptaincy(players:FplPlayer[],storedCaptainId:number,storedViceId:number,managerCaptainId:number|null|undefined,managerViceCaptainId:number|null|undefined,modelCaptain:FplPlayer|undefined,modelVice:FplPlayer|undefined):CaptaincyResolution|null{
  if(!players.length)return null;
  const valid=(id:number|null|undefined)=>!!id&&players.some(p=>p.id===id);
  const captainId=valid(storedCaptainId)?storedCaptainId:valid(managerCaptainId)?managerCaptainId!:modelCaptain?.id??players[0].id;
  let viceId=valid(storedViceId)?storedViceId:valid(managerViceCaptainId)?managerViceCaptainId!:modelVice?.id??players.find(p=>p.id!==captainId)?.id??captainId;
  if(viceId===captainId)viceId=players.find(p=>p.id!==captainId)?.id??captainId;
  return{captainId,viceId};
}

function useCaptaincy(players:FplPlayer[],event:number,modelCaptain:FplPlayer|undefined,modelVice:FplPlayer|undefined){
  const[captainId,setCaptainId]=useState<number|null>(null);const[viceId,setViceId]=useState<number|null>(null);
  useEffect(()=>{if(!event||!players.length)return;let manager:ManagerMeta|null=null;try{manager=JSON.parse(localStorage.getItem("fpl-edge-manager")||"null")}catch{}const storedCaptain=Number(localStorage.getItem(`fpl-edge-captain-${event}`));const storedVice=Number(localStorage.getItem(`fpl-edge-vice-${event}`));const resolved=resolveCaptaincy(players,storedCaptain,storedVice,manager?.captainId,manager?.viceCaptainId,modelCaptain,modelVice);if(!resolved)return;setCaptainId(resolved.captainId);setViceId(resolved.viceId)},[event,players.map(p=>p.id).join(","),modelCaptain?.id,modelVice?.id]);
  const saveCaptaincy=(captain:number,vice:number)=>{persist(`fpl-edge-captain-${event}`,String(captain));persist(`fpl-edge-vice-${event}`,String(vice))};
  const chooseCaptain=(id:number)=>{const oldCaptain=captainId??modelCaptain?.id??players[0]?.id;const nextVice=id===viceId?oldCaptain:viceId??modelVice?.id??players.find(p=>p.id!==id)?.id??id;setCaptainId(id);setViceId(nextVice);saveCaptaincy(id,nextVice)};
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

function Team({data,go,revision}:{data:FplData;go:(v:View)=>void;revision:number}){
  const[manager,setManager]=useManager();
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

  if(!a)return <><ConnectTeam data={data}/><button className="wide-action" onClick={()=>go("draft")}>Or build manually →</button></>;

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
function Pitch({players,bench,captain,vice,event,data,onSelect}:{players:FplPlayer[];bench:FplPlayer[];captain:FplPlayer;vice:FplPlayer;event:number;data:FplData;onSelect:(p:FplPlayer)=>void}){return <><section className="coach-pitch"><div className="pitch-markings"/>{["GKP","DEF","MID","FWD"].map(pos=><div className={`coach-pitch-row ${pos.toLowerCase()}`} key={pos}>{players.filter(p=>p.positionShort===pos).map(p=><button key={p.id} className={p.status!=="a"||startPct(p,event,data)<68?"flagged":""} onClick={()=>onSelect(p)}><i>{pos}</i><b>{p.name}{p.id===captain.id&&<em>C</em>}{p.id===vice.id&&<em>V</em>}</b><span>{opponent(p,event,data)} · {playerProjection(p,event,data.fixtures,event).toFixed(1)} xPts</span><small>{startPct(p,event,data)}% start</small></button>)}</div>)}</section><section className="coach-bench"><span>BENCH ORDER</span>{bench.map((p,i)=><button key={p.id} onClick={()=>onSelect(p)}><i>{i+1}</i><b>{p.name}</b><small>{opponent(p,event,data)} · {playerProjection(p,event,data.fixtures,event).toFixed(1)}</small></button>)}</section></>}
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
      <div>
        <span>{resolved.source==="official"?"OFFICIAL RESULT":"YOUR LOCKED PLAN"}</span>
        <h2>{resolved.totalPoints!==null?`${resolved.totalPoints} points`:resolved.predictedPoints!==null?`${resolved.predictedPoints} projected`:"—"}</h2>
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

  return <div className="gw-current">
    <section className="team-toolbar"><div><span>FORMATION</span><b>{formation(scoring.effectiveXi)}</b></div><div><span>{hasStarted?"LIVE POINTS":"KICKOFF PENDING"}</span><b>{hasStarted?scoring.liveTotal:"—"}</b></div>{scoring.activeChip&&<div><span>ACTIVE CHIP</span><b>{scoring.activeChip==="3xc"?"Triple Captain":scoring.activeChip==="bboost"?"Bench Boost":scoring.activeChip}</b></div>}<div className="segmented">{(["Pitch","List"] as const).map(x=><button className={tab===x?"active":""} onClick={()=>setTab(x)} key={x}>{x}</button>)}</div><button onClick={()=>go("draft")}>Edit squad</button></section>
    {!hasStarted&&<p className="gw-pending-note">{event.name}'s matches haven't kicked off yet -- live points will appear here once they do.</p>}
    {hasStarted&&!allFixturesFinished&&<p className="gw-pending-note">Some of this gameweek's matches are still in progress -- a player showing 0 minutes may not have played yet. Final XI and automatic substitutions appear once every match finishes.</p>}
    {allFixturesFinished&&!event.dataChecked&&<p className="gw-pending-note">Bonus points aren't final yet -- FPL confirms them a few hours after the last match of the gameweek.</p>}
    {scoring.swaps.length>0&&<section className="gw-autosub-note"><span>AUTOMATIC SUBSTITUTIONS</span>{scoring.swaps.map((s,i)=><p key={i}><b>{s.inName}</b> came on for <b>{s.outName}</b> (0 minutes)</p>)}</section>}
    {scoring.armbandPassedToVice&&<p className="gw-armband-note">{captain.name} didn't play -- the armband passed to {vice.name} ({vice.name}'s score is {multiplierWord}).</p>}
    {scoring.captaincyLost&&<p className="gw-armband-note">Neither {captain.name} nor {vice.name} played -- no captain multiplier applies this week.</p>}
    {scoring.activeChip==="bboost"&&<p className="gw-chip-note">Bench Boost is active · {scoring.benchBoostPoints} bench points are included in the live total.</p>}
    <CaptaincyPicker players={xi} captain={captain} vice={vice} onCaptain={chooseCaptain} onVice={chooseVice} event={event.id} data={data} readOnly={officialLocked} status={captaincyStatus}/>
    {tab==="Pitch"&&<><section className="coach-pitch"><div className="pitch-markings"/>{["GKP","DEF","MID","FWD"].map(pos=><div className={`coach-pitch-row ${pos.toLowerCase()}`} key={pos}>{scoring.effectiveXi.filter(p=>p.positionShort===pos).map(p=>{const isArmband=p.id===scoring.effectiveCaptainId;const wasSubbedIn=scoring.swaps.some(s=>s.inId===p.id);return <button key={p.id} className={p.status!=="a"?"flagged":""} onClick={()=>setSelected(p)}><i>{pos}{wasSubbedIn?" · AUTO":""}</i><b>{p.name}{isArmband&&<em>C</em>}{p.id===scoring.viceId&&!isArmband&&<em>V</em>}</b><span>{hasStarted?`${p.eventPoints}${isArmband&&scoring.captainMultiplier>1?` × ${scoring.captainMultiplier}`:""} pts`:opponent(p,event.id,data)}</span><small>{hasStarted?`${p.eventMinutes} mins`:""}</small></button>})}</div>)}</section>
    <section className="coach-bench"><span>{scoring.activeChip==="bboost"?"BENCH BOOST":"BENCH"}</span>{scoring.displayedBench.map((p,i)=><button key={p.id} onClick={()=>setSelected(p)}><i>{i+1}</i><b>{p.name}</b><small>{hasStarted?`${p.eventPoints} pts · ${p.eventMinutes} mins${scoring.activeChip==="bboost"?" · COUNTED":""}`:opponent(p,event.id,data)}</small></button>)}</section></>}
    {tab==="List"&&<section className="team-list"><header><span>PLAYER</span><span>FIXTURE</span><span>PTS</span><span>MINS</span><span>STATUS</span></header>{[...scoring.effectiveXi,...scoring.displayedBench].map((p,i)=>{const isArmband=p.id===scoring.effectiveCaptainId;return <button key={p.id} onClick={()=>setSelected(p)}><b>{i<scoring.effectiveXi.length?"XI":"BENCH"} · {p.name}{isArmband?" (C)":p.id===scoring.viceId?" (V)":""}<small>{p.teamShort} · {p.positionShort}</small></b><span>{opponent(p,event.id,data)}</span><strong>{p.eventPoints}{isArmband&&scoring.captainMultiplier>1?` × ${scoring.captainMultiplier}`:""}</strong><span>{p.eventMinutes}</span><em className={p.status==="a"?"ok":"risk"}>{i>=scoring.effectiveXi.length&&scoring.activeChip==="bboost"?"COUNTED":p.status==="a"?"LIKELY":"FLAGGED"}</em></button>})}</section>}
    {selected&&hasStarted&&<LivePointsPanel player={selected} scoring={scoring} close={()=>setSelected(null)}/>}
    {selected&&!hasStarted&&<PlayerPanel player={selected} data={data} first={planningFirst} replacements={replacement} close={()=>setSelected(null)}/>}
  </div>;
}

function LivePointsPanel({player,scoring,close}:{player:FplPlayer;scoring:LiveScoringResult;close:()=>void}){
  const inXi=scoring.effectiveXi.some(p=>p.id===player.id);
  const onBoostedBench=scoring.activeChip==="bboost"&&scoring.displayedBench.some(p=>p.id===player.id);
  const multiplier=player.id===scoring.effectiveCaptainId?scoring.captainMultiplier:1;
  const counted=inXi||onBoostedBench;
  const countedPoints=counted?player.eventPoints*multiplier:0;
  return <div className="player-panel-backdrop" onClick={close}><aside className="player-panel live-points-panel" onClick={e=>e.stopPropagation()}><button className="panel-close" onClick={close}>×</button><span>OFFICIAL LIVE POINTS</span><h2>{player.name}</h2><div className="panel-price">{countedPoints} counted points <small>{player.eventMinutes} minutes</small></div><div className="panel-stats"><p><span>Official raw points</span><b>{player.eventPoints}</b></p><p><span>Multiplier</span><b>×{multiplier}</b></p><p><span>Captain bonus</span><b>+{player.id===scoring.effectiveCaptainId?scoring.captainBonus:0}</b></p><p><span>Squad role</span><b>{inXi?"Starting XI":onBoostedBench?"Bench Boost":"Bench"}</b></p><p><span>Active chip</span><b>{scoring.activeChip==="3xc"?"Triple Captain":scoring.activeChip==="bboost"?"Bench Boost":"None"}</b></p><p><span>Included in total</span><b>{counted?"Yes":"No"}</b></p></div><section><span>COUNTING RULE</span><p>{player.id===scoring.effectiveCaptainId?`${player.eventPoints} raw points × ${multiplier} = ${countedPoints}.`:onBoostedBench?`${player.eventPoints} bench points are included because Bench Boost is active.`:inXi?`${player.eventPoints} official points count once in the starting XI.`:"This bench player's points are not included without Bench Boost or an automatic substitution."}</p></section></aside></div>;
}

function FutureGameweekView({data,event,squad,tab,setTab,selected,setSelected,bank}:{data:FplData;event:FplEvent;squad:FplPlayer[];tab:"Pitch"|"List";setTab:(t:"Pitch"|"List")=>void;selected:FplPlayer|null;setSelected:(p:FplPlayer|null)=>void;bank:number}){
  const xiResult=bestXi(squad,event.id,data.fixtures,event.id);
  const xi=xiResult.players;
  const bench=benchOrderForEvent(xi,squad.filter(p=>!xi.some(x=>x.id===p.id)),event.id,data).bench;
  const replacement=bestTransfers(data,squad,bank).filter(x=>selected&&x.out.id===selected.id&&x.qualityStatus!=="blocked").slice(0,3);
  const gwFixtures=data.fixtures.filter(f=>f.event===event.id);

  return <div className="gw-future">
    <section className="gw-provisional-note"><span>PROVISIONAL</span><h2>Today's squad against {event.name}'s fixtures.</h2><p>No transfers have been made for this week yet -- this is where your squad stands right now, not a locked plan. Come back closer to the deadline as news and fixtures firm up.</p></section>
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

function Transfers({data,go,revision}:{data:FplData;go:(v:View)=>void;revision:number}){
  const squad=useMemo(()=>savedSquad(data),[data,revision]);
  const[meta]=useManager();const[tab,setTab]=useState<"moves"|"watchlist">("moves");const[fts,setFts]=useState(readFreeTransfers);
  const[watchIds,setWatchIds]=useState<number[]>([]);useEffect(()=>setWatchIds(readIds("fpl-edge-watchlist")),[]);
  const[expanded,setExpanded]=useState<Set<string>>(new Set());
  const a=analysis(data,squad);
  const optimizer=useMemo(()=>data?createOptimizer(data,"Balanced 5 GWs","Balanced","Maximum xPts"):null,[data]);
  const bank=meta?.bank??a?.bank??0;
  const baseRows=useMemo(()=>a?bestTransfers(data,squad,bank,fts,60,sellingPricesFor(meta)):[],[data,squad,bank,fts,a,meta]);
  const rows=useMemo(()=>withModelUtilityChange(baseRows,squad,optimizer),[baseRows,squad,optimizer]);
  if(!a)return <><ConnectTeam data={data}/><button className="wide-action" onClick={()=>go("draft")}>Build manually instead →</button></>;
  const best=selectPrimaryTransfer(rows);const roll=!best;
  const actionableRows=rows.filter(row=>row.qualityStatus==="actionable");
  const watchlistRows=rows.filter(row=>row.qualityStatus==="watchlist");
  const blockedRows=rows.filter(row=>row.qualityStatus==="blocked");
  const holdNote=transferHoldNote(nearestInHorizon(detectFixtureAnomalies(data).doubles,futureEvents(data,5).map(e=>e.id)),roll);
  const setWatch=(id:number)=>{const next=watchIds.includes(id)?watchIds.filter(x=>x!==id):[...watchIds,id];setWatchIds(next);persist("fpl-edge-watchlist",JSON.stringify(next))};
  const toggleExpand=(key:string)=>setExpanded(x=>{const next=new Set(x);next.has(key)?next.delete(key):next.add(key);return next});
  return <div className="coach-page">
    <section className="transfer-tabs"><button className={tab==="moves"?"active":""} onClick={()=>setTab("moves")}>Transfer centre</button><button className={tab==="watchlist"?"active":""} onClick={()=>setTab("watchlist")}>Watchlist <b>{watchIds.length}</b></button><label>Free transfers <select value={fts} onChange={e=>{const next=Number(e.target.value);setFts(next);localStorage.setItem("fpl-edge-free-transfers",String(next))}}>{[0,1,2,3,4,5].map(x=><option key={x}>{x}</option>)}</select></label></section>
    {tab==="moves"?<>
      <section className="recommended-move">
        <div className="call-label"><span>RECOMMENDED MOVE</span><b>{roll?"SAVE":"QUALITY-GATED EDGE"}</b></div>
        <h2>{roll?"ROLL":`${best.out.name} → ${best.incoming.name}`}</h2>
        <p>{roll?"No actionable single transfer clears both the 2.2-point threshold and the evidence, minutes, confidence and robustness gates.":`This is the highest-ranked legal route that passed every quality gate. ${best.risk} minutes risk.`}</p>
        {!roll&&<div>{[["GW","1",best.gain1],["NEXT","3",best.gain3],["NEXT","5",best.gain5]].map(([label,n,value])=><span key={String(n)}><small>{label} {n}</small><b>{Number(value)>=0?"+":""}{Number(value).toFixed(1)} pts</b></span>)}<span><small>PRICE DIFFERENCE</small><b>{`${best.price>=0?"+":"−"}£${Math.abs(best.price).toFixed(1)}m`}</b></span><span><small>EXPECTED MINUTES</small><b>{`${best.minutes>=0?"+":""}${Math.round(best.minutes)}`}</b></span><span><small>TRANSFER HIT</small><b>{best.hitCost?`−${best.hitCost}`:"None"}</b></span><span><small>NET (AFTER HIT)</small><b>{best.netDifference>=0?"+":""}{best.netDifference.toFixed(1)} pts</b></span>{best.utilityChange!==null&&<span><small>MODEL UTILITY CHANGE</small><b>{best.utilityChange>=0?"+":""}{best.utilityChange.toFixed(1)}</b></span>}</div>}
        <strong>{roll?"Recommendation: SAVE THE TRANSFER":best.gain1-best.hitCost>0?"Recommendation: MOVE NOW":"Recommendation: WAIT / RECHECK"}</strong>
      </section>
      {holdNote&&<p className="transfer-hold-note">{holdNote}</p>}
      <section className="quality-gate-summary"><header><span>RECOMMENDATION QUALITY GATE</span><h2>Raw upside must earn the right to be ranked.</h2></header><div><article><b>{actionableRows.length}</b><span>Actionable</span><small>Can become the primary recommendation</small></article><article><b>{watchlistRows.length}</b><span>Watchlist</span><small>Promising, but evidence or timing is incomplete</small></article><article><b>{blockedRows.length}</b><span>Blocked</span><small>Fails a hard plausibility or role-security floor</small></article></div></section>
      <TransferRouteList title="Actionable routes" eyebrow="PASSED EVERY GATE" rows={actionableRows.slice(0,10)} expanded={expanded} toggleExpand={toggleExpand} watchIds={watchIds} setWatch={setWatch}/>
      <TransferRouteList title="Watchlist routes" eyebrow="NOT READY TO RECOMMEND" rows={watchlistRows.slice(0,6)} expanded={expanded} toggleExpand={toggleExpand} watchIds={watchIds} setWatch={setWatch}/>
      <TransferRouteList title="Blocked by the quality gate" eyebrow="VISIBLE FOR AUDIT · NEVER RANKED #1" rows={blockedRows.slice(0,6)} expanded={expanded} toggleExpand={toggleExpand} watchIds={watchIds} setWatch={setWatch}/>
      <PriceIntel rows={rows}/>
      {process.env.NODE_ENV!=="production"&&<TransferDebugTable rows={rows.slice(0,10)}/>}
    </>:<Watchlist data={data} squad={squad} ids={watchIds} remove={setWatch} bank={bank}/>}
  </div>;
}

function TransferRouteList({title,eyebrow,rows,expanded,toggleExpand,watchIds,setWatch}:{title:string;eyebrow:string;rows:Transfer[];expanded:Set<string>;toggleExpand:(key:string)=>void;watchIds:number[];setWatch:(id:number)=>void}){
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
      {isOpen&&<TransferBreakdown r={r}/>}
    </article>})}
  </section>;
}

function TransferBreakdown({r}:{r:Transfer}){
  const horizons=[
    {label:"NEXT GAMEWEEK",out:r.outGw1,incoming:r.inGw1,gain:r.gain1,individual:r.individualGain1},
    {label:"NEXT 3 GWs",out:r.outGw3,incoming:r.inGw3,gain:r.gain3,individual:r.individualGain3},
    {label:"NEXT 5 GWs",out:r.outGw5,incoming:r.inGw5,gain:r.gain5,individual:r.individualGain5},
  ];
  const statusCopy=r.qualityStatus==="actionable"?"The role, evidence and multi-week upside are strong enough to act on.":r.qualityStatus==="watchlist"?"The upside is interesting, but at least one signal needs more evidence.":"This route failed a hard plausibility or role-security check.";
  const signed=(value:number,places=1)=>`${value>=0?"+":""}${value.toFixed(places)}`;
  return <div className={`transfer-detail ${r.qualityStatus}`}>
    <header className="transfer-detail-head">
      <div><span>MODEL VERDICT</span><h3>{r.out.name} <i>→</i> {r.incoming.name}</h3><p>{statusCopy}</p></div>
      <strong><small>{r.qualityStatus.toUpperCase()}</small>{r.qualityScore}<em>/100</em></strong>
    </header>

    <section className="transfer-horizons">{horizons.map(horizon=><article key={horizon.label}>
      <span>{horizon.label}</span>
      <div><p><small>KEEP {r.out.name.toUpperCase()}</small><b>{horizon.out.toFixed(1)}</b></p><i>vs</i><p><small>BUY {r.incoming.name.toUpperCase()}</small><b>{horizon.incoming.toFixed(1)}</b></p></div>
      <footer><b>{signed(horizon.gain)} squad pts</b><small>{signed(horizon.individual)} individual edge</small></footer>
    </article>)}</section>

    <div className="transfer-detail-columns">
      <section className="player-signal-card">
        <header><span>PLAYER SIGNALS</span><b>{r.out.name}</b><b>{r.incoming.name}</b></header>
        <p><span>Expected minutes</span><b>{Math.round(r.expectedMinutesOut)}</b><strong>{Math.round(r.expectedMinutesIn)}</strong></p>
        <p><span>Start probability</span><b>{Math.round(r.startProbOut*100)}%</b><strong>{Math.round(r.startProbIn*100)}%</strong></p>
        <p><span>Attacking threat</span><b>{r.attackingOut.toFixed(2)}</b><strong>{r.attackingIn.toFixed(2)}</strong></p>
        <p><span>Defensive contribution</span><b>{r.dcOut.toFixed(2)}</b><strong>{r.dcIn.toFixed(2)}</strong></p>
        <p><span>Model confidence</span><b>{Math.round(r.confidenceOut*100)}%</b><strong>{Math.round(r.confidenceIn*100)}%</strong></p>
      </section>

      <section className="fixture-context-card">
        <header><span>INCOMING PLAYER CONTEXT</span><small>1.00 = league average</small></header>
        <div><p><span>Team attack</span><b>×{r.teamAttackIn.toFixed(2)}</b></p><p><span>Opponent defence</span><b>×{r.opponentDefenceIn.toFixed(2)}</b></p><p className="accent"><span>Attack matchup</span><b>×{r.fixtureAttackMultiplierIn.toFixed(2)}</b></p><p><span>Team defence</span><b>×{r.teamDefenceIn.toFixed(2)}</b></p><p><span>Opponent attack</span><b>×{r.opponentAttackIn.toFixed(2)}</b></p><p className="accent"><span>Defence matchup</span><b>×{r.fixtureDefenceMultiplierIn.toFixed(2)}</b></p></div>
        <footer><span>Average fixture difficulty</span><b>{r.fixtureAdjustmentIn.toFixed(1)} / 5</b></footer>
      </section>
    </div>

    <section className="transfer-decision-math">
      <p><span>After transfer hit</span><b>{signed(r.netDifference)} pts</b><small>{r.hitCost?`${r.hitCost}-point cost included`:"No hit required"}</small></p>
      <p><span>Risk-adjusted score</span><b>{r.rankScore.toFixed(1)}</b><small>{r.risk} minutes risk</small></p>
      <p><span>Multi-week robustness</span><b>{r.positiveWeeks}/{r.weeklyGains.length} positive</b><small>{signed(r.gainWithoutBestWeek)} without best GW</small></p>
      <p><span>Squad utility change</span><b>{r.utilityChange===null?"—":signed(r.utilityChange)}</b><small>structure, bench and flexibility</small></p>
    </section>

    {(r.qualityReasons.length>0||r.anomalies.length>0)&&<section className="transfer-detail-warnings">
      <span>{r.qualityStatus==="blocked"?"WHY THIS ROUTE IS BLOCKED":"WHAT TO WATCH"}</span>
      {[...r.qualityReasons.map(reason=>({key:`quality-${reason.code}`,message:reason.message})),...r.anomalies.map(flag=>({key:`anomaly-${flag.code}`,message:flag.message}))].map(item=><p key={item.key}>{item.message}</p>)}
    </section>}
  </div>;
}

function TransferDebugTable({rows}:{rows:Transfer[]}){return <section className="transfer-debug-table"><header><span>DEV ONLY · TRANSFER ENGINE DEBUG</span><h2>Every number, traceable to its components.</h2></header><div className="debug-table-scroll"><table><thead><tr><th>OUT</th><th>IN</th><th>OUT GW1</th><th>IN GW1</th><th>GW1 Δ</th><th>OUT 3GW</th><th>IN 3GW</th><th>3GW Δ</th><th>OUT 5GW</th><th>IN 5GW</th><th>5GW Δ</th><th>xMins OUT/IN</th><th>Start% OUT/IN</th><th>Risk OUT/IN</th><th>Fixture adj.</th><th>DC IN</th><th>Attacking IN</th><th>Confidence IN</th><th>Utility Δ</th></tr></thead><tbody>{rows.map(r=><tr key={`${r.out.id}-${r.incoming.id}`}><td>{r.out.name}</td><td>{r.incoming.name}</td><td>{r.outGw1.toFixed(2)}</td><td>{r.inGw1.toFixed(2)}</td><td>{r.gain1.toFixed(2)}</td><td>{r.outGw3.toFixed(2)}</td><td>{r.inGw3.toFixed(2)}</td><td>{r.gain3.toFixed(2)}</td><td>{r.outGw5.toFixed(2)}</td><td>{r.inGw5.toFixed(2)}</td><td>{r.gain5.toFixed(2)}</td><td>{Math.round(r.expectedMinutesOut)}/{Math.round(r.expectedMinutesIn)}</td><td>{Math.round(r.startProbOut*100)}%/{Math.round(r.startProbIn*100)}%</td><td>{Math.round((1-r.startProbOut)*100)}%/{Math.round((1-r.startProbIn)*100)}%</td><td>{r.fixtureAdjustmentIn.toFixed(1)}</td><td>{r.dcIn.toFixed(2)}</td><td>{r.attackingIn.toFixed(2)}</td><td>{Math.round(r.confidenceIn*100)}%</td><td>{r.utilityChange===null?"—":r.utilityChange.toFixed(2)}</td></tr>)}</tbody></table></div></section>}

// FPL doesn't publish its price-change algorithm, and priceProjectionToday is FPL's own
// first-party end-of-day forecast (not a heuristic estimated from raw transfer counts here) --
// this threshold is only about noise reduction (most players sit under it every day), not an
// assertion about FPL's own undisclosed move-trigger threshold.
export const MEANINGFUL_PRICE_PRESSURE=15;

export type PriceTiming={direction:"rise"|"fall"|"stable";message:string};
export function priceTimingSignal(player:FplPlayer):PriceTiming{
  const pct=player.priceProjectionToday;
  if(pct>=MEANINGFUL_PRICE_PRESSURE)return{direction:"rise",message:`${Math.round(pct)}% rise pressure today (FPL's own projection) — buying before a rise saves money.`};
  if(pct<=-MEANINGFUL_PRICE_PRESSURE)return{direction:"fall",message:`${Math.round(Math.abs(pct))}% fall pressure today — no rush, a drop may make this cheaper soon.`};
  return{direction:"stable",message:"No meaningful price pressure today."};
}

// Only falls matter for squad-value protection -- a rise in a squad player is good news, not a risk.
export function priceProtectionAlerts(squad:FplPlayer[]):FplPlayer[]{
  return squad.filter(p=>p.priceProjectionToday<=-MEANINGFUL_PRICE_PRESSURE).sort((a,b)=>a.priceProjectionToday-b.priceProjectionToday);
}

function PriceIntel({rows}:{rows:Transfer[]}){return <section className="price-intel"><header><span>PRICE-CHANGE INTELLIGENCE</span><h2>Market pressure, without chasing it.</h2></header>{rows.slice(0,4).map(r=>{const timing=priceTimingSignal(r.incoming);return <article key={r.incoming.id}><b>{r.incoming.name}<small>£{r.incoming.price.toFixed(1)}m</small></b><span className={timing.direction}>{timing.direction==="rise"?"Rise pressure":timing.direction==="fall"?"Fall pressure":"Stable"}</span><p>{timing.message}</p></article>})}</section>}

// Surfaces squad players at real risk of a price drop before it happens -- nothing today watches
// your own squad for this, only transfer targets. Renders nothing when no squad player clears the
// same MEANINGFUL_PRICE_PRESSURE bar used for targets, which is most days.
function SquadValueAlert({squad}:{squad:FplPlayer[]}){
  const atRisk=priceProtectionAlerts(squad);
  if(!atRisk.length)return null;
  return <section className="price-value-alert">
    <div><span>SQUAD VALUE</span><h2>Protect your squad value before it drops.</h2></div>
    <div>
      {atRisk.slice(0,3).map(p=><p key={p.id}><b>{p.name}</b> carries {Math.round(Math.abs(p.priceProjectionToday))}% fall pressure today — selling before the drop protects the standard £0.1m step.</p>)}
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
  const candidates=useMemo(()=>watchlistCandidatePool(data.players,squad.map(player=>player.id),ids,search,position),[data.players,squad,ids,search,position]);
  const addPlayer=()=>{const id=Number(add);if(id)remove(id);setAdd("")};
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
        <span><small>CONFIDENCE</small><b>{Math.round(m.confidence*100)}%</b></span>
      </div>
      <p><b>Role:</b> {p.positionShort}{m.penaltyRole?" · first-choice penalties":""}{m.setPieceRole?" · set-piece role":""}{!m.penaltyRole&&!m.setPieceRole?" · no confirmed set-piece role":""}</p>
      <p className={trigger.ready?"trigger-ready":""}><b>Performance trigger:</b> {trigger.message}</p>
      {trigger.budgetNote&&<p className="watch-budget-note"><b>Budget:</b> {trigger.budgetNote}</p>}
      <small>Compared route: {natural?`${natural.name} → ${p.name}`:"No same-position route yet"}</small>
      <footer>
        <div>{events.map(e=>{const games=data.fixtures.filter(f=>f.event===e.id&&(f.teamH===p.teamId||f.teamA===p.teamId));const difficulties=games.map(f=>f.teamH===p.teamId?f.teamHDifficulty:f.teamADifficulty);const difficulty=difficulties.length?Math.round(difficulties.reduce((s,d)=>s+d,0)/difficulties.length):3;return <i key={e.id} className={`fdr-${difficulty}`}>{opponent(p,e.id,data)}<small>{difficulties.length?difficulties.join(", "):3}</small></i>})}</div>
        <button onClick={()=>remove(p.id)}>Remove</button>
      </footer>
    </article>
  }):<div className="empty-watch"><b>Your watchlist is empty.</b><p>Add a transfer target above or from the ranked transfer list.</p></div>}</section></>;
}

function Players({data,go,revision}:{data:FplData;go:(v:View)=>void;revision:number}){const events=futureEvents(data,5),first=events[0]?.id;const[query,setQuery]=useState("");const[pos,setPos]=useState("ALL");const[club,setClub]=useState("ALL");const[maxPrice,setMaxPrice]=useState(15);const[minMins,setMinMins]=useState(0);const[special,setSpecial]=useState("ALL");const[sort,setSort]=useState("xPts5");const[direction,setDirection]=useState<"desc"|"asc">("desc");const[compare,setCompare]=useState<number[]>([]);const[watch,setWatch]=useState<number[]>([]);useEffect(()=>setWatch(readIds("fpl-edge-watchlist")),[revision]);const toggleWatch=(id:number)=>{const next=watch.includes(id)?watch.filter(x=>x!==id):[...watch,id];setWatch(next);persist("fpl-edge-watchlist",JSON.stringify(next))};const rows=useMemo(()=>data.players.map(p=>{const metrics=first?projectionMetrics(p,first,data.fixtures,first):null;const xPts3=events.slice(0,3).reduce((s,e)=>s+playerProjection(p,e.id,data.fixtures,first),0),xPts5=events.reduce((s,e)=>s+playerProjection(p,e.id,data.fixtures,first),0);const xgi90=p.minutes?p.expectedGoalInvolvements/p.minutes*90:0;const fdr=events.length?events.reduce((s,e)=>{const games=data.fixtures.filter(x=>x.event===e.id&&(x.teamH===p.teamId||x.teamA===p.teamId));const difficulties=games.map(f=>f.teamH===p.teamId?f.teamHDifficulty:f.teamADifficulty);return s+(difficulties.length?difficulties.reduce((a,b)=>a+b,0)/difficulties.length:5)},0)/events.length:5;return{p,metrics,xPts3,xPts5,xgi90,fdr,value:xPts5/Math.max(3.5,p.price)}}).filter(r=>(pos==="ALL"||r.p.positionShort===pos)&&(club==="ALL"||String(r.p.teamId)===club)&&r.p.price<=maxPrice&&(r.metrics?.expectedMinutes||0)>=minMins&&(`${r.p.name} ${r.p.teamName}`).toLowerCase().includes(query.toLowerCase())&&(special==="ALL"||special==="DIFF"&&r.p.selectedBy<10||special==="PEN"&&r.metrics?.penaltyRole||special==="SET"&&r.metrics?.setPieceRole||special==="WATCH"&&watch.includes(r.p.id))).sort((a,b)=>{const val=(r:typeof a)=>sort==="xPts3"?r.xPts3:sort==="xPts5"?r.xPts5:sort==="xgi90"?r.xgi90:sort==="fdr"?-r.fdr:sort==="value"?r.value:sort==="expectedMinutes"?(r.metrics?.expectedMinutes||0):sort==="start"?(r.metrics?.startProbability||0):Number(r.p[sort as keyof FplPlayer])||0;return direction==="desc"?val(b)-val(a):val(a)-val(b)}),[data,events.map(e=>e.id).join(","),first,query,pos,club,maxPrice,minMins,special,sort,direction,watch.join(",")]);return <div className="coach-page"><section className="research-intro"><div><span>LIVE 2026/27 RESEARCH</span><h2>Every decision variable, one player database.</h2><p>{data.seasonStatsThrough?`Current-season totals through GW${data.seasonStatsThrough}.`:`No 2026/27 gameweek has finished, so new-season totals correctly start at zero.`} Prices and availability are live.</p></div><strong>{rows.length}<small>matching players</small></strong></section><section className="research-filters"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search player or club…"/><select value={pos} onChange={e=>setPos(e.target.value)}><option value="ALL">All positions</option>{data.rules.positions.map(p=><option key={p.id}>{p.short}</option>)}</select><select value={club} onChange={e=>setClub(e.target.value)}><option value="ALL">All clubs</option>{data.teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select><select value={special} onChange={e=>setSpecial(e.target.value)}><option value="ALL">All roles</option><option value="DIFF">Differential under 10%</option><option value="PEN">Penalties</option><option value="SET">Set pieces</option><option value="WATCH">Watchlist</option></select><label>Max £{maxPrice.toFixed(1)}m<input type="range" min="4" max="15" step=".5" value={maxPrice} onChange={e=>setMaxPrice(Number(e.target.value))}/></label><label>Min xMins {minMins}<input type="range" min="0" max="90" step="10" value={minMins} onChange={e=>setMinMins(Number(e.target.value))}/></label><select value={sort} onChange={e=>setSort(e.target.value)}>{[["xPts5","5-GW xPts"],["xPts3","3-GW xPts"],["price","Price"],["selectedBy","Ownership"],["totalPoints","Total points"],["pointsPerGame","Points per match"],["expectedGoals","xG"],["expectedAssists","xA"],["xgi90","xGI/90"],["expectedMinutes","Expected minutes"],["start","Start probability"],["fdr","Fixture rating"],["value","Value"]].map(x=><option value={x[0]} key={x[0]}>Sort: {x[1]}</option>)}</select><button onClick={()=>setDirection(x=>x==="desc"?"asc":"desc")}>{direction==="desc"?"High → low":"Low → high"}</button></section>{compare.length>=2&&<Compare data={data} ids={compare} close={()=>setCompare([])}/>}<section className="research-table"><header>{["Player","£","Own","Pts","PPM","xG","xA","xGI/90","G","A","CS","DC","xMins","Start","Next","3GW","5GW","FDR","Value","Actions"].map(x=><span key={x}>{x}</span>)}</header>{rows.slice(0,120).map(r=><article key={r.p.id}><b>{r.p.name}<small>{r.p.teamShort} · {r.p.positionShort}</small></b><span>{r.p.price.toFixed(1)}</span><span>{r.p.selectedBy.toFixed(1)}%</span><span>{r.p.totalPoints}</span><span>{r.p.pointsPerGame.toFixed(1)}</span><span>{r.p.expectedGoals.toFixed(2)}</span><span>{r.p.expectedAssists.toFixed(2)}</span><span>{r.xgi90.toFixed(2)}</span><span>{r.p.goals}</span><span>{r.p.assists}</span><span>{r.p.cleanSheets}</span><span>{r.p.defensiveContribution}</span><span>{Math.round(r.metrics?.expectedMinutes||0)}</span><span>{Math.round((r.metrics?.startProbability||0)*100)}%</span><span>{first?opponent(r.p,first,data):"—"}</span><strong>{r.xPts3.toFixed(1)}</strong><strong>{r.xPts5.toFixed(1)}</strong><span>{r.fdr.toFixed(1)}</span><span>{r.value.toFixed(2)}</span><div><button className={compare.includes(r.p.id)?"active":""} disabled={!compare.includes(r.p.id)&&compare.length>=4} onClick={()=>setCompare(x=>x.includes(r.p.id)?x.filter(id=>id!==r.p.id):[...x,r.p.id])}>Compare</button><button className={watch.includes(r.p.id)?"active":""} onClick={()=>toggleWatch(r.p.id)}>Watch</button><button onClick={()=>go("transfers")}>Transfer</button></div></article>)}</section></div>}
function Compare({data,ids,close}:{data:FplData;ids:number[];close:()=>void}){const players=ids.map(id=>data.players.find(p=>p.id===id)).filter(Boolean) as FplPlayer[],events=futureEvents(data,5),first=events[0]?.id;const best=[...players].sort((a,b)=>events.reduce((s,e)=>s+playerProjection(b,e.id,data.fixtures,first),0)-events.reduce((s,e)=>s+playerProjection(a,e.id,data.fixtures,first),0))[0];const secure=[...players].sort((a,b)=>projectionMetrics(b,first,data.fixtures,first).startProbability-projectionMetrics(a,first,data.fixtures,first).startProbability)[0];return <section className="compare-drawer"><header><div><span>PLAYER COMPARISON</span><h2>{players.map(p=>p.name).join(" vs ")}</h2></div><button onClick={close}>Close</button></header><div>{players.map(p=>{const m=projectionMetrics(p,first,data.fixtures,first),xgi90=p.minutes?p.expectedGoalInvolvements/p.minutes*90:0;return <article key={p.id}><h3>{p.name}<small>{p.teamShort} · £{p.price.toFixed(1)}m</small></h3><p><span>Next 5</span><b>{events.map(e=>opponent(p,e.id,data)).join(" · ")}</b></p><p><span>5-GW xPts</span><b>{events.reduce((s,e)=>s+playerProjection(p,e.id,data.fixtures,first),0).toFixed(1)}</b></p><p><span>xMins / start</span><b>{Math.round(m.expectedMinutes)} / {Math.round(m.startProbability*100)}%</b></p><p><span>xG90 / xA90</span><b>{p.minutes?(p.expectedGoals/p.minutes*90).toFixed(2):"—"} / {p.minutes?(p.expectedAssists/p.minutes*90).toFixed(2):"—"}</b></p><p><span>xGI/90</span><b>{xgi90.toFixed(2)}</b></p><p><span>Roles</span><b>{m.penaltyRole?"Pens · ":""}{m.setPieceRole?"Set pieces":"No confirmed role"}</b></p><p><span>Ownership / rotation</span><b>{p.selectedBy.toFixed(1)}% / {Math.round(m.rotationRisk*100)}%</b></p></article>})}</div><footer><span>MODEL VERDICT</span><p><b>{best.name}</b> has the highest five-gameweek projection. <b>{secure.name}</b> has the safest minutes profile. Choose upside only if its minutes uncertainty fits your risk tolerance.</p></footer></section>}

function TeamQualityFixtures({data}:{data:FplData}){
  const[horizon,setHorizon]=useState(8);
  const[sort,setSort]=useState<"attack"|"defence">("attack");
  const events=futureEvents(data,horizon),teamMap=new Map(data.teams.map(team=>[team.id,team]));
  const difficulty=(opportunity:number)=>clamp(3-(opportunity-1)*6,1,5);
  const rows=data.teams.map(team=>{
    const cells=events.map(event=>{
      const games=data.fixtures.filter(fixture=>fixture.event===event.id&&(fixture.teamH===team.id||fixture.teamA===team.id));
      if(!games.length)return{label:"BLANK",attack:5,defence:5,attackMultiplier:0,defenceMultiplier:0};
      const perGame=games.map(fixture=>{
        const home=fixture.teamH===team.id,opponent=teamMap.get(home?fixture.teamA:fixture.teamH);
        const own=team.quality,opp=opponent?.quality;
        const ownAttack=home?(own?.effectiveAttackHome??1):(own?.effectiveAttackAway??1);
        const ownDefence=home?(own?.effectiveDefenceHome??1):(own?.effectiveDefenceAway??1);
        const opponentDefence=home?(opp?.effectiveDefenceAway??1):(opp?.effectiveDefenceHome??1);
        const opponentAttack=home?(opp?.effectiveAttackAway??1):(opp?.effectiveAttackHome??1);
        const attackMultiplier=clamp(ownAttack/Math.max(.6,opponentDefence)*(home?1.04:.96),.65,1.5);
        const defenceMultiplier=clamp(ownDefence/Math.max(.6,opponentAttack)*(home?1.05:.94),.65,1.5);
        return{label:`${opponent?.short??"—"} ${home?"H":"A"}`,attack:difficulty(attackMultiplier),defence:difficulty(defenceMultiplier),attackMultiplier,defenceMultiplier};
      });
      const average=(pick:(game:typeof perGame[number])=>number)=>perGame.reduce((sum,game)=>sum+pick(game),0)/perGame.length;
      return{label:perGame.map(game=>game.label).join(", "),attack:average(game=>game.attack),defence:average(game=>game.defence),attackMultiplier:average(game=>game.attackMultiplier),defenceMultiplier:average(game=>game.defenceMultiplier)};
    });
    const average=(pick:(cell:typeof cells[number])=>number)=>cells.reduce((sum,cell)=>sum+pick(cell),0)/Math.max(1,cells.length);
    const split=Math.ceil(cells.length/2),firstHalf=cells.slice(0,split),secondHalf=cells.slice(split);
    const early=firstHalf.reduce((sum,cell)=>sum+cell.attack,0)/Math.max(1,firstHalf.length),later=secondHalf.reduce((sum,cell)=>sum+cell.attack,0)/Math.max(1,secondHalf.length);
    return{team,cells,attack:average(cell=>cell.attack),defence:average(cell=>cell.defence),swing:early-later};
  }).sort((a,b)=>sort==="attack"?a.attack-b.attack:a.defence-b.defence);
  const attack=[...rows].sort((a,b)=>a.attack-b.attack).slice(0,3),defence=[...rows].sort((a,b)=>a.defence-b.defence).slice(0,3),avoid=[...rows].sort((a,b)=>b.attack-a.attack).slice(0,3),swings=[...rows].sort((a,b)=>b.swing-a.swing).slice(0,3);
  return <div className="team-quality-fixtures"><section className="fixture-summary"><div><span>QUALITY-AWARE FIXTURE TICKER</span><h2>Opponent difficulty and each club's own quality now move together.</h2><p>Lower scores are better. Attack rankings compare a club's attack with the opponent's defence; clean-sheet rankings compare its defence with the opponent's attack.</p></div><div>{[3,5,8].map(value=><button className={horizon===value?"active":""} onClick={()=>setHorizon(value)} key={value}>{value} GW</button>)}</div></section><div className="schedule-ranks"><Rank title="Best attacking schedules" rows={attack} keyName="attack"/><Rank title="Best defensive schedules" rows={defence} keyName="defence"/><Rank title="Fixture swings" rows={swings} keyName="swing"/><Rank title="Teams to avoid" rows={avoid} keyName="attack" bad/></div><section className="fixture-ticker"><header><div><span>TEAM</span><button className={sort==="attack"?"active":""} onClick={()=>setSort("attack")}>ATTACK</button><button className={sort==="defence"?"active":""} onClick={()=>setSort("defence")}>DEFENCE</button></div>{events.map(event=><span key={event.id}>{event.name.replace("Gameweek ","GW")}</span>)}</header>{rows.map(row=><article key={row.team.id}><div><b>{row.team.short}<small>{row.team.name}</small></b><span>{row.attack.toFixed(2)} ATK</span><span>{row.defence.toFixed(2)} DEF</span></div>{row.cells.map((cell,index)=>{const value=sort==="attack"?cell.attack:cell.defence,multiplier=sort==="attack"?cell.attackMultiplier:cell.defenceMultiplier;return <span className={`fdr-${Math.round(value)}`} key={events[index].id}><b>{cell.label}</b><small>{cell.label==="BLANK"?"—":`${value.toFixed(1)} · ×${multiplier.toFixed(2)}`}</small></span>})}</article>)}</section></div>;
}

function Fixtures({data}:{data:FplData}){const[horizon,setHorizon]=useState(8);const[sort,setSort]=useState<"attack"|"defence">("attack");const events=futureEvents(data,horizon),teamMap=new Map(data.teams.map(t=>[t.id,t]));const rows=data.teams.map(team=>{const cells=events.map(e=>{const games=data.fixtures.filter(x=>x.event===e.id&&(x.teamH===team.id||x.teamA===team.id));if(!games.length)return{label:"BLANK",attack:5,defence:5};const perGame=games.map(f=>{const home=f.teamH===team.id,opp=teamMap.get(home?f.teamA:f.teamH);const raw=home?f.teamHDifficulty:f.teamADifficulty;return{label:`${opp?.short??"—"} ${home?"H":"A"}`,attack:clamp(raw+(home?-.25:.25),1,5),defence:clamp(raw+(home?-.45:.35)+(raw<=2?.2:-.1),1,5)}});return{label:perGame.map(g=>g.label).join(", "),attack:perGame.reduce((s,g)=>s+g.attack,0)/perGame.length,defence:perGame.reduce((s,g)=>s+g.defence,0)/perGame.length}});const attack=cells.reduce((s,c)=>s+c.attack,0)/Math.max(1,cells.length),defence=cells.reduce((s,c)=>s+c.defence,0)/Math.max(1,cells.length);const firstHalf=cells.slice(0,Math.ceil(cells.length/2)).reduce((s,c)=>s+c.attack,0),secondHalf=cells.slice(Math.ceil(cells.length/2)).reduce((s,c)=>s+c.attack,0);return{team,cells,attack,defence,swing:firstHalf-secondHalf}}).sort((a,b)=>sort==="attack"?a.attack-b.attack:a.defence-b.defence);const attack=[...rows].sort((a,b)=>a.attack-b.attack).slice(0,3),defence=[...rows].sort((a,b)=>a.defence-b.defence).slice(0,3),avoid=[...rows].sort((a,b)=>b.attack-a.attack).slice(0,3),swings=[...rows].sort((a,b)=>b.swing-a.swing).slice(0,3);return <div className="coach-page"><section className="fixture-summary"><div><span>FIXTURE TICKER</span><h2>Attack and clean-sheet routes are ranked separately.</h2></div><div>{[3,5,8].map(n=><button className={horizon===n?"active":""} onClick={()=>setHorizon(n)} key={n}>{n} GW</button>)}</div></section><div className="schedule-ranks"><Rank title="Best attacking schedules" rows={attack} keyName="attack"/><Rank title="Best defensive schedules" rows={defence} keyName="defence"/><Rank title="Fixture swings" rows={swings} keyName="swing"/><Rank title="Teams to avoid" rows={avoid} keyName="attack" bad/></div><section className="fixture-ticker"><header><div><span>TEAM</span><button className={sort==="attack"?"active":""} onClick={()=>setSort("attack")}>ATTACK</button><button className={sort==="defence"?"active":""} onClick={()=>setSort("defence")}>DEFENCE</button></div>{events.map(e=><span key={e.id}>{e.name.replace("Gameweek ","GW")}</span>)}</header>{rows.map(r=><article key={r.team.id}><div><b>{r.team.short}<small>{r.team.name}</small></b><span>{r.attack.toFixed(2)} ATK</span><span>{r.defence.toFixed(2)} DEF</span></div>{r.cells.map((c,i)=><span className={`fdr-${Math.round(sort==="attack"?c.attack:c.defence)}`} key={events[i].id}><b>{c.label}</b><small>{(sort==="attack"?c.attack:c.defence).toFixed(1)}</small></span>)}</article>)}</section></div>}
function Rank({title,rows,keyName,bad}:{title:string;rows:any[];keyName:string;bad?:boolean}){return <article className={bad?"avoid":""}><span>{title.toUpperCase()}</span>{rows.map((r,i)=><p key={r.team.id}><i>{i+1}</i><b>{r.team.name}</b><strong>{keyName==="swing"?`BUY LATER +${r.swing.toFixed(1)}`:Number(r[keyName]).toFixed(2)}</strong></p>)}</article>}

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
export type ProjectionReceipt={
  schemaVersion:1|2|3|4|5|6;receiptId:string;modelVersion:string;event:number;eventIds:number[];
  deadline:string;capturedAt:string;dataUpdatedAt:string;dataSource:string;seasonStatsThrough:number;
  assumptions:{bank:number;freeTransfers:number;transferHorizon:number};
  squad:{squadIds:number[];xiIds:number[];benchIds?:number[];captainId:number;viceId:number;predictedTotal:number;captainXPts:number;viceXPts:number};
  playerEncoding:"tuple-v1"|"tuple-v2"|"tuple-v3"|"tuple-v4";players:ProjectionReceiptPlayer[];transfers:ProjectionReceiptTransfer[];
};
type ReceiptTransferInput=Pick<Transfer,"gain1"|"gain3"|"gain5"|"individualGain1"|"individualGain3"|"individualGain5"|"rankScore"|"netDifference"|"hitCost"|"startProbIn"|"confidenceIn"|"risk"|"reviewRequired"|"anomalies">&Partial<Pick<Transfer,"qualityStatus"|"qualityScore"|"qualityReasons">>&{out:Pick<FplPlayer,"id"|"name">;incoming:Pick<FplPlayer,"id"|"name">};
const receiptNumber=(value:number,places=3)=>Number(value.toFixed(places));

// Pure, explicit and deliberately complete enough for later calibration. It snapshots every
// official player, not only the chosen squad, so future model-vs-reality work can evaluate the
// full prediction population without reconstructing what the model "must have meant" later.
export function createProjectionReceipt({data,eventIds,deadline,capturedAt,squad,xiIds,benchIds,captainId,viceId,bank,freeTransfers,transferRows}:{data:FplData;eventIds:number[];deadline:string;capturedAt:string;squad:FplPlayer[];xiIds:number[];benchIds?:number[];captainId:number;viceId:number;bank:number;freeTransfers:number;transferRows:ReceiptTransferInput[]}):ProjectionReceipt{
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
  return{schemaVersion:6,receiptId:`gw${first}-${Date.parse(capturedAt)}`,modelVersion:PROJECTION_MODEL_VERSION,event:first,eventIds:horizon,deadline,capturedAt,dataUpdatedAt:data.updatedAt,dataSource:data.source,seasonStatsThrough:data.seasonStatsThrough,assumptions:{bank:receiptNumber(bank,1),freeTransfers,transferHorizon:horizon.length},squad:{squadIds:squad.map(player=>player.id),xiIds:[...xiIds],benchIds:frozenBenchIds,captainId,viceId,predictedTotal:receiptNumber(predictedTotal),captainXPts:receiptNumber(captainXPts),viceXPts:receiptNumber(viceXPts)},playerEncoding:"tuple-v4",players,transfers};
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
export function captainRiskNote(captain:FplPlayer,vice:FplPlayer,captainStartPct:number,viceStartPct:number,captainXPts:number,viceXPts:number):CaptainRiskNote|null{
  if(captainStartPct>=68)return null;
  const pointsIfCaptainPlays=captainXPts*2;
  const pointsIfArmbandPasses=viceXPts*2;
  const viceAlsoAtRisk=viceStartPct<68;
  const message=`${captain.name} carries real doubt this week (${captainStartPct}% start probability). If they don't play at all, the armband passes to ${vice.name} and your week swings from ${pointsIfCaptainPlays.toFixed(1)} to ${pointsIfArmbandPasses.toFixed(1)} captained points${viceAlsoAtRisk?` — and ${vice.name} isn't nailed either, at ${viceStartPct}% start probability`:""}.`;
  return{message,captainStartPct,viceStartPct,pointsIfCaptainPlays,pointsIfArmbandPasses};
}

// The haul formula previously had a stray *30 multiplier that pushed every realistic player
// straight through its clamp ceiling -- verified against real profiles (elite forward through
// fringe defender all clamped to the same 58%, zero differentiation). Fixed here; return
// probability was already sane and is unchanged.
export function captainReturnHaul(m:ProjectionMetrics):{ret:number;haul:number}{
  const ret=clamp((m.xG+m.xA)*64+m.startProbability*18,5,92);
  const haul=clamp(m.xG*45+m.xA*25,2,58);
  return{ret,haul};
}

export type CaptainCandidate={id:number;name:string;xPts:number;ret:number;haul:number;startProbability:number;selectedBy:number};
export type CaptaincyRiskFraming={defaultRole:"safe"|"differential"|"balanced";safeAlternative:CaptainCandidate|null;differentialAlternative:CaptainCandidate|null};
// "Safe" reuses this exact component's own existing "Risk: Low" threshold (startProbability>.8).
// "Differential" reuses the Players page's existing "Differential under 10%" ownership filter --
// neither threshold is invented fresh for this feature. An alternative only surfaces if it's a
// real tradeoff, not a free upgrade or rounding noise: a double-digit percentage-point edge on its
// own axis, and (for the differential specifically) a genuine cost in return probability.
const SAFE_START_THRESHOLD=.8;
const DIFFERENTIAL_OWNERSHIP_THRESHOLD=10;
const MEANINGFUL_EDGE=10;
const MIN_RETURN_COST=5;
export function captaincyRiskFraming(candidates:CaptainCandidate[],defaultCaptainId:number):CaptaincyRiskFraming{
  const defaultCaptain=candidates.find(c=>c.id===defaultCaptainId);
  if(!defaultCaptain)return{defaultRole:"balanced",safeAlternative:null,differentialAlternative:null};
  const safeCandidates=candidates.filter(c=>c.startProbability>=SAFE_START_THRESHOLD);
  const safePick=safeCandidates.length?safeCandidates.reduce((best,c)=>c.ret>best.ret?c:best):null;
  const diffCandidates=candidates.filter(c=>c.selectedBy<DIFFERENTIAL_OWNERSHIP_THRESHOLD);
  const differentialPick=diffCandidates.length?diffCandidates.reduce((best,c)=>c.haul>best.haul?c:best):null;
  const defaultRole=safePick?.id===defaultCaptainId?"safe":differentialPick?.id===defaultCaptainId?"differential":"balanced";
  const safeAlternative=safePick&&safePick.id!==defaultCaptainId&&(safePick.ret-defaultCaptain.ret)>=MEANINGFUL_EDGE?safePick:null;
  const differentialAlternative=differentialPick&&differentialPick.id!==defaultCaptainId&&(differentialPick.haul-defaultCaptain.haul)>=MEANINGFUL_EDGE&&(defaultCaptain.ret-differentialPick.ret)>=MIN_RETURN_COST?differentialPick:null;
  return{defaultRole,safeAlternative,differentialAlternative};
}

function FinalCheck({data,go,revision}:{data:FplData;go:(v:View)=>void;revision:number}){
  const squad=useMemo(()=>savedSquad(data),[data,revision]);
  const[meta]=useManager();
  const a=analysis(data,squad);
  const[lockVersion,setLockVersion]=useState(0);
  const[lockError,setLockError]=useState("");
  const players=a?.xi.players??[];
  const ranked=[...players].sort((x,y)=>a?playerProjection(y,a.first,data.fixtures,a.first)-playerProjection(x,a.first,data.fixtures,a.first):0);
  const captaincy=useCaptaincy(players,a?.first??0,a?.xi.captain??ranked[0],ranked[1]);
  if(!a)return <><ConnectTeam data={data}/><button className="wide-action" onClick={()=>go("draft")}>Build a team first →</button></>;
  const{captain,vice,chooseCaptain,chooseVice}=captaincy;
  const xiBase=a.xi.players.reduce((s,p)=>s+playerProjection(p,a.first,data.fixtures,a.first),0);
  const predicted=xiBase+playerProjection(captain,a.first,data.fixtures,a.first);
  const xiIds=a.xi.players.map(p=>p.id);
  const benchIds=a.bench.map(p=>p.id);
  let existingLocks:LockRecord[]=[];try{existingLocks=JSON.parse(localStorage.getItem("fpl-edge-locks")||"[]")}catch{}
  const existingLock=existingLocks.find(l=>l.event===a.first);
  const lockStatus=reconcileLock(existingLock,{xiIds,benchIds,captainId:captain.id,viceId:vice.id});
  const locked=lockStatus==="matches";
  const fullReceiptSaved=locked&&existingLock?.receipt?.modelVersion===PROJECTION_MODEL_VERSION&&existingLock.receipt.schemaVersion===6&&existingLock.receipt.dataUpdatedAt===data.updatedAt;
  const lock=()=>{
    setLockError("");
    const event=data.events.find(item=>item.id===a.first),capturedAt=new Date().toISOString();
    if(!event||Date.parse(capturedAt)>=Date.parse(event.deadline)){setLockError("The official deadline has passed. A pre-deadline receipt was not created.");return}
    try{
      const freeTransfers=readFreeTransfers(),bank=meta?.bank??a.bank;
      const baseRows=bestTransfers(data,squad,bank,freeTransfers,60,sellingPricesFor(meta));
      const transferRows=withModelUtilityChange(baseRows,squad,createOptimizer(data,"Balanced 5 GWs","Balanced","Maximum xPts"));
      const receipt=createProjectionReceipt({data,eventIds:a.events.slice(0,5).map(item=>item.id),deadline:event.deadline,capturedAt,squad,xiIds,benchIds,captainId:captain.id,viceId:vice.id,bank,freeTransfers,transferRows});
      const record:LockRecord={event:a.first,lockedAt:capturedAt,dataUpdatedAt:data.updatedAt,predicted:receipt.squad.predictedTotal,squadIds:squad.map(p=>p.id),xiIds,benchIds,captainId:captain.id,viceId:vice.id,receipt};
      persist("fpl-edge-locks",JSON.stringify([...existingLocks.filter(item=>item.event!==a.first),record]));setLockVersion(v=>v+1);
    }catch(error){setLockError(error instanceof Error?error.message:"Could not create the projection receipt.")}
  };
  const modelCaptain=a.xi.captain;
  const captainDisagreement=modelCaptain&&modelCaptain.id!==captain.id?modelCaptain:null;
  const riskNote=captainRiskNote(captain,vice,startPct(captain,a.first,data),startPct(vice,a.first,data),playerProjection(captain,a.first,data.fixtures,a.first),playerProjection(vice,a.first,data.fixtures,a.first));
  const chipHorizon=a.events.slice(0,5);
  const chipRows=chipHorizon.map((event,index)=>({eventId:event.id,scores:chipScoresForEvent(data,squad,event,chipHorizon.slice(index,index+5).map(e=>e.id),true)}));
  const chip=chipVerdictAcrossHorizon(chipRows);
  return <div className="coach-page">
    <section className="lock-header"><div><span>LOCK-IN</span><h2>Your exact deadline plan.</h2><p>Generated from your saved squad and the latest official FPL feed.</p></div><div><b>{formation(a.xi.players)}</b><small>formation · {predicted.toFixed(1)} xPts</small></div></section>
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
    <button className={`lock-button ${fullReceiptSaved?"locked":""}`} onClick={lock}>{fullReceiptSaved?"FULL RECEIPT SAVED ✓":locked?"REFRESH FULL RECEIPT":"LOCK THIS TEAM"}<small>{fullReceiptSaved?`${existingLock!.receipt!.players.length} player projections · ${existingLock!.receipt!.transfers.length} ranked routes · ${existingLock!.receipt!.modelVersion}`:"Save the XI, captaincy, every player projection and ranked transfer routes before the deadline."}</small></button>
  </div>;
}
function CaptainCompare({xi,captain,vice,data,event}:{xi:FplPlayer[];captain:FplPlayer;vice:FplPlayer;data:FplData;event:number}){
  const players=[captain,vice];
  const candidates:CaptainCandidate[]=xi.map(p=>{
    const m=projectionMetrics(p,event,data.fixtures,event);
    const{ret,haul}=captainReturnHaul(m);
    return{id:p.id,name:p.name,xPts:m.xPts,ret,haul,startProbability:m.startProbability,selectedBy:p.selectedBy};
  });
  const framing=captaincyRiskFraming(candidates,captain.id);
  const defaultCandidate=candidates.find(c=>c.id===captain.id)!;
  const roleLabel=framing.defaultRole==="safe"?`${captain.name} is both your model pick and the safest option in your XI this week.`:framing.defaultRole==="differential"?`${captain.name} is both your model pick and the highest-ceiling differential in your XI this week.`:`${captain.name} is a balanced pick — not the safest floor or the highest ceiling in your XI, just the highest projected points.`;
  const sameAlternative=framing.safeAlternative&&framing.differentialAlternative&&framing.safeAlternative.id===framing.differentialAlternative.id;
  return <section className="captain-compare">
    <header><span>CAPTAIN COMPARISON</span><h2>{players.map(p=>p.name).join(" vs ")}</h2></header>
    <div>{players.map(p=>{const m=projectionMetrics(p,event,data.fixtures,event);const{ret,haul}=captainReturnHaul(m);return <article key={p.id}><h3>{p.name}<small>{opponent(p,event,data)}</small></h3><p><span>xPts</span><b>{m.xPts.toFixed(1)}</b></p><p><span>Projected minutes</span><b>{Math.round(m.expectedMinutes)}</b></p><p><span>Return probability</span><b>{Math.round(ret)}%</b></p><p><span>Haul probability</span><b>{Math.round(haul)}%</b></p><p><span>Ownership</span><b>{p.selectedBy.toFixed(1)}%</b></p><p><span>Risk</span><b>{m.startProbability>.8?"Low":m.startProbability>.65?"Medium":"High"}</b></p></article>})}</div>
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
    <section className="model-trust"><div><span>HOW PROJECTIONS WORK</span><h2>Transparent by default. Technical when you want it.</h2><p>Expected points combine expected minutes, team and opponent strength, xG/xA, penalties and set pieces, clean-sheet probability, defensive contributions, home advantage, role and official availability.</p></div><button onClick={()=>setTechnical(x=>!x)}>{technical?"Hide technical detail":"Open technical detail"}</button>{technical&&<div className="technical-note"><b>Technical method</b><p>Players are assigned to an explicit Premier League evidence group. Established PL history uses normal shrinkage; limited history receives stronger shrinkage; players with no genuine PL prior start from a position baseline and learn more slowly from early current-season matches.</p><p>Club-level PL continuity lowers the confidence ceiling when a roster has little proven top-flight evidence. It never substitutes Championship output as Premier League data.</p></div>}</section>
    <section className="model-picker"><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search a player…"/><div>{players.map(x=><button className={x.id===p.id?"active":""} onClick={()=>setSelected(x.id)} key={x.id}>{x.name}<small>{x.teamShort}</small></button>)}</div></section>
    <section className="projection-explainer"><header><div><span>{p.teamName} · {p.position} · £{p.price.toFixed(1)}m</span><h2>{p.name} — {m.xPts.toFixed(1)} xPts</h2></div><b className={confidence.toLowerCase()}>Confidence: {confidence}</b></header><div>{[["Appearance",appearance],["Goals",goalPts],["Assists",assistPts],["Clean sheet",cleanPts],["Bonus",m.bonus],["Other",other]].map(([label,value])=><article key={String(label)}><span>{label}</span><b>{Number(value).toFixed(2)}</b><i><em style={{width:`${clamp(Number(value)/Math.max(.1,m.xPts)*100)}%`}}/></i></article>)}</div><footer><span>{Math.round(m.expectedMinutes)} xMins</span><span>{Math.round(m.startProbability*100)}% start</span><span>{m.penaltyRole?"Penalties":"No confirmed pens"}</span><span>{m.setPieceRole?"Set pieces":"No confirmed set pieces"}</span></footer></section>
    <section className="calibration-card"><header><div><span>PLAYER EVIDENCE CLASS</span><h2>{calibration.label}</h2></div><b>{Math.round(m.confidence*100)}% confidence</b></header><div><p><span>Prior PL sample</span><b>{p.priorMinutes.toLocaleString()} min</b><small>{calibration.hasPremierLeaguePrior?`${p.priorSeason??"Prior season"} · ${p.priorCompetition??"Premier League"}`:"No non-PL statistics substituted"}</small></p><p><span>Current PL sample</span><b>{p.minutes.toLocaleString()} min</b><small>{Math.round((m.currentEvidenceWeight??0)*100)}% current-rate weight</small></p><p><span>Confidence ceiling</span><b>{Math.round((m.confidenceCap??1)*100)}%</b><small>rises only when real PL evidence supports it</small></p><p><span>Club PL continuity</span><b>{Math.round((p.teamPlPriorCoverage??0)*100)}%</b><small>{calibration.lowPlContinuityClub?"Promoted / low-continuity context":"Established roster context"}</small></p></div>{calibration.group!=="established-pl"&&<footer>This player is deliberately prevented from receiving established-player certainty. The transfer rank consumes the lower confidence; warnings explain the evidence gap.</footer>}</section>
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
      <div className="accuracy-breakdowns"><SliceTable title="BY POSITION" items={byPosition}/><SliceTable title="BY CONFIDENCE" items={byConfidence}/></div>
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

function CoachDock({data,go,revision}:{data:FplData;go:(v:View)=>void;revision:number}){const[open,setOpen]=useState(false);const squad=useMemo(()=>savedSquad(data),[data,revision]),a=analysis(data,squad);let title="Connect your team to activate the coach.",detail="Once connected, I will summarise the strongest action using the same live data as every page.",target:View="team";let manager:ManagerMeta|null=null;try{manager=JSON.parse(localStorage.getItem("fpl-edge-manager")||"null")}catch{}if(a){const moves=bestTransfers(data,squad,manager?.bank??a.bank,1,12,sellingPricesFor(manager)),move=moves[0];if(a.issues.length){title=`Your biggest concern is ${a.issues[0].name}.`;detail=`${startPct(a.issues[0],a.first,data)}% modelled start probability. Review late news before acting.`;target="deadline"}else if(move&&!move.reviewRequired&&move.rankScore>=2.2){title=`${move.out.name} → ${move.incoming.name} is your leading route.`;detail=`+${move.gain5.toFixed(1)} projected squad points over five gameweeks, before any hit cost.`;target="transfers"}else{title="You do not need to force a transfer.";detail="No risk-adjusted squad move currently clears the action threshold. Rolling preserves flexibility.";target="transfers"}}return <aside className={`coach-dock ${open?"open":""}`}><button className="coach-orb" onClick={()=>setOpen(x=>!x)}><i>E</i><span>FPL Coach</span></button>{open&&<div><span>FPL COACH · LIVE SUMMARY</span><h3>{title}</h3><p>{detail}</p><button onClick={()=>{go(target);setOpen(false)}}>Inspect the evidence →</button></div>}</aside>}
