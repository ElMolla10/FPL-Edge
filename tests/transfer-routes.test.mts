import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FplData, FplPlayer, ROLE_SECURITY_FLOOR, bestXi, playerProjection } from "../app/lib/fpl.ts";
import { RouteTransfer, solveTransferRoutes } from "../app/lib/transfer-routes.ts";
import { routeTransferPriceWarning } from "../app/components/CoachApp.tsx";

function makePlayer(overrides:Partial<FplPlayer>={}):FplPlayer{return{
  id:1,name:"Player",firstName:"Test",secondName:"Player",teamId:1,teamName:"Test FC",teamShort:"TFC",positionId:3,position:"Midfielder",positionShort:"MID",price:5,status:"a",chance:null,
  epNext:3,form:3,pointsPerGame:3,priorPointsPerGame:3,priorMinutes:2500,priorStarts:30,priorExpectedGoals:3,priorExpectedAssists:3,priorBonus:10,priorSaves:0,priorPenaltiesSaved:0,priorDefensiveContribution:100,priorSource:"official-pl-history",
  totalPoints:0,eventPoints:0,eventMinutes:0,eventBonus:0,eventDefensiveContribution:0,selectedBy:10,priceChange:0,priceProjectionToday:0,priceChangeSinceStart:0,priceOutlook:[],transfersIn:0,transfersOut:0,goals:0,assists:0,expectedGoals:0,expectedAssists:0,expectedGoalInvolvements:0,expectedGoalsConceded:0,cleanSheets:0,goalsConceded:0,minutes:0,starts:0,bonus:0,bps:0,ictIndex:0,influence:0,creativity:0,threat:0,saves:0,penaltiesSaved:0,defensiveContribution:0,clearancesBlocksInterceptions:0,recoveries:0,tackles:0,penaltiesOrder:null,directFreekicksOrder:null,cornersOrder:null,scoutRisks:[],news:"",newsAdded:null,...overrides,
}}

const rules={budget:100,squadSize:15,teamLimit:3,positions:[
  {id:1,name:"Goalkeeper",short:"GKP",squad:2,minPlay:1,maxPlay:1},
  {id:2,name:"Defender",short:"DEF",squad:5,minPlay:3,maxPlay:5},
  {id:3,name:"Midfielder",short:"MID",squad:5,minPlay:2,maxPlay:5},
  {id:4,name:"Forward",short:"FWD",squad:3,minPlay:1,maxPlay:3},
]};

function squad():FplPlayer[]{
  const player=(id:number,positionId:number,positionShort:FplPlayer["positionShort"],price=5)=>makePlayer({id,name:`P${id}`,teamId:id,teamName:`Team ${id}`,teamShort:`T${id}`,positionId,positionShort,position:positionShort,price});
  return[
    player(1,1,"GKP",4.5),player(2,1,"GKP",4.5),
    ...[11,12,13,14,15].map(id=>player(id,2,"DEF",4.5)),
    ...[21,22,23,24,25].map(id=>player(id,3,"MID",6)),
    ...[31,32,33].map(id=>player(id,4,"FWD",7)),
  ];
}

function dataFor(players:FplPlayer[],count:number=3):FplData{
  const events=Array.from({length:count},(_,index)=>({id:index+1,name:`Gameweek ${index+1}`,deadline:new Date(Date.now()+(index+1)*86400000).toISOString(),current:false,next:index===0,finished:false,dataChecked:false}));
  const clubIds=[...new Set(players.map(player=>player.teamId))];
  const fixtures=events.flatMap(event=>clubIds.map((teamId,index)=>({id:event.id*1000+index,event:event.id,teamH:teamId,teamA:1000+teamId,teamHDifficulty:3,teamADifficulty:3,finished:false,kickoff:null,started:false,teamHScore:null,teamAScore:null})));
  return{updatedAt:new Date().toISOString(),source:"test",seasonStatsThrough:0,players,fixtures,events,teams:clubIds.map(id=>({id,name:`Team ${id}`,short:`T${id}`})),rules};
}

test("route solver rolls legally and banks free transfers when no replacement exists",()=>{
  const initial=squad();
  const routes=solveTransferRoutes(dataFor(initial,5),initial,1,{horizon:5,freeTransfers:3,resultLimit:2});
  assert.equal(routes.length,1);
  const route=routes[0];
  assert.equal(route.totalTransfers,0);
  assert.equal(route.totalHitCost,0);
  assert.equal(route.gain,0);
  assert.equal(route.finalFreeTransfers,5,"rolled transfers stop at the official five-transfer cap");
  assert.deepEqual(route.weeks.map(week=>week.freeTransfersAfter),[4,5,5,5,5]);
});

