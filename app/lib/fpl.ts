import type { TeamQualityProfile } from "./team-quality";

export type FplPlayer = {
  id:number; name:string; firstName:string; secondName:string; teamId:number; teamName:string; teamShort:string;
  positionId:number; position:string; positionShort:string; price:number; status:string; chance:number|null;
  epNext:number; form:number; pointsPerGame:number; priorPointsPerGame:number; priorMinutes:number; priorStarts:number; priorExpectedGoals:number; priorExpectedAssists:number; priorBonus:number; priorSaves:number; priorPenaltiesSaved:number; priorDefensiveContribution:number; totalPoints:number; eventPoints:number; eventMinutes:number; eventBonus:number; eventDefensiveContribution:number; selectedBy:number; priceChange:number; priceProjectionToday:number;
  transfersIn:number; transfersOut:number; goals:number; assists:number; expectedGoals:number; expectedAssists:number;
  expectedGoalInvolvements:number; expectedGoalsConceded:number; cleanSheets:number; goalsConceded:number; minutes:number;
  starts:number; bonus:number; bps:number; ictIndex:number; influence:number; creativity:number; threat:number;saves:number;penaltiesSaved:number;defensiveContribution:number;clearancesBlocksInterceptions:number;recoveries:number;tackles:number;penaltiesOrder:number|null;directFreekicksOrder:number|null;cornersOrder:number|null;scoutRisks:string[];news:string; newsAdded:string|null;
  priorSource?:"official-pl-history"|"position-baseline";priorSeason?:string|null;priorCompetition?:string|null;
  calibrationGroup?:PlayerCalibrationGroup;teamPlPriorCoverage?:number;lowPlContinuityClub?:boolean;
  teamMatchesPlayed?:number;teamStrengthHome?:number;teamStrengthAway?:number;teamAttackHome?:number|null;teamAttackAway?:number|null;teamDefenceHome?:number|null;teamDefenceAway?:number|null;
  teamQualityAttackHome?:number;teamQualityAttackAway?:number;teamQualityDefenceHome?:number;teamQualityDefenceAway?:number;teamQualityConfidence?:number;
};
export type FplFixture = { id:number; event:number|null; teamH:number; teamA:number; teamHDifficulty:number; teamADifficulty:number; finished:boolean; kickoff:string|null; started:boolean; teamHScore:number|null; teamAScore:number|null;teamHAttackQuality?:number;teamHDefenceQuality?:number;teamAAttackQuality?:number;teamADefenceQuality?:number };
export type FplEvent = { id:number; name:string; deadline:string; current:boolean; next:boolean; finished:boolean; dataChecked:boolean; averageEntryScore?:number|null };
export type PositionRule = { id:number; name:string; short:string; squad:number; minPlay:number; maxPlay:number };
export type FplData = { updatedAt:string; source:string; seasonStatsThrough:number; players:FplPlayer[]; fixtures:FplFixture[]; events:FplEvent[]; teams:{id:number;name:string;short:string;strengthHome?:number;strengthAway?:number;attackHome?:number|null;attackAway?:number|null;defenceHome?:number|null;defenceAway?:number|null;plPriorCoverage?:number;lowPlContinuity?:boolean;quality?:TeamQualityProfile}[]; rules:{budget:number;squadSize:number;teamLimit:number;positions:PositionRule[]}; dataIntegrityWarnings?:string[] };

// Bump whenever projection or ranking semantics change. Deadline receipts persist this value so
// later accuracy reports never compare outcomes from different model generations as one system.
export const PROJECTION_MODEL_VERSION="fpl-edge-2026.08.23-r6";

const difficultyFactor:Record<number,number>={1:1.24,2:1.12,3:1,4:.88,5:.76};
export const availability=(player:FplPlayer)=>player.chance!==null?Math.max(0,player.chance/100):player.status==="a"?1:player.status==="d"?.72:.2;
// No grace window past an event's own deadline: once locked, there's nothing left to plan for it,
// regardless of whether its matches have finished being played. That's a separate "results"
// concept (official post-event history), not this function's job.
export const futureEvents=(data:FplData,count=8)=>data.events.filter(event=>!event.finished&&new Date(event.deadline).getTime()>Date.now()).slice(0,count);

export type DisplayedGameweekAverage={value:number;provisional:boolean};

/** Selects only the official average attached to the gameweek currently displayed by the Team page. */
export function displayedGameweekAverage(events:readonly FplEvent[],eventId:number):DisplayedGameweekAverage|null{
  const event=events.find(candidate=>candidate.id===eventId);
  if(!event)return null;
  const value=event.averageEntryScore;
  if(typeof value!=="number"||!Number.isFinite(value))return null;
  return{value,provisional:event.current&&!event.finished};
}

