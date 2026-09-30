"use client";

import {ReactNode,Suspense,lazy,useState,useEffect,useRef,useMemo} from "react";
import {Wordmark} from "./Wordmark";

import ReconnectFplPanel from "./ReconnectFplPanel";

import {plannedChipFor,readPlannedChips} from "../lib/chip-portfolio";
import {resolveCaptaincy} from "../lib/captaincy";
import {FplPlayer,projectionMetrics,FplData,fetchFplData,futureEvents,savedSquad,playerProjection,startPct} from "../lib/fpl";
import {createOptimizer} from "../lib/optimizer";
import {FiveGwGainBand} from "../lib/anomalies";
import {detectFixtureAnomalies,nearestInHorizon} from "../lib/dgw";
import {markSignedIn,syncWithServer,persist,writeAccountTeam} from "../lib/persistence";
import {activateExampleSquad,isExampleSquadActive,EXAMPLE_SQUAD_LABEL,clearExampleSquadFlag} from "../lib/example-squad";
import {refreshConnectedTeamFromApi} from "../lib/team-live-refresh";
import {TeamLinkAuthProvider,useTeamLinkAuth,TEAM_SIGN_IN_HREF} from "./team-link-auth";
import {Transfer,bestTransfers,selectBestDecision} from "../lib/transfers";
import {scheduleDeferred} from "../lib/transfer-engine/schedule";
import {ManagerMeta,deriveSandboxFinancialContext,isRankingFinanceUnavailable} from "../lib/squad-comparison";
import {SeasonLocked} from "./SeasonPass";
import {formatSeasonPassPrice} from "../lib/season-pass";
import {computeDataFreshness,publicConnectionStatus,isDataFreshnessDebug} from "../lib/data-freshness";
import {ConnectTeam,analysis,authoritativeFreeTransfers,connectTeam,managerWildcardActive,priceProtectionAlerts,rankTransfersForBestDecision,useManager} from "./coach/CoachCore";
import type {View} from "./coach/CoachCore";

const VALID_VIEWS: ReadonlySet<View> = new Set(["overview","team","transfers","league","draft","board","players","fixtures","news","deadline","chips","model","history","ownership","coach","squad-fixtures","season-stats"]);

export function parseCoachView(raw:string|null|undefined):View|null{
  if(!raw)return null;
  const value=raw.trim().toLowerCase() as View;
  return VALID_VIEWS.has(value)?value:null;
}

export function coachViewFromLocation(search:string):View|null{
  try{return parseCoachView(new URLSearchParams(search).get("view"))}catch{return null}
}

/** Pure ?view= search builder for deep links. Client-side only (needs JS; no SSR rewrite). */
export function coachViewSearchParams(view:View, currentSearch:string=""):string{
  const raw=currentSearch.startsWith("?")?currentSearch.slice(1):currentSearch;
  const params=new URLSearchParams(raw);
  if(view==="overview")params.delete("view");
  else params.set("view",view);
  // Preserve app/demo entry flags used by the marketing shell.
  if(!params.has("app")&&!params.has("demo"))params.set("app","1");
  const q=params.toString();
  return q?`?${q}`:"";
}

function writeCoachViewToUrl(view:View){
  try{
    const url=new URL(window.location.href);
    const next=coachViewSearchParams(view,url.search);
    url.search=next.startsWith("?")?next.slice(1):next;
    window.history.pushState({fplEdgeView:view},"",url.pathname+url.search+url.hash);
  }catch{/* ignore */}
}

type Desk="unknown"|"visitor"|"free"|"season";

// Signed-in users without an active season pass see these views as the full desk, not the free move.
const PRO_VIEWS: ReadonlySet<View> = new Set(["news", "draft", "board", "chips", "history"]);

// Grouped navigation (Home/Coach standalone, then 4 labeled sections) -- the single source of
// truth for both the desktop sidebar and the mobile nav/overlay below. No separate flat array is
// kept alongside this: nothing outside this file's own render sites ever consumed `nav`'s prior
// flat shape or its ordering (confirmed by auditing every go() call site -- every call passes a
// literal View id or an already-View-typed variable, never a position/index).
type NavGroup=Readonly<{label:string|null;items:readonly(readonly[View,string,string])[]}>;

const navGroups:readonly NavGroup[]=[
  {label:null,items:[["overview","Overview","⌂"]]},
  {label:null,items:[["coach","Coach","♟"]]},
  // Desktop primary owns deadline/Final check; My Fixtures lives under Research disclosure.
  {label:"My Squad",items:[["team","My team","◫"],["news","News","●"]]},
  {label:"Plan",items:[["transfers","Transfers","⇄"],["draft","Draft lab","◇"],["board","Strategy board","⊞"],["chips","Chips","★"]]},
  {label:"Research",items:[["players","Players","⌕"],["season-stats","Season Stats","▥"],["squad-fixtures","My Fixtures","▤"],["ownership","Ownership","◈"],["model","Points model","∑"],["fixtures","Fixtures","▦"]]},
  {label:"League & History",items:[["league","Mini-League","◎"],["history","History","↗"]]},
];

const fmt=(n:number|null|undefined)=>n?Math.round(n).toLocaleString():"—";

// Tightened cadence while a gameweek is genuinely live (deadline passed, not yet finished). Note
// this only bounds the client's own added latency: /api/fpl's response and internal FPL fetches are
// both cached for ~5 minutes server-side, so real freshness is still floored there regardless of
// this value -- tightening that cache is a separate, app-wide change, deliberately out of scope here.
const LIVE_GAMEWEEK_REFRESH_MS=60000;

const certainty=(p:FplPlayer)=>p.status!=="a"?"CONFIRMED":projectionMetrics(p,0,[],0).startProbability>.72?"LIKELY":"UNCERTAIN";

// Desktop primary (Kevin IA): Overview · Squad · Transfers · Final check · Players · Coach.
// Research · PRO remain disclosures only — no new PRO features.
const PRIMARY_NAV = [
  ["overview","Overview","⌂"],
  ["team","Squad","◫"],
  ["transfers","Transfers","⇄"],
  ["deadline","Final check","✓"],
  ["players","Players","⌕"],
  ["coach","Coach","♟"],
] as const;

function NavLock(){return <em className="nav-lock" aria-label="Locked"/>}