test("route solver uses exact selling value, preserves bank and returns a legal sequence",()=>{
  const initial=squad();
  const upgrade=makePlayer({id:99,name:"Upgrade",teamId:99,teamName:"Upgrade FC",teamShort:"UPG",positionId:3,position:"Midfielder",positionShort:"MID",price:6.5,epNext:9,form:8,pointsPerGame:7,priorPointsPerGame:7,priorExpectedGoals:15,priorExpectedAssists:12});
  const data=dataFor([...initial,upgrade],3);
  const exactSellingPrices=new Map(initial.filter(player=>player.positionShort==="MID").map(player=>[player.id,5.5]));
  const routes=solveTransferRoutes(data,initial,1,{horizon:3,freeTransfers:1,sellingPrices:exactSellingPrices,resultLimit:4});
  const route=routes.find(candidate=>candidate.weeks.some(week=>week.transfers.some(move=>move.incoming.id===upgrade.id)));
  assert.ok(route,"the high-confidence upgrade should appear in a returned route");
  const week=route.weeks.find(item=>item.transfers.some(move=>move.incoming.id===upgrade.id))!;
  const move=week.transfers.find(item=>item.incoming.id===upgrade.id)!;
  assert.equal(move.sellingPrice,5.5,"connected manager selling value overrides market price");
  assert.equal(move.bankChange,-1);
  assert.ok(week.bankAfter>=0);
  assert.equal(week.squadIdsAfter.length,15);
  assert.equal(new Set(week.squadIdsAfter).size,15);
  assert.ok(route.gain>0);
});

test("every planned week charges the official hit formula and updates free transfers deterministically",()=>{
  const initial=squad();
  const upgrades=[
    makePlayer({id:91,name:"Mid Upgrade",teamId:91,positionId:3,position:"Midfielder",positionShort:"MID",price:6,epNext:9,form:8,pointsPerGame:7,priorPointsPerGame:7,priorExpectedGoals:15,priorExpectedAssists:12}),
    makePlayer({id:92,name:"Def Upgrade",teamId:92,positionId:2,position:"Defender",positionShort:"DEF",price:4.5,epNext:8,form:7,pointsPerGame:6,priorPointsPerGame:6,priorExpectedGoals:8,priorExpectedAssists:8}),
  ];
  const routes=solveTransferRoutes(dataFor([...initial,...upgrades],3),initial,0,{horizon:3,freeTransfers:1,maxWeeklyHit:4,resultLimit:4});
  assert.ok(routes.length);
  for(const route of routes)for(const week of route.weeks){
    assert.equal(week.hitCost,Math.max(0,week.transfers.length-week.freeTransfersBefore)*4);
    assert.ok(week.hitCost<=4);
    assert.equal(week.freeTransfersAfter,Math.min(5,Math.max(0,week.freeTransfersBefore-week.transfers.length)+1));
    assert.equal(week.netProjectedPoints,week.projectedPoints-week.hitCost);
  }
});

test("role-insecure targets cannot anchor a route despite an inflated headline projection",()=>{
  const initial=squad();
  const trap=makePlayer({id:199,name:"Trap",teamId:199,positionId:3,position:"Midfielder",positionShort:"MID",price:5,epNext:15,form:15,pointsPerGame:9,priorPointsPerGame:9,priorMinutes:63,priorStarts:1,priorExpectedGoals:20,priorExpectedAssists:20,status:"d",chance:25});
  const routes=solveTransferRoutes(dataFor([...initial,trap],3),initial,5,{horizon:3,freeTransfers:1,resultLimit:4});
  assert.ok(routes.every(route=>route.weeks.every(week=>week.transfers.every(move=>move.incoming.id!==trap.id))));
});

