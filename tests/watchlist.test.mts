import assert from "node:assert/strict";
import test from "node:test";
import { FplPlayer, ProjectionMetrics } from "../app/lib/fpl.ts";
import { buyTriggerMessage, watchlistCandidatePool } from "../app/components/CoachApp.tsx";

function makePlayer(overrides:Partial<FplPlayer>={}):FplPlayer{return{
  id:1,name:"Target",firstName:"Target",secondName:"Player",teamId:1,teamName:"Test FC",teamShort:"TFC",positionId:3,position:"Midfielder",positionShort:"MID",price:6,status:"a",chance:null,
  epNext:2,form:2,pointsPerGame:3,priorPointsPerGame:3,priorMinutes:1500,priorStarts:20,priorExpectedGoals:3,priorExpectedAssists:3,priorBonus:10,priorSaves:0,priorPenaltiesSaved:0,priorDefensiveContribution:100,
  totalPoints:0,eventPoints:0,eventMinutes:0,eventBonus:0,eventDefensiveContribution:0,selectedBy:10,priceChange:0,priceProjectionToday:0,priceChangeSinceStart:0,priceOutlook:[],transfersIn:0,transfersOut:0,goals:0,assists:0,expectedGoals:0,expectedAssists:0,expectedGoalInvolvements:0,expectedGoalsConceded:0,cleanSheets:0,goalsConceded:0,minutes:180,starts:2,bonus:0,bps:0,ictIndex:0,influence:0,creativity:0,threat:0,saves:0,penaltiesSaved:0,defensiveContribution:0,clearancesBlocksInterceptions:0,recoveries:0,tackles:0,penaltiesOrder:null,directFreekicksOrder:null,cornersOrder:null,scoutRisks:[],news:"",newsAdded:null,...overrides,
}}

function makeMetrics(overrides:Partial<ProjectionMetrics>={}):ProjectionMetrics{return{xPts:5,expectedMinutes:80,startProbability:.9,sixtyProbability:.85,rotationRisk:.1,xG:.3,xA:.2,xG90:.15,xA90:.1,cleanSheetProbability:.3,bonus:.5,defensiveContribution:.2,saves:0,penaltyRole:false,setPieceRole:false,confidence:.8,...overrides}}

test("watchlist candidate pool includes the complete eligible official database, not a top-12 slice",()=>{
  const players=Array.from({length:30},(_,index)=>makePlayer({id:index+1,name:`Player ${String(index+1).padStart(2,"0")}`,teamId:index%3+1,teamName:index%3===0?"Arsenal":"Other",teamShort:index%3===0?"ARS":"OTH",positionId:index%2?2:3,positionShort:index%2?"DEF":"MID"}));
  const candidates=watchlistCandidatePool(players,[1,2],[3]);
  assert.equal(candidates.length,27);
  assert.ok(candidates.some(player=>player.id===30),"players beyond the old 12-row cap remain selectable");
});

test("watchlist candidate pool searches player or club and filters position",()=>{
  const players=[makePlayer({id:1,name:"Saka",teamName:"Arsenal",teamShort:"ARS",positionShort:"MID"}),makePlayer({id:2,name:"Saliba",teamName:"Arsenal",teamShort:"ARS",positionId:2,positionShort:"DEF"}),makePlayer({id:3,name:"Palmer",teamName:"Chelsea",teamShort:"CHE",positionShort:"MID"})];
  assert.deepEqual(watchlistCandidatePool(players,[],[],"arsenal","DEF").map(player=>player.name),["Saliba"]);
  assert.deepEqual(watchlistCandidatePool(players,[],[],"palmer").map(player=>player.name),["Palmer"]);
});

test("no same-position route is honest and never ready",()=>{
  const result=buyTriggerMessage(makePlayer(),undefined,makeMetrics(),undefined,20,0,5);
  assert.equal(result.ready,false);assert.equal(result.budgetNote,null);assert.match(result.message,/build your squad first/);
});

test("an unaffordable target is never told to wait for a fantasy price crash",()=>{
  const target=makePlayer({price:8,pointsPerGame:5}),natural=makePlayer({id:2,name:"Incumbent",price:5,pointsPerGame:3});
  const result=buyTriggerMessage(target,natural,makeMetrics(),makeMetrics({startProbability:.75}),20,10,1);
  assert.equal(result.ready,false);assert.doesNotMatch(result.message,/price drops/i);assert.match(result.message,/Performance case met/);assert.match(result.budgetNote??"",/£2\.0m outside your budget/);
});

test("insecure incoming role is the first football blocker and compares the outgoing player",()=>{
  const target=makePlayer(),natural=makePlayer({id:2,name:"Incumbent"});
  const result=buyTriggerMessage(target,natural,makeMetrics({startProbability:.55,expectedMinutes:48}),makeMetrics({startProbability:.88}),25,10,5);
  assert.equal(result.ready,false);assert.equal(result.close,false);assert.match(result.message,/secure role/);assert.match(result.message,/Incumbent/);assert.match(result.message,/55%/);
});

test("a small projected edge remains a watch condition",()=>{
  const target=makePlayer(),natural=makePlayer({id:2,name:"Incumbent"});
  const result=buyTriggerMessage(target,natural,makeMetrics(),makeMetrics(),12,11,5);
  assert.equal(result.ready,false);assert.equal(result.close,true);assert.match(result.message,/real five-gameweek edge/);assert.match(result.message,/\+1\.0/);
});

test("one current-season start is building evidence, never a buy signal",()=>{
  const target=makePlayer({starts:1,minutes:90}),natural=makePlayer({id:2,name:"Incumbent"});
  const result=buyTriggerMessage(target,natural,makeMetrics({startProbability:.95}),makeMetrics(),20,10,5);
  assert.equal(result.ready,false);assert.equal(result.close,true);assert.match(result.message,/second confirmed start/);assert.match(result.message,/one match is not enough/);
});

test("recent output behind the outgoing player blocks a fixture-only transfer",()=>{
  const target=makePlayer({pointsPerGame:2.5}),natural=makePlayer({id:2,name:"Incumbent",pointsPerGame:4.5});
  const result=buyTriggerMessage(target,natural,makeMetrics(),makeMetrics(),20,10,5);
  assert.equal(result.ready,false);assert.match(result.message,/recent output supports the move/);assert.match(result.message,/2\.5 points per appearance/);assert.match(result.message,/4\.5/);
});

test("secure role, confirmed performance, projection edge and affordability produce BUY",()=>{
  const target=makePlayer({price:6,pointsPerGame:5}),natural=makePlayer({id:2,name:"Incumbent",price:6,pointsPerGame:3});
  const result=buyTriggerMessage(target,natural,makeMetrics({startProbability:.92}),makeMetrics({startProbability:.78}),20,10,0);
  assert.equal(result.ready,true);assert.equal(result.close,false);assert.equal(result.budgetNote,null);assert.match(result.message,/Performance case met/);assert.match(result.message,/\+10\.0-point five-GW edge/);
});
