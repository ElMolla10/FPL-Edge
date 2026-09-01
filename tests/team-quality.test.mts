import assert from "node:assert/strict";
import test from "node:test";
import { FplFixture, FplPlayer, projectionMetrics } from "../app/lib/fpl.ts";
import { TeamQualityInput, buildTeamQualityProfiles } from "../app/lib/team-quality.ts";

const input=(overrides:Partial<TeamQualityInput>={}):TeamQualityInput=>({
  id:1,name:"Average",short:"AVG",
  officialAttackHome:1000,officialAttackAway:1000,officialDefenceHome:1000,officialDefenceAway:1000,
  plPriorCoverage:.8,lowPlContinuity:false,matches:0,homeMatches:0,awayMatches:0,
  goalsForHome:0,goalsForAway:0,goalsAgainstHome:0,goalsAgainstAway:0,expectedGoalsFor:0,
  ...overrides,
});

const player=(overrides:Partial<FplPlayer>={}):FplPlayer=>({
  id:1,name:"Player",firstName:"Test",secondName:"Player",teamId:1,teamName:"Strong",teamShort:"STR",
  positionId:3,position:"Midfielder",positionShort:"MID",price:7,status:"a",chance:null,
  epNext:0,form:3,pointsPerGame:4,priorPointsPerGame:4,priorMinutes:1800,priorStarts:20,
  priorExpectedGoals:5,priorExpectedAssists:4,priorBonus:12,priorSaves:0,priorPenaltiesSaved:0,priorDefensiveContribution:80,
  totalPoints:0,eventPoints:0,eventMinutes:0,eventBonus:0,eventDefensiveContribution:0,selectedBy:15,priceChange:0,priceProjectionToday:0,transfersIn:0,transfersOut:0,
  goals:0,assists:0,expectedGoals:0,expectedAssists:0,expectedGoalInvolvements:0,expectedGoalsConceded:0,
  cleanSheets:0,goalsConceded:0,minutes:0,starts:0,bonus:0,bps:0,ictIndex:0,influence:0,creativity:0,threat:0,
  saves:0,penaltiesSaved:0,defensiveContribution:0,clearancesBlocksInterceptions:0,recoveries:0,tackles:0,
  penaltiesOrder:null,directFreekicksOrder:null,cornersOrder:null,scoutRisks:[],news:"",newsAdded:null,
  priorSource:"official-pl-history",teamMatchesPlayed:0,
  ...overrides,
});

const fixture=(overrides:Partial<FplFixture>={}):FplFixture=>({
  id:1,event:1,teamH:1,teamA:2,teamHDifficulty:3,teamADifficulty:3,finished:false,kickoff:null,started:false,teamHScore:null,teamAScore:null,
  ...overrides,
});

test("official team strengths are normalized as league-relative values, not mistaken for the 1-5 FDR scale",()=>{
  const profiles=buildTeamQualityProfiles([
    input({id:1,name:"Strong",short:"STR",officialAttackHome:1200,officialAttackAway:1150,officialDefenceHome:1200,officialDefenceAway:1150}),
    input({id:2,name:"Weak",short:"WEA",officialAttackHome:800,officialAttackAway:850,officialDefenceHome:800,officialDefenceAway:850}),
  ]);
  const strong=profiles.find(profile=>profile.id===1)!,weak=profiles.find(profile=>profile.id===2)!;
  assert.ok(strong.attackHome>1&&weak.attackHome<1);
  assert.ok(strong.defenceAway>1&&weak.defenceAway<1);
});

test("a low-continuity promoted club starts conservatively and with lower confidence",()=>{
  const [established,promoted]=buildTeamQualityProfiles([
    input({id:1,name:"Established",short:"EST",officialAttackHome:1100,officialAttackAway:1100,officialDefenceHome:1100,officialDefenceAway:1100}),
    input({id:2,name:"Promoted",short:"PRO",officialAttackHome:1100,officialAttackAway:1100,officialDefenceHome:1100,officialDefenceAway:1100,plPriorCoverage:0,lowPlContinuity:true}),
  ]);
  assert.ok(promoted.attackHome<established.attackHome);
  assert.ok(promoted.defenceHome<established.defenceHome);
  assert.ok(promoted.confidence<established.confidence);
});

