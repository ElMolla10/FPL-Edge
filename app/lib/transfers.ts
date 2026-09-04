import { FplData, FplPlayer, ProjectionMetrics, futureEvents, isCompleteSquad, playerCalibrationProfile, playerProjection, projectionMetrics } from "./fpl";
import { AnomalyFlag, FiveGwGainBand, classifyFiveGwGain, transferAnomalies } from "./anomalies";
import { TRANSFER_ACTION_THRESHOLD, TransferQualityReason, TransferQualityStatus, evaluateTransferQuality, transferHitCost } from "./transfer-quality";
import { plannedChipFor, readPlannedChips } from "./chip-portfolio";

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

// Shared setup for scoring transfers against ONE squad: the whole-squad best-XI+captain baseline
// (per gameweek, before any swap) and a memoized single-player projection lookup. Split out of
// bestTransfers() so evaluateTransfer() (a single ad-hoc pair, e.g. a live Draft Lab pitch swap) can
// build the same baseline without needing bestTransfers()'s full candidate sweep, while bestTransfers()
// itself still computes this ONCE per call rather than once per (out,incoming) pair -- that reuse is
// the reason this stayed a closure-returning function rather than being folded into buildTransferRow.
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
  // A planned Triple Captain/Bench Boost for a specific future event adds one more term to
  // whichever candidate squad is being scored for THAT event only -- same two-term addition
  // evaluateProjectionReceipt already uses to reconcile a receipt against the real chip that was
  // played (CoachApp.tsx), just applied forward from an unconfirmed plan instead of backward from
  // confirmed history. Wildcard/Free Hit are deliberately NOT handled here (Option A, Feature #7
  // revision): they change which 15 players this formula should even be scoring, not a term within
  // it, and squadWeekTotal always scores one fixed candidate squad passed in by the caller.
  const plannedChips=readPlannedChips();
  const squadWeekTotal=(players:FplPlayer[],eventId:number)=>{let best=0;const score=(p:FplPlayer)=>projected(p,eventId);const keepers=players.filter(p=>p.positionShort==="GKP").sort((a,b)=>score(b)-score(a));const chip=plannedChipFor(plannedChips,eventId);for(let def=3;def<=5;def++)for(let mid=2;mid<=5;mid++){const fwd=10-def-mid;if(fwd<1||fwd>3)continue;const xi=[keepers[0],...players.filter(p=>p.positionShort==="DEF").sort((a,b)=>score(b)-score(a)).slice(0,def),...players.filter(p=>p.positionShort==="MID").sort((a,b)=>score(b)-score(a)).slice(0,mid),...players.filter(p=>p.positionShort==="FWD").sort((a,b)=>score(b)-score(a)).slice(0,fwd)].filter(Boolean);if(xi.length!==11)continue;const captain=[...xi].sort((a,b)=>score(b)-score(a))[0];const captainBonus=chip==="Triple Captain"?score(captain):0;const benchBonus=chip==="Bench Boost"?players.filter(p=>!xi.includes(p)).reduce((sum,p)=>sum+score(p),0):0;best=Math.max(best,xi.reduce((sum,p)=>sum+score(p),0)+score(captain)+captainBonus+benchBonus)}return best};
  const baselineSquadByEvent=events.map(event=>squadWeekTotal(squad,event.id));
  return{events,first,hitCost,projected,squadWeekTotal,baselineSquadByEvent};
}