const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));

// The hard role-security floor a player must clear before a projection can anchor an actionable
// transfer recommendation, single-move or multi-week route. Single source for CoachApp.tsx's
// evaluateTransferQuality() and transfer-routes.ts's eligibleAt() -- both consume this object
// directly rather than each keeping their own copy of the same three numbers, so tuning one can't
// silently leave the other behind (found duplicated independently during retroactive review).
export const ROLE_SECURITY_FLOOR={startProbability:.55,expectedMinutes:45,confidence:.35} as const;

export type PlayerCalibrationGroup="established-pl"|"limited-pl"|"no-pl-prior"|"current-pl-established";
export type PlayerCalibrationProfile={group:PlayerCalibrationGroup;label:string;hasPremierLeaguePrior:boolean;lowPlContinuityClub:boolean;priorShrinkageMinutes:number;currentLearningMinutes:number;currentWeightCap:number;confidenceCap:number;rolePriorMatches:number};
export const LOW_PL_CONTINUITY_THRESHOLD=.35;
// Each roster place contributes at most 1,800 prior PL minutes. This measures how much genuine
// top-flight evidence exists across a current club without guessing promotion status from names.
export function plRosterContinuity(priorMinutes:number[]):number{return priorMinutes.length?clamp(priorMinutes.reduce((sum,minutes)=>sum+Math.min(1800,Math.max(0,minutes)),0)/(priorMinutes.length*1800),0,1):0}
export const isLowPlContinuity=(coverage:number)=>coverage<LOW_PL_CONTINUITY_THRESHOLD;

// Gates season-stat accumulation on the specific fixture(s) a player's live stat line came from
// (via explain[].fixture), not on FPL's event-level finished/data_checked admin flags -- those are
// whole-gameweek sign-off markers that can lag real match completion by days, while the actual
// protection this gate exists for ("never learn from a match still being played") is already fully
// satisfied once that player's own fixture is finished. fixture.finished (distinct from
// finished_provisional, which this app does not fetch) is FPL's own signal that a match's bonus
// points have been calculated, not merely that full time was reached -- so bonus is accumulated
// through this same per-fixture gate with no separate carve-out; the residual risk of a rare, small,
// late correction between finished and data_checked is accepted rather than built around.
export function accumulateLiveStats(fixtures:{id:number;finished:boolean}[],liveEventPayloads:{eventId:number;payload:{elements:{id:number;stats:Record<string,unknown>;explain?:{fixture:number}[]}[]}}[],aggregateFields:string[]):{seasonStats:Map<number,Record<string,number>&{appearances:number}>;latestEventStats:Map<number,Record<string,unknown>&{eventId:number}>}{
  const number=(value:unknown)=>Number(value)||0;
  const fixturesById=new Map(fixtures.map(fixture=>[fixture.id,fixture]));
  const seasonStats=new Map<number,Record<string,number>&{appearances:number}>();
  const latestEventStats=new Map<number,Record<string,unknown>&{eventId:number}>();
  for(const{eventId,payload}of liveEventPayloads)for(const element of payload.elements){
    const latest=latestEventStats.get(element.id);
    if(!latest||eventId>=latest.eventId)latestEventStats.set(element.id,{eventId,...element.stats});
    const playerFixtures=(element.explain??[]).map(entry=>entry.fixture);
    const allFixturesFinished=playerFixtures.every(fixtureId=>fixturesById.get(fixtureId)?.finished);
    if(allFixturesFinished){
      const aggregate=seasonStats.get(element.id)??{appearances:0};
      for(const field of aggregateFields)aggregate[field]=number(aggregate[field])+number(element.stats?.[field]);
      if(number(element.stats?.minutes)>0)aggregate.appearances+=1;
      seasonStats.set(element.id,aggregate);
    }
  }
  return{seasonStats,latestEventStats};
}

// "Through GW N" is a whole-gameweek floor guarantee for the summary line shown across the app --
// distinct from accumulateLiveStats above, which credits a player's own fixture the moment it
// finishes, even before the rest of that gameweek's fixtures (or FPL's admin sign-off) catch up.
export function seasonStatsThroughEvent(events:{id:number}[],fixtures:{event:number|null;finished:boolean}[]):number{
  const fullyCompleted=events.filter(event=>{
    const eventFixtures=fixtures.filter(fixture=>fixture.event===event.id);
    return eventFixtures.length>0&&eventFixtures.every(fixture=>fixture.finished);
  }).map(event=>event.id);
  return fullyCompleted.length?Math.max(...fullyCompleted):0;
}

