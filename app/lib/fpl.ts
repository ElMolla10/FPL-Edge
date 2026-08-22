export type FplPlayer = {
  id:number; name:string; firstName:string; secondName:string; teamId:number; teamName:string; teamShort:string;
  positionId:number; position:string; positionShort:string; price:number; status:string; chance:number|null;
  epNext:number; form:number; pointsPerGame:number; priorPointsPerGame:number; priorMinutes:number; priorStarts:number; priorExpectedGoals:number; priorExpectedAssists:number; priorBonus:number; priorSaves:number; priorPenaltiesSaved:number; priorDefensiveContribution:number; totalPoints:number; eventPoints:number; selectedBy:number; priceChange:number;
  transfersIn:number; transfersOut:number; goals:number; assists:number; expectedGoals:number; expectedAssists:number;
  expectedGoalInvolvements:number; expectedGoalsConceded:number; cleanSheets:number; goalsConceded:number; minutes:number;
  starts:number; bonus:number; bps:number; ictIndex:number; influence:number; creativity:number; threat:number;saves:number;penaltiesSaved:number;defensiveContribution:number;clearancesBlocksInterceptions:number;recoveries:number;tackles:number;penaltiesOrder:number|null;directFreekicksOrder:number|null;cornersOrder:number|null;scoutRisks:string[];news:string; newsAdded:string|null;
};
export type FplFixture = { id:number; event:number|null; teamH:number; teamA:number; teamHDifficulty:number; teamADifficulty:number; finished:boolean; kickoff:string|null; started:boolean; teamHScore:number|null; teamAScore:number|null };
export type FplEvent = { id:number; name:string; deadline:string; current:boolean; next:boolean; finished:boolean };
export type PositionRule = { id:number; name:string; short:string; squad:number; minPlay:number; maxPlay:number };
export type FplData = { updatedAt:string; source:string; seasonStatsThrough:number; players:FplPlayer[]; fixtures:FplFixture[]; events:FplEvent[]; teams:{id:number;name:string;short:string}[]; rules:{budget:number;squadSize:number;teamLimit:number;positions:PositionRule[]}; dataIntegrityWarnings?:string[] };

const difficultyFactor:Record<number,number>={1:1.24,2:1.12,3:1,4:.88,5:.76};
export const availability=(player:FplPlayer)=>player.chance!==null?Math.max(0,player.chance/100):player.status==="a"?1:player.status==="d"?.72:.2;
export const futureEvents=(data:FplData,count=8)=>data.events.filter(event=>!event.finished&&new Date(event.deadline).getTime()>Date.now()-86400000).slice(0,count);

const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));

// Position-average per-90 goal/assist-involvement rates. Used as a shrinkage prior so a tiny
// prior-season minutes sample (e.g. a single late substitute appearance) regresses toward a
// plausible baseline instead of being extrapolated at face value into an unstable per-90 rate.
const baselineRates:Record<string,{xG90:number;xA90:number}>={GKP:{xG90:.001,xA90:.01},DEF:{xG90:.03,xA90:.05},MID:{xG90:.12,xA90:.10},FWD:{xG90:.22,xA90:.08}};
const SAMPLE_PRIOR_MINUTES=450; // ~5 full matches of pseudo-observations
const shrinkPer90=(total:number,minutes:number,baseline:number,prior=SAMPLE_PRIOR_MINUTES)=>{if(minutes<=0)return baseline;const rate=total/minutes*90;return (rate*minutes+baseline*prior)/(minutes+prior)};

// Same shrinkage principle, applied to every other "total / priorStarts" rate in this file
// (bonus, defensive contribution, saves, penalty saves). A player with 1-2 prior starts and one
// outlier match is otherwise treated as if that rate were their true per-match average.
const baselinePerStart:Record<string,{bonus:number;dc:number}>={GKP:{bonus:.15,dc:0},DEF:{bonus:.2,dc:6},MID:{bonus:.3,dc:4},FWD:{bonus:.35,dc:2}};
const SAMPLE_PRIOR_STARTS=5; // ~5 matches of pseudo-observations
const shrinkPerStart=(total:number,starts:number,baseline:number,prior=SAMPLE_PRIOR_STARTS)=>{if(starts<=0)return baseline;const rate=total/starts;return (rate*starts+baseline*prior)/(starts+prior)};

