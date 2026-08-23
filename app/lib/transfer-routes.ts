import { FplData, FplPlayer, bestXi, futureEvents, playerProjection, projectionMetrics } from "./fpl";

export type RouteTransfer={
  out:FplPlayer;
  incoming:FplPlayer;
  sellingPrice:number;
  buyingPrice:number;
  bankChange:number;
  horizonGain:number;
};

export type RouteWeek={
  eventId:number;
  eventName:string;
  freeTransfersBefore:number;
  freeTransfersAfter:number;
  transfers:RouteTransfer[];
  hitCost:number;
  bankAfter:number;
  projectedPoints:number;
  netProjectedPoints:number;
  squadIdsAfter:number[];
};

export type TransferRoute={
  id:string;
  weeks:RouteWeek[];
  totalProjectedPoints:number;
  netProjectedPoints:number;
  baselinePoints:number;
  gain:number;
  totalHitCost:number;
  totalTransfers:number;
  finalBank:number;
  finalFreeTransfers:number;
  confidence:number;
  risk:"Low"|"Medium"|"High";
  firstAction:string;
  explanation:string[];
};

export type TransferRouteOptions={
  horizon?:3|5|8;
  freeTransfers?:number;
  maxWeeklyHit?:0|4|8;
  sellingPrices?:Map<number,number>;
  beamWidth?:number;
  resultLimit?:number;
};

type RouteState={
  squad:FplPlayer[];
  bank:number;
  freeTransfers:number;
  sellingPrices:Map<number,number>;
  weeks:RouteWeek[];
  projectedPoints:number;
  hitCost:number;
  incomingEvidence:{start:number;confidence:number}[];
};

type SwapProposal={out:FplPlayer;incoming:FplPlayer;horizonGain:number};

const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const money=(value:number)=>Math.round((value+Number.EPSILON)*10)/10;
const squadKey=(squad:FplPlayer[])=>squad.map(player=>player.id).sort((a,b)=>a-b).join("-");

function legalSquadShape(squad:FplPlayer[],data:FplData):boolean{
  if(squad.length!==data.rules.squadSize||new Set(squad.map(player=>player.id)).size!==squad.length)return false;
  if(data.rules.positions.some(rule=>squad.filter(player=>player.positionId===rule.id).length!==rule.squad))return false;
  const clubs=new Map<number,number>();
  for(const player of squad){const count=(clubs.get(player.teamId)??0)+1;if(count>data.rules.teamLimit)return false;clubs.set(player.teamId,count)}
  return true;
}

function firstActionOf(weeks:RouteWeek[]):string{
  const active=weeks.find(week=>week.transfers.length);
  if(!active)return"Roll throughout";
  const moves=active.transfers.map(move=>`${move.out.name} → ${move.incoming.name}`).join(" + ");
  return active===weeks[0]?moves:`Roll to ${active.eventName}, then ${moves}`;
}