export function playerCalibrationProfile(player:FplPlayer):PlayerCalibrationProfile{
  const hasPremierLeaguePrior=(player.priorSource==="official-pl-history"||player.priorSource===undefined)&&player.priorMinutes>0;
  const lowPlContinuityClub=player.lowPlContinuityClub===true;
  let group:PlayerCalibrationGroup,label:string,priorShrinkageMinutes:number,currentLearningMinutes:number,currentWeightCap:number,confidenceCap:number,rolePriorMatches:number;
  if(hasPremierLeaguePrior&&player.priorMinutes>=900){group="established-pl";label="Established PL prior";priorShrinkageMinutes=450;currentLearningMinutes=900;currentWeightCap=.75;confidenceCap=1;rolePriorMatches=8}
  else if(hasPremierLeaguePrior){group="limited-pl";label="Limited PL prior";priorShrinkageMinutes=900;currentLearningMinutes=1200;currentWeightCap=.68;confidenceCap=.72;rolePriorMatches=3}
  else if(player.minutes>=900){group="current-pl-established";label="Established this PL season";priorShrinkageMinutes=1350;currentLearningMinutes=1350;currentWeightCap=.82;confidenceCap=.82;rolePriorMatches=2}
  else{group="no-pl-prior";label="No genuine PL prior";priorShrinkageMinutes=1350;currentLearningMinutes=1350;currentWeightCap=.58;confidenceCap=.58;rolePriorMatches=3}
  if(lowPlContinuityClub)confidenceCap=Math.max(.35,confidenceCap-.08);
  return{group,label,hasPremierLeaguePrior,lowPlContinuityClub,priorShrinkageMinutes,currentLearningMinutes,currentWeightCap,confidenceCap,rolePriorMatches};
}

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
const ownAttackFactor:Record<number,number>={1:.78,2:.88,3:1,4:1.08,5:1.16};
const ownDefenceFactor:Record<number,number>={1:.72,2:.85,3:1,4:1.12,5:1.24};

// Poisson model for defensive-contribution threshold points: P(actions >= threshold) * 2pts,
// rather than treating an average rate as guaranteed/linear credit toward the points award.
const logFactorial=(n:number)=>{let s=0;for(let i=2;i<=n;i++)s+=Math.log(i);return s};
const poissonAtLeast=(lambda:number,threshold:number)=>{if(lambda<=0)return 0;let cdf=0;for(let k=0;k<threshold;k++)cdf+=Math.exp(-lambda+k*Math.log(lambda)-logFactorial(k));return clamp(1-cdf,0,1)};

