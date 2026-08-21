"use client";

import { useState } from "react";
import LiveDraftBuilder from "./components/LiveDraftBuilder";
import { LiveChips, LiveFixtures, LiveHistory, LiveNews, LivePlayers, LivePointsModel } from "./components/LiveIntelligence";
import CoachApp from "./components/CoachApp";

const features = [
  ["SQUAD", "Build a draft with a plan", "Balance premiums, minutes, fixtures and bench value—then compare safe, balanced and aggressive structures.", "15/15", "valid squad"],
  ["TRANSFERS", "Know when not to move", "Compare rolling, free transfers and hits across one, three or six gameweeks. Net points only—no transfer for transfer’s sake.", "+8.4", "3-GW upside"],
  ["DEADLINE", "React to news that matters", "Recommendation-impacting updates are separated from noise, timestamped and tied to the player they affect.", "2", "alerts to review"],
];

const faq = [
  ["Does FPL Edge guarantee more points?", "No. FPL contains injuries, rotation and variance. FPL Edge improves the quality and consistency of your decisions by comparing the best options with the information available before the deadline."],
  ["Will it make transfers on my official FPL account?", "No. It is a decision assistant. You stay in control and make the final change on the official FPL website."],
  ["What makes the recommendations trustworthy?", "Every major recommendation shows projected net gain, confidence, the main downside, what could change, and the freshness of the supporting data."],
];