function NavIcon({id}:{id:string}){
  const stroke={viewBox:"0 0 24 24",width:22,height:22,fill:"none" as const,stroke:"currentColor",strokeWidth:1.75,strokeLinecap:"round" as const,strokeLinejoin:"round" as const,"aria-hidden":true as const};
  switch(id){
    case "overview":return <svg {...stroke}><path d="M4 10.5 12 3.5 20 10.5"/><path d="M6 9.8V20h4.5v-5.5h3V20H18V9.8"/></svg>;
    case "team":return <svg {...stroke}><path d="M8.2 5.2 12 7 15.8 5.2 19.5 8 17.4 10v9H6.6V10L4.5 8z"/></svg>;
    case "deadline":return <svg {...stroke}><circle cx="12" cy="12" r="8"/><path d="m8.4 12.2 2.6 2.5 4.8-5.4"/></svg>;
    case "squad-fixtures":
    case "fixtures":return <svg {...stroke}><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3.5v3M16 3.5v3M4 10h16"/></svg>;
    case "transfers":return <svg {...stroke}><path d="M4 8h13M14 5l3 3-3 3M20 16H7M10 13l-3 3 3 3"/></svg>;
    case "players":return <svg {...stroke}><circle cx="9" cy="8" r="2.5"/><circle cx="16" cy="9" r="2"/><path d="M3.8 18.4c.9-2.5 2.8-3.8 5.2-3.8s4.3 1.3 5.2 3.8M14.2 14.7c1.4-.4 2.7-.4 3.9 0 1.5.5 2.6 1.6 3.1 3.2"/></svg>;
    case "coach":return <svg {...stroke}><path d="M6 4.5v15M6 5.5h11l-2.2 3.2L17 12H6"/></svg>;
    case "research":return <svg {...stroke}><path d="M4 19V5M4 19h16M8 16V11M12 16V8M16 16v-3"/></svg>;
    case "pro":return <svg {...stroke}><rect x="5" y="11" width="14" height="8.5" rx="1.5"/><path d="M8 11V8.2a4 4 0 0 1 8 0V11"/></svg>;
    case "more":return <svg {...stroke}><circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg>;
    case "news":return <svg {...stroke}><path d="M6 9.2a6 6 0 0 1 12 0c0 3.6 1.4 5 1.4 5H4.6S6 12.8 6 9.2"/><path d="M10 18.2a2 2 0 0 0 4 0"/></svg>;
    case "draft":return <svg {...stroke}><path d="m12 3.5 8 4.6-8 4.6-8-4.6zM4 12.4l8 4.6 8-4.6M4 16.2l8 4.5 8-4.5"/></svg>;
    case "board":return <svg {...stroke}><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 16h16M10 4v16M16 4v16"/></svg>;
    case "chips":return <svg {...stroke}><path d="m12 3.8 2.2 5.2 5.5.4-4.3 3.6 1.4 5.3L12 15.6 7.2 18.3 8.6 13 4.3 9.4 9.8 9z"/></svg>;
    case "ownership":return <svg {...stroke}><circle cx="12" cy="12" r="8"/><path d="M12 4v8h8"/></svg>;
    case "season-stats":return <svg {...stroke}><path d="M5 20V11M11 20V6M17 20v-7"/><path d="M3 20h18"/></svg>;
    case "model":return <svg {...stroke}><path d="m4 16.5 5-5.5 3.2 3.2L20 6.5M15 6.5h5v5"/></svg>;
    case "league":return <svg {...stroke}><circle cx="8" cy="9" r="2.3"/><circle cx="16" cy="9" r="2.3"/><path d="M3.6 17.6c.7-2.2 2.3-3.4 4.4-3.4s3.7 1.2 4.4 3.4M12.4 14.5c1-.4 2.1-.5 3.1-.2 1.7.4 2.8 1.5 3.3 3.3"/></svg>;
    case "history":return <svg {...stroke}><circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 2"/></svg>;
    default:return <svg {...stroke}><circle cx="12" cy="12" r="7"/></svg>;
  }
}

function MobileSheet({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}){
  return <div className="mobile-sheet" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button type="button" onClick={onClose} aria-label="Close">×</button></header><div className="mobile-sheet-list">{children}</div></div>;
}

const MORE_VIEW_LABELS:Partial<Record<View,string>>={
  deadline:"Final check",
  players:"Players",
  "season-stats":"Season Stats",
  ownership:"Ownership",
  model:"Points model",
  fixtures:"Fixtures",
  league:"Mini-league",
  history:"History",
  news:"News",
  draft:"Draft lab",
  board:"Strategy board",
  chips:"Chips",
};

function PhoneMoreCrumb({view,onOpenMore}:{view:View;onOpenMore:()=>void}){
  const label=MORE_VIEW_LABELS[view]??String(view);
  return <nav className="phone-more-crumb" aria-label="More destination"><button type="button" onClick={onOpenMore}>More</button><span aria-hidden="true">›</span><strong>{label}</strong></nav>;
}

function freshness(data:FplData, opts?:{loadFailed?:boolean;debug?:boolean}){
  const f=computeDataFreshness({
    edgeCalculatedAt:data.edgeCalculatedAt||data.updatedAt,
    officialFetchedAt:data.officialFetchedAt??null,
    cacheMaxAgeSeconds:data.cacheMaxAgeSeconds,
  });
  const usable=Array.isArray(data.players)&&data.players.length>0;
  const pub=publicConnectionStatus({hasUsableData:usable,loadFailed:opts?.loadFailed===true});
  const debug=opts?.debug===true||(typeof window!=="undefined"&&isDataFreshnessDebug(window.location.search));
  // Public UX: Connected / Not connected only. Detailed Edge/Official/cache string is ?debug=1 only.
  return{
    minutes:f.effectiveAgeMinutes,
    label:pub.label,
    tone:pub.tone,
    publicStatus:pub.status,
    edgeLabel:f.edgeLabel,
    officialLabel:f.officialLabel,
    detailLabel:f.summaryLabel,
    showDetail:debug,
  };
}

function expectedMins(p:FplPlayer,event:number,data:FplData){return Math.round(projectionMetrics(p,event,data.fixtures,event).expectedMinutes)}