export type ProjectionMetrics={xPts:number;expectedMinutes:number;startProbability:number;sixtyProbability:number;rotationRisk:number;xG:number;xA:number;xG90:number;xA90:number;cleanSheetProbability:number;bonus:number;defensiveContribution:number;saves:number;penaltySavePoints?:number;penaltyRole:boolean;setPieceRole:boolean;confidence:number;calibrationGroup?:PlayerCalibrationGroup;confidenceCap?:number;currentEvidenceWeight?:number;teamAttackFactor?:number;opponentDefenceFactor?:number;teamDefenceFactor?:number;opponentAttackFactor?:number;fixtureAttackMultiplier?:number;fixtureDefenceMultiplier?:number;fixtureCount?:number};
function projectionMetricsBase(player:FplPlayer,eventId:number,fixtures:FplFixture[],firstEvent:number):ProjectionMetrics{
  const games=fixtures.filter(f=>f.event===eventId&&(f.teamH===player.teamId||f.teamA===player.teamId));
  const available=availability(player);
  // Older persisted/test fixtures predate explicit provenance and already represent real PL priors;
  // production API payloads always set priorSource, so a promoted/new player can never enter this
  // branch merely because a current-season bootstrap total happens to be non-zero.
  const calibration=playerCalibrationProfile(player),hasPremierLeaguePrior=calibration.hasPremierLeaguePrior;
  const roleBaseline=clamp(.42+player.selectedBy/100,.35,.82);
  const historicalStartRate=hasPremierLeaguePrior?clamp(player.priorStarts/38,.08,.98):roleBaseline;
  const completedMatches=Math.max(0,player.teamMatchesPlayed??player.starts);
  const rolePriorMatches=calibration.rolePriorMatches;
  const observedStarts=Math.min(player.starts,completedMatches);
  const blendedStartRate=(historicalStartRate*rolePriorMatches+observedStarts)/Math.max(1,rolePriorMatches+completedMatches);
  const roleRisk=player.scoutRisks?.length?Math.min(.18,player.scoutRisks.length*.05):0;
  const startProbability=clamp(blendedStartRate*available-roleRisk,.03,.99);
  const historicalMinutesPerStart=hasPremierLeaguePrior&&player.priorStarts?clamp(player.priorMinutes/player.priorStarts,58,90):72;
  const currentMinutesPerStart=player.starts?clamp(player.minutes/player.starts,58,90):historicalMinutesPerStart;
  const currentSampleWeight=clamp(player.minutes/(player.minutes+calibration.currentLearningMinutes),0,calibration.currentWeightCap);
  const minutesPerStart=historicalMinutesPerStart*(1-currentSampleWeight)+currentMinutesPerStart*currentSampleWeight;
  const expectedMinutes=clamp(startProbability*minutesPerStart+(1-startProbability)*12,4,90);
  const sixtyProbability=clamp(startProbability*(minutesPerStart>=72?.94:.72),.02,.98);
  const baseline=baselineRates[player.positionShort]??baselineRates.MID;
  const priorXG90=hasPremierLeaguePrior?shrinkPer90(player.priorExpectedGoals,player.priorMinutes,baseline.xG90,calibration.priorShrinkageMinutes):baseline.xG90;
  const priorXA90=hasPremierLeaguePrior?shrinkPer90(player.priorExpectedAssists,player.priorMinutes,baseline.xA90,calibration.priorShrinkageMinutes):baseline.xA90;
  const currentXG90=player.minutes?shrinkPer90(player.expectedGoals,player.minutes,baseline.xG90,calibration.currentLearningMinutes):baseline.xG90;
  const currentXA90=player.minutes?shrinkPer90(player.expectedAssists,player.minutes,baseline.xA90,calibration.currentLearningMinutes):baseline.xA90;
  const xG90=priorXG90*(1-currentSampleWeight)+currentXG90*currentSampleWeight;
  const xA90=priorXA90*(1-currentSampleWeight)+currentXA90*currentSampleWeight;
  const penaltyRole=player.penaltiesOrder===1;const setPieceRole=player.directFreekicksOrder===1||player.cornersOrder===1;
  const startBaseline=baselinePerStart[player.positionShort]??baselinePerStart.MID;
  const priorDcPerStart=hasPremierLeaguePrior?shrinkPerStart(player.priorDefensiveContribution,player.priorStarts,startBaseline.dc):startBaseline.dc;
  const currentDcPerStart=player.starts?shrinkPerStart(player.defensiveContribution,player.starts,startBaseline.dc,8):startBaseline.dc;
  const dcPerStart=priorDcPerStart*(1-currentSampleWeight)+currentDcPerStart*currentSampleWeight;
  const priorBonusPerStart=hasPremierLeaguePrior?shrinkPerStart(player.priorBonus,player.priorStarts,startBaseline.bonus):startBaseline.bonus;
  const currentBonusPerStart=player.starts?shrinkPerStart(player.bonus,player.starts,startBaseline.bonus,8):startBaseline.bonus;
  const bonusPerStart=priorBonusPerStart*(1-currentSampleWeight)+currentBonusPerStart*currentSampleWeight;
  const dcThreshold=player.positionShort==="DEF"?10:12;
  let totals={xPts:0,xG:0,xA:0,cleanSheetProbability:0,bonus:0,defensiveContribution:0,saves:0,penaltySavePoints:0};
  for(const game of games){const home=game.teamH===player.teamId;const difficulty=home?game.teamHDifficulty:game.teamADifficulty;const attackFactor=home?1.08:.95;const csProb=clamp(.31*(home?1.05:.94),.05,.68);const appearance=(1-sixtyProbability)*startProbability+sixtyProbability*2;const roleBoost=(penaltyRole?.09:0)+(setPieceRole?.035:0);const expectedXG=Math.max(0,xG90*expectedMinutes/90*attackFactor+roleBoost*startProbability);const expectedXA=Math.max(0,xA90*expectedMinutes/90*attackFactor+(setPieceRole?.035:0)*startProbability);const goalPoints=player.positionShort==="FWD"?4:player.positionShort==="MID"?5:6;const cleanSheetPoints=player.positionShort==="MID"?1:["GKP","DEF"].includes(player.positionShort)?4:0;const bonus=clamp(bonusPerStart*startProbability*attackFactor+(expectedXG+expectedXA)*.45,0,1.6);const dcLambda=dcPerStart*(expectedMinutes/90);const dc=["DEF","MID","FWD"].includes(player.positionShort)?poissonAtLeast(dcLambda,dcThreshold)*2:0;let savePoints=0,penaltySave=0,saves=0;if(player.positionShort==="GKP"){const priorSavesPerStart=hasPremierLeaguePrior?shrinkPerStart(player.priorSaves,player.priorStarts,2.6):2.6;const currentSavesPerStart=player.starts?shrinkPerStart(player.saves,player.starts,2.6,8):2.6;const savesPerStart=priorSavesPerStart*(1-currentSampleWeight)+currentSavesPerStart*currentSampleWeight;saves=savesPerStart*(difficulty>=4?1.18:difficulty<=2?.85:1)*startProbability;savePoints=saves/3;const priorPenaltiesSavedPerStart=hasPremierLeaguePrior?shrinkPerStart(player.priorPenaltiesSaved,player.priorStarts,.03):.03;penaltySave=priorPenaltiesSavedPerStart*.22*5}const fixturePts=appearance+expectedXG*goalPoints+expectedXA*3+csProb*cleanSheetPoints*sixtyProbability+bonus+dc+savePoints+penaltySave;totals.xPts+=fixturePts;totals.xG+=expectedXG;totals.xA+=expectedXA;totals.cleanSheetProbability+=csProb;totals.bonus+=bonus;totals.defensiveContribution+=dc;totals.saves+=saves;totals.penaltySavePoints+=penaltySave}
  const officialNext=eventId===firstEvent?player.epNext:0;const componentTotal=totals.xPts;const blended=officialNext>0?componentTotal*.82+officialNext*.18:componentTotal;const historicalConfidence=hasPremierLeaguePrior?clamp(player.priorMinutes/1800,0,1):0;const currentConfidence=clamp(player.minutes/900,0,1);const confidence=clamp(historicalConfidence*.5+currentConfidence*.25+startProbability*.25,.05,calibration.confidenceCap);return{xPts:games.length?clamp(blended,0,16*Math.max(1,games.length)):0,expectedMinutes,startProbability,sixtyProbability,rotationRisk:1-startProbability,xG:totals.xG,xA:totals.xA,xG90,xA90,cleanSheetProbability:games.length?totals.cleanSheetProbability/games.length:0,bonus:totals.bonus,defensiveContribution:totals.defensiveContribution,saves:totals.saves,penaltySavePoints:totals.penaltySavePoints,penaltyRole,setPieceRole,confidence,calibrationGroup:calibration.group,confidenceCap:calibration.confidenceCap,currentEvidenceWeight:currentSampleWeight,fixtureCount:games.length};
}
// Applies the normalized team-quality layer to the stable player/minutes model above. Ratings are
// league-relative multipliers where 1.00 is average and higher defence means stronger defence.
// FDR remains a small residual in the base model; direct own-team and opponent quality now carry
// the explicit attack/defence signal that raw 1,000+ official strength values previously lost.
export function projectionMetrics(player:FplPlayer,eventId:number,fixtures:FplFixture[],firstEvent:number):ProjectionMetrics{
  const base=projectionMetricsBase(player,eventId,fixtures,firstEvent);
  const games=fixtures.filter(fixture=>fixture.event===eventId&&(fixture.teamH===player.teamId||fixture.teamA===player.teamId));
  if(!games.length)return{...base,teamAttackFactor:1,opponentDefenceFactor:1,teamDefenceFactor:1,opponentAttackFactor:1,fixtureAttackMultiplier:1,fixtureDefenceMultiplier:1};
  const legacyFactor=(value:number|null|undefined,table:Record<number,number>)=>value!==null&&value!==undefined&&value>=1&&value<=5?(table[Math.round(value)]??1):1;
  const contexts=games.map(game=>{
    const home=game.teamH===player.teamId,difficulty=home?game.teamHDifficulty:game.teamADifficulty;
    const teamAttack=home?(player.teamQualityAttackHome??legacyFactor(player.teamAttackHome??player.teamStrengthHome,ownAttackFactor)):(player.teamQualityAttackAway??legacyFactor(player.teamAttackAway??player.teamStrengthAway,ownAttackFactor));
    const teamDefence=home?(player.teamQualityDefenceHome??legacyFactor(player.teamDefenceHome??player.teamStrengthHome,ownDefenceFactor)):(player.teamQualityDefenceAway??legacyFactor(player.teamDefenceAway??player.teamStrengthAway,ownDefenceFactor));
    const opponentDefence=home?(game.teamADefenceQuality??1):(game.teamHDefenceQuality??1);
    const opponentAttack=home?(game.teamAAttackQuality??1):(game.teamHAttackQuality??1);
    const fdrResidual=Math.pow(difficultyFactor[difficulty]??1,.3);
    const attackMultiplier=clamp(teamAttack/Math.max(.6,opponentDefence)*fdrResidual,.7,1.4);
    const defenceMultiplier=clamp(teamDefence/Math.max(.6,opponentAttack),.7,1.4);
    const expectedGoalsAgainst=1.42*(home?.88:1.12)/defenceMultiplier/Math.max(.78,fdrResidual);
    const cleanSheetProbability=clamp(Math.exp(-expectedGoalsAgainst),.05,.68);
    return{teamAttack,teamDefence,opponentDefence,opponentAttack,attackMultiplier,defenceMultiplier,cleanSheetProbability};
  });
  const avg=(pick:(context:typeof contexts[number])=>number)=>contexts.reduce((sum,context)=>sum+pick(context),0)/contexts.length;
  const fixtureAttackMultiplier=avg(context=>context.attackMultiplier),fixtureDefenceMultiplier=avg(context=>context.defenceMultiplier);
  const xG=base.xG*fixtureAttackMultiplier,xA=base.xA*fixtureAttackMultiplier;
  const cleanSheetProbability=avg(context=>context.cleanSheetProbability);
  const goalPoints=player.positionShort==="FWD"?4:player.positionShort==="MID"?5:6;
  const cleanSheetPoints=player.positionShort==="MID"?1:["GKP","DEF"].includes(player.positionShort)?4:0;
  const oldScoring=base.xG*goalPoints+base.xA*3+base.cleanSheetProbability*games.length*cleanSheetPoints*base.sixtyProbability+base.bonus;
  const bonus=clamp(base.bonus*(.85+.15*fixtureAttackMultiplier)+Math.max(-.5,Math.min(.5,(xG+xA)-(base.xG+base.xA)))*.2,0,1.6*games.length);
  const newScoring=xG*goalPoints+xA*3+cleanSheetProbability*games.length*cleanSheetPoints*base.sixtyProbability+bonus;
  const componentWeight=eventId===firstEvent&&player.epNext>0 ? .82 : 1;
  const xPts=clamp(base.xPts+(newScoring-oldScoring)*componentWeight,0,16*Math.max(1,games.length));
  return{...base,xPts,xG,xA,cleanSheetProbability,bonus,teamAttackFactor:avg(context=>context.teamAttack),opponentDefenceFactor:avg(context=>context.opponentDefence),teamDefenceFactor:avg(context=>context.teamDefence),opponentAttackFactor:avg(context=>context.opponentAttack),fixtureAttackMultiplier,fixtureDefenceMultiplier};
}
export const playerProjection=(player:FplPlayer,eventId:number,fixtures:FplFixture[],firstEvent:number)=>projectionMetrics(player,eventId,fixtures,firstEvent).xPts;

