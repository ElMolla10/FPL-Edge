import { FplData, FplPlayer, ProjectionMetrics, futureEvents, isValidSquad, playerCalibrationProfile, playerProjection, projectionMetrics } from "./fpl";
import { AnomalyFlag, FiveGwGainBand, classifyFiveGwGain, transferAnomalies } from "./anomalies";
import { TRANSFER_ACTION_THRESHOLD, TransferQualityReason, TransferQualityStatus, evaluateTransferQuality } from "./transfer-quality";

// Moved from CoachApp.tsx (Phase 1 of the Draft Lab result-mode work) so LiveDraftBuilder.tsx's
// "Best available transfer right now" can call the real, already-battle-tested single-transfer
// engine directly -- real selling-price handling when connected, whole-squad re-optimized ranking
// (not a player-level approximation), the full evaluateTransferQuality gate, real hit cost -- rather
// than building a second, weaker computation from the recommended-changes diff mechanism. Same
// circular-import reason as the Pitch/transfer-quality extractions: CoachApp.tsx already imports
// LiveDraftBuilder, so LiveDraftBuilder importing this back from CoachApp.tsx would cycle.
// sortTransfersByQuality/selectPrimaryTransfer stay bundled with Transfer/bestTransfers here since
// all four are one cohesive unit, not independently useful pieces.
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
};

const clamp=(n:number,min=0,max=100)=>Math.max(min,Math.min(max,n));
const qualityOrder:Record<TransferQualityStatus,number>={actionable:0,watchlist:1,blocked:2};

export function sortTransfersByQuality(rows:Transfer[]):Transfer[]{
  return [...rows].sort((a,b)=>qualityOrder[a.qualityStatus]-qualityOrder[b.qualityStatus]||b.rankScore-a.rankScore||b.netDifference-a.netDifference);
}

export function selectPrimaryTransfer(rows:Transfer[],threshold=TRANSFER_ACTION_THRESHOLD):Transfer|null{
  return sortTransfersByQuality(rows).find(row=>row.qualityStatus==="actionable"&&row.rankScore>=threshold)??null;
}

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
      // Standing decision (reviewed ac6a221): rank by the whole-squad re-optimized delta
      // (best XI + captain before vs after the swap), not the raw individual player delta above.
      // This matches the optimizer's own squad-level objective rather than a player-level one, and
      // individualGain1/3/5 stay on the row so the breakdown UI can still show the simpler number.
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
      // Standing decision (reviewed ac6a221): bounded 0.55-1.0x discount on positive gain, sized so
      // it can never invert a ranking. This is a stopgap point-estimate risk adjustment for exactly
      // the failure class this projection engine review started from (Hull City's Mendy/Ajayi --
      // see the ac6a221 review). When the Probabilistic Projection Simulator's distribution engine
      // ships, IT should own risk-adjusted ranking and this multiplier should be REMOVED, not kept
      // stacked alongside it as a second, redundant risk adjustment. Flag this for that review round.
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
        outMetrics:om,inMetrics:im,
        gainBand,anomalies,hitCost,netDifference:gain5-hitCost,utilityChange:null,rankScore,reviewRequired,
        weeklyGains:squadDeltas,positiveWeeks:quality.positiveWeeks,gainWithoutBestWeek:quality.gainWithoutBestWeek,
        qualityStatus:quality.status,qualityScore:quality.score,qualityReasons:quality.reasons,
        risk,
      });
    }
  }
  return sortTransfersByQuality(rows).slice(0,limit);
}