export default function CoachApp({onBack,startAuth=false,startExample=false}:{onBack:()=>void;startAuth?:boolean;startExample?:boolean}){
  const[view,setView]=useState<View>(()=>{if(typeof window==="undefined")return "overview";const initial=coachViewFromLocation(window.location.search)??"overview";/* ?view= deep link: start the chunk download now, in parallel with the /api/fpl fetch */preloadView(initial);return initial});const[data,setData]=useState<FplData|null>(null);const[error,setError]=useState("");const[loading,setLoading]=useState(true);const[revision,setRevision]=useState(0);
  const[desk,setDesk]=useState<Desk>("unknown");
  const[exampleActive,setExampleActive]=useState(false);
  const openPay=()=>{window.location.assign("/pay")};
  const onAccount=(account:{seasonPassActive:boolean;seasonPassEndsAt:string|null}|null)=>{
    if(!account){markSignedIn(false);setDesk("visitor");return}
    markSignedIn(true);
    setDesk(account.seasonPassActive?"season":"free");
  };
  // Phone sheet: "My Squad" | "PRO" | "More", or null. PRO stays the menu word (never Plan).
  const[mobileOverlay,setMobileOverlay]=useState<string|null>(null);const[sidebarMenu,setSidebarMenu]=useState<"pro"|"research"|null>(null);
  const load=async()=>{setLoading(true);setError("");try{setData(await fetchFplData())}catch(e){setError(e instanceof Error?e.message:"Official FPL data unavailable")}finally{setLoading(false)}};
  useEffect(()=>{load()},[]);
  // Visitor demo: preload labelled example squad when Open Demo / ?demo=1 asked for it.
  // Demo ids live in isolated storage — never overwrite a visitor's saved manual draft.
  useEffect(()=>{
    if(!data||!startExample)return;
    try{
      // Official connected team wins: do not mask real FPL data with the example XV.
      if(localStorage.getItem("fpl-edge-manager"))return;
      if(activateExampleSquad(data)){setExampleActive(true);setRevision(x=>x+1)}
    }catch{/* keep empty desk */}
  },[data,startExample]);
  useEffect(()=>{setExampleActive(isExampleSquadActive())},[revision,data]);
  // Warm the primary-nav chunks once the first view has painted, off the critical path (idle time), so a
  // tab click resolves from cache instead of showing the Loading placeholder. Purely a download hint.
  useEffect(()=>{if(!data)return;const handle=scheduleDeferred(()=>{for(const v of PREFETCH_AFTER_PAINT)preloadView(v)},{timeout:4000,delayMs:800});return()=>handle.cancel()},[!!data]);
  const currentEvent=data?.events.find(e=>e.current);
  const isLiveWindow=!!currentEvent&&!currentEvent.finished&&Date.parse(currentEvent.deadline)<=Date.now();
  useEffect(()=>{const id=window.setInterval(load,isLiveWindow?LIVE_GAMEWEEK_REFRESH_MS:300000);return()=>window.clearInterval(id)},[isLiveWindow]);
  const dataRef=useRef(data);dataRef.current=data;
  const runSync=()=>{syncWithServer().then(async changed=>{if(changed)setRevision(x=>x+1);const current=dataRef.current;if(!current)return;const live=await refreshConnectedTeamFromApi(current,{force:true});if(live.updated)setRevision(x=>x+1)})};
  useEffect(()=>{runSync()},[]);
  // Always refresh live `/api/fpl/team` into localStorage when an entry is present — do not gate on
  // desk/sign-in. After `/api/squad` hydrate, runSync already force-refreshes; this covers late data
  // load and signed-out entry caches so Transfers never first-paints the stale £2.1 XI.
  useEffect(()=>{if(!data)return;let cancelled=false;refreshConnectedTeamFromApi(data,{force:true}).then(live=>{if(!cancelled&&live.updated)setRevision(x=>x+1)});return()=>{cancelled=true}},[data]);
  // After sign-in desk flips, force-refresh again so account hydrate cannot leave stale bank/squad.
  useEffect(()=>{if(!data||(desk!=="free"&&desk!=="season"))return;let cancelled=false;refreshConnectedTeamFromApi(data,{force:true}).then(live=>{if(!cancelled&&live.updated)setRevision(x=>x+1)});return()=>{cancelled=true}},[data,desk]);
  const go=(next:View)=>{preloadView(next);setView(next);setRevision(x=>x+1);setMobileOverlay(null);setSidebarMenu(null);writeCoachViewToUrl(next);window.scrollTo({top:0,behavior:"smooth"})};
  useEffect(()=>{
    const onPop=()=>{
      const next=coachViewFromLocation(window.location.search)??"overview";
      preloadView(next);setView(next);setRevision(x=>x+1);setMobileOverlay(null);setSidebarMenu(null);
    };
    window.addEventListener("popstate",onPop);
    return()=>window.removeEventListener("popstate",onPop);
  },[]);
  const fresh=data?freshness(data):null;
  const allNav=navGroups.flatMap(g=>[...g.items]);
  const proItems=(["draft","board","chips","news","history"] as const).map(key=>allNav.find(([id])=>id===key)!);
  // Research disclosure: everything under Research/League except Players (already primary) and PRO locks.
  const researchRest=navGroups.filter(g=>g.label==="Research"||g.label==="League & History").flatMap(g=>[...g.items]).filter(([key])=>key!=="players"&&!PRO_VIEWS.has(key));
  // Desktop primary is exactly PRIMARY_NAV — no injected squadRest duplicates (Final check already primary).
  const sideNav=PRIMARY_NAV;
  const toggleMobileOverlay=(label:string)=>setMobileOverlay(current=>current===label?null:label);
  const teamAuth=desk==="unknown"?"loading":desk==="visitor"?"out":"in";
  // Phone 5-tab destinations are partitioned (no overlap). When a sheet is open, ONLY that
  // sheet's tab is active (clears Home/Coach/content tabs). Final check stays in More.
  // Transfers under My Squad: phoneSquadViews includes transfers so go("transfers") keeps My Squad active.
  // My Fixtures stays under My Squad on phone even though desktop Research owns the disclosure entry.
  const phoneSquadViews=new Set<View>(["team","transfers","squad-fixtures"]);
  const phoneProViews=new Set<View>(proItems.map(([key])=>key));
  const phoneMoreResearch=researchRest.filter(([key])=>key!=="squad-fixtures");
  const phoneMoreViews=new Set<View>(["deadline","players",...phoneMoreResearch.map(([key])=>key)]);
  // Exactly one bottom tab active: sheet open → that sheet's tab only; else content partition.
  // More-routed child pages (Players, Final check, …) clear More lime and show PhoneMoreCrumb instead.
  const phoneHomeActive=!mobileOverlay&&view==="overview";
  const phoneSquadActive=mobileOverlay==="My Squad"||(!mobileOverlay&&phoneSquadViews.has(view));
  const phoneProActive=mobileOverlay==="PRO"||(!mobileOverlay&&phoneProViews.has(view));
  const phoneCoachActive=!mobileOverlay&&view==="coach";
  const phoneMoreActive=mobileOverlay==="More";
  const phoneMoreChild=!mobileOverlay&&phoneMoreViews.has(view);
  // Phase 1 chrome-strip: sticky header = Wordmark · GW countdown · Sign in/Account only.
  // Season pass lives under More; floating Coach pill removed; freshness owned by sidebar (desktop) / slim line (phone).
  return <TeamLinkAuthProvider value={teamAuth}><main className={desk==="visitor"?"coach-shell signed-out":"coach-shell"}>
    <aside className="coach-sidebar"><button className="brand sidebar-brand" onClick={onBack}><Wordmark/></button><nav className="coach-primary">{sideNav.map(([key,label])=><button key={key} className={view===key?"active":""} onClick={()=>go(key)}><i><NavIcon id={key}/></i><span>{label}</span></button>)}</nav><div className="sidebar-menus"><button type="button" className={researchRest.some(([key])=>key===view)?"active":sidebarMenu==="research"?"open":""} onClick={()=>setSidebarMenu(m=>m==="research"?null:"research")}><i><NavIcon id="research"/></i><span>Research</span><i className="nav-caret" aria-hidden="true"/></button>{sidebarMenu==="research"&&<div className="sidebar-drop">{researchRest.map(([key,label])=><button key={key} className={view===key?"active":""} onClick={()=>go(key)}><i><NavIcon id={key}/></i><span>{label}</span></button>)}</div>}</div><div className="sidebar-pro"><button type="button" className={proItems.some(([key])=>key===view)?"sidebar-pro-btn active":sidebarMenu==="pro"?"sidebar-pro-btn open":"sidebar-pro-btn"} onClick={()=>setSidebarMenu(m=>m==="pro"?null:"pro")}><i><NavIcon id="pro"/></i><span>PRO</span><i className="nav-caret" aria-hidden="true"/></button>{sidebarMenu==="pro"&&<div className="sidebar-drop">{proItems.map(([key,label])=><button key={key} className={view===key?"active":""} onClick={()=>go(key)}><i><NavIcon id={key}/></i><span>{label}</span>{desk!=="season"&&<NavLock/>}</button>)}</div>}</div><div className="coach-data-note" aria-label="Data connection"><span className={`fresh-dot ${fresh?.tone||"stale"}`}/><div><b>{fresh?fresh.label:(error&&!data?"Not connected":"Connecting…")}</b>{fresh?.showDetail?<small className="freshness-debug">{fresh.detailLabel}</small>:null}</div></div><ThemeToggle/><button className="back-link" onClick={onBack}>← Back to site</button></aside>
    <section className="coach-main"><header className="coach-header"><span className="brand header-wordmark"><Wordmark/></span><div className="header-tools">{data&&<DeadlineClock data={data}/>}{desk==="visitor"?<div className="signin-action"><a className="team-signin" href="/signin?return_to=%2F%3Fapp%3D1">Sign in</a></div>:<AccountBar onAuthChange={runSync} onAccount={onAccount} initialOpen={startAuth}/>}</div></header>
      {loading&&!data?<Loading label="Loading your FPL decision engine…"/>:error&&!data?<Loading label={error} retry={load}/>:data?<><Freshness data={data} onRefresh={load} loading={loading} phoneQuiet/>{phoneMoreChild&&<PhoneMoreCrumb view={view} onOpenMore={()=>setMobileOverlay("More")}/>}{exampleActive&&<p className="example-squad-banner" role="status">{EXAMPLE_SQUAD_LABEL}. Transfers, captaincy and explanations use this demo XV — sign in to connect your real team.</p>}<Page view={view} data={data} go={go} revision={revision} onTeamChange={()=>setRevision(x=>x+1)} desk={desk} onUpgrade={openPay} onLoadExample={()=>{if(activateExampleSquad(data)){setExampleActive(true);setRevision(x=>x+1)}}} exampleActive={exampleActive} onClearExample={()=>{clearExampleSquadFlag();setExampleActive(false);setRevision(x=>x+1)}}/><p className="truth-note">Official FPL supplies players, prices, fixtures, flags and results. FPL Edge projections and recommendations are estimates with uncertainty—not guarantees.</p></>:null}
    </section>
    {(desk==="free"||desk==="season")&&<footer className="coach-footer"><TeamBar data={data} revision={revision} onTeamChange={()=>setRevision(x=>x+1)}/></footer>}
    <nav className="coach-mobile-nav" aria-label="Phone primary"><button className={phoneHomeActive?"active":""} onClick={()=>go("overview")}><i><NavIcon id="overview"/></i>Home</button><button className={phoneSquadActive?"active":""} onClick={()=>toggleMobileOverlay("My Squad")}><i><NavIcon id="team"/></i>My Squad</button><button className={phoneProActive?"active":""} onClick={()=>toggleMobileOverlay("PRO")}><i><NavIcon id="pro"/></i>PRO</button><button className={phoneCoachActive?"active":""} onClick={()=>go("coach")}><i><NavIcon id="coach"/></i>Coach</button><button className={phoneMoreActive?"active":""} onClick={()=>toggleMobileOverlay("More")}><i><NavIcon id="more"/></i>More</button></nav>
    {mobileOverlay&&<MobileSheet title={mobileOverlay} onClose={()=>setMobileOverlay(null)}>
      {mobileOverlay==="My Squad"&&([["team","My team"],["transfers","Transfers"],["squad-fixtures","My Fixtures"]] as const).map(([key,label])=><button type="button" key={key} className={view===key?"sheet-active":""} onClick={()=>go(key)}><span>{label}</span>{key==="transfers"?<small className="sheet-hint">Single · Route · Watch</small>:null}</button>)}
      {mobileOverlay==="PRO"&&proItems.map(([key,label])=><button type="button" key={key} onClick={()=>go(key)}><span>{label}</span>{desk!=="season"&&<NavLock/>}</button>)}
      {mobileOverlay==="More"&&<><button type="button" className={view==="deadline"?"sheet-active":""} onClick={()=>go("deadline")}><span>Final check</span></button><button type="button" className={view==="players"?"sheet-active":""} onClick={()=>go("players")}><span>Players</span></button>{phoneMoreResearch.map(([key,label])=><button type="button" key={key} className={view===key?"sheet-active":""} onClick={()=>go(key)}><span>{label}</span></button>)}<button type="button" className="sheet-refresh" onClick={()=>{load();setMobileOverlay(null)}} disabled={loading}><span>{loading?"Refreshing…":"Refresh FPL data"}</span>{fresh?<small className="sheet-hint">Updated {fresh.label}</small>:null}</button>{desk==="season"?<p className="sheet-account-note">Season pass active · managed on your account</p>:(desk==="visitor"||desk==="free")&&<a className="sheet-link" href="/pay"><span>Season pass, {formatSeasonPassPrice()}</span></a>}</>}
    </MobileSheet>}
  </main></TeamLinkAuthProvider>
}
// Panels other than Overview are code-split: Overview (the default landing view, first paint) plus the
// shell chrome stay in this chunk; every other view is its own dynamic-import chunk. The loaders are
// module-level so the SAME promise is reused by prefetch (`preloadView`) and by React.lazy.
const loadTeam=()=>import("./coach/TeamPanel");
const loadTransfers=()=>import("./coach/TransfersPanel");
const loadPlayers=()=>import("./coach/PlayersPanel");
const loadCoach=()=>import("./coach/CoachPanel");
const loadFinal=()=>import("./coach/FinalCheckPanel");
const loadPlan=()=>import("./coach/PlanPanels");
const loadResearch=()=>import("./coach/ResearchPanels");
const loadDraft=()=>import("./LiveDraftBuilder");
const loadLeague=()=>import("./MiniLeagueWarRoom");
const LazyTeam=lazy(()=>loadTeam().then(m=>({default:m.Team})));
const LazyTransfers=lazy(()=>loadTransfers().then(m=>({default:m.Transfers})));
const LazyPlayers=lazy(()=>loadPlayers().then(m=>({default:m.Players})));
const LazyCoach=lazy(()=>loadCoach().then(m=>({default:m.Coach})));
const LazyFinalCheck=lazy(()=>loadFinal().then(m=>({default:m.FinalCheck})));
const LazyStrategyBoard=lazy(()=>loadPlan().then(m=>({default:m.StrategyBoard})));
const LazyNews=lazy(()=>loadPlan().then(m=>({default:m.News})));
const LazyOwnership=lazy(()=>loadResearch().then(m=>({default:m.OwnershipRadar})));
const LazySeasonStats=lazy(()=>loadResearch().then(m=>({default:m.SeasonStats})));
const LazyMyFixtures=lazy(()=>loadResearch().then(m=>({default:m.MyFixtures})));
const LazyFixturesView=lazy(()=>loadResearch().then(m=>({default:m.FixturesView})));
const LazyModelView=lazy(()=>loadResearch().then(m=>({default:m.ModelView})));
const LazyHistoryView=lazy(()=>loadResearch().then(m=>({default:m.HistoryView})));
const LazyChipsView=lazy(()=>loadResearch().then(m=>({default:m.ChipsView})));
const LazyDraft=lazy(loadDraft);
const LazyLeague=lazy(loadLeague);
/** Start fetching a view's chunk (idempotent: import() is cached by the module system). */
export function preloadView(view:View):void{
  const loader:Partial<Record<View,()=>Promise<unknown>>>={team:loadTeam,transfers:loadTransfers,players:loadPlayers,coach:loadCoach,deadline:loadFinal,board:loadPlan,news:loadPlan,ownership:loadResearch,"season-stats":loadResearch,"squad-fixtures":loadResearch,fixtures:loadResearch,model:loadResearch,history:loadResearch,chips:loadResearch,draft:loadDraft,league:loadLeague};
  loader[view]?.().catch(()=>{/* a failed prefetch is retried by React.lazy on render */});
}
/** Primary-nav views warmed in idle time after first paint (Overview itself is in this chunk). */
const PREFETCH_AFTER_PAINT:readonly View[]=["team","transfers","players","coach","deadline"];
/** Fixed-height placeholder (same box as Loading) so a lazy chunk arriving never shifts layout. */
function PanelFallback(){return <div className="coach-loading" role="status" aria-live="polite"><span className="live-spinner"/><b>Loading…</b></div>}