export type LiveMover={player:FplPlayer;countedActual:number;countedProjected:number;delta:number};

// "Currently hurting/helping rank" is scoped to players who actually count toward the live total
// right now (pass the effective XI, or XI+bench when Bench Boost is active -- whatever the caller's
// own liveTotal computation already treats as counted) and whose gameweek fixture has genuinely
// started; a not-yet-kicked-off player's delta would just be "0 minus a real projection", which
// isn't a live signal, it's every unplayed player misreported as hurting. No magnitude threshold is
// applied to the classification itself -- these are simply the top 3 counted players by |delta| in
// each direction, the same "no invented significance threshold" principle already used for
// rank-estimate-core.ts's arrow-chance frequencies.
export function liveScoringMovers(counted:FplPlayer[],captainId:number|null,captainMultiplier:number,eventId:number,fixtures:FplFixture[],projectionAnchorEvent:number):{hurting:readonly LiveMover[];helping:readonly LiveMover[]}{
  const started=counted.filter(p=>fixtures.some(f=>f.event===eventId&&(f.teamH===p.teamId||f.teamA===p.teamId)&&f.started));
  const movers=started.map(p=>{
    const multiplier=p.id===captainId?captainMultiplier:1;
    const countedActual=p.eventPoints*multiplier;
    const countedProjected=playerProjection(p,eventId,fixtures,projectionAnchorEvent)*multiplier;
    return{player:p,countedActual,countedProjected,delta:countedActual-countedProjected};
  });
  const helping=[...movers].filter(m=>m.delta>0).sort((a,b)=>b.delta-a.delta).slice(0,3);
  const hurting=[...movers].filter(m=>m.delta<0).sort((a,b)=>a.delta-b.delta).slice(0,3);
  return{hurting,helping};
}