export function solveTransferRoutes(data:FplData,initialSquad:FplPlayer[],initialBank:number,options:TransferRouteOptions={}):TransferRoute[]{
  const horizon=options.horizon??5;
  const events=futureEvents(data,horizon);
  if(!events.length||!legalSquadShape(initialSquad,data))return[];
  const freeTransfers=clamp(Math.floor(options.freeTransfers??1),0,5);
  const maxWeeklyHit=options.maxWeeklyHit??4;
  const beamWidth=Math.max(12,options.beamWidth??42);
  const resultLimit=Math.max(1,options.resultLimit??4);
  const firstEvent=events[0].id;
  const projectionCache=new Map<string,number>();
  const metricCache=new Map<string,ReturnType<typeof projectionMetrics>>();
  const projected=(player:FplPlayer,eventId:number)=>{const key=`${player.id}:${eventId}`;if(!projectionCache.has(key))projectionCache.set(key,playerProjection(player,eventId,data.fixtures,firstEvent));return projectionCache.get(key)!};
  const metrics=(player:FplPlayer,eventId:number)=>{const key=`${player.id}:${eventId}`;if(!metricCache.has(key))metricCache.set(key,projectionMetrics(player,eventId,data.fixtures,firstEvent));return metricCache.get(key)!};
  const weekTotalCache=new Map<string,number>();
  const weekTotal=(squad:FplPlayer[],eventId:number)=>{const key=`${eventId}:${squadKey(squad)}`;if(!weekTotalCache.has(key))weekTotalCache.set(key,bestXi(squad,eventId,data.fixtures,firstEvent).total);return weekTotalCache.get(key)!};
  const remainingScore=(player:FplPlayer,index:number)=>events.slice(index).reduce((sum,event)=>sum+projected(player,event.id),0);
  const baselinePoints=events.reduce((sum,event)=>sum+weekTotal(initialSquad,event.id),0);

  // A route candidate must clear the same hard role-security floors as the single-transfer
  // quality gate. Watch-level uncertainty can still be researched elsewhere, but it cannot
  // silently become the backbone of a multi-week plan.
  const eligibleAt=(player:FplPlayer,index:number)=>{
    if(player.status==="u")return false;
    const model=metrics(player,events[index].id);
    return model.startProbability>=.55&&model.expectedMinutes>=45&&model.confidence>=.35;
  };
  const pools=events.map((_,index)=>new Map(data.rules.positions.map(rule=>{
    const players=data.players.filter(player=>player.positionId===rule.id&&eligibleAt(player,index)).sort((a,b)=>{
      const am=metrics(a,events[index].id),bm=metrics(b,events[index].id);
      const aScore=remainingScore(a,index)*(.72+.16*am.startProbability+.12*am.confidence);
      const bScore=remainingScore(b,index)*(.72+.16*bm.startProbability+.12*bm.confidence);
      return bScore-aScore||a.price-b.price;
    }).slice(0,16);
    return[rule.id,players] as const;
  })));

  const initialSelling=new Map(initialSquad.map(player=>[player.id,options.sellingPrices?.get(player.id)??player.price]));
  let beam:RouteState[]=[{squad:[...initialSquad],bank:money(initialBank),freeTransfers,sellingPrices:initialSelling,weeks:[],projectedPoints:0,hitCost:0,incomingEvidence:[]}];

  const apply=(state:RouteState,proposals:SwapProposal[],index:number):RouteState|null=>{
    const outIds=new Set(proposals.map(proposal=>proposal.out.id)),incomingIds=new Set(proposals.map(proposal=>proposal.incoming.id));
    if(outIds.size!==proposals.length||incomingIds.size!==proposals.length)return null;
    if(proposals.some(proposal=>state.squad.some(player=>player.id===proposal.incoming.id)))return null;
    const selling=proposals.reduce((sum,proposal)=>sum+(state.sellingPrices.get(proposal.out.id)??proposal.out.price),0);
    const buying=proposals.reduce((sum,proposal)=>sum+proposal.incoming.price,0);
    const bankAfter=money(state.bank+selling-buying);
    if(bankAfter<-.001)return null;
    const replacements=new Map(proposals.map(proposal=>[proposal.out.id,proposal.incoming]));
    const squad=state.squad.map(player=>replacements.get(player.id)??player);
    if(!legalSquadShape(squad,data))return null;
    const transferCount=proposals.length;
    const hitCost=Math.max(0,transferCount-state.freeTransfers)*4;
    if(hitCost>maxWeeklyHit)return null;
    const projectedPoints=weekTotal(squad,events[index].id);
    const nextFreeTransfers=Math.min(5,Math.max(0,state.freeTransfers-transferCount)+1);
    const sellingPrices=new Map(state.sellingPrices);
    const transfers=proposals.map(proposal=>{
      const sellingPrice=state.sellingPrices.get(proposal.out.id)??proposal.out.price;
      sellingPrices.delete(proposal.out.id);sellingPrices.set(proposal.incoming.id,proposal.incoming.price);
      return{out:proposal.out,incoming:proposal.incoming,sellingPrice,buyingPrice:proposal.incoming.price,bankChange:money(sellingPrice-proposal.incoming.price),horizonGain:proposal.horizonGain};
    });
    const evidence=proposals.map(proposal=>{const model=metrics(proposal.incoming,events[index].id);return{start:model.startProbability,confidence:model.confidence}});
    const week:RouteWeek={eventId:events[index].id,eventName:events[index].name,freeTransfersBefore:state.freeTransfers,freeTransfersAfter:nextFreeTransfers,transfers,hitCost,bankAfter,projectedPoints,netProjectedPoints:projectedPoints-hitCost,squadIdsAfter:squad.map(player=>player.id)};
    return{squad,bank:bankAfter,freeTransfers:nextFreeTransfers,sellingPrices,weeks:[...state.weeks,week],projectedPoints:state.projectedPoints+projectedPoints,hitCost:state.hitCost+hitCost,incomingEvidence:[...state.incomingEvidence,...evidence]};
  };

  for(let index=0;index<events.length;index++){
    const next:RouteState[]=[];
    for(const state of beam){
      const owned=new Set(state.squad.map(player=>player.id));
      const proposals:SwapProposal[]=[];
      for(const out of state.squad){
        for(const incoming of pools[index].get(out.positionId)??[]){
          if(owned.has(incoming.id))continue;
          proposals.push({out,incoming,horizonGain:remainingScore(incoming,index)-remainingScore(out,index)});
        }
      }
      proposals.sort((a,b)=>b.horizonGain-a.horizonGain||a.incoming.price-b.incoming.price);
      const shortlist=proposals.slice(0,20);
      const actions:SwapProposal[][]=[[]];
      for(const proposal of shortlist){
        const sale=state.sellingPrices.get(proposal.out.id)??proposal.out.price;
        if(proposal.incoming.price<=state.bank+sale+.001)actions.push([proposal]);
      }
      for(let left=0;left<shortlist.length;left++)for(let right=left+1;right<shortlist.length;right++){
        const pair=[shortlist[left],shortlist[right]];
        if(pair[0].out.id===pair[1].out.id||pair[0].incoming.id===pair[1].incoming.id)continue;
        actions.push(pair);
      }
      const expanded=actions.map(action=>apply(state,action,index)).filter((candidate):candidate is RouteState=>Boolean(candidate));
      expanded.sort((a,b)=>{
        const futureA=events.slice(index+1).reduce((sum,event)=>sum+weekTotal(a.squad,event.id),0);
        const futureB=events.slice(index+1).reduce((sum,event)=>sum+weekTotal(b.squad,event.id),0);
        return(b.projectedPoints-b.hitCost+futureB)-(a.projectedPoints-a.hitCost+futureA)||b.bank-a.bank;
      });
      next.push(...expanded.slice(0,28));
    }
    const deduped=new Map<string,RouteState>();
    for(const state of next){
      const key=`${squadKey(state.squad)}:${state.freeTransfers}:${state.bank.toFixed(1)}`;
      const current=deduped.get(key);
      if(!current||state.projectedPoints-state.hitCost>current.projectedPoints-current.hitCost)deduped.set(key,state);
    }
    beam=[...deduped.values()].sort((a,b)=>{
      const futureA=events.slice(index+1).reduce((sum,event)=>sum+weekTotal(a.squad,event.id),0);
      const futureB=events.slice(index+1).reduce((sum,event)=>sum+weekTotal(b.squad,event.id),0);
      return(b.projectedPoints-b.hitCost+futureB)-(a.projectedPoints-a.hitCost+futureA)||b.bank-a.bank;
    }).slice(0,beamWidth);
  }

  const all=beam.map((state,index):TransferRoute=>{
    const netProjectedPoints=state.projectedPoints-state.hitCost;
    const gain=netProjectedPoints-baselinePoints;
    const confidence=state.incomingEvidence.length?state.incomingEvidence.reduce((sum,item)=>sum+(item.start+item.confidence)/2,0)/state.incomingEvidence.length:1;
    const risk:TransferRoute["risk"]=confidence>=.8?"Low":confidence>=.66?"Medium":"High";
    const totalTransfers=state.weeks.reduce((sum,week)=>sum+week.transfers.length,0);
    const firstAction=firstActionOf(state.weeks);
    const explanation=[
      gain>.05?`${gain.toFixed(1)} projected points better than rolling every week after hits.`:"No transfer sequence beats rolling across this horizon.",
      state.hitCost?`${state.hitCost} hit point${state.hitCost===1?"":"s"} are included in the route total.`:"The route uses no points hits.",
      totalTransfers?`${totalTransfers} transfer${totalTransfers===1?"":"s"} leave £${state.bank.toFixed(1)}m in the bank and ${state.freeTransfers} free transfer${state.freeTransfers===1?"":"s"} after the final gameweek.`:`Rolling preserves the full squad and builds to ${state.freeTransfers} free transfers.`,
    ];
    return{id:`route-${index}-${state.weeks.map(week=>week.transfers.map(move=>`${move.out.id}-${move.incoming.id}`).join("+")||"roll").join("_")}`,weeks:state.weeks,totalProjectedPoints:state.projectedPoints,netProjectedPoints,baselinePoints,gain,totalHitCost:state.hitCost,totalTransfers,finalBank:state.bank,finalFreeTransfers:state.freeTransfers,confidence,risk,firstAction,explanation};
  }).sort((a,b)=>b.netProjectedPoints-a.netProjectedPoints||a.totalHitCost-b.totalHitCost||b.finalBank-a.finalBank);

  // Alternatives must represent genuinely different opening decisions. Four tiny variations of
  // the same first transfer are not useful to a manager comparing routes.
  const diverse:TransferRoute[]=[];const seen=new Set<string>();
  for(const route of all){if(seen.has(route.firstAction))continue;seen.add(route.firstAction);diverse.push(route);if(diverse.length>=resultLimit)break}
  return diverse;
}