function PageContent({view,data,go,revision,onTeamChange,desk,onUpgrade,onLoadExample,exampleActive,onClearExample}:{view:View;data:FplData;go:(v:View)=>void;revision:number;onTeamChange:()=>void;desk:Desk;onUpgrade:()=>void;onLoadExample:()=>void;exampleActive:boolean;onClearExample:()=>void}){
  // unknown/visitor keep the demo. Only a signed-in account without a pass is gated, and only from the server session — never a client flag.
  if(desk==="unknown"&&PRO_VIEWS.has(view))return <div className="coach-page"><p className="truth-note">Checking access…</p></div>;
  if(desk==="free"&&view==="news")return <SeasonLocked feature="News impact alerts are part of the season pass." onUpgrade={onUpgrade}/>;
  if(desk==="free"&&(view==="draft"||view==="chips"))return <SeasonLocked feature="Draft and chip optimization are part of the season pass." onUpgrade={onUpgrade}/>;
  if(desk==="free"&&view==="board")return <SeasonLocked feature="Multi-week transfer planning is part of the season pass." onUpgrade={onUpgrade}/>;
  if(desk==="free"&&view==="history")return <SeasonLocked feature="Decision history is part of the season pass." onUpgrade={onUpgrade}/>;
  const fullDesk=desk!=="free";
  if(view==="overview")return <Overview data={data} go={go} revision={revision} onTeamChange={onTeamChange} onLoadExample={onLoadExample} onClearExample={onClearExample}/>;
  if(view==="team")return <LazyTeam data={data} go={go} revision={revision} onTeamChange={onTeamChange} fullDesk={fullDesk} onUpgrade={onUpgrade}/>;
  if(view==="transfers")return <LazyTransfers data={data} go={go} revision={revision} onTeamChange={onTeamChange} fullDesk={fullDesk} onUpgrade={onUpgrade}/>;
  if(view==="league")return <LazyLeague revision={revision} onGoToTeam={()=>go("team")}/>;
  if(view==="draft")return <LazyDraft/>;
  if(view==="board")return <LazyStrategyBoard data={data} go={go} revision={revision}/>;
  if(view==="players")return <LazyPlayers data={data} go={go} revision={revision}/>;
  if(view==="ownership")return <LazyOwnership data={data}/>;
  if(view==="season-stats")return <LazySeasonStats data={data}/>;
  if(view==="coach")return <LazyCoach data={data} go={go} revision={revision} onTeamChange={onTeamChange}/>;
  if(view==="squad-fixtures")return <LazyMyFixtures data={data} go={go} revision={revision} onTeamChange={onTeamChange}/>;
  if(view==="fixtures")return <LazyFixturesView data={data}/>;
  if(view==="news")return <LazyNews data={data} go={go} revision={revision}/>;
  if(view==="deadline")return <LazyFinalCheck data={data} go={go} revision={revision} onTeamChange={onTeamChange}/>;
  if(view==="chips")return <LazyChipsView/>;
  if(view==="model")return <LazyModelView data={data}/>;
  return <LazyHistoryView data={data} revision={revision} go={go}/>;
}
function Page(props:Parameters<typeof PageContent>[0]){
  return <Suspense fallback={<PanelFallback/>}><PageContent {...props}/></Suspense>;
}

