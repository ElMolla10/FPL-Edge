"use client";

import "../../styles/panel-players.css";
import {useState,useEffect,useMemo} from "react";
import {FplData,futureEvents,projectionMetrics,playerProjection,FplPlayer,opponent} from "../../lib/fpl";
import {persist} from "../../lib/persistence";
import type {View} from "./CoachCore";
import {readIds} from "./PanelShared";

export function Players({data,go,revision}:{data:FplData;go:(v:View)=>void;revision:number}){
  const events=futureEvents(data,5),first=events[0]?.id;
  const realMaxPrice=Math.max(...data.players.map(p=>p.price));
  const[query,setQuery]=useState("");
  const[pos,setPos]=useState("ALL");
  const[club,setClub]=useState("ALL");
  const[maxPrice,setMaxPrice]=useState(realMaxPrice);
  const[minMins,setMinMins]=useState(0);
  const[special,setSpecial]=useState("ALL");
  const[more,setMore]=useState(false);
  const[showAdvanced,setShowAdvanced]=useState(false);
  const[sort,setSort]=useState("xPts1"); // Default matches primary Next GW column; 5-GW remains visible.
  const[direction,setDirection]=useState<"desc"|"asc">("desc");
  const[compare,setCompare]=useState<number[]>([]);
  const[watch,setWatch]=useState<number[]>([]);
  useEffect(()=>setWatch(readIds("fpl-edge-watchlist")),[revision]);
  const toggleWatch=(id:number)=>{const next=watch.includes(id)?watch.filter(x=>x!==id):[...watch,id];setWatch(next);persist("fpl-edge-watchlist",JSON.stringify(next))};
  const rows=useMemo(()=>data.players.map(p=>{
    const metrics=first?projectionMetrics(p,first,data.fixtures,first):null;
    const xPts1=first?playerProjection(p,first,data.fixtures,first):0;
    const xPts3=events.slice(0,3).reduce((s,e)=>s+playerProjection(p,e.id,data.fixtures,first),0);
    const xPts5=events.reduce((s,e)=>s+playerProjection(p,e.id,data.fixtures,first),0);
    const xgi90=p.minutes?p.expectedGoalInvolvements/p.minutes*90:0;
    const fdr=events.length?events.reduce((s,e)=>{
      const games=data.fixtures.filter(x=>x.event===e.id&&(x.teamH===p.teamId||x.teamA===p.teamId));
      const difficulties=games.map(f=>f.teamH===p.teamId?f.teamHDifficulty:f.teamADifficulty);
      return s+(difficulties.length?difficulties.reduce((a,b)=>a+b,0)/difficulties.length:5);
    },0)/events.length:5;
    return{p,metrics,xPts1,xPts3,xPts5,xgi90,fdr,value:xPts5/Math.max(3.5,p.price)};
  }).filter(r=>(pos==="ALL"||r.p.positionShort===pos)&&(club==="ALL"||String(r.p.teamId)===club)&&r.p.price<=maxPrice&&(r.metrics?.expectedMinutes||0)>=minMins&&(`${r.p.name} ${r.p.teamName}`).toLowerCase().includes(query.toLowerCase())&&(special==="ALL"||special==="DIFF"&&r.p.selectedBy<10||special==="PEN"&&r.metrics?.penaltyRole||special==="SET"&&r.metrics?.setPieceRole||special==="WATCH"&&watch.includes(r.p.id))).sort((a,b)=>{
    const val=(r:typeof a)=>sort==="xPts1"?r.xPts1:sort==="xPts3"?r.xPts3:sort==="xPts5"?r.xPts5:sort==="xgi90"?r.xgi90:sort==="fdr"?-r.fdr:sort==="value"?r.value:sort==="expectedMinutes"?(r.metrics?.expectedMinutes||0):sort==="start"?(r.metrics?.startProbability||0):Number(r.p[sort as keyof FplPlayer])||0;
    return direction==="desc"?val(b)-val(a):val(a)-val(b);
  }),[data,events.map(e=>e.id).join(","),first,query,pos,club,maxPrice,minMins,special,sort,direction,watch.join(",")]);
  const advancedActive=special!=="ALL"||maxPrice<realMaxPrice||minMins>0||more;
  const rowActions=(id:number)=><>
    <button type="button" className={compare.includes(id)?"active":""} disabled={!compare.includes(id)&&compare.length>=4} onClick={()=>setCompare(x=>x.includes(id)?x.filter(pid=>pid!==id):[...x,id])}>Compare</button>
    <button type="button" className={watch.includes(id)?"active":""} onClick={()=>toggleWatch(id)}>Watch</button>
    <button type="button" onClick={()=>go("transfers")}>Transfer</button>
  </>;
  return <div className="coach-page players-page">
    <section className="research-intro player-count"><div><span>LIVE 2026/27 RESEARCH</span><h2>Players</h2><p>{data.seasonStatsThrough?`Current-season totals through GW${data.seasonStatsThrough}.`:`No 2026/27 gameweek has finished, so new-season totals correctly start at zero.`} Prices and availability are live.</p></div><strong>{rows.length}<small>matching players</small></strong></section>
    <input className="players-search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search player or club…"/>
    <div className="players-filter-row players-filter-primary">
      <select className="players-select" value={pos} onChange={e=>setPos(e.target.value)}><option value="ALL">All positions</option>{data.rules.positions.map(p=><option key={p.id}>{p.short}</option>)}</select>
      <select className="players-select" value={club} onChange={e=>setClub(e.target.value)}><option value="ALL">All clubs</option>{data.teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select>
      <button type="button" className={advancedActive?"players-filter-toggle is-active":"players-filter-toggle"} aria-expanded={showAdvanced} onClick={()=>setShowAdvanced(x=>!x)}>{showAdvanced?"Hide filters":"Filters"}{advancedActive&&!showAdvanced?" · on":""}</button>
    </div>
    <div className={showAdvanced?"players-filter-row players-filter-advanced is-open":"players-filter-row players-filter-advanced"}>
      <select className="players-select" value={sort} onChange={e=>setSort(e.target.value)}>{[["xPts1","Next GW xPts"],["xPts5","5-GW xPts"],["xPts3","3-GW xPts"],["price","Price"],["selectedBy","Ownership"],["form","Form"],["totalPoints","Total points"],["pointsPerGame","Points per match"],["expectedGoals","xG"],["expectedAssists","xA"],["xgi90","xGI/90"],["goals","Goals"],["assists","Assists"],["cleanSheets","Clean sheets"],["defensiveContribution","Defensive contribution"],["expectedMinutes","Expected minutes"],["start","Start probability"],["fdr","Fixture rating"],["value","Value"]].map(x=><option value={x[0]} key={x[0]}>Sort: {x[1]}</option>)}</select>
      <button type="button" className="players-direction" onClick={()=>setDirection(x=>x==="desc"?"asc":"desc")}>{direction==="desc"?"High → low":"Low → high"}</button>
      <select className="players-select" value={special} onChange={e=>setSpecial(e.target.value)}><option value="ALL">All roles</option><option value="DIFF">Differential under 10%</option><option value="PEN">Penalties</option><option value="SET">Set pieces</option><option value="WATCH">Watchlist</option></select>
      <label className="players-range">Max £{maxPrice.toFixed(1)}m<input type="range" min="4" max={realMaxPrice} step=".5" value={maxPrice} onChange={e=>setMaxPrice(Number(e.target.value))}/></label>
      <label className="players-range">Min xMins {minMins}<input type="range" min="0" max="90" step="10" value={minMins} onChange={e=>setMinMins(Number(e.target.value))}/></label>
      <button type="button" className="players-more-toggle" onClick={()=>setMore(x=>!x)}>{more?"Fewer columns":"More columns"}</button>
    </div>
    {compare.length>=2&&<Compare data={data} ids={compare} close={()=>setCompare([])}/>}
    <section className={more?"research-table wide sticky-head":"research-table sticky-head"}>
      <header>{(more?["Player","Next GW","5 gameweeks","Price","Ownership","Points","Form","Points per match","Expected goals","Expected assists","xGI per 90","Goals","Assists","Clean sheets","Defensive contribution","Expected minutes","Start chance","Next fixture","3 gameweeks","Fixture rating","Value","Actions"]:["Player","Next GW","5 gameweeks","Price","Ownership","Actions"]).map(x=><span key={x}>{x}</span>)}</header>
      {rows.slice(0,120).map(r=><article key={r.p.id}>
        <b className="players-identity">{r.p.name}<small>{r.p.teamShort} · {r.p.positionShort}</small></b>
        <strong className="players-xpts">{r.xPts1.toFixed(1)}</strong>
        <strong className="players-xpts">{r.xPts5.toFixed(1)}</strong>
        <span>{r.p.price.toFixed(1)}</span>
        <span>{r.p.selectedBy.toFixed(1)}%</span>
        {more&&<><span>{r.p.totalPoints}</span><span>{(r.p.form??0).toFixed(1)}</span><span>{r.p.pointsPerGame.toFixed(1)}</span><span>{r.p.expectedGoals.toFixed(2)}</span><span>{r.p.expectedAssists.toFixed(2)}</span><span>{r.xgi90.toFixed(2)}</span><span>{r.p.goals}</span><span>{r.p.assists}</span><span>{r.p.cleanSheets}</span><span>{r.p.defensiveContribution}</span><span>{Math.round(r.metrics?.expectedMinutes||0)}</span><span>{Math.round((r.metrics?.startProbability||0)*100)}%</span><span>{first?opponent(r.p,first,data):"—"}</span><strong>{r.xPts3.toFixed(1)}</strong><span>{r.fdr.toFixed(1)}</span><span>{r.value.toFixed(2)}</span></>}
        <div className="players-row-actions">
          <div className="players-actions-inline">{rowActions(r.p.id)}</div>
          <details className="players-actions-menu">
            <summary aria-label={`Actions for ${r.p.name}`}>⋯</summary>
            <div className="players-actions-menu-panel">{rowActions(r.p.id)}</div>
          </details>
        </div>
      </article>)}
    </section>
  </div>;
}

function Compare({data,ids,close}:{data:FplData;ids:number[];close:()=>void}){const players=ids.map(id=>data.players.find(p=>p.id===id)).filter(Boolean) as FplPlayer[],events=futureEvents(data,5),first=events[0]?.id;const best=[...players].sort((a,b)=>events.reduce((s,e)=>s+playerProjection(b,e.id,data.fixtures,first),0)-events.reduce((s,e)=>s+playerProjection(a,e.id,data.fixtures,first),0))[0];const secure=[...players].sort((a,b)=>projectionMetrics(b,first,data.fixtures,first).startProbability-projectionMetrics(a,first,data.fixtures,first).startProbability)[0];return <section className="compare-drawer"><header><div><span>PLAYER COMPARISON</span><h2>{players.map(p=>p.name).join(" vs ")}</h2></div><button onClick={close}>Close</button></header><div>{players.map(p=>{const m=projectionMetrics(p,first,data.fixtures,first),xgi90=p.minutes?p.expectedGoalInvolvements/p.minutes*90:0;return <article key={p.id}><h3>{p.name}<small>{p.teamShort} · £{p.price.toFixed(1)}m</small></h3><p><span>Next 5</span><b>{events.map(e=>opponent(p,e.id,data)).join(" · ")}</b></p><p><span>5-GW xPts</span><b>{events.reduce((s,e)=>s+playerProjection(p,e.id,data.fixtures,first),0).toFixed(1)}</b></p><p><span>xMins / start</span><b>{Math.round(m.expectedMinutes)} / {Math.round(m.startProbability*100)}%</b></p><p><span>xG90 / xA90</span><b>{p.minutes?(p.expectedGoals/p.minutes*90).toFixed(2):"—"} / {p.minutes?(p.expectedAssists/p.minutes*90).toFixed(2):"—"}</b></p><p><span>xGI/90</span><b>{xgi90.toFixed(2)}</b></p><p><span>Roles</span><b>{m.penaltyRole?"Pens · ":""}{m.setPieceRole?"Set pieces":"No confirmed role"}</b></p><p><span>Ownership / rotation</span><b>{p.selectedBy.toFixed(1)}% / {Math.round(m.rotationRisk*100)}%</b></p></article>})}</div><footer><span>MODEL VERDICT</span><p><b>{best.name}</b> has the highest five-gameweek projection. <b>{secure.name}</b> has the safest minutes profile. Choose upside only if its minutes uncertainty fits your risk tolerance.</p></footer></section>}