// Poisson model for defensive-contribution threshold points: P(actions >= threshold) * 2pts,
// rather than treating an average rate as guaranteed/linear credit toward the points award.
const logFactorial=(n:number)=>{let s=0;for(let i=2;i<=n;i++)s+=Math.log(i);return s};
const poissonAtLeast=(lambda:number,threshold:number)=>{if(lambda<=0)return 0;let cdf=0;for(let k=0;k<threshold;k++)cdf+=Math.exp(-lambda+k*Math.log(lambda)-logFactorial(k));return clamp(1-cdf,0,1)};

export type ProjectionMetrics={xPts:number;expectedMinutes:number;startProbability:number;sixtyProbability:number;rotationRisk:number;xG:number;xA:number;xG90:number;xA90:number;cleanSheetProbability:number;bonus:number;defensiveContribution:number;saves:number;penaltyRole:boolean;setPieceRole:boolean;confidence:number};
export function projectionMetrics(player:FplPlayer,eventId:number,fixtures:FplFixture[],firstEvent:number):ProjectionMetrics{
  const games=fixtures.filter(f=>f.event===eventId&&(f.teamH===player.teamId||f.teamA===player.teamId));
  const available=availability(player);const priorStartRate=player.priorStarts?clamp(player.priorStarts/38,.15,.98):clamp(.42+player.selectedBy/100,.35,.82);const roleRisk=player.scoutRisks?.length?Math.min(.18,player.scoutRisks.length*.05):0;const startProbability=clamp(priorStartRate*available-roleRisk,.03,.99);const minutesPerStart=player.priorStarts?clamp(player.priorMinutes/player.priorStarts,58,90):72;const expectedMinutes=clamp(startProbability*minutesPerStart+(1-startProbability)*12,4,90);const sixtyProbability=clamp(startProbability*(minutesPerStart>=72?.94:.72),.02,.98);const sampleWeight=clamp(player.minutes/900,0,.75);
  const baseline=baselineRates[player.positionShort]??baselineRates.MID;
  const priorXG90=shrinkPer90(player.priorExpectedGoals,player.priorMinutes,baseline.xG90);const priorXA90=shrinkPer90(player.priorExpectedAssists,player.priorMinutes,baseline.xA90);const currentXG90=player.minutes?shrinkPer90(player.expectedGoals,player.minutes,baseline.xG90):priorXG90;const currentXA90=player.minutes?shrinkPer90(player.expectedAssists,player.minutes,baseline.xA90):priorXA90;const xG90=priorXG90*(1-sampleWeight)+currentXG90*sampleWeight;const xA90=priorXA90*(1-sampleWeight)+currentXA90*sampleWeight;const penaltyRole=player.penaltiesOrder===1;const setPieceRole=player.directFreekicksOrder===1||player.cornersOrder===1;
  const startBaseline=baselinePerStart[player.positionShort]??baselinePerStart.MID;
  const priorDcPerStart=shrinkPerStart(player.priorDefensiveContribution,player.priorStarts,startBaseline.dc);const dcThreshold=player.positionShort==="DEF"?10:12;
  let totals={xPts:0,xG:0,xA:0,cleanSheetProbability:0,bonus:0,defensiveContribution:0,saves:0};
  for(const game of games){const home=game.teamH===player.teamId;const difficulty=home?game.teamHDifficulty:game.teamADifficulty;const attackFactor=(difficultyFactor[difficulty]??1)*(home?1.08:.95);const csBase:Record<number,number>={1:.52,2:.42,3:.31,4:.21,5:.13};const csProb=clamp((csBase[difficulty]??.3)*(home?1.05:.94),.07,.62);const appearance=(1-sixtyProbability)*startProbability+sixtyProbability*2;const roleBoost=(penaltyRole?.09:0)+(setPieceRole?.035:0);let expectedXG=Math.max(0,xG90*expectedMinutes/90*attackFactor+roleBoost*startProbability);let expectedXA=Math.max(0,xA90*expectedMinutes/90*attackFactor+(setPieceRole?.035:0)*startProbability);if(expectedXG+expectedXA<.08&&player.priorPointsPerGame>3.5){const fallback=(player.priorPointsPerGame-2)*.12*attackFactor;expectedXG+=fallback*(player.positionShort==="FWD"?.65:.4);expectedXA+=fallback*.3}const goalPoints=player.positionShort==="FWD"?4:player.positionShort==="MID"?5:6;const cleanSheetPoints=player.positionShort==="MID"?1:["GKP","DEF"].includes(player.positionShort)?4:0;const priorBonusPerStart=shrinkPerStart(player.priorBonus,player.priorStarts,startBaseline.bonus);const bonus=clamp(priorBonusPerStart*startProbability*attackFactor+(expectedXG+expectedXA)*.45,0,1.6);const dcLambda=priorDcPerStart*(expectedMinutes/90);const dc=["DEF","MID","FWD"].includes(player.positionShort)?poissonAtLeast(dcLambda,dcThreshold)*2:0;let savePoints=0,penaltySave=0,saves=0;if(player.positionShort==="GKP"){const priorSavesPerStart=shrinkPerStart(player.priorSaves,player.priorStarts,2.6);saves=priorSavesPerStart*(difficulty>=4?1.18:difficulty<=2?.85:1)*startProbability;savePoints=saves/3;const priorPenaltiesSavedPerStart=shrinkPerStart(player.priorPenaltiesSaved,player.priorStarts,.03);penaltySave=priorPenaltiesSavedPerStart*.22*5}const fixturePts=appearance+expectedXG*goalPoints+expectedXA*3+csProb*cleanSheetPoints*sixtyProbability+bonus+dc+savePoints+penaltySave;totals.xPts+=fixturePts;totals.xG+=expectedXG;totals.xA+=expectedXA;totals.cleanSheetProbability+=csProb;totals.bonus+=bonus;totals.defensiveContribution+=dc;totals.saves+=saves}
  const officialNext=eventId===firstEvent?player.epNext:0;const componentTotal=totals.xPts;const blended=officialNext>0?componentTotal*.82+officialNext*.18:componentTotal;const sampleConfidence=clamp(player.priorMinutes/1800,0,1);const confidence=clamp(sampleConfidence*.6+startProbability*.4,0,1);return{xPts:games.length?clamp(blended,0,16*Math.max(1,games.length))*clamp(.78+startProbability*.22,.78,1):0,expectedMinutes,startProbability,sixtyProbability,rotationRisk:1-startProbability,xG:totals.xG,xA:totals.xA,xG90,xA90,cleanSheetProbability:games.length?totals.cleanSheetProbability/games.length:0,bonus:totals.bonus,defensiveContribution:totals.defensiveContribution,saves:totals.saves,penaltyRole,setPieceRole,confidence};
}
export const playerProjection=(player:FplPlayer,eventId:number,fixtures:FplFixture[],firstEvent:number)=>projectionMetrics(player,eventId,fixtures,firstEvent).xPts;