test("one promoted-club clean sheet cannot erase the conservative prior",()=>{
  const profiles=buildTeamQualityProfiles([
    input({id:1,name:"Promoted",short:"PRO",lowPlContinuity:true,plPriorCoverage:0,matches:1,homeMatches:1,goalsForHome:1,goalsAgainstHome:0,expectedGoalsFor:.8}),
    input({id:2,name:"League peer",short:"PEE",matches:1,awayMatches:1,goalsForAway:0,goalsAgainstAway:1,expectedGoalsFor:1.2}),
  ]);
  const promoted=profiles[0];
  assert.ok(promoted.currentWeight<.15,"one match must have little authority");
  assert.ok(promoted.defenceHome<.95,`one clean sheet produced ${promoted.defenceHome.toFixed(3)} defence strength`);
  assert.equal(promoted.matches,1);
});

test("completed PL evidence updates ratings and confidence gradually",()=>{
  const early=buildTeamQualityProfiles([input({lowPlContinuity:true,plPriorCoverage:0})])[0];
  const mature=buildTeamQualityProfiles([
    input({id:1,lowPlContinuity:true,plPriorCoverage:0,matches:8,homeMatches:4,awayMatches:4,goalsForHome:8,goalsForAway:6,goalsAgainstHome:3,goalsAgainstAway:4,expectedGoalsFor:14}),
    input({id:2,matches:8,homeMatches:4,awayMatches:4,goalsForHome:4,goalsForAway:3,goalsAgainstHome:8,goalsAgainstAway:7,expectedGoalsFor:7}),
  ])[0];
  assert.ok(mature.attackHome>early.attackHome);
  assert.ok(mature.defenceAway>early.defenceAway);
  assert.ok(mature.confidence>early.confidence);
  assert.ok(mature.currentWeight<.65,"current results must not fully replace the prior after eight matches");
});

test("projection uses own attack and opponent defence independently at equal FDR",()=>{
  const p=player({teamQualityAttackHome:1.15,teamQualityDefenceHome:1.05});
  const weakDefence=projectionMetrics(p,1,[fixture({teamADefenceQuality:.8,teamAAttackQuality:1})],1);
  const strongDefence=projectionMetrics(p,1,[fixture({teamADefenceQuality:1.2,teamAAttackQuality:1})],1);
  assert.ok(weakDefence.xG>strongDefence.xG);
  assert.ok(weakDefence.xA>strongDefence.xA);
  assert.ok(weakDefence.xPts>strongDefence.xPts);
  assert.ok((weakDefence.fixtureAttackMultiplier??0)>1);
});

test("projection uses own defence and opponent attack independently at equal FDR",()=>{
  const defender=player({positionId:2,position:"Defender",positionShort:"DEF",teamQualityAttackHome:1,teamQualityDefenceHome:1.1});
  const weakAttack=projectionMetrics(defender,1,[fixture({teamADefenceQuality:1,teamAAttackQuality:.8})],1);
  const strongAttack=projectionMetrics(defender,1,[fixture({teamADefenceQuality:1,teamAAttackQuality:1.2})],1);
  assert.ok(weakAttack.cleanSheetProbability>strongAttack.cleanSheetProbability);
  assert.ok(weakAttack.xPts>strongAttack.xPts);
  assert.ok((weakAttack.fixtureDefenceMultiplier??0)>1);
});

test("team-quality profiles are deterministic",()=>{
  const inputs=[input({id:1}),input({id:2,lowPlContinuity:true,plPriorCoverage:0})];
  assert.deepEqual(buildTeamQualityProfiles(inputs),buildTeamQualityProfiles(inputs));
});