// weekTotal() is a private closure inside solveTransferRoutes that wraps bestXi() rather than
// modifying it (bestXi's five other, unrelated callers must stay byte-identical) -- this proves the
// wrapper is actually wired up, by comparing solveTransferRoutes's own output against bestXi's total
// computed independently, plus the exact bonus term evaluateProjectionReceipt's own real-chip
// reconciliation formula uses (CoachApp.tsx's chipAdjustment), rather than re-deriving a new formula.
test("solveTransferRoutes: a planned Triple Captain for a specific event adds exactly one more captain term to that week's projectedPoints, not other weeks",()=>{
  const initial=squad();
  const data=dataFor(initial,3);
  const withoutPlan=solveTransferRoutes(data,initial,1,{horizon:3,freeTransfers:5,resultLimit:1});
  const withPlan=solveTransferRoutes(data,initial,1,{horizon:3,freeTransfers:5,resultLimit:1,plannedChips:[{event:1,chip:"Triple Captain"}]});
  assert.equal(withoutPlan.length,1);assert.equal(withPlan.length,1);
  const xi=bestXi(initial,1,data.fixtures,1);
  assert.ok(xi.captain,"a legal XI with a captain must exist for this synthetic squad");
  const captainTerm=playerProjection(xi.captain!,1,data.fixtures,1);
  assert.ok(Math.abs((withPlan[0].weeks[0].projectedPoints-withoutPlan[0].weeks[0].projectedPoints)-captainTerm)<1e-6,"week 1's projectedPoints must grow by exactly one more captain term under a planned Triple Captain");
  assert.equal(withPlan[0].weeks[1].projectedPoints,withoutPlan[0].weeks[1].projectedPoints,"week 2 (no plan for that event) must be completely unaffected");
  assert.equal(withPlan[0].weeks[2].projectedPoints,withoutPlan[0].weeks[2].projectedPoints,"week 3 (no plan for that event either) must be completely unaffected");
});

test("solveTransferRoutes: a planned Wildcard/Free Hit is silently ignored by projectedPoints -- Option A, no squad-rebuild math here",()=>{
  const initial=squad();
  const data=dataFor(initial,3);
  const withoutPlan=solveTransferRoutes(data,initial,1,{horizon:3,freeTransfers:5,resultLimit:1});
  const withPlan=solveTransferRoutes(data,initial,1,{horizon:3,freeTransfers:5,resultLimit:1,plannedChips:[{event:1,chip:"Wildcard"}]});
  assert.equal(withPlan[0].weeks[0].projectedPoints,withoutPlan[0].weeks[0].projectedPoints,"Wildcard/Free Hit must not change projectedPoints -- they change which squad should be scored, which this function doesn't rebuild");
});

test("solveTransferRoutes: omitting plannedChips entirely behaves exactly as before -- every existing caller stays correct unmodified",()=>{
  const initial=squad();
  const data=dataFor(initial,3);
  const a=solveTransferRoutes(data,initial,1,{horizon:3,freeTransfers:5,resultLimit:1});
  const b=solveTransferRoutes(data,initial,1,{horizon:3,freeTransfers:5,resultLimit:1,plannedChips:[]});
  assert.deepEqual(a[0].weeks.map(w=>w.projectedPoints),b[0].weeks.map(w=>w.projectedPoints));
});

// routeTransferPriceWarning: week-1-only, rise-only, display-only -- the honest boundary this
// whole feature turns on (FPL's own predictor reaches 3 days out at most; a route's later weeks
// execute real weeks from now, genuinely outside that window).
function move(overrides:Partial<FplPlayer>={}):RouteTransfer{
  return{out:makePlayer({id:2}),incoming:makePlayer({id:3,...overrides}),sellingPrice:5,buyingPrice:5,bankChange:0,horizonGain:0};
}

test("routeTransferPriceWarning: week 0 with real rise pressure today returns a message",()=>{
  const m=move({priceProjectionToday:25,priceOutlook:[{offsetDays:0,projectedPercent:25,likelihood:3},{offsetDays:1,projectedPercent:0,likelihood:0},{offsetDays:2,projectedPercent:0,likelihood:0}]});
  const warning=routeTransferPriceWarning(m,0);
  assert.ok(warning);
  assert.ok(warning!.includes("25%"));
});

test("routeTransferPriceWarning: week 0 rise pressure that CONTINUES tomorrow is disclosed as such",()=>{
  const m=move({priceProjectionToday:25,priceOutlook:[{offsetDays:0,projectedPercent:25,likelihood:3},{offsetDays:1,projectedPercent:20,likelihood:3},{offsetDays:2,projectedPercent:0,likelihood:0}]});
  const warning=routeTransferPriceWarning(m,0);
  assert.ok(warning?.includes("still rising tomorrow"),`expected the richer 3-day message, got: ${warning}`);
});