// Moved from CoachApp.tsx so Pitch.tsx (used by both CoachApp.tsx's Final Check and
// LiveDraftBuilder.tsx's Draft Lab result view) can depend on them without a circular import --
// CoachApp.tsx already imports LiveDraftBuilder, so LiveDraftBuilder importing anything back from
// CoachApp.tsx would cycle. Pure functions, no component dependency, belong here with
// playerProjection/projectionMetrics rather than in a UI file.
export function opponent(player:FplPlayer,eventId:number,data:FplData){const games=data.fixtures.filter(f=>f.event===eventId&&(f.teamH===player.teamId||f.teamA===player.teamId));if(!games.length)return"BLANK";return games.map(fixture=>{const home=fixture.teamH===player.teamId;const id=home?fixture.teamA:fixture.teamH;return`${data.teams.find(t=>t.id===id)?.short??"—"} ${home?"H":"A"}`}).join(", ")}
export function startPct(p:FplPlayer,event:number,data:FplData){return Math.round(projectionMetrics(p,event,data.fixtures,event).startProbability*100)}

export function bestXi(squad:FplPlayer[],eventId:number,fixtures:FplFixture[],firstEvent:number){
  const score=(p:FplPlayer)=>playerProjection(p,eventId,fixtures,firstEvent); let best:{players:FplPlayer[];total:number;captain:FplPlayer|null}={players:[],total:0,captain:null};
  const gk=squad.filter(p=>p.positionShort==="GKP").sort((a,b)=>score(b)-score(a));
  for(let def=3;def<=5;def++)for(let mid=2;mid<=5;mid++){const fwd=10-def-mid;if(fwd<1||fwd>3)continue;const xi=[gk[0],...squad.filter(p=>p.positionShort==="DEF").sort((a,b)=>score(b)-score(a)).slice(0,def),...squad.filter(p=>p.positionShort==="MID").sort((a,b)=>score(b)-score(a)).slice(0,mid),...squad.filter(p=>p.positionShort==="FWD").sort((a,b)=>score(b)-score(a)).slice(0,fwd)].filter(Boolean);if(xi.length!==11)continue;const captain=xi.sort((a,b)=>score(b)-score(a))[0];const total=xi.reduce((s,p)=>s+score(p),0)+score(captain);if(total>best.total)best={players:xi,total,captain};}
  return best;
}