export function bestXi(squad:FplPlayer[],eventId:number,fixtures:FplFixture[],firstEvent:number){
  const score=(p:FplPlayer)=>playerProjection(p,eventId,fixtures,firstEvent); let best:{players:FplPlayer[];total:number;captain:FplPlayer|null}={players:[],total:0,captain:null};
  const gk=squad.filter(p=>p.positionShort==="GKP").sort((a,b)=>score(b)-score(a));
  for(let def=3;def<=5;def++)for(let mid=2;mid<=5;mid++){const fwd=10-def-mid;if(fwd<1||fwd>3)continue;const xi=[gk[0],...squad.filter(p=>p.positionShort==="DEF").sort((a,b)=>score(b)-score(a)).slice(0,def),...squad.filter(p=>p.positionShort==="MID").sort((a,b)=>score(b)-score(a)).slice(0,mid),...squad.filter(p=>p.positionShort==="FWD").sort((a,b)=>score(b)-score(a)).slice(0,fwd)].filter(Boolean);if(xi.length!==11)continue;const captain=xi.sort((a,b)=>score(b)-score(a))[0];const total=xi.reduce((s,p)=>s+score(p),0)+score(captain);if(total>best.total)best={players:xi,total,captain};}
  return best;
}

export type IdentityConflict={id:number;issue:string};
// Startup/data-refresh integrity check: the same official FPL id must never resolve to two
// different teams or positions within one payload. Joins throughout this app are id-based
// (Map<id, ...>) by construction, but this guards against the upstream feed itself misbehaving.
export function findIdentityConflicts(players:FplPlayer[]):IdentityConflict[]{
  const seen=new Map<number,FplPlayer>();const conflicts:IdentityConflict[]=[];
  for(const p of players){
    const prior=seen.get(p.id);
    if(prior){
      if(prior.teamId!==p.teamId)conflicts.push({id:p.id,issue:`id ${p.id} maps to conflicting teams: ${prior.teamId} vs ${p.teamId}`});
      if(prior.positionId!==p.positionId)conflicts.push({id:p.id,issue:`id ${p.id} maps to conflicting positions: ${prior.positionId} vs ${p.positionId}`});
    } else seen.set(p.id,p);
  }
  return conflicts;
}

