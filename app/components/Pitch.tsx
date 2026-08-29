"use client";

import { FplData, FplPlayer, opponent, playerProjection, startPct } from "../lib/fpl";

// Extracted from CoachApp.tsx so LiveDraftBuilder.tsx's Draft Lab result view can reuse it --
// CoachApp.tsx already imports LiveDraftBuilder, so LiveDraftBuilder importing this back from
// CoachApp.tsx would be a circular import. Behavior is unchanged from the original: Final Check's
// usage in CoachApp.tsx is untouched. Reuses the same 68% start-probability risk-flag convention
// already established in analysis()'s issues filter and captainRiskNote, not a new threshold.
export default function Pitch({players,bench,captain,vice,event,data,onSelect}:{players:FplPlayer[];bench:FplPlayer[];captain:FplPlayer;vice:FplPlayer;event:number;data:FplData;onSelect:(p:FplPlayer)=>void}){return <><section className="coach-pitch"><div className="pitch-markings"/>{["GKP","DEF","MID","FWD"].map(pos=><div className={`coach-pitch-row ${pos.toLowerCase()}`} key={pos}>{players.filter(p=>p.positionShort===pos).map(p=><button type="button" key={p.id} className={p.status!=="a"||startPct(p,event,data)<68?"flagged":""} onClick={()=>onSelect(p)}><i>{pos}</i><b>{p.name}{p.id===captain.id&&<em>C</em>}{p.id===vice.id&&<em>V</em>}</b><span>{opponent(p,event,data)} · {playerProjection(p,event,data.fixtures,event).toFixed(1)} xPts</span><small>{startPct(p,event,data)}% start</small></button>)}</div>)}</section><section className="coach-bench"><span>BENCH ORDER</span>{bench.map((p,i)=><button type="button" key={p.id} onClick={()=>onSelect(p)}><i>{i+1}</i><b>{p.name}</b><small>{opponent(p,event,data)} · {playerProjection(p,event,data.fixtures,event).toFixed(1)}</small></button>)}</section></>}