export default function Home() {
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [demoMode, setDemoMode] = useState(false);
  if (demoMode) return <CoachApp onBack={() => setDemoMode(false)} />;

  return <main>
    <header className="site-header">
      <a className="brand" href="#top" aria-label="FPL Edge home"><span className="brand-mark">E</span><span>FPL EDGE</span></a>
      <nav className="desktop-nav" aria-label="Primary navigation"><a href="#product">Product</a><a href="#how">How it works</a><a href="#method">Method</a><a href="#pricing">Pricing</a></nav>
      <button className="button button-small button-outline" onClick={() => setDemoMode(true)}>Open demo</button>
    </header>

    <section className="hero" id="top"><div className="hero-grid" />
      <div className="hero-copy"><p className="kicker"><span /> Your gameweek decision desk</p><h1>Stop guessing.<br /><em>Win the decision.</em></h1><p className="hero-subtitle">Build a stronger squad, choose smarter transfers, set the right lineup and react to team news before every FPL deadline.</p><div className="hero-actions"><button className="button button-primary" onClick={() => setDemoMode(true)}>Get my gameweek plan <span>→</span></button><a className="text-link" href="#product">See how it works <span>↓</span></a></div><div className="truth-row"><span>NO BLACK BOX</span><span>NET POINTS, NOT HYPE</span><span>SOURCES &amp; TIMESTAMPS</span></div></div>
      <div className="hero-product" aria-label="Example FPL recommendation"><div className="product-topbar"><div><span className="live-dot" /> DEMO PLAN</div><span>GW 1 · 04:52:18 left</span></div><div className="score-row"><div><p>PROJECTED XI</p><strong>67</strong><small>.4 pts</small></div><div className="confidence-ring"><span>82%</span><small>confidence</small></div></div><div className="recommendation"><div className="recommendation-label"><span>BEST MOVE</span><b>ROLL</b></div><h3>Save the transfer.</h3><p>Your current XI already covers the strongest fixtures. No available move clears the value threshold this week.</p><div className="recommendation-metrics"><span><small>Best transfer</small><b>+0.8 pts</b></span><span><small>Flexibility next GW</small><b>High</b></span></div></div><div className="captain-row"><div className="player-token">EH</div><div><small>CAPTAIN</small><b>Erling Haaland</b><span>12.6 projected</span></div><div className="captain-badge">C</div></div><div className="news-alert"><span>!</span><p><b>Recheck after press conferences</b><small>One defender is currently rated 70% to start.</small></p><time>18m</time></div><p className="demo-label">Illustrative demo data — not live</p></div>
    </section>

    <section className="proof-strip"><p>ONE ANSWER FOR EVERY DEADLINE</p><div><b>DRAFT</b><span>→</span><b>TRANSFERS</b><span>→</span><b>LINEUP</b><span>→</span><b>CAPTAIN</b><span>→</span><b>CHIPS</b></div></section>

    <section className="section" id="product"><div className="section-heading"><div><p className="section-index">01 / THE PRODUCT</p><h2>Hours of research.<br /><em>One clear plan.</em></h2></div><p>FPL Edge turns fixtures, expected minutes, underlying performance, prices and real-world availability news into one decision you can understand.</p></div><div className="feature-grid">{features.map((f, i) => <article className="feature-card" key={f[1]}><div className="feature-number">0{i+1}</div><p className="eyebrow">{f[0]}</p><h3>{f[1]}</h3><p>{f[2]}</p><div className="feature-stat"><strong>{f[3]}</strong><span>{f[4]}</span></div></article>)}</div></section>

    <section className="section workflow" id="how"><div className="section-heading compact"><div><p className="section-index">02 / YOUR WEEK</p><h2>Three steps.<br /><em>Then lock it.</em></h2></div></div><div className="steps"><article><span>01</span><h3>Connect or build</h3><p>Import with a read-only manager ID or create your fifteen-player squad manually.</p></article><article><span>02</span><h3>Compare the paths</h3><p>See the best overall move beside the safer and higher-upside alternatives.</p></article><article><span>03</span><h3>Recheck and act</h3><p>Review late availability news, lock captaincy and make the final move on FPL.</p></article></div></section>

    <section className="section" id="method"><div className="method-card"><div className="method-copy"><p className="section-index">03 / BUILT FOR TRUST</p><h2>Not “AI says so.”<br /><em>Evidence says why.</em></h2><p>Every recommendation answers what to do, expected net gain, why it wins, its biggest risk and what could change before the deadline.</p><button className="button button-outline" onClick={() => setDemoMode(true)}>Explore the decision view →</button></div><div className="method-list"><div><b>01</b><span>Expected minutes</span><small>Starts, substitutions, injuries and rotation</small></div><div><b>02</b><span>Fixture context</span><small>Opponent strength, venue, rest and congestion</small></div><div><b>03</b><span>Underlying output</span><small>Role, xG, xA, creation, saves and bonus potential</small></div><div><b>04</b><span>Decision cost</span><small>Hits, budget, flexibility and future transfers</small></div></div></div></section>

    <section className="section" id="pricing"><div className="section-heading compact"><div><p className="section-index">04 / ACCESS</p><h2>Start with a decision.<br /><em>Upgrade for the season.</em></h2></div></div><div className="pricing-grid"><article className="price-card"><p>FREE</p><h3>One clear move</h3><strong>£0</strong><ul><li>One active team</li><li>Current gameweek projection</li><li>Lineup and captain recommendation</li><li>One transfer scenario</li></ul><button className="button button-outline" onClick={() => setDemoMode(true)}>Try the demo</button></article><article className="price-card pro"><div className="pro-tag">MOST USEFUL</div><p>PRO</p><h3>Your full decision desk</h3><strong>Coming soon</strong><ul><li>Multi-week transfer planning</li><li>Safe and aggressive alternatives</li><li>News impact alerts</li><li>Draft and chip optimization</li><li>Decision history</li></ul><button className="button button-primary" onClick={() => setDemoMode(true)}>Preview Pro</button></article></div></section>

    <section className="section faq-section"><div><p className="section-index">05 / FAQ</p><h2>What you should<br /><em>know upfront.</em></h2></div><div className="faq-list">{faq.map(([q,a], i) => <button className="faq-item" key={q} onClick={() => setOpenFaq(openFaq === i ? null : i)} aria-expanded={openFaq === i}><span><b>0{i+1}</b>{q}<i>{openFaq === i ? "−" : "+"}</i></span>{openFaq === i && <p>{a}</p>}</button>)}</div></section>

    <footer><div className="footer-cta"><p>YOUR NEXT DEADLINE STARTS HERE</p><h2>Make the move<br /><em>you can defend.</em></h2><button className="button button-primary" onClick={() => setDemoMode(true)}>Get my gameweek plan →</button></div><div className="footer-bottom"><span>FPL EDGE</span><p>Independent FPL decision assistant. Not affiliated with or endorsed by the Premier League.</p><span>© 2026</span></div></footer>
  </main>;
}

