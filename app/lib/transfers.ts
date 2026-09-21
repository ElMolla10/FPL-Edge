import { FplData, FplPlayer, ProjectionMetrics, futureEvents, isCompleteSquad, playerCalibrationProfile, playerProjection, projectionMetrics } from "./fpl";
import { AnomalyFlag, FiveGwGainBand, classifyFiveGwGain, transferAnomalies } from "./anomalies";
import { TRANSFER_ACTION_THRESHOLD, TransferQualityReason, TransferQualityStatus, evaluateTransferQuality, transferHitCost } from "./transfer-quality";
import { plannedChipFor, readPlannedChips } from "./chip-portfolio";
import {
  bestTransfersFromEngine,
  isLegalSingleTransfer,
  selectPrimaryEngineTransfer,
  type TransferClassification,
} from "./transfer-engine";


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
  outMetrics:ProjectionMetrics;inMetrics:ProjectionMetrics;
  gainBand:FiveGwGainBand;anomalies:AnomalyFlag[];
  hitCost:number;netDifference:number;utilityChange:number|null;
  rankScore:number;reviewRequired:boolean;
  weeklyGains:number[];positiveWeeks:number;gainWithoutBestWeek:number;
  qualityStatus:TransferQualityStatus;qualityScore:number;qualityReasons:TransferQualityReason[];
  risk:"Low"|"Medium"|"High";
  /** Present when ranked by the 2026 transfer-engine rebuild. */
  classification?:TransferClassification;
  engineReason?:string;
  netEv3?:number;
  netEv5?:number;
  riskAdjustedNet5?:number;
  bankAfter?:number;
  hitLabel?:string;
  nextGwGross?:number;
  isHold?:boolean;
};

const clamp=(n:number,min=0,max=100)=>Math.max(min,Math.min(max,n));
const qualityOrder:Record<TransferQualityStatus,number>={actionable:0,watchlist:1,blocked:2};
const classificationOrder:Record<TransferClassification,number>={MAKE:0,LEAN:1,HOLD:2,WATCH:3,ROLL:4,AVOID:5};

export function sortTransfersByQuality(rows:Transfer[]):Transfer[]{
  return [...rows].sort((a,b)=>{
    const ca=a.classification,cb=b.classification;
    if(ca&&cb&&ca!==cb)return classificationOrder[ca]-classificationOrder[cb];
    return qualityOrder[a.qualityStatus]-qualityOrder[b.qualityStatus]||b.rankScore-a.rankScore||b.netDifference-a.netDifference;
  });
}

export function selectPrimaryTransfer(rows:Transfer[],threshold=TRANSFER_ACTION_THRESHOLD):Transfer|null{
  const enginePrimary=selectPrimaryEngineTransfer(rows as Parameters<typeof selectPrimaryEngineTransfer>[0]);
  if(enginePrimary)return enginePrimary;
  // Legacy fallback when rows lack classification (e.g. evaluateTransfer ad-hoc pairs).
  return sortTransfersByQuality(rows).find(row=>row.qualityStatus==="actionable"&&row.rankScore>=threshold)??null;
}

type TransferBaseline={
  events:{id:number}[];first:number;hitCost:number;
  projected:(player:FplPlayer,eventId:number)=>number;
  squadWeekTotal:(players:FplPlayer[],eventId:number)=>number;
  baselineSquadByEvent:number[];
};
function buildTransferBaseline(data:FplData,squad:FplPlayer[],freeTransfers:number,hitCostOverride?:number):TransferBaseline|null{
  const events=futureEvents(data,5);
  if(!events.length)return null;
  const first=events[0].id;
  const hitCost=hitCostOverride??transferHitCost(1,freeTransfers);
  const projectionCache=new Map<string,number>();
  const projected=(player:FplPlayer,eventId:number)=>{const key=`${player.id}:${eventId}`;if(!projectionCache.has(key))projectionCache.set(key,playerProjection(player,eventId,data.fixtures,first));return projectionCache.get(key)!};
  const plannedChips=readPlannedChips();
  const squadWeekTotal=(players:FplPlayer[],eventId:number)=>{let best=0;const score=(p:FplPlayer)=>projected(p,eventId);const keepers=players.filter(p=>p.positionShort==="GKP").sort((a,b)=>score(b)-score(a));const chip=plannedChipFor(plannedChips,eventId);for(let def=3;def<=5;def++)for(let mid=2;mid<=5;mid++){const fwd=10-def-mid;if(fwd<1||fwd>3)continue;const xi=[keepers[0],...players.filter(p=>p.positionShort==="DEF").sort((a,b)=>score(b)-score(a)).slice(0,def),...players.filter(p=>p.positionShort==="MID").sort((a,b)=>score(b)-score(a)).slice(0,mid),...players.filter(p=>p.positionShort==="FWD").sort((a,b)=>score(b)-score(a)).slice(0,fwd)].filter(Boolean);if(xi.length!==11)continue;const captain=[...xi].sort((a,b)=>score(b)-score(a))[0];const captainBonus=chip==="Triple Captain"?score(captain):0;const benchBonus=chip==="Bench Boost"?players.filter(p=>!xi.includes(p)).reduce((sum,p)=>sum+score(p),0):0;best=Math.max(best,xi.reduce((sum,p)=>sum+score(p),0)+score(captain)+captainBonus+benchBonus)}return best};
  const baselineSquadByEvent=events.map(event=>squadWeekTotal(squad,event.id));
  return{events,first,hitCost,projected,squadWeekTotal,baselineSquadByEvent};
}

