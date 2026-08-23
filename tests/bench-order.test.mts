import test from "node:test";
import assert from "node:assert/strict";
import { FplPlayer } from "../app/lib/fpl.ts";
import { optimizeBenchOrder } from "../app/lib/bench-order.ts";

function player(id:number,positionShort:"GKP"|"DEF"|"MID"|"FWD",name=`P${id}`):FplPlayer{return{
  id,name,firstName:name,secondName:"",teamId:id,teamName:`Team ${id}`,teamShort:`T${id}`,positionId:positionShort==="GKP"?1:positionShort==="DEF"?2:positionShort==="MID"?3:4,position:positionShort,positionShort,price:5,status:"a",chance:null,
  epNext:0,form:0,pointsPerGame:0,priorPointsPerGame:0,priorMinutes:0,priorStarts:0,priorExpectedGoals:0,priorExpectedAssists:0,priorBonus:0,priorSaves:0,priorPenaltiesSaved:0,priorDefensiveContribution:0,totalPoints:0,eventPoints:0,eventMinutes:0,selectedBy:0,priceChange:0,priceProjectionToday:0,transfersIn:0,transfersOut:0,goals:0,assists:0,expectedGoals:0,expectedAssists:0,expectedGoalInvolvements:0,expectedGoalsConceded:0,cleanSheets:0,goalsConceded:0,minutes:0,starts:0,bonus:0,bps:0,ictIndex:0,influence:0,creativity:0,threat:0,saves:0,penaltiesSaved:0,defensiveContribution:0,clearancesBlocksInterceptions:0,recoveries:0,tackles:0,penaltiesOrder:null,directFreekicksOrder:null,cornersOrder:null,scoutRisks:[],news:"",newsAdded:null,
}}

const xi=[player(1,"GKP"),...Array.from({length:3},(_,index)=>player(10+index,"DEF")),...Array.from({length:5},(_,index)=>player(20+index,"MID")),...Array.from({length:2},(_,index)=>player(30+index,"FWD"))];
const risky=player(40,"MID","Rare high ceiling"),secure=player(41,"DEF","Reliable cover"),third=player(42,"FWD","Third cover"),keeper=player(43,"GKP","Reserve keeper");
const metrics=new Map<number,{xPts:number;appearanceProbability:number}>([
  ...xi.map(item=>[item.id,{xPts:4,appearanceProbability:.95}] as const),
  [risky.id,{xPts:3,appearanceProbability:.2}],
  [secure.id,{xPts:4,appearanceProbability:.95}],
  [third.id,{xPts:2.1,appearanceProbability:.9}],
  [keeper.id,{xPts:3,appearanceProbability:.95}],
]);
const metricOf=(item:FplPlayer)=>metrics.get(item.id)!;

test("autosub-aware ordering can put a conditional high ceiling before the raw-xPts leader",()=>{
  const result=optimizeBenchOrder(xi,[risky,secure,third,keeper],metricOf);
  assert.equal(result.bench[0].id,risky.id,"if the rare high-ceiling player appears they get priority; if not, reliable cover still follows");
  assert.ok(result.expectedAutosubPoints>result.naiveExpectedAutosubPoints);
  assert.ok(result.improvement>0);
  assert.equal(result.scenarios,8192,"10 outfield starters plus 3 outfield substitutes are evaluated");
});

test("the reserve goalkeeper stays last because goalkeeper autosubs use a separate rule",()=>{
  const result=optimizeBenchOrder(xi,[keeper,third,risky,secure],metricOf);
  assert.equal(result.bench.length,4);
  assert.equal(result.bench[3].id,keeper.id);
  assert.equal(result.bench[3].positionShort,"GKP");
});

test("bench optimizer is deterministic for identical inputs",()=>{
  const first=optimizeBenchOrder(xi,[risky,secure,third,keeper],metricOf);
  const second=optimizeBenchOrder(xi,[risky,secure,third,keeper],metricOf);
  assert.deepEqual(first,second);
});

test("formation floors skip an ineligible substitute and use the defender who keeps 3 DEF",()=>{
  const missingDefender=xi.find(item=>item.positionShort==="DEF")!;
  const scenarioMetrics=new Map(metrics);
  xi.forEach(item=>scenarioMetrics.set(item.id,{xPts:4,appearanceProbability:item.id===missingDefender.id?0:1}));
  scenarioMetrics.set(risky.id,{xPts:12,appearanceProbability:1});
  scenarioMetrics.set(secure.id,{xPts:3,appearanceProbability:1});
  scenarioMetrics.set(third.id,{xPts:8,appearanceProbability:1});
  const result=optimizeBenchOrder(xi,[risky,secure,third,keeper],item=>scenarioMetrics.get(item.id)!);
  assert.equal(result.expectedAutosubPoints,3,"a 3-5-2 cannot replace its missing third defender with a midfielder or forward");
});