type DemoView = "overview" | "team" | "transfers" | "draft" | "players" | "fixtures" | "news" | "deadline" | "chips" | "model" | "history";

const navItems: [DemoView, string][] = [["overview","Overview"],["team","My team"],["transfers","Transfers"],["draft","Draft lab"],["players","Players"],["fixtures","Fixtures"],["news","News"],["deadline","Final check"],["chips","Chips"],["model","Points model"],["history","History"]];

function DashboardPreview({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<DemoView>("overview");
  const [refreshed, setRefreshed] = useState(false);
  const titles: Record<DemoView, string> = {overview:"Your GW1 plan",team:"My team",transfers:"Transfer planner",draft:"Draft & Wildcard lab",players:"Player explorer",fixtures:"Fixture intelligence",news:"News centre",deadline:"Deadline final check",chips:"Chip planner",model:"Expected-points model",history:"Decision history"};

  const liveView=["team","draft","players","fixtures","news","chips","model","history"].includes(view);
  return <main className="demo-shell"><aside className="demo-sidebar"><button className="brand sidebar-brand" onClick={onBack}><span className="brand-mark">E</span><span>FPL EDGE</span></button><nav>{navItems.map(([key,label],i)=><button key={key} className={view===key?"active":""} onClick={()=>setView(key)}><span>0{i+1}</span> {label}</button>)}</nav><div className={`demo-warning ${liveView?"connected":""}`}><b>{liveView?"FPL FEED LIVE":"DEMO MODULE"}</b><p>{liveView?"Official roster and prices refresh automatically.":"This section still uses illustrative analysis."}</p></div><button className="back-link" onClick={onBack}>← Back to site</button></aside>
    <section className="demo-main"><header className="demo-header"><div><p>{liveView?"LIVE OFFICIAL FPL DATA · FPL EDGE MODELS":"FRIDAY, 21 AUGUST · ILLUSTRATIVE DATA"}</p><h1>{titles[view]}</h1></div>{!liveView&&<div className="deadline"><small>DEADLINE</small><b>04:52:18</b></div>}</header>
      {view==="overview" && <Overview refreshed={refreshed} onRefresh={()=>setRefreshed(true)} go={setView}/>} 
      {view==="team" && <TeamView go={setView}/>} 
      {view==="transfers" && <TransfersView/>}
      {view==="draft" && <DraftView/>}
      {view==="players" && <LivePlayers/>}
      {view==="fixtures" && <LiveFixtures/>}
      {view==="news" && <LiveNews/>}
      {view==="deadline" && <DeadlineView go={setView}/>} 
      {view==="chips" && <LiveChips/>}
      {view==="model" && <LivePointsModel/>}
      {view==="history" && <LiveHistory/>}
      <p className="prototype-note">{liveView?"Players, prices, stats, fixtures, flags and finished-gameweek history come from official FPL. Projections, ratings and chip scores are FPL Edge model estimates.":"Functional preview using illustrative data. Live recommendations require performance and news feeds."}</p>
    </section><nav className="mobile-demo-nav" aria-label="Demo navigation">{navItems.slice(0,5).map(([key,label])=><button className={view===key?"active":""} onClick={()=>setView(key)} key={key}>{label}</button>)}</nav></main>;
}

function Overview({refreshed,onRefresh,go}:{refreshed:boolean;onRefresh:()=>void;go:(v:DemoView)=>void}){
  return <><div className="status-banner"><span>{refreshed?"ANALYSIS REFRESHED":"PLAN READY"}</span><p>{refreshed?"Demo projections recalculated. No recommendation changed.":"Your squad is valid. One item should be rechecked after press conferences."}</p><button onClick={onRefresh}>{refreshed?"Up to date":"Refresh analysis"}</button></div><div className="dashboard-grid">
    <article className="dash-card main-decision"><div className="dash-card-top"><p>THE DECISION</p><span>82% CONFIDENCE</span></div><div className="decision-icon">R</div><h2>Roll the transfer.</h2><p>Your current XI already covers the strongest fixtures. Saving the move gives you more flexibility for next week’s fixture swing.</p><div className="metric-row"><span><small>Best available transfer</small><b>+0.8 pts</b></span><span><small>3-GW flexibility</small><b>High</b></span><span><small>Recheck</small><b>18:30</b></span></div><button onClick={()=>go("transfers")}>See the full reasoning →</button></article>
    <article className="dash-card projection"><p>PROJECTED XI</p><strong>67<span>.4</span></strong><small>Expected range 55–81</small><div className="bar"><i /></div><div><span>Floor 55</span><span>Ceiling 81</span></div></article>
    <article className="dash-card captain"><p>CAPTAINCY</p><div className="captain-player"><div className="player-token large">EH</div><div><h3>Erling Haaland</h3><span>Home fixture · 91% start</span></div><b>C</b></div><div className="captain-stats"><span><small>Projected</small><b>12.6</b></span><span><small>Ceiling</small><b>19.8</b></span><span><small>Confidence</small><b>88%</b></span></div><button onClick={()=>go("team")}>Compare captains →</button></article>
    <article className="dash-card watch"><div className="dash-card-top"><p>WHAT CHANGED</p><span>2 UPDATES</span></div><div className="update"><i className="amber"/><div><b>Defender still a doubt</b><span>Start probability moved 78% → 70%</span></div><time>18m</time></div><div className="update"><i className="green"/><div><b>Midfielder cleared to start</b><span>Expected minutes moved 61 → 76</span></div><time>1h</time></div><button onClick={()=>go("news")}>Open news centre →</button></article>
  </div><section className="points-stack"><div><span>MAX-POINTS SYSTEM</span><b>20 connected decision modules</b><small>Every module feeds the same gameweek plan.</small></div><div>{["xPts","xMins","Best transfer","Roll decision","Multi-GW","Hit calculator","Captain","Lineup","Bench order","Live news","Auto recalc","Final check","Fixture swings","Role tracker","Price path","Draft solver","Chip value","Blanks / doubles","Scenarios","Calibration"].map((x,i)=><button key={x} onClick={()=>go(i<2||i===19?"model":i<6||i===14||i===18?"transfers":i<9?"team":i<11?"news":i===11?"deadline":i<14?i===12?"fixtures":"players":i===15?"draft":"chips")}><i>{String(i+1).padStart(2,"0")}</i>{x}</button>)}</div></section></>;
}

function TeamView({go: _go}:{go:(v:DemoView)=>void}){return <LiveDraftBuilder/>;}

function TransfersView(){
  const [scenario,setScenario]=useState(0); const [horizon,setHorizon]=useState(3); const [saved,setSaved]=useState(false);
  const options=[
    {tag:"BEST OVERALL",title:"Roll the transfer",cost:"0 pts",risk:"Low",bank:"£0.5m",gain:[0,0,0],why:"No available single transfer adds enough net value. Two free transfers next week unlock a stronger fixture-swing move."},
    {tag:"SAFER MOVE",title:"Hall → Gabriel",cost:"0 pts",risk:"Low",bank:"£0.0m",gain:[0.4,0.8,2.6],why:"Raises clean-sheet probability and minutes security, but uses flexibility for a modest gain."},
    {tag:"HIGHER UPSIDE",title:"Groß → Semenyo",cost:"0 pts",risk:"Medium",bank:"£0.0m",gain:[1.1,2.1,4.7],why:"Adds open-play threat and a better short-term fixture, with more variance and less set-piece security."},
    {tag:"POINTS HIT",title:"Hall + Groß → Gabriel + Semenyo",cost:"−4 pts",risk:"High",bank:"£0.0m",gain:[-2.5,1.8,6.4],why:"The combined move loses points this week after the hit, breaks even around GW3, and becomes strongest only across six gameweeks."},
  ]; const o=options[scenario]; const gain=o.gain[horizon===1?0:horizon===3?1:2];
  const paths=[
    [["GW1","ROLL","2 free transfers banked"],["GW2","Hall → Gabriel","Fixture swing begins"],["GW3","Groß → Semenyo","Funded without a hit"]],
    [["GW1","Hall → Gabriel","Immediate floor upgrade"],["GW2","ROLL","Keep flexibility"],["GW3","Groß → Semenyo","If role remains strong"]],
    [["GW1","Groß → Semenyo","Attack the fixture"],["GW2","ROLL","Assess minutes"],["GW3","Hall → Gabriel","Defensive swing"]],
    [["GW1","DOUBLE MOVE · −4","Immediate restructure"],["GW2","ROLL","Hit recovery"],["GW3","ROLL","Break-even target"]],
  ];
  return <><div className="planner-controls"><div><span>PLANNING HORIZON</span>{[1,3,6].map(n=><button key={n} className={horizon===n?"active":""} onClick={()=>{setHorizon(n);setSaved(false)}}>{n} GW</button>)}</div><div><span>OBJECTIVE</span><b>MAXIMIZE NET POINTS</b></div></div><div className="scenario-tabs four">{options.map((x,i)=><button className={scenario===i?"active":""} key={x.tag} onClick={()=>{setScenario(i);setSaved(false)}}><span>{x.tag}</span><b>{x.title}</b></button>)}</div><article className="transfer-card"><div className="transfer-head"><span>{o.tag}</span><b>{Math.max(58,82-scenario*7)}% confidence</b></div><h2>{o.title}.</h2><p>{o.why}</p><div className="transfer-kpis"><span><small>{horizon}-GW NET GAIN</small><b>{gain>=0?"+":""}{gain.toFixed(1)} pts</b></span><span><small>HIT COST</small><b>{o.cost}</b></span><span><small>DOWNSIDE</small><b>{o.risk}</b></span><span><small>BANK AFTER</small><b>{o.bank}</b></span></div><div className="reason-grid"><div><span>WHY IT WINS</span><p>{o.why}</p></div><div><span>WHAT COULD CHANGE</span><p>Late injury news, a confirmed role change, or a price move that makes the path unaffordable.</p></div></div><button className="app-primary" onClick={()=>setSaved(true)}>{saved?"Plan saved ✓":"Save this plan"}</button></article><section className="route-planner"><div className="route-title"><div><span>RECOMMENDED ROUTE</span><b>{horizon}-gameweek transfer path</b></div><small>Uses real selling-value logic · no hidden hits</small></div><div className="route-steps">{paths[scenario].map((p,i)=><article key={p[0]}><span>{p[0]}</span><b>{p[1]}</b><small>{p[2]}</small>{i<2&&<i>→</i>}</article>)}</div></section><section className="price-watch"><div><span>PRICE WATCH</span><b>Gabriel</b><small>55% rise likelihood · affordable after one rise</small></div><div><span>PLAN BLOCKER</span><b>Semenyo</b><small>A £0.1m rise blocks the double move</small></div><div><span>EARLY-MOVE VERDICT</span><b>Wait</b><small>Team-news value currently outweighs price risk</small></div></section></>;
}

function DraftView(){return <LiveDraftBuilder/>;}
function PlayersView(){return <LiveDraftBuilder explorer/>;}

function NewsView(){
  const [filter,setFilter]=useState("Impacting my team"); const [recalculated,setRecalculated]=useState(false); const items=[
    ["18m","TEAM IMPACT · PROBABLE","Hall remains a late fitness decision","The manager says the defender will be assessed after the final training session.","Club press conference","Start probability 78% → 70%"],
    ["1h","TEAM IMPACT · CONFIRMED","Groß cleared and available","The midfielder completed full training and is available for selection.","Official club update","Expected minutes 61 → 76"],
    ["3h","WATCHLIST · UNCERTAIN","Isidor expected to lead the line","Two reliable predicted lineups include the forward, but no official confirmation is available.","Predicted lineups","Watchlist confidence +6%"],
  ]; return <><div className={`news-recalc ${recalculated?"done":""}`}><div><span>{recalculated?"RECALCULATION COMPLETE":"2 UPDATES AFFECT YOUR PLAN"}</span><b>{recalculated?"Recommendation unchanged · xPts −0.3":"Recalculate transfers, lineup and captaincy"}</b><small>{recalculated?"Hall remains first bench; transfer still rolls.":"Uses only the three sourced updates shown below."}</small></div><button onClick={()=>setRecalculated(true)}>{recalculated?"Plan up to date ✓":"Recalculate now"}</button></div><div className="news-filters">{["Impacting my team","All updates","Confirmed only"].map(x=><button className={filter===x?"active":""} onClick={()=>setFilter(x)} key={x}>{x}</button>)}</div><div className="news-list">{items.filter(x=>filter!=="Confirmed only"||x[1].includes("CONFIRMED")).map(x=><article key={x[2]}><time>{x[0]}</time><div><span>{x[1]}</span><h3>{x[2]}</h3><p>{x[3]}</p><small>Source: {x[4]} · credibility recorded · illustrative</small></div><b>{x[5]}</b></article>)}</div></>;
}

function ChipsView(){const [selected,setSelected]=useState("Wildcard"); const chips=[["Wildcard","GW6–8","Wait","Squad is structurally sound; the first major fixture swing arrives around GW7.","+18.4"],["Free Hit","Blank GW","Hold","No confirmed blank currently creates enough squad-specific value.","+7.2"],["Bench Boost","Double GW","Hold","Bench value is solid, but wait for a confirmed double with 15 likely starters.","+9.6"],["Triple Captain","Double GW","Hold","Preserve for a premium attacker with two strong fixtures and secure minutes.","+8.8"]]; return <><div className="chip-grid">{chips.map(c=><button key={c[0]} className={selected===c[0]?"active":""} onClick={()=>setSelected(c[0])}><span>{c[0]}</span><b>{c[1]}</b><i>{c[2]}</i></button>)}</div>{chips.filter(c=>c[0]===selected).map(c=><article className="chip-detail" key={c[0]}><span>SQUAD-SPECIFIC PLAN</span><h2>{c[2]} the {c[0]}.</h2><p>{c[3]}</p><div><b>Current estimated value</b><strong>{c[4]} pts</strong></div><small>Fixture changes can materially change this plan. Recalculated after every confirmed schedule update.</small></article>)}<div className="chip-calendar"><div><span>GW1–5</span><b>No chip</b><small>Build information and preserve flexibility</small></div><div className="target"><span>GW6–8</span><b>Wildcard window</b><small>First strong structural fixture swing</small></div><div><span>GW9–18</span><b>Hold</b><small>React only to confirmed blanks or doubles</small></div><div><span>GW19</span><b>Expiry check</b><small>Use remaining first-half chips before the deadline</small></div></div></>}

function HistoryView(){return <><div className="history-summary"><article><span>DECISIONS LOGGED</span><b>12</b></article><article><span>PROJECTED VALUE ADDED</span><b>+21.6</b></article><article><span>MODEL CALIBRATION</span><b>Good</b></article></div><div className="accuracy-panel"><div><span>MODEL ACCURACY · LAST 38 GAMEWEEKS</span><h2>Better than both simple baselines.</h2><p>Illustrative backtest view. Production results will be populated only after the connected model has enough time-correct predictions.</p></div><div className="accuracy-bars"><div><span>FPL Edge xPts</span><i><em style={{width:"84%"}}/></i><b>84</b></div><div><span>Official PPG</span><i><em style={{width:"68%"}}/></i><b>68</b></div><div><span>Fixture-only</span><i><em style={{width:"61%"}}/></i><b>61</b></div></div></div><div className="history-list"><div className="table-head"><span>GAMEWEEK</span><span>DECISION</span><span>AT DEADLINE</span><span>OUTCOME</span><span>QUALITY</span></div>{[["GW38","Roll transfer","+0.0 expected","+5 actual","Good"],["GW37","Saka → Palmer","+4.3 expected","+1 actual","Good"],["GW36","Captain Haaland","+1.8 expected","−4 actual","Good process"],["GW35","Take a -4 hit","+5.6 expected","+9 actual","Strong"]].map(x=><div className="table-row" key={x[0]}>{x.map((v,i)=>i===0?<b key={v}>{v}</b>:<span key={v}>{v}</span>)}</div>)}</div><p className="history-explainer">Outcome is kept separate from decision quality. A sound probabilistic decision can still produce a bad single-gameweek result.</p></>}

function FixturesView(){
  const [horizon,setHorizon]=useState(6);
  const teams=[
    ["ARS",8.8,["LEE H","NFO A","WHU H","NEW A","FUL H","BUR A"]],
    ["MCI",8.5,["WOL H","BHA A","EVE H","CHE A","SUN H","BRE A"]],
    ["CHE",7.9,["FUL H","SUN A","NEW H","MCI H","BOU A","LEE H"]],
    ["BOU",7.4,["BUR A","WHU H","LEE A","FUL H","CHE H","EVE A"]],
    ["NEW",5.8,["MCI A","ARS H","CHE A","LIV H","AVL A","MUN H"]],
  ];
  return <><div className="planner-controls"><div><span>FIXTURE HORIZON</span>{[3,6,8].map(n=><button className={horizon===n?"active":""} onClick={()=>setHorizon(n)} key={n}>{n} GW</button>)}</div><div><span>NEXT CONFIRMED DOUBLE</span><b>NONE YET</b></div></div><div className="swing-banner"><div><span>BIGGEST SWING</span><b>Arsenal · GW2–6</b><small>Attack 8.9 / Defence 8.6</small></div><p>Move one Arsenal slot into your transfer roadmap before GW2. Their run improves by 31% versus the previous five fixtures.</p></div><div className="fixture-matrix"><div className="fixture-head"><span>TEAM</span><span>RUN RATING</span>{Array.from({length:Math.min(horizon,6)},(_,i)=><span key={i}>GW{i+1}</span>)}</div>{teams.map(t=><div className="fixture-row" key={String(t[0])}><b>{t[0]}</b><strong>{t[1]}</strong>{(t[2] as string[]).slice(0,Math.min(horizon,6)).map((f,i)=><span className={i<2&&Number(t[1])>7?"easy":Number(t[1])<6?"hard":"mid"} key={f}>{f}</span>)}</div>)}</div><div className="schedule-watch"><article><span>BLANK WATCH</span><b>No confirmed blanks</b><p>Possible cup-related blanks remain provisional and are excluded from the main recommendation.</p></article><article><span>DOUBLE WATCH</span><b>Confidence: low</b><p>Chip recommendations will update only after fixture confirmation.</p></article><article><span>ROTATION WATCH</span><b>City: elevated</b><p>Three matches in eight days lowers expected minutes for fringe attackers.</p></article></div></>;
}

function DeadlineView({go}:{go:(v:DemoView)=>void}){
  const initial=[true,true,true,false,false]; const [checks,setChecks]=useState(initial); const [locked,setLocked]=useState(false);
  const labels=["Squad and budget valid","Latest projections calculated","Captain and vice-captain selected","Press-conference doubt reviewed","Final lineup confirmed on FPL"];
  const toggle=(i:number)=>setChecks(x=>x.map((v,n)=>n===i?!v:v));
  const complete=checks.every(Boolean);
  return <><div className={`deadline-state ${complete?"complete":""}`}><div><span>{complete?"READY TO LOCK":"2 ITEMS REMAIN"}</span><h2>{complete?"Your final plan is ready.":"Do not lock yet."}</h2><p>{complete?"All decision-changing checks are complete.":"Wait for the final availability update, then confirm the lineup on FPL."}</p></div><strong>{checks.filter(Boolean).length}/5</strong></div><div className="final-grid"><article className="final-plan"><div className="dash-card-top"><p>FINAL RECOMMENDATION</p><span>ILLUSTRATIVE MODULE</span></div><div className="final-move"><span>TRANSFER</span><b>RECHECK</b><small>Create a live squad first, then run the connected recommendation model.</small></div><div className="final-captains"><div><span>CAPTAIN</span><b>Not selected</b><small>Use the official squad builder</small></div><div><span>VICE</span><b>Not selected</b><small>No stale player assumptions</small></div></div><button onClick={()=>go("team")}>Build live squad →</button></article><article className="checklist"><p>DEADLINE CHECKLIST</p>{labels.map((label,i)=><button className={checks[i]?"done":""} onClick={()=>toggle(i)} key={label}><i>{checks[i]?"✓":""}</i><span>{label}</span></button>)}<button className="lock-button" disabled={!complete||locked} onClick={()=>setLocked(true)}>{locked?"Plan locked ✓":complete?"Lock my plan":"Complete checks first"}</button></article></div></>;
}

function ModelView(){
  const [player,setPlayer]=useState("Haaland");
  const models:Record<string,{total:string;minutes:string;parts:[string,string,string][]}>={
    Haaland:{total:"12.6",minutes:"82",parts:[["Appearance","1.8","14%"],["Goals","6.4","51%"],["Assists","1.5","12%"],["Bonus","1.8","14%"],["Other","1.1","9%"]]},
    Palmer:{total:"8.2",minutes:"84",parts:[["Appearance","1.8","22%"],["Goals","2.8","34%"],["Assists","1.7","21%"],["Bonus","1.2","15%"],["Other","0.7","8%"]]},
    Gabriel:{total:"5.6",minutes:"88",parts:[["Appearance","1.9","34%"],["Clean sheet","2.3","41%"],["Goal threat","0.6","11%"],["Bonus","0.5","9%"],["Other","0.3","5%"]]},
  }; const m=models[player];
  return <><div className="model-header"><div><span>MODEL VERSION</span><b>EDGE xPTS 1.8</b><small>Illustrative outputs · trained without future-data leakage</small></div><div><span>LAST BACKTEST</span><b>38 gameweeks</b><small>Compared with official PPG and fixture-only baselines</small></div><div><span>CALIBRATION</span><b>Good</b><small>High-confidence predictions land within expected bands</small></div></div><div className="model-player-tabs">{Object.keys(models).map(x=><button className={player===x?"active":""} onClick={()=>setPlayer(x)} key={x}>{x}</button>)}</div><div className="model-grid"><article className="xpts-total"><span>PROJECTED POINTS</span><strong>{m.total}</strong><small>Expected range {player==="Haaland"?"7–20":player==="Palmer"?"4–16":"2–10"}</small><div><b>{m.minutes}</b><span>expected minutes</span></div></article><article className="xpts-breakdown"><p>WHERE THE PROJECTION COMES FROM</p>{m.parts.map(p=><div key={p[0]}><span>{p[0]}</span><i><em style={{width:p[2]}}/></i><b>+{p[1]}</b></div>)}</article></div><div className="model-signals"><article><span>MINUTES SIGNAL</span><b>{player==="Gabriel"?"92%":"91%"} start</b><p>Team news, rest, substitution patterns and manager selection history.</p></article><article><span>FIXTURE SIGNAL</span><b>Top 25%</b><p>Opponent strength, venue, clean-sheet and scoring probabilities.</p></article><article><span>ROLE SIGNAL</span><b>{player==="Haaland"?"Penalties + focal 9":player==="Palmer"?"Central creator + penalties":"Set-piece target"}</b><p>Position, set pieces and recent involvement are tracked separately from FPL points.</p></article></div></>;
}
