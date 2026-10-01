"use client";

import "../../styles/panel-plan.css";
import {useState,useEffect,useMemo} from "react";
import {writePlannedChips,removePlannedChip,readPlannedChips} from "../../lib/chip-portfolio";
import {FplData,savedSquad,isCompleteSquad,futureEvents,FplPlayer} from "../../lib/fpl";
import {HorizonMode,RiskMode,SquadPhilosophy,createOptimizer,createFiveWeekEvaluator} from "../../lib/optimizer";
import {evaluateSandbox} from "../../lib/squad-comparison";
import {PersistedPlan,readPlans,MAX_PLANS,createPlan,writePlans,LOAD_PLAN_SIGNAL_KEY,hydratePlanSandbox} from "../../lib/strategy-plans";
import {horizonModeLabel} from "../../lib/horizon-labels";
import type {View} from "./CoachCore";
import {readIds} from "./PanelShared";

// Compare/manage only -- no in-board transfer editor. Editing a plan's actual squad happens in
// Draft Lab, which already has a complete transfer-picker UI; duplicating that here was the
// higher-risk option in the design checkpoint. "Edit in Draft Lab" writes LOAD_PLAN_SIGNAL_KEY and
// navigates; LiveDraftBuilder.tsx's own load() consumes and clears it on mount.
export function StrategyBoard({data,go,revision}:{data:FplData;go:(v:View)=>void;revision:number}){
  const[plans,setPlans]=useState<readonly PersistedPlan[]>([]);
  const[horizonMode,setHorizonMode]=useState<HorizonMode>("Balanced 5 GWs"); // internal id; UI via horizonModeLabel
  const[riskMode,setRiskMode]=useState<RiskMode>("Balanced");
  const[philosophy,setPhilosophy]=useState<SquadPhilosophy>("Maximum xPts");
  useEffect(()=>setPlans(readPlans()),[revision]);
  const squad=useMemo(()=>savedSquad(data),[data,revision]);
  const complete=isCompleteSquad(squad,data);
  const boardNextGwId=futureEvents(data,1)[0]?.id;
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
    <section className="optimizer-controls"><div><span>TIME HORIZON</span>{(["GW1 Attack","Next 3 GWs","Balanced 5 GWs","Long-term 8 GWs"] as HorizonMode[]).map(mode=><button className={horizonMode===mode?"active":""} onClick={()=>setHorizonMode(mode)} key={mode}>{horizonModeLabel(mode,boardNextGwId)}</button>)}</div><div><span>RISK PROFILE</span>{(["Safe","Balanced","Aggressive"] as RiskMode[]).map(mode=><button className={riskMode===mode?"active":""} onClick={()=>setRiskMode(mode)} key={mode}>{mode}</button>)}</div><div><span>SQUAD PHILOSOPHY</span>{(["Maximum xPts","Flexible","Strong Bench","Premium Heavy","Differential"] as SquadPhilosophy[]).map(mode=><button className={philosophy===mode?"active":""} onClick={()=>setPhilosophy(mode)} key={mode}>{mode}</button>)}</div></section>
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

export function News({data,go,revision}:{data:FplData;go:(v:View)=>void;revision:number}){const squad=useMemo(()=>savedSquad(data),[data,revision]);const watch=readIds("fpl-edge-watchlist");const owned=new Set(squad.map(p=>p.id)),watched=new Set(watch);const[filter,setFilter]=useState("PRIORITY");const items=data.players.filter(p=>p.news||p.status!=="a").map(p=>({p,priority:owned.has(p.id)?0:watched.has(p.id)?1:p.selectedBy>=10?2:3})).filter(x=>filter==="ALL"||filter==="PRIORITY"&&x.priority<3||filter==="SQUAD"&&owned.has(x.p.id)||filter==="WATCHLIST"&&watched.has(x.p.id)).sort((a,b)=>a.priority-b.priority||(b.p.newsAdded?Date.parse(b.p.newsAdded):0)-(a.p.newsAdded?Date.parse(a.p.newsAdded):0));const tag=(p:FplPlayer)=>p.status==="s"?"SUSPENSION":p.status==="i"||p.status==="d"?"INJURY":p.news.toLowerCase().includes("transfer")?"TRANSFER":p.news.toLowerCase().includes("international")?"LINEUP":"PRESS CONFERENCE";const impact=(p:FplPlayer)=>{if(owned.has(p.id))return p.status!=="a"?`Your player is officially flagged. Review ${p.name}'s start probability and bench cover before transferring.`:`Your squad is affected. Recheck the player panel before lock-in.`;if(watched.has(p.id))return`Watchlist target: ${p.status!=="a"?"do not buy until availability improves":"keep monitoring role and expected minutes before buying"}.`;return`High-ownership FPL relevance. This update does not automatically create a transfer recommendation.`};return <div className="coach-page"><section className="news-lead"><div><span>PERSONALISED NEWS</span><h2>{items.filter(x=>x.priority<2).length} updates affect your squad or watchlist.</h2><p>Official FPL status only. No invented quotes, predicted lineups or unsupported rumours.</p></div><button onClick={()=>go("deadline")}>See deadline impact →</button></section><div className="news-tabs">{["PRIORITY","SQUAD","WATCHLIST","ALL"].map(x=><button className={filter===x?"active":""} onClick={()=>setFilter(x)} key={x}>{x}</button>)}</div><section className="impact-news">{items.length?items.map(({p,priority})=><article key={p.id}><header><div><span className="news-tag">{tag(p)}</span><span className={`certainty ${p.status!=="a"?"confirmed":priority<2?"likely":"uncertain"}`}>{p.status!=="a"?"CONFIRMED":priority<2?"LIKELY":"UNCERTAIN"}</span></div><time>{p.newsAdded?new Date(p.newsAdded).toLocaleString():"No official timestamp"}</time></header><h3>{p.name} · {p.teamShort}</h3><p>{p.news||"Official FPL flag has no published detail."}</p><aside><span>FPL IMPACT</span><b>{impact(p)}</b></aside><footer><span>{owned.has(p.id)?"MY SQUAD":watched.has(p.id)?"WATCHLIST":`${p.selectedBy.toFixed(1)}% OWNED`}</span><span>{p.transfersOut.toLocaleString()} transfers out</span></footer></article>):<div className="empty-watch"><b>No official updates match this filter.</b><p>That is good news. We will not manufacture a story to fill the page.</p></div>}</section></div>}