// The exact function the API route calls on every refresh -- kept here (not inlined in the route)
// so the production code path itself is directly unit-testable, not just findIdentityConflicts()
// in isolation. A refactor that silently drops this call would fail the route's own test.
export function attachIntegrityWarnings<T extends {players:FplPlayer[]}>(payload:T):T&{dataIntegrityWarnings:string[]}{
  const conflicts=findIdentityConflicts(payload.players);
  if(conflicts.length)console.error("FPL data integrity: conflicting player identities in upstream feed",conflicts);
  return {...payload,dataIntegrityWarnings:conflicts.map(c=>c.issue)};
}

export const eventTotals=(squad:FplPlayer[],eventIds:number[],fixtures:FplFixture[])=>eventIds.map(id=>bestXi(squad,id,fixtures,eventIds[0]).total);
export function isValidSquad(squad:FplPlayer[],data:FplData){if(squad.length!==data.rules.squadSize||squad.reduce((s,p)=>s+p.price,0)>data.rules.budget+.001||data.rules.positions.some(r=>squad.filter(p=>p.positionId===r.id).length!==r.squad))return false;const clubs=new Map<number,number>();squad.forEach(p=>clubs.set(p.teamId,(clubs.get(p.teamId)??0)+1));return [...clubs.values()].every(n=>n<=data.rules.teamLimit)}

export function optimizeSquad(data:FplData,eventIds:number[]){
  if(!eventIds.length)return[];const projectionCache=new Map<number,number>();const projection=(p:FplPlayer)=>{if(!projectionCache.has(p.id))projectionCache.set(p.id,eventIds.reduce((s,e)=>s+playerProjection(p,e,data.fixtures,eventIds[0]),0));return projectionCache.get(p.id)!};const eligible=data.players.filter(p=>p.status!=="u").sort((a,b)=>a.price-b.price||projection(b)-projection(a));const squad:FplPlayer[]=[];const clubs=new Map<number,number>();
  for(const rule of data.rules.positions)for(const player of eligible.filter(p=>p.positionId===rule.id)){if(squad.filter(p=>p.positionId===rule.id).length>=rule.squad)break;if((clubs.get(player.teamId)??0)>=data.rules.teamLimit)continue;squad.push(player);clubs.set(player.teamId,(clubs.get(player.teamId)??0)+1)}
  if(squad.length!==data.rules.squadSize)return[];let cost=squad.reduce((s,p)=>s+p.price,0);
  for(let iteration=0;iteration<100;iteration++){let best:{index:number;player:FplPlayer;gain:number}|null=null;squad.forEach((current,index)=>eligible.filter(candidate=>candidate.positionId===current.positionId&&!squad.some(p=>p.id===candidate.id)).forEach(candidate=>{const next=cost-current.price+candidate.price;if(next>data.rules.budget+.001||(candidate.teamId!==current.teamId&&(clubs.get(candidate.teamId)??0)>=data.rules.teamLimit))return;const gain=projection(candidate)-projection(current);if(gain>.001&&(!best||gain>best.gain))best={index,player:candidate,gain}}));if(!best)break;const move=best as {index:number;player:FplPlayer;gain:number};const old=squad[move.index];cost=cost-old.price+move.player.price;clubs.set(old.teamId,(clubs.get(old.teamId)??1)-1);clubs.set(move.player.teamId,(clubs.get(move.player.teamId)??0)+1);squad[move.index]=move.player}
  return squad.sort((a,b)=>a.positionId-b.positionId||projection(b)-projection(a));
}

export async function fetchFplData():Promise<FplData>{const response=await fetch(`/api/fpl?refresh=${Date.now()}`,{cache:"no-store"});const json=await response.json();if(!response.ok)throw new Error(json.error||"Could not load official FPL data");return json}
export const savedSquad=(data:FplData)=>{try{const ids=JSON.parse(localStorage.getItem("fpl-edge-squad")||"[]");return ids.map((id:number)=>data.players.find(p=>p.id===id)).filter(Boolean) as FplPlayer[]}catch{return[]}}