function Loading({label,retry}:{label:string;retry?:()=>void}){return <div className="coach-loading"><span className="live-spinner"/><b>{label}</b>{retry&&<button onClick={retry}>Try again</button>}</div>}

function DeadlineClock({data}:{data:FplData}){const next=futureEvents(data,1)[0];const[now,setNow]=useState(Date.now());useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id)},[]);if(!next)return <div className="deadline-chip"><small>NEXT DEADLINE</small><b>Season complete</b><em className="deadline-compact">Season complete</em></div>;const total=Math.max(0,Date.parse(next.deadline)-now);const d=Math.floor(total/86400000),h=Math.floor(total/3600000)%24,m=Math.floor(total/60000)%60,s=Math.floor(total/1000)%60;const gw=next.name.replace(/^Gameweek\s+/i,"GW");const clock=`${d?`${d}d `:""}${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;return <div className="deadline-chip"><small>{next.name.toUpperCase()} DEADLINE</small><b>{clock}</b><span>{new Date(next.deadline).toLocaleString([],{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</span><em className="deadline-compact">{gw} {clock}</em></div>}

function Freshness({data,onRefresh,loading,phoneQuiet=false,loadFailed=false}:{data:FplData;onRefresh:()=>void;loading:boolean;phoneQuiet?:boolean;loadFailed?:boolean}){const f=freshness(data,{loadFailed});const warnings=data.dataIntegrityWarnings??[];const urgent=f.publicStatus==="not_connected"||warnings.length>0;return <section className={`freshness-strip ${f.tone}${phoneQuiet?" phone-quiet":""}${urgent?" has-urgent":""}`} aria-label="Data connection"><div><span className={`fresh-dot ${f.tone}`}/><b>{f.label}</b>{f.showDetail&&<small className="freshness-debug">{f.detailLabel}</small>}</div>{warnings.length>0&&<strong className="integrity-warning">⚠ Data integrity issue: {warnings[0]}{warnings.length>1?` (+${warnings.length-1} more)`:""}</strong>}<button onClick={onRefresh} disabled={loading}>{loading?"Refreshing…":"Refresh"}</button></section>}

// Squad/watchlist/locks persist to the server (see app/lib/persistence.ts) when signed in via
// either method below; both resolve to the same account (see app/lib/auth.ts).
// Step 3: the app defaults to dark now (see layout.tsx's themeInitScript), which already ran
// synchronously in <head> before this component's client-side render -- so the initial state is
// read straight from the DOM via useState's lazy-initializer form rather than guessed and
// corrected in a later effect. That removes the artificial extra render/repaint cycle a
// useEffect-based correction adds on top of hydration. This runs during SSR too (CoachApp is
// server-rendered -- confirmed by tests/mini-league-ui.test.mts crashing here without the guard),
// where `document` doesn't exist at all, so the guard below is load-bearing, not defensive
// boilerplate: SSR has no choice but to guess, and "dark" matches the app's real default. This
// toggle only ever writes an explicit "light"/"dark" override once the user actually clicks it.
function ThemeToggle(){
  const[theme,setTheme]=useState<"light"|"dark">(()=>typeof document!=="undefined"&&document.documentElement.getAttribute("data-theme")==="light"?"light":"dark");
  const toggle=()=>{const next=theme==="dark"?"light":"dark";setTheme(next);document.documentElement.setAttribute("data-theme",next);persist("fpl-edge-theme",next)};
  return <button type="button" className={theme==="dark"?"theme-toggle on":"theme-toggle"} role="switch" aria-checked={theme==="dark"} aria-label={theme==="dark"?"Dark mode on":"Light mode on"} onClick={toggle}><span>{theme==="dark"?"Dark":"Light"}</span><i/></button>;
}

function AccountBar({onAuthChange,onAccount,initialOpen=false}:{onAuthChange:()=>void;onAccount:(account:{seasonPassActive:boolean;seasonPassEndsAt:string|null}|null)=>void;initialOpen?:boolean}){
  const[account,setAccount]=useState<{email:string;method:"password";seasonPassActive:boolean;seasonPassEndsAt:string|null}|null>(null);
  const[checked,setChecked]=useState(false);
  const[open,setOpen]=useState(initialOpen);
  const[mode,setMode]=useState<"signin"|"signup">("signin");
  const[form,setForm]=useState({email:"",password:""});
  const[busy,setBusy]=useState(false);
  const[msg,setMsg]=useState("");
  const refresh=()=>{fetch("/api/auth/me",{cache:"no-store"}).then(r=>r.json()).then(d=>{
    const user=d.user??null;
    if(!user){setAccount(null);onAccount(null);setChecked(true);return}
    const season=user.seasonPass??{};
    const next={email:user.email as string,method:"password" as const,seasonPassActive:season.active===true,seasonPassEndsAt:typeof season.endsAt==="string"?season.endsAt:null};
    setAccount(next);onAccount(next);setChecked(true);
  }).catch(()=>{setChecked(true);onAccount(null)})};
  useEffect(()=>{refresh()},[]);
  const submit=async()=>{
    if(!form.email||!form.password){setMsg("Enter email and password.");return}
    setBusy(true);setMsg("");
    try{
      const post=(path:string)=>fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(form)});
      const res=await post(mode==="signup"?"/api/auth/signup":"/api/auth/login");
      const json=await res.json();
      if(!res.ok)throw new Error(json.error||"Could not sign in.");
      if(mode==="signup"){
        // Signup is a non-oracle endpoint (same reply for new/existing email, no session), so sign in explicitly.
        const login=await post("/api/auth/login");
        if(!login.ok){const lj=await login.json().catch(()=>({}));throw new Error(login.status===429&&lj.error?lj.error:"We could not finish setting up this account. If you already have an account with this email, sign in with your existing password.")}
      }
      setOpen(false);setForm({email:"",password:""});onAuthChange();refresh();
    }catch(e){setMsg(e instanceof Error?e.message:"Could not sign in.")}
    finally{setBusy(false)}
  };
  const signOut=async()=>{await fetch("/api/auth/logout",{method:"POST"});setAccount(null);onAccount(null);onAuthChange()};
  if(!checked)return <div className="account-bar account-chip"><small>Checking…</small></div>;
  if(account){
    const short=account.email.length>28?`${account.email.slice(0,25)}…`:account.email;
    return <div className="account-bar signed-in account-chip" title={account.email}>
      <span className="account-email">{short}</span>
      <button type="button" className="account-signout" onClick={signOut}>Sign out</button>
    </div>;
  }
  return <div className="account-bar account-chip"><a className="account-open" href="/signin?return_to=%2F%3Fapp%3D1">Sign in</a></div>;
}

// Sidebar-resident sibling to ConnectTeam -- that component only renders when there's no usable
// squad yet (isCompleteSquad fails), so once a team is connected there is no way back to it. This
// stays mounted regardless of connection state so switching (or dropping) teams is always reachable.
// Captain/vice picks (fpl-edge-captain-*/vice-*) are deliberately left untouched on disconnect/
// reconnect: resolveCaptaincy already validates any stored id against the CURRENT squad's players
// on every read (see its `valid()` guard) and falls back through manager->model->first-player when
// the stored id isn't in that squad -- confirmed by reading its call sites, not assumed from the
// similar pattern elsewhere. A stale id is inert dead data, never a rendering risk.
function TeamBar({data,revision,onTeamChange}:{data:FplData|null;revision:number;onTeamChange:()=>void}){
  const teamAuth=useTeamLinkAuth();
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
  const disconnect=async()=>{
    if(!confirm("Disconnect this team from your account? You can connect it again after you sign in."))return;
    setBusy(true);setMsg("");
    try{
      const saved=await writeAccountTeam({squadIds:[],entry:null,manager:null});
      if(!saved.ok)throw new Error(saved.error);
      setMeta(null);setOpen(false);onTeamChange();
    }catch(e){setMsg(e instanceof Error?e.message:"Could not disconnect this team from your account.")}
    finally{setBusy(false)}
  };
  if(teamAuth!=="in")return <div className="team-bar"><small>FPL TEAM</small><b>{meta?meta.teamName:teamAuth==="loading"?"Checking sign-in…":"Not connected"}</b><a className="team-open" href={TEAM_SIGN_IN_HREF}>Sign in to connect your team</a></div>;
  return <div className="team-bar">{!open?<><small>FPL TEAM</small><b>{meta?meta.teamName:"Not connected"}</b><button className="team-open" onClick={()=>setOpen(true)}>{meta?"Switch team":"Connect team"}</button></>:<div className="team-form"><input value={id} onChange={e=>setId(e.target.value.replace(/\D/g,""))} placeholder="FPL Team ID" inputMode="numeric"/><button onClick={connect} disabled={busy}>{busy?"Connecting…":"Connect"}</button>{msg&&<small className="team-error">{msg}</small>}<button className="team-cancel" onClick={()=>{setOpen(false);setMsg("")}}>Cancel</button>{meta&&<button className="team-disconnect" onClick={disconnect}>Disconnect team</button>}</div>}</div>;
}

function OverviewDeadlineStrip({event}:{event:{name:string;deadline:string}}){
  return <section className="overview-deadline" aria-label="Upcoming gameweek">
    <div><span>UP NEXT</span><h2>{event.name}</h2>
      <p className="overview-deadline-when">Deadline · {new Date(event.deadline).toLocaleString([],{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</p>
    </div>
  </section>;
}

/** Same FT input Transfers uses after live sync — authoritative when live my-team, else stored/default. */
function rankingFreeTransfersForDecision(meta:ManagerMeta|null|undefined):number{
  return authoritativeFreeTransfers(meta);
}

function Overview({data,go,revision,onTeamChange,onLoadExample,onClearExample}:{data:FplData;go:(v:View)=>void;revision:number;onTeamChange:()=>void;onLoadExample:()=>void;onClearExample:()=>void}){
  const[meta,setMeta]=useManager(revision);
  const squad=useMemo(()=>savedSquad(data),[data,revision,meta]);
  const a=analysis(data,squad);
  const finance=useMemo(()=>deriveSandboxFinancialContext(squad,data.rules.budget,meta),[squad,data.rules.budget,meta]);
  const wildcardActive=managerWildcardActive(meta);
  const fts=rankingFreeTransfersForDecision(meta);
  const optimizer=useMemo(()=>createOptimizer(data,"Balanced 5 GWs","Balanced","Maximum xPts"),[data]);
  // ASSERT — hang-safe Overview path (OVERVIEW_HANG_HOTFIX): sync shallow first paint; deep only via scheduleDeferred.
  // Do NOT reintroduce blocking planner work on the critical path. Deferred deep uses the SAME Transfers
  // pipeline (limit 60 + withModelUtilityChange via rankTransfersForBestDecision) so BEST DECISION matches.
  const shallowMoves=useMemo(()=>{
    if(!a||finance.source==="unavailable"||isRankingFinanceUnavailable(meta))return [] as Transfer[];
    return bestTransfers(data,squad,finance.baselineBank,fts,12,finance.baselineSellingPrices,{profile:"overview",mode:"shallow",wildcardActive});
  },[data,squad,finance,meta,a,fts,wildcardActive]);
  const[moves,setMoves]=useState<Transfer[]>([]);
  useEffect(()=>{
    setMoves(shallowMoves);
    if(!a||finance.source==="unavailable"||isRankingFinanceUnavailable(meta))return;
    const handle=scheduleDeferred(()=>{
      try{
        // Deferred deep upgrade: identical ranking/utility pipeline as Transfers (not hang-safe restricted budgets).
        const upgraded=rankTransfersForBestDecision(
          data,squad,finance.baselineBank,fts,finance.baselineSellingPrices,optimizer,{wildcardActive},
        );
        setMoves(upgraded);
      }catch{/* keep shallow */}
    },{timeout:500,delayMs:50});
    return()=>handle.cancel();
  },[data,squad,finance,meta,shallowMoves,a,fts,wildcardActive,optimizer]);
  const decision=selectBestDecision(moves);
  const decisionHold=Boolean(!decision||decision.isHold||decision.classification==="HOLD");
  const decisionClass=decisionHold?(wildcardActive?"KEEP":"HOLD"):(decision!.classification??"MAKE");
  const fiveGwNet=decision?(decision.fiveGwNetVsHold??decision.netEv5??decision.netDifference):0;
  const shortReason=decisionHold
    ?(decision?.engineReason??(wildcardActive?"No Wildcard swap clears the full-squad bar — keep iterating before the deadline.":"HOLD — bank the free transfer; no move clears 5-GW NET vs HOLD."))
    :(decision?.engineReason??`${decision!.out.name} → ${decision!.incoming.name} clears the risk-adjusted 5-GW NET vs HOLD bar.`);

  if(!a)return <>
    <section className="empty-command example-demo-card" aria-label="Open Demo">
      <span>OPEN DEMO</span>
      <h2>Try a real decision without signing in</h2>
      <p>Load a labelled example 15 — transfers, captaincy and explanation on live FPL data. Not your FPL team.</p>
      <button type="button" className="wide-action" onClick={onLoadExample}>Open Demo →</button>
    </section>
    <ConnectTeam data={data} onConnected={m=>{onClearExample();setMeta(m);onTeamChange()}}/>
    <section className="empty-command">
      <span>MANUAL OPTION</span>
      <h2>Already know your draft?</h2>
      <p>Build and save it manually. Your recommendations, transfer centre and deadline check will activate immediately.</p>
      <button onClick={()=>go("draft")}>Build a squad →</button>
    </section>
  </>;

  const liveBankBlocked=isRankingFinanceUnavailable(meta);
  const issues=a.issues;
  const next=a.events[0];
  let manager:ManagerMeta|null=null;
  try{manager=JSON.parse(localStorage.getItem("fpl-edge-manager")||"null")}catch{}
  const storedCaptainId=Number(localStorage.getItem(`fpl-edge-captain-${a.first}`));
  const storedViceId=Number(localStorage.getItem(`fpl-edge-vice-${a.first}`));
  const modelCaptain=a.xi.captain??a.xi.players[0];
  const resolvedCaptaincy=resolveCaptaincy(a.xi.players,storedCaptainId,storedViceId,manager?.captainId,manager?.viceCaptainId,modelCaptain,undefined);
  const activeCaptain=(resolvedCaptaincy&&a.xi.players.find(p=>p.id===resolvedCaptaincy.captainId))??modelCaptain;
  const plannedChip=plannedChipFor(readPlannedChips(),a.first);
  const captainTerm=playerProjection(activeCaptain,a.first,data.fixtures,a.first);
  const chipBonus=plannedChip==="Triple Captain"?captainTerm:plannedChip==="Bench Boost"?a.bench.reduce((s,p)=>s+playerProjection(p,a.first,data.fixtures,a.first),0):0;
  const projected=a.xi.players.reduce((s,p)=>s+playerProjection(p,a.first,data.fixtures,a.first),0)+captainTerm+chipBonus;
  const liveFtKnown=meta?.bankSource==="live-my-team"&&meta.freeTransferLimit!==undefined&&meta.freeTransferLimit!==null;
  const bankKnown=!(liveBankBlocked||(meta?.bank==null&&meta?.bankSource==="unavailable"));
  const bankValue=meta?.bank??a.bank;
  const bankSourceLabel=liveBankBlocked||meta?.bankSource==="unavailable"
    ?"reconnect FPL for live bank"
    :meta?(meta.bankSource==="live-my-team"?"live FPL transfer bank":meta.liveOverlayError?"live bank unavailable":"official public data"):"builder estimate";

  return <div className="coach-page overview-command">
    {/* Demo banner lives in coach chrome once — omit duplicate here so captain+projected stay above the fold. */}
    <OverviewDeadlineStrip event={next}/>

    {/* Known finance / chip only — no freshness tech chip (public Connected/Not connected lives in header/sidebar from #89). */}
    {!liveBankBlocked&&<section className="overview-status-strip" aria-label="Known squad state">
      {bankKnown&&<div><span>IN THE BANK</span><b>£{bankValue.toFixed(1)}m</b><small>{bankSourceLabel}</small></div>}
      <div>
        <span>{wildcardActive?"WILDCARD":"FREE TRANSFERS"}</span>
        <b>{wildcardActive?"Active":(liveFtKnown?String(fts):"Set in Transfers")}</b>
        <small>{wildcardActive?"unlimited swaps until deadline":liveFtKnown?"live FPL (limit − made this GW)":"not exposed publicly by FPL"}</small>
      </div>
      {plannedChip&&<div><span>PLANNED CHIP</span><b>{plannedChip}</b><small>for {next.name.replace(/^Gameweek\s+/i,"GW")}</small></div>}
    </section>}

    {liveBankBlocked&&<ReconnectFplPanel errorHint={meta?.liveOverlayError??null} onReconnected={async()=>{
      const live=await refreshConnectedTeamFromApi(data,{force:true});
      try{setMeta(JSON.parse(localStorage.getItem("fpl-edge-manager")||"null"))}catch{}
      if(live.updated)onTeamChange();
    }}/>}

    {!liveBankBlocked&&<section className="recommended-move best-decision-hero overview-best-decision" aria-label="Best decision">
      <div className="call-label">
        <span>{wildcardActive?"WILDCARD BEST SWAP":"BEST DECISION"}</span>
        <b className={decisionHold?"badge-hold":"badge-make"}>{decisionClass}</b>
      </div>
      <h2>{decisionHold
        ?(wildcardActive?"KEEP — leave this temporary Wildcard squad unchanged":"HOLD — do not transfer now")
        :`${decision!.out.name} → ${decision!.incoming.name}`}</h2>
      <p className="best-decision-lede">{decisionHold
        ?(wildcardActive?"Should I swap on Wildcard? No strong full-squad upgrade clears the bar.":fts<=0?"Should I transfer? No — with 0 FT, no move clears hit-adjusted NET vs HOLD.":"Should I transfer? No — HOLD now and bank the free transfer.")
        :(wildcardActive?"Should I swap on Wildcard? Yes — full-squad objective improves.":`Should I transfer? Yes — ${decisionClass} clears the risk-adjusted 5-GW NET vs HOLD bar.`)}</p>
      <div className="best-decision-metrics" aria-label="Decision metrics">
        <span><small>{wildcardActive?"MODE":"HIT"}</small><b>{wildcardActive?"Wildcard":(decisionHold?"Free":(decision!.hitLabel??(decision!.hitCost?`−${decision!.hitCost}`:"Free")))}</b></span>
        <span><small>{wildcardActive?"5-GW SQUAD Δ":"5-GW NET vs HOLD"}</small><b>{decisionHold?"0.0":`${fiveGwNet>=0?"+":""}${fiveGwNet.toFixed(1)}`}</b></span>
        {!decisionHold&&decision&&<span><small>ADJUSTED 5-GW NET</small><b>{((decision.riskAdjustedFiveGwNetVsHold??decision.riskAdjustedNet5??decision.rankScore)>=0?"+":"")}{(decision.riskAdjustedFiveGwNetVsHold??decision.riskAdjustedNet5??decision.rankScore).toFixed(1)}</b></span>}
        {decisionHold&&!wildcardActive&&<span><small>FT NOW → NEXT</small><b>{fts} → {Math.min(5,fts+1)}</b></span>}
      </div>
      <div className="engine-why" aria-label="Why"><span>WHY</span><p className="engine-reason-hero">{shortReason}</p></div>
      <button type="button" className="overview-transfers-link" onClick={()=>go("transfers")}>Open Transfers →</button>
    </section>}

    {!liveBankBlocked&&<div className="command-metrics overview-captain-metrics" aria-label="Captain and projected points">
      <article>
        <span>CAPTAIN</span>
        <b>{activeCaptain.name}</b>
        <small>{captainTerm.toFixed(1)} xPts{plannedChip==="Triple Captain"?" · Triple Captain":""}</small>
      </article>
      <article>
        <span>PROJECTED GW</span>
        <b>{projected.toFixed(1)}</b>
        <small>including {activeCaptain.name} captaincy{plannedChip==="Triple Captain"?" + Triple Captain":plannedChip==="Bench Boost"?" + Bench Boost":""}</small>
      </article>
    </div>}

    <section className="urgent-card">
      <header>
        <div><span>URGENT RISKS</span><h2>{issues.length?`${issues.length} squad issue${issues.length>1?"s":""} to monitor`:"No urgent squad issues."}</h2></div>
        <button type="button" onClick={()=>go("deadline")}>Open final check →</button>
      </header>
      {issues.length>0&&<div>{issues.slice(0,5).map(p=><article key={p.id}><b>{p.name}</b><span className={p.status!=="a"?"bad":"warn"}>{p.status!=="a"?"CONFIRMED FLAG":"LIKELY MINUTES RISK"}</span><p>{p.news||`${startPct(p,a.first,data)}% modelled start probability.`}</p></article>)}</div>}
    </section>

    <section className="overview-jumps" aria-label="Next actions">
      <button type="button" onClick={()=>go("deadline")}><span>FINAL CHECK</span><b>Lock captain, XI and chips →</b></button>
      <button type="button" onClick={()=>go("transfers")}><span>TRANSFERS</span><b>Full BEST DECISION + routes →</b></button>
      <button type="button" onClick={()=>go("draft")}><span>DRAFT LAB</span><b>Sandbox the squad →</b></button>
    </section>

    <WhatChanged data={data} squad={squad}/>
    <DgwAlert data={data}/>
    <SquadValueAlert squad={squad}/>
  </div>;
}

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

const bandLabel:Record<FiveGwGainBand,string>={negligible:"Negligible",modest:"Modest",strong:"Strong",exceptional:"Exceptional",anomaly:"Anomaly review"};

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

export type { ManagerMeta, OfficialPick } from "../lib/squad-comparison";

export{evaluateTransferQuality,TRANSFER_ACTION_THRESHOLD}from"../lib/transfer-quality";

export type{TransferQuality,TransferQualityInput,TransferQualityReason,TransferQualityStatus}from"../lib/transfer-quality";

export{bestTransfers,selectPrimaryTransfer,sortTransfersByQuality}from"../lib/transfers";

export type{Transfer}from"../lib/transfers";

export{opponent}from"../lib/fpl";
export type {View, PriceOutlookDaySignal, PriceRiskAlert} from "./coach/CoachCore";
export type {HistoryWeekPick, HistoryPlayerStats, HistoryWeek, CurrentXiResolution, OfficialScoringAuthority, LiveScoringResult, ProjectionReceiptPlayer, ProjectionReceiptTransfer, ProjectionReceiptRoute, ProjectionReceipt, LockRecord, CaptainCandidate, CaptaincyRiskFraming} from "./coach/PanelShared";
export type {OfficialRank, PastGameweekPlayer, PastGameweekResult} from "./coach/TeamPanel";
export type {PriceTiming, BuyTrigger} from "./coach/TransfersPanel";
export type {LockStatus, ChipHorizonRow, ChipVerdictResult, CaptainRiskNote} from "./coach/FinalCheckPanel";
export type {ProjectionTransferEvaluation, ProjectionConfidenceBand, ProjectionPlayerEvaluationRow, ProjectionEvaluation, AccuracyMetric, TransferAccuracyMetric} from "./coach/ResearchPanels";
export {ConnectTeam, benchOrderForEvent, analysis, withModelUtilityChange, rankTransfersForBestDecision, MEANINGFUL_PRICE_PRESSURE, priceOutlookSignal, priceProtectionAlerts} from "./coach/CoachCore";