// The actual per-candidate computation -- moved verbatim out of bestTransfers()'s loop body, not
// rewritten. om/outByEvent are passed in (not recomputed here) because bestTransfers() computes them
// once per OUT player and reuses them across every candidate IN player for that OUT; recomputing
// them per pair here would silently reintroduce the O(squad x pool) cost this split is meant to avoid.
function buildTransferRow(data:FplData,squad:FplPlayer[],baseline:TransferBaseline,out:FplPlayer,om:ProjectionMetrics,outByEvent:number[],incoming:FplPlayer):Transfer{
  const{events,first,hitCost,projected,squadWeekTotal,baselineSquadByEvent}=baseline;
  const outGw1=outByEvent[0]||0,outGw3=outByEvent.slice(0,3).reduce((a,b)=>a+b,0),outGw5=outByEvent.reduce((a,b)=>a+b,0);
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
  // Standing decision (reviewed ac6a221, re-affirmed in the Decision Confidence Engine
  // integration review): bounded 0.55-1.0x discount on positive gain, sized so it can never invert
  // a ranking. This is a point-estimate risk adjustment for exactly the failure class this
  // projection engine review started from (Hull City's Mendy/Ajayi -- see the ac6a221 review).
  //
  // The joint squad-level Monte Carlo Decision Confidence Engine (008867b onward) is NOT a
  // replacement for this multiplier and this is not a removal-pending stopgap anymore: the engine
  // is deliberately too expensive to run across bestTransfers()'s full ~200-candidate sweep, so it
  // was scoped from the start to run once, opt-in, on an already-ranked single candidate (primary
  // transfer or a user-selected alternative) as deep verification -- not as the ranking mechanism.
  // confidenceMultiplier remains the only risk adjustment applied across the full sweep and is not
  // stacked with the engine's output; they answer different questions at different candidate counts.
  //
  // Replacing confidenceMultiplier still needs either (a) a cheap per-candidate approximation built
  // from the engine's own cheap-to-compute primitives -- e.g. playerPointsDistribution's per-player
  // blank/haul probabilities, not a full per-candidate Monte Carlo run -- or (b) a fundamentally
  // different ranking architecture that doesn't require re-scoring every candidate at simulation
  // cost. Neither exists yet. This is real future design work, not a pending removal.
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

// Standalone single-pair evaluator -- added for Draft Lab's pitch-click swap (click a player, pick
// a specific replacement, get the same real breakdown bestTransfers() gives its ranked candidates).
// Deliberately takes no bank/sellingPrices: the caller (bestTransfers()'s loop, or Draft Lab's own
// swap() validation) is responsible for confirming the pair is legal and affordable BEFORE calling
// this -- it computes the projection/quality/gain breakdown for a given pair, it does not gate
// eligibility. Throws if there is no future event to project against (the season is over); every
// real call site already requires live event data to reach this point at all (Draft Lab hides the
// swap interaction whenever eventIds is empty), so this is a genuine precondition, not a normal
// control-flow path to render around.
export function evaluateTransfer(data:FplData,squad:FplPlayer[],out:FplPlayer,incoming:FplPlayer,freeTransfers=1,hitCostOverride?:number):Transfer{
  const baseline=buildTransferBaseline(data,squad,freeTransfers,hitCostOverride);
  if(!baseline)throw new Error("No future gameweek to project this transfer against.");
  const om=projectionMetrics(out,baseline.first,data.fixtures,baseline.first);
  const outByEvent=baseline.events.map(e=>baseline.projected(out,e.id));
  return buildTransferRow(data,squad,baseline,out,om,outByEvent,incoming);
}

export function bestTransfers(data:FplData,squad:FplPlayer[],bank:number,freeTransfers=1,limit=12,sellingPrices=new Map<number,number>()):Transfer[]{
  // isCompleteSquad, not the stricter isValidSquad -- squad here is the caller's real/saved squad
  // (never a candidate this function is constructing), and a real manager's squad can legitimately
  // be worth more than the nominal £100m budget today due to price rises since it was assembled.
  if(!isCompleteSquad(squad,data))return[];
  const baseline=buildTransferBaseline(data,squad,freeTransfers);
  if(!baseline)return[];
  const owned=new Set(squad.map(p=>p.id));
  const clubCount=new Map<number,number>();squad.forEach(p=>clubCount.set(p.teamId,(clubCount.get(p.teamId)||0)+1));
  const rows:Transfer[]=[];
  for(const out of squad){
    const om=projectionMetrics(out,baseline.first,data.fixtures,baseline.first);
    const outByEvent=baseline.events.map(e=>baseline.projected(out,e.id));
    for(const incoming of data.players){
      const saleValue=sellingPrices.get(out.id)??out.price;
      if(owned.has(incoming.id)||incoming.positionId!==out.positionId||incoming.status==="u"||incoming.price>saleValue+bank+.001)continue;
      if(incoming.teamId!==out.teamId&&(clubCount.get(incoming.teamId)||0)>=3)continue;
      rows.push(buildTransferRow(data,squad,baseline,out,om,outByEvent,incoming));
    }
  }
  return sortTransfersByQuality(rows).slice(0,limit);
}