export type AutosubSwap={outId:number;outName:string;inId:number;inName:string};
export type AutosubResult={effectiveXi:FplPlayer[];swaps:AutosubSwap[];unfilled:FplPlayer[];effectiveCaptainId:number|null;armbandPassedToVice:boolean;doubleLost:boolean};

// Same DEF 3-5 / MID 2-5 / FWD 1-3 bounds bestXi uses above -- a legal FPL formation, GK fixed at 1.
const formationLegal=(players:FplPlayer[])=>{const def=players.filter(p=>p.positionShort==="DEF").length,mid=players.filter(p=>p.positionShort==="MID").length,fwd=players.filter(p=>p.positionShort==="FWD").length;return def>=3&&def<=5&&mid>=2&&mid<=5&&fwd>=1&&fwd<=3};

// Real FPL autosub rules, applied to a single gameweek's actual eventMinutes (only meaningful once
// that gameweek has kicked off -- callers should not invoke this before then). GK: 0-minute starting
// keeper is replaced by the bench keeper only if the bench keeper actually played. Outfield: bench
// players 2-4 are tried in bench order; each is swapped in for the first 0-minute outfield starter
// where the resulting formation stays legal (>=3 DEF, >=2 MID, >=1 FWD) -- if no 0-minute starter
// can legally take that bench player, they're skipped and the next bench player is tried, matching
// how the official game actually resolves bench priority. Captain armband: if the captain recorded
// 0 minutes, the double passes to the vice-captain; if the vice also recorded 0 minutes, no one
// gets the double that week (doubleLost=true) -- this is independent of whether the captain's own
// XI slot could be filled by a substitute.
export function simulateAutosubs(xi:FplPlayer[],bench:FplPlayer[],captainId:number,viceId:number):AutosubResult{
  let effective=[...xi];
  const swaps:AutosubSwap[]=[];
  const usedBenchIds=new Set<number>();

  const gkStarter=effective.find(p=>p.positionShort==="GKP");
  const benchGk=bench.find(p=>p.positionShort==="GKP"&&p.eventMinutes>0);
  if(gkStarter&&gkStarter.eventMinutes===0&&benchGk){
    effective=effective.map(p=>p.id===gkStarter.id?benchGk:p);
    swaps.push({outId:gkStarter.id,outName:gkStarter.name,inId:benchGk.id,inName:benchGk.name});
    usedBenchIds.add(benchGk.id);
  }

  const benchOutfield=bench.filter(p=>p.positionShort!=="GKP"&&!usedBenchIds.has(p.id));
  for(const benchPlayer of benchOutfield){
    if(benchPlayer.eventMinutes===0)continue;
    const zeroMinuteStarters=effective.filter(p=>p.positionShort!=="GKP"&&p.eventMinutes===0);
    for(const candidate of zeroMinuteStarters){
      const attempt=effective.map(p=>p.id===candidate.id?benchPlayer:p);
      if(formationLegal(attempt)){
        effective=attempt;
        swaps.push({outId:candidate.id,outName:candidate.name,inId:benchPlayer.id,inName:benchPlayer.name});
        usedBenchIds.add(benchPlayer.id);
        break;
      }
    }
  }

  const unfilled=effective.filter(p=>p.eventMinutes===0);

  const captainMinutes=xi.find(p=>p.id===captainId)?.eventMinutes??0;
  const viceMinutes=xi.find(p=>p.id===viceId)?.eventMinutes??0;
  let effectiveCaptainId:number|null=captainId,armbandPassedToVice=false,doubleLost=false;
  if(captainMinutes===0){
    if(viceMinutes>0){effectiveCaptainId=viceId;armbandPassedToVice=true}
    else{effectiveCaptainId=null;doubleLost=true}
  }

  return{effectiveXi:effective,swaps,unfilled,effectiveCaptainId,armbandPassedToVice,doubleLost};
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
// Same structural checks as isValidSquad (size, position quotas, club limit) but without the total
// cost <= budget check. isValidSquad's budget check is correct for a squad being actively CONSTRUCTED
// against a fixed £100m budget (manual add(), the optimizer's search candidates) -- but a real
// manager's already-assembled squad legitimately has a CURRENT market value that can exceed the
// original budget as player prices rise over the season (extremely common, not a bug in their squad).
// Gating "do we have a usable saved/connected squad" on the strict budget check meant any manager
// whose squad had appreciated even slightly above £100.0m saw every page silently fall back to the
// "connect your team" screen forever, with no error and no explanation -- found via a live connected
// account (real squad cost £100.1m vs the £100.0m budget) reported as "not working".
export function isCompleteSquad(squad:FplPlayer[],data:FplData){if(squad.length!==data.rules.squadSize||data.rules.positions.some(r=>squad.filter(p=>p.positionId===r.id).length!==r.squad))return false;const clubs=new Map<number,number>();squad.forEach(p=>clubs.set(p.teamId,(clubs.get(p.teamId)??0)+1));return [...clubs.values()].every(n=>n<=data.rules.teamLimit)}

export function optimizeSquad(data:FplData,eventIds:number[]){
  if(!eventIds.length)return[];const projectionCache=new Map<number,number>();const projection=(p:FplPlayer)=>{if(!projectionCache.has(p.id))projectionCache.set(p.id,eventIds.reduce((s,e)=>s+playerProjection(p,e,data.fixtures,eventIds[0]),0));return projectionCache.get(p.id)!};const eligible=data.players.filter(p=>p.status!=="u").sort((a,b)=>a.price-b.price||projection(b)-projection(a));const squad:FplPlayer[]=[];const clubs=new Map<number,number>();
  for(const rule of data.rules.positions)for(const player of eligible.filter(p=>p.positionId===rule.id)){if(squad.filter(p=>p.positionId===rule.id).length>=rule.squad)break;if((clubs.get(player.teamId)??0)>=data.rules.teamLimit)continue;squad.push(player);clubs.set(player.teamId,(clubs.get(player.teamId)??0)+1)}
  if(squad.length!==data.rules.squadSize)return[];let cost=squad.reduce((s,p)=>s+p.price,0);
  for(let iteration=0;iteration<100;iteration++){let best:{index:number;player:FplPlayer;gain:number}|null=null;squad.forEach((current,index)=>eligible.filter(candidate=>candidate.positionId===current.positionId&&!squad.some(p=>p.id===candidate.id)).forEach(candidate=>{const next=cost-current.price+candidate.price;if(next>data.rules.budget+.001||(candidate.teamId!==current.teamId&&(clubs.get(candidate.teamId)??0)>=data.rules.teamLimit))return;const gain=projection(candidate)-projection(current);if(gain>.001&&(!best||gain>best.gain))best={index,player:candidate,gain}}));if(!best)break;const move=best as {index:number;player:FplPlayer;gain:number};const old=squad[move.index];cost=cost-old.price+move.player.price;clubs.set(old.teamId,(clubs.get(old.teamId)??1)-1);clubs.set(move.player.teamId,(clubs.get(move.player.teamId)??0)+1);squad[move.index]=move.player}
  return squad.sort((a,b)=>a.positionId-b.positionId||projection(b)-projection(a));
}

export async function fetchFplData():Promise<FplData>{const response=await fetch(`/api/fpl?refresh=${Date.now()}`,{cache:"no-store"});const json=await response.json();if(!response.ok)throw new Error(json.error||"Could not load official FPL data");return json}
export const savedSquad=(data:FplData)=>{try{const ids=JSON.parse(localStorage.getItem("fpl-edge-squad")||"[]");return ids.map((id:number)=>data.players.find(p=>p.id===id)).filter(Boolean) as FplPlayer[]}catch{return[]}}