test("routeTransferPriceWarning: week 0 with fall or stable pressure returns null -- a fall on a buying target is good news, not a warning",()=>{
  const fall=move({priceProjectionToday:-25,priceOutlook:[{offsetDays:0,projectedPercent:-25,likelihood:-3},{offsetDays:1,projectedPercent:0,likelihood:0},{offsetDays:2,projectedPercent:0,likelihood:0}]});
  const stable=move({priceProjectionToday:2,priceOutlook:[{offsetDays:0,projectedPercent:2,likelihood:0},{offsetDays:1,projectedPercent:0,likelihood:0},{offsetDays:2,projectedPercent:0,likelihood:0}]});
  assert.equal(routeTransferPriceWarning(fall,0),null);
  assert.equal(routeTransferPriceWarning(stable,0),null);
});

// The core off-by-one-style boundary: any week after the first must never surface a warning, no
// matter how strong the pressure -- FPL's own data says nothing honest that far out.
test("routeTransferPriceWarning: week 1 and beyond ALWAYS return null regardless of pressure",()=>{
  const m=move({priceProjectionToday:40,priceOutlook:[{offsetDays:0,projectedPercent:40,likelihood:5},{offsetDays:1,projectedPercent:35,likelihood:5},{offsetDays:2,projectedPercent:30,likelihood:5}]});
  assert.equal(routeTransferPriceWarning(m,1),null);
  assert.equal(routeTransferPriceWarning(m,2),null);
  assert.equal(routeTransferPriceWarning(m,4),null);
});

// eligibleAt() is a private closure inside solveTransferRoutes -- it can't be called directly to
// prove it reads ROLE_SECURITY_FLOOR the way the boundary test for evaluateTransferQuality does in
// projection-engine.test.mts. This inspects the actual source instead: it fails if either consumer
// goes back to an independently hardcoded .55/45/.35 rather than the shared exported constant, the
// exact duplication found during retroactive review of 4f8762e (same failure class as the earlier
// duplicated 2.2 action threshold). evaluateTransferQuality itself now lives in
// app/lib/transfer-quality.ts (relocated so LiveDraftBuilder.tsx could reuse it without a circular
// import through CoachApp.tsx) -- this scans that file, not CoachApp.tsx's re-export, so the check
// keeps testing the real implementation rather than silently going blind after the move.
test("route eligibility and the single-transfer quality gate read the same ROLE_SECURITY_FLOOR constant, not independently duplicated numbers",()=>{
  assert.deepEqual(ROLE_SECURITY_FLOOR,{startProbability:.55,expectedMinutes:45,confidence:.35});
  const routesSource=readFileSync(new URL("../app/lib/transfer-routes.ts",import.meta.url),"utf-8");
  const transferQualitySource=readFileSync(new URL("../app/lib/transfer-quality.ts",import.meta.url),"utf-8");
  assert.ok(routesSource.includes("ROLE_SECURITY_FLOOR.startProbability")&&routesSource.includes("ROLE_SECURITY_FLOOR.expectedMinutes")&&routesSource.includes("ROLE_SECURITY_FLOOR.confidence"),"transfer-routes.ts's eligibleAt must read all three floors from the shared constant");
  assert.ok(!/startProbability\s*>=\s*\.55/.test(routesSource)&&!/expectedMinutes\s*>=\s*45\b/.test(routesSource)&&!/confidence\s*>=\s*\.35/.test(routesSource),"transfer-routes.ts must not independently hardcode the floor values");
  const evaluateTransferQuality=transferQualitySource.slice(transferQualitySource.indexOf("export function evaluateTransferQuality("));
  assert.notEqual(evaluateTransferQuality.length,0,"evaluateTransferQuality must still be found in app/lib/transfer-quality.ts -- if it moved again, update this scan target too");
  assert.ok(evaluateTransferQuality.includes("ROLE_SECURITY_FLOOR.startProbability")&&evaluateTransferQuality.includes("ROLE_SECURITY_FLOOR.expectedMinutes")&&evaluateTransferQuality.includes("ROLE_SECURITY_FLOOR.confidence"),"evaluateTransferQuality's hard floors must read from the shared constant");
  assert.ok(!/startProbability\s*<\s*\.55/.test(evaluateTransferQuality)&&!/expectedMinutes\s*<\s*45\b/.test(evaluateTransferQuality)&&!/confidence\s*<\s*\.35/.test(evaluateTransferQuality),"evaluateTransferQuality must not independently hardcode the floor values");
});