function buildTransferRow(data:FplData,squad:FplPlayer[],baseline:TransferBaseline,out:FplPlayer,om:ProjectionMetrics,outByEvent:number[],incoming:FplPlayer):Transfer{
  const{events,first,hitCost,projected,squadWeekTotal,baselineSquadByEvent}=baseline;
  const outGw1=outByEvent[0]||0,outGw3=outByEvent.slice(0,3).reduce((a,b)=>a+b,0),outGw5=outByEvent.reduce((a,b)=>a+b,0);
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
  return{
    out,incoming,gain1,gain3,gain5,individualGain1,individualGain3,individualGain5,
    outGw1,inGw1,outGw3,inGw3,outGw5,inGw5,
    price:incoming.price-out.price,minutes:im.expectedMinutes-om.expectedMinutes,
    expectedMinutesOut:om.expectedMinutes,expectedMinutesIn:im.expectedMinutes,
    startProbOut:om.startProbability,startProbIn:im.startProbability,
    dcOut:om.defensiveContribution,dcIn:im.defensiveContribution,
    attackingOut:om.xG+om.xA,attackingIn:im.xG+im.xA,
    fixtureAdjustmentIn,confidenceOut:om.confidence,confidenceIn:im.confidence,
    teamAttackIn:im.teamAttackFactor??1,teamDefenceIn:im.teamDefenceFactor??1,opponentDefenceIn:im.opponentDefenceFactor??1,opponentAttackIn:im.opponentAttackFactor??1,fixtureAttackMultiplierIn:im.fixtureAttackMultiplier??1,fixtureDefenceMultiplierIn:im.fixtureDefenceMultiplier??1,
    outMetrics:om,inMetrics:im,
    gainBand,anomalies,hitCost,netDifference:gain5-hitCost,utilityChange:null,rankScore,reviewRequired,
    weeklyGains:squadDeltas,positiveWeeks:quality.positiveWeeks,gainWithoutBestWeek:quality.gainWithoutBestWeek,
    qualityStatus:quality.status,qualityScore:quality.score,qualityReasons:quality.reasons,
    risk,
  };
}

/** Ad-hoc single-pair evaluator for Draft Lab pitch swaps (not the ranking sweep). */
export function evaluateTransfer(data:FplData,squad:FplPlayer[],out:FplPlayer,incoming:FplPlayer,freeTransfers=1,hitCostOverride?:number):Transfer{
  const baseline=buildTransferBaseline(data,squad,freeTransfers,hitCostOverride);
  if(!baseline)throw new Error("No future gameweek to project this transfer against.");
  const om=projectionMetrics(out,baseline.first,data.fixtures,baseline.first);
  const outByEvent=baseline.events.map(e=>baseline.projected(out,e.id));
  return buildTransferRow(data,squad,baseline,out,om,outByEvent,incoming);
}

export type PlaceableTransferReason="owned"|"unavailable"|"position"|"club-limit"|"budget"|"squad-shape";
export function isPlaceableTransfer(data:FplData,squad:FplPlayer[],out:FplPlayer,incoming:FplPlayer,bank:number,sellingPrices=new Map<number,number>()):{placeable:true}|{placeable:false;reason:PlaceableTransferReason}{
  const result=isLegalSingleTransfer(data,squad,out,incoming,bank,sellingPrices);
  if(result.legal)return{placeable:true};
  const reason=result.reason;
  if(reason==="duplicate-out"||reason==="duplicate-in")return{placeable:false,reason:"owned"};
  return{placeable:false,reason};
}

/**
 * Transfers page ranking — powered by app/lib/transfer-engine (NET vs HOLD,
 * discounted multi-GW squad EP, MAKE/LEAN/ROLL/WATCH/AVOID).
 * isPlaceableTransfer / live selling prices remain the legality gate inside the engine.
 */
export function bestTransfers(data:FplData,squad:FplPlayer[],bank:number,freeTransfers=1,limit=12,sellingPrices=new Map<number,number>()):Transfer[]{
  if(!isCompleteSquad(squad,data))return[];
  return bestTransfersFromEngine(data,squad,bank,freeTransfers,limit,sellingPrices) as Transfer[];
}
