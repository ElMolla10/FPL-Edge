import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FplData,
  FplFixture,
  FplPlayer,
  PROJECTION_MODEL_VERSION,
  ROLE_SECURITY_FLOOR,
  attachIntegrityWarnings,
  bestXi,
  findIdentityConflicts,
  isLowPlContinuity,
  isValidSquad,
  playerCalibrationProfile,
  playerProjection,
  plRosterContinuity,
  projectionMetrics,
} from "../app/lib/fpl.ts";
import { HistoryWeek, LockRecord, ProjectionPlayerEvaluationRow, ProjectionTransferEvaluation, aggregateAccuracy, aggregateTransferAccuracy, analysis, bestTransfers, createProjectionReceipt, evaluateProjectionReceipt, evaluateTransferQuality, projectionConfidenceBand, selectPrimaryTransfer, sortTransfersByQuality, Transfer, withModelUtilityChange } from "../app/components/CoachApp.tsx";
import { TransferRoute } from "../app/lib/transfer-routes.ts";

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Test", firstName: "Test", secondName: "Player", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, status: "a", chance: null,
    epNext: 2, form: 2, pointsPerGame: 3, priorPointsPerGame: 3, priorMinutes: 1500, priorStarts: 20,
    priorExpectedGoals: 3, priorExpectedAssists: 3, priorBonus: 10, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 100, totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0, selectedBy: 10, priceChange: 0, priceProjectionToday: 0,
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0,
    starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

function makeFixture(overrides: Partial<FplFixture> = {}): FplFixture {
  return {
    id: 1, event: 1, teamH: 1, teamA: 2, teamHDifficulty: 3, teamADifficulty: 3,
    finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null,
    ...overrides,
  };
}

function makeRules() {
  return {
    budget: 100,
    squadSize: 15,
    teamLimit: 3,
    positions: [
      { id: 1, name: "Goalkeeper", short: "GKP", squad: 2, minPlay: 1, maxPlay: 1 },
      { id: 2, name: "Defender", short: "DEF", squad: 5, minPlay: 3, maxPlay: 5 },
      { id: 3, name: "Midfielder", short: "MID", squad: 5, minPlay: 2, maxPlay: 5 },
      { id: 4, name: "Forward", short: "FWD", squad: 3, minPlay: 1, maxPlay: 3 },
    ],
  };
}

test("regression: a near-zero-minutes player does not out-project an established elite midfielder", () => {
  // Mirrors the real Josh Dasilva anomaly: 2 prior minutes, 0.08 prior xG.
  const tinySample = makePlayer({ id: 103, price: 5, priorMinutes: 2, priorStarts: 0, priorExpectedGoals: 0.08, priorExpectedAssists: 0, priorPointsPerGame: 1, selectedBy: 0 });
  const elite = makePlayer({ id: 124, price: 5.5, priorMinutes: 1636, priorStarts: 18, priorExpectedGoals: 1.39, priorExpectedAssists: 3.95, priorBonus: 10, priorPointsPerGame: 4.1, selectedBy: 14.5 });
  const fixtures = [makeFixture({ event: 1, teamH: 1, teamA: 99 })];

  const tinyMetrics = projectionMetrics(tinySample, 1, fixtures, 1);
  const eliteMetrics = projectionMetrics({ ...elite, teamId: 1 }, 1, fixtures, 1);

  assert.ok(
    tinyMetrics.xPts < eliteMetrics.xPts,
    `a 2-minute-sample player (${tinyMetrics.xPts.toFixed(2)} xPts) must not outproject an established elite midfielder (${eliteMetrics.xPts.toFixed(2)} xPts)`,
  );
  assert.ok(
    tinyMetrics.xPts < 4,
    `2-minute-sample player projected ${tinyMetrics.xPts.toFixed(2)} xPts in one gameweek — per-90 rates must shrink toward a sane baseline, not extrapolate from a tiny sample`,
  );
});

test("projection receipt freezes every player, selected captaincy and ranked transfer evidence",()=>{
  const captain=makePlayer({id:11,name:"Captain",teamId:1,teamShort:"ONE",priorSource:"official-pl-history"});
  const target=makePlayer({id:22,name:"Target",teamId:2,teamShort:"TWO",price:6.5,priorSource:"position-baseline",priorMinutes:0,priorStarts:0});
  const capturedAt="2026-08-22T10:00:00.000Z",deadline="2026-08-23T10:00:00.000Z";
  const data:FplData={updatedAt:"2026-08-22T09:55:00.000Z",source:"official-test",seasonStatsThrough:1,players:[target,captain],fixtures:[makeFixture({id:1,event:2,teamH:1,teamA:2}),makeFixture({id:2,event:3,teamH:2,teamA:1})],events:[{id:2,name:"Gameweek 2",deadline,finished:false,current:false,next:true,dataChecked:false},{id:3,name:"Gameweek 3",deadline:"2026-08-30T10:00:00.000Z",finished:false,current:false,next:false,dataChecked:false}],teams:[{id:1,name:"One",short:"ONE"},{id:2,name:"Two",short:"TWO"}],rules:makeRules()};
  const transferRows=[{out:captain,incoming:target,gain1:1.2345,gain3:2.3456,gain5:3.4567,individualGain1:1.1111,individualGain3:3.3333,individualGain5:4.5678,rankScore:2.2222,netDifference:3.4567,hitCost:0,startProbIn:.6543,confidenceIn:.4321,risk:"Medium" as const,reviewRequired:true,anomalies:[{code:"test-warning",message:"Test"}],qualityStatus:"blocked" as const,qualityScore:31,qualityReasons:[{code:"insufficient-start-probability",message:"Blocked"}]}];
  const routeRows:TransferRoute[]=[{id:"route",weeks:[{eventId:2,eventName:"Gameweek 2",freeTransfersBefore:2,freeTransfersAfter:2,transfers:[{out:captain,incoming:target,sellingPrice:6,buyingPrice:6.5,bankChange:-.5,horizonGain:3.4567}],hitCost:0,bankAfter:1,projectedPoints:55.5555,netProjectedPoints:55.5555,squadIdsAfter:[22]}],totalProjectedPoints:55.5555,netProjectedPoints:55.5555,baselinePoints:52,gain:3.5555,totalHitCost:0,totalTransfers:1,finalBank:1,finalFreeTransfers:2,confidence:.6543,risk:"Medium",firstAction:"Captain → Target",explanation:[]}];
  const receipt=createProjectionReceipt({data,eventIds:[2,3],deadline,capturedAt,squad:[captain,target],xiIds:[captain.id],captainId:captain.id,viceId:target.id,bank:1.5,freeTransfers:2,transferRows,routeRows});
  assert.equal(receipt.schemaVersion,8);
  assert.equal(receipt.plannedChip,null,"no plannedChip was passed in, so the receipt honestly records none rather than defaulting to a guess");
  assert.equal(receipt.modelVersion,PROJECTION_MODEL_VERSION);
  assert.equal(receipt.playerEncoding,"tuple-v4");
  assert.deepEqual(receipt.players.map(player=>player[0]),[11,22],"every official player is captured in deterministic id order");
  assert.equal(receipt.players[0][11]?.length,2,"each player freezes the full evaluation horizon");
  assert.equal(receipt.players[0][12],1,"team identity is frozen at prediction time");
  assert.equal(receipt.players[0][13],"MID","position is frozen at prediction time");
  assert.equal(receipt.players[0][14],"established-pl","the historical evidence class is frozen with the forecast");
  assert.equal(receipt.players[1][14],"no-pl-prior");
  assert.equal(receipt.players[1][3],"position-baseline");
  assert.deepEqual(receipt.eventIds,[2,3]);
  assert.equal(receipt.squad.captainId,11);
  assert.equal(receipt.squad.viceId,22);
  assert.deepEqual(receipt.squad.benchIds,[22],"receipt freezes the ordered bench rather than reconstructing it later");
  assert.equal(receipt.assumptions.freeTransfers,2);
  assert.equal(receipt.transfers[0].rank,1);
  assert.equal(receipt.transfers[0].incomingId,22);
  assert.equal(receipt.transfers[0].rankScore,2.222);
  assert.deepEqual(receipt.transfers[0].anomalyCodes,["test-warning"]);
  assert.equal(receipt.transfers[0].qualityStatus,"blocked");
  assert.equal(receipt.transfers[0].qualityScore,31);
  assert.deepEqual(receipt.transfers[0].qualityReasonCodes,["insufficient-start-probability"]);
  assert.equal(receipt.routes?.[0].firstAction,"Captain → Target");
  assert.equal(receipt.routes?.[0].gain,3.555);
  assert.deepEqual(receipt.routes?.[0].weeks[0].moves,[[11,22,6,6.5]],"complete route freezes exact player ids and transaction prices");
});

test("createProjectionReceipt: a planned chip is stored as a label, but predictedTotal stays the plain no-chip baseline (never double-counted against evaluateProjectionReceipt's own real-chip adjustment)",()=>{
  const captain=makePlayer({id:11,name:"Captain",teamId:1,teamShort:"ONE"});
  const target=makePlayer({id:22,name:"Target",teamId:2,teamShort:"TWO",price:6.5});
  const capturedAt="2026-08-22T10:00:00.000Z",deadline="2026-08-23T10:00:00.000Z";
  const data:FplData={updatedAt:"2026-08-22T09:55:00.000Z",source:"official-test",seasonStatsThrough:1,players:[captain,target],fixtures:[],events:[{id:2,name:"Gameweek 2",deadline,finished:false,current:false,next:true,dataChecked:false}],teams:[{id:1,name:"One",short:"ONE"},{id:2,name:"Two",short:"TWO"}],rules:makeRules()};
  const withoutPlan=createProjectionReceipt({data,eventIds:[2],deadline,capturedAt,squad:[captain,target],xiIds:[captain.id],captainId:captain.id,viceId:target.id,bank:1,freeTransfers:1,transferRows:[]});
  const withPlan=createProjectionReceipt({data,eventIds:[2],deadline,capturedAt,squad:[captain,target],xiIds:[captain.id],captainId:captain.id,viceId:target.id,bank:1,freeTransfers:1,transferRows:[],plannedChip:"Triple Captain"});
  assert.equal(withoutPlan.plannedChip,null);
  assert.equal(withPlan.plannedChip,"Triple Captain");
  assert.equal(withPlan.squad.predictedTotal,withoutPlan.squad.predictedTotal,"predictedTotal must be identical regardless of plannedChip -- the bonus belongs only to forward-projection call sites, never baked into this frozen receipt");
});

test("post-GW evaluation grades a matching official plan, player calibration and transfer-route outcomes",()=>{
  const captain=makePlayer({id:11,name:"Captain",teamId:1,teamShort:"ONE",priorSource:"official-pl-history"});
  const target=makePlayer({id:22,name:"Target",teamId:2,teamShort:"TWO",price:6.5,priorSource:"position-baseline",priorMinutes:0,priorStarts:0});
  const deadline="2026-08-23T10:00:00.000Z",capturedAt="2026-08-22T10:00:00.000Z";
  const data:FplData={updatedAt:"2026-08-22T09:55:00.000Z",source:"official-test",seasonStatsThrough:1,players:[captain,target],fixtures:[makeFixture({id:1,event:2,teamH:1,teamA:2}),makeFixture({id:2,event:3,teamH:2,teamA:1})],events:[{id:2,name:"Gameweek 2",deadline,finished:false,current:false,next:true,dataChecked:false},{id:3,name:"Gameweek 3",deadline:"2026-08-30T10:00:00.000Z",finished:false,current:false,next:false,dataChecked:false}],teams:[{id:1,name:"One",short:"ONE"},{id:2,name:"Two",short:"TWO"}],rules:makeRules()};
  const transferRows=[{out:captain,incoming:target,gain1:1,gain3:2,gain5:3,individualGain1:1,individualGain3:2,individualGain5:3,rankScore:2,netDifference:3,hitCost:0,startProbIn:.7,confidenceIn:.6,risk:"Medium" as const,reviewRequired:false,anomalies:[]}];
  const receipt=createProjectionReceipt({data,eventIds:[2,3],deadline,capturedAt,squad:[captain,target],xiIds:[captain.id],captainId:captain.id,viceId:target.id,bank:1,freeTransfers:1,transferRows});
  const lock:LockRecord={event:2,lockedAt:capturedAt,dataUpdatedAt:data.updatedAt,predicted:receipt.squad.predictedTotal,squadIds:[11,22],xiIds:[11],captainId:11,viceId:22,receipt};
  const weeks:HistoryWeek[]=[
    {event:2,points:6,transferCost:4,captainId:11,viceCaptainId:22,captainContribution:10,chip:null,squad:[{elementId:11,position:1,multiplier:2,isCaptain:true,isViceCaptain:false,elementType:3},{elementId:22,position:12,multiplier:0,isCaptain:false,isViceCaptain:true,elementType:3}],playerStats:{"11":{points:5,minutes:90,starts:1,goals:1,assists:0,cleanSheets:0,bonus:2},"22":{points:2,minutes:30,starts:0,goals:0,assists:0,cleanSheets:0,bonus:0}}},
    {event:3,points:7,playerStats:{"11":{points:1,minutes:90,starts:1,goals:0,assists:0,cleanSheets:0,bonus:0},"22":{points:8,minutes:90,starts:1,goals:1,assists:1,cleanSheets:0,bonus:1}}},
  ];
  const result=evaluateProjectionReceipt(lock,weeks);
  assert.equal(result.status,"evaluated");
  assert.equal(result.modelVersion,receipt.modelVersion,"the evaluation remains attributable to its frozen model generation");
  assert.equal(result.officialPlanMatch,true);
  assert.equal(result.managerActual,6,"official net points stay visible");
  assert.equal(result.actualBeforeHits,10,"projection accuracy is graded against scoring output before transfer-cost accounting");
  assert.equal(result.completedEvents,2);
  assert.ok(result.population&&result.population.rows===4,"both players across both completed events are calibrated");
  assert.equal(result.captain?.actualRaw,5);
  assert.equal(result.captain?.officialContribution,10);
  assert.equal(result.playerRows.length,2,"the dashboard receives one-step-ahead rows, not hindsight-weighted future rows");
  assert.deepEqual({teamId:result.playerRows[0].teamId,position:result.playerRows[0].positionShort,band:result.playerRows[0].confidenceBand},{teamId:1,position:"MID",band:projectionConfidenceBand(result.playerRows[0].confidence)});
  assert.deepEqual(result.playerRows.map(row=>row.calibrationGroup),["established-pl","no-pl-prior"],"accuracy rows retain the evidence class that existed when the forecast was made");
  assert.equal(result.transfers[0].actualPlayerSwing,4,"actual route swing is IN minus OUT across completed events");
  assert.equal(result.transfers[0].actualNetAfterHit,4);
});

test("post-GW evaluation refuses to grade squad-total accuracy when the official submitted captain differs",()=>{
  const captain=makePlayer({id:11,name:"Captain"}),vice=makePlayer({id:22,name:"Vice",teamId:2});
  const deadline="2026-08-23T10:00:00.000Z",capturedAt="2026-08-22T10:00:00.000Z";
  const data:FplData={updatedAt:capturedAt,source:"test",seasonStatsThrough:0,players:[captain,vice],fixtures:[makeFixture({event:2})],events:[{id:2,name:"Gameweek 2",deadline,finished:false,current:false,next:true,dataChecked:false}],teams:[{id:1,name:"One",short:"ONE"},{id:2,name:"Two",short:"TWO"}],rules:makeRules()};
  const receipt=createProjectionReceipt({data,eventIds:[2],deadline,capturedAt,squad:[captain,vice],xiIds:[11],captainId:11,viceId:22,bank:0,freeTransfers:1,transferRows:[]});
  const lock:LockRecord={event:2,lockedAt:capturedAt,dataUpdatedAt:data.updatedAt,predicted:receipt.squad.predictedTotal,squadIds:[11,22],xiIds:[11],captainId:11,viceId:22,receipt};
  const week:HistoryWeek={event:2,points:20,captainId:22,viceCaptainId:11,captainContribution:16,chip:null,squad:[{elementId:11,position:1,multiplier:1,isCaptain:false,isViceCaptain:true,elementType:3},{elementId:22,position:12,multiplier:2,isCaptain:true,isViceCaptain:false,elementType:3}],playerStats:{"11":{points:4,minutes:90,starts:1,goals:0,assists:0,cleanSheets:0,bonus:0},"22":{points:8,minutes:90,starts:1,goals:1,assists:1,cleanSheets:0,bonus:1}}};
  const result=evaluateProjectionReceipt(lock,[week]);
  assert.equal(result.officialPlanMatch,false);
  assert.equal(result.managerActual,20,"official result remains visible for context");
  assert.equal(result.signedSquadError,null,"a different official plan must not be used to grade the frozen plan");
  assert.equal(result.absoluteSquadError,null);
});

test("post-GW evaluation adjusts the frozen team forecast for an official scoring chip",()=>{
  const captain=makePlayer({id:11,name:"Captain"}),bench=makePlayer({id:22,name:"Bench",teamId:2});
  const deadline="2026-08-23T10:00:00.000Z",capturedAt="2026-08-22T10:00:00.000Z";
  const data:FplData={updatedAt:capturedAt,source:"test",seasonStatsThrough:0,players:[captain,bench],fixtures:[makeFixture({event:2})],events:[{id:2,name:"Gameweek 2",deadline,finished:false,current:false,next:true,dataChecked:false}],teams:[{id:1,name:"One",short:"ONE"},{id:2,name:"Two",short:"TWO"}],rules:makeRules()};
  const receipt=createProjectionReceipt({data,eventIds:[2],deadline,capturedAt,squad:[captain,bench],xiIds:[11],captainId:11,viceId:22,bank:0,freeTransfers:1,transferRows:[]});
  const lock:LockRecord={event:2,lockedAt:capturedAt,dataUpdatedAt:data.updatedAt,predicted:receipt.squad.predictedTotal,squadIds:[11,22],xiIds:[11],captainId:11,viceId:22,receipt};
  const baseWeek={event:2,points:0,captainId:11,viceCaptainId:22,captainContribution:0,squad:[{elementId:11,position:1,multiplier:2,isCaptain:true,isViceCaptain:false,elementType:3},{elementId:22,position:12,multiplier:0,isCaptain:false,isViceCaptain:true,elementType:3}],playerStats:{"11":{points:0,minutes:90,starts:1,goals:0,assists:0,cleanSheets:0,bonus:0},"22":{points:0,minutes:90,starts:1,goals:0,assists:0,cleanSheets:0,bonus:0}}};
  const triple=evaluateProjectionReceipt(lock,[{...baseWeek,chip:"3xc"}]);
  const boost=evaluateProjectionReceipt(lock,[{...baseWeek,chip:"bboost"}]);
  assert.equal(triple.adjustedProjectedTotal,Number((receipt.squad.predictedTotal+receipt.squad.captainXPts).toFixed(3)));
  assert.equal(boost.adjustedProjectedTotal,Number((receipt.squad.predictedTotal+(receipt.players.find(player=>player[0]===22)?.[4]??0)).toFixed(3)));
});

test("post-GW evaluation keeps tuple-v1 receipts readable without inventing missing horizon forecasts",()=>{
  const out=makePlayer({id:11,name:"Out"}),incoming=makePlayer({id:22,name:"In",teamId:2});
  const deadline="2026-08-23T10:00:00.000Z",capturedAt="2026-08-22T10:00:00.000Z";
  const data:FplData={updatedAt:capturedAt,source:"test",seasonStatsThrough:0,players:[out,incoming],fixtures:[makeFixture({event:2}),makeFixture({id:2,event:3,teamH:2,teamA:1})],events:[{id:2,name:"Gameweek 2",deadline,finished:false,current:false,next:true,dataChecked:false},{id:3,name:"Gameweek 3",deadline:"2026-08-30T10:00:00.000Z",finished:false,current:false,next:false,dataChecked:false}],teams:[{id:1,name:"One",short:"ONE"},{id:2,name:"Two",short:"TWO"}],rules:makeRules()};
  const receipt=createProjectionReceipt({data,eventIds:[2,3],deadline,capturedAt,squad:[out,incoming],xiIds:[11],captainId:11,viceId:22,bank:0,freeTransfers:1,transferRows:[{out,incoming,gain1:1,gain3:2,gain5:3,individualGain1:1,individualGain3:2,individualGain5:3,rankScore:2,netDifference:3,hitCost:0,startProbIn:.8,confidenceIn:.7,risk:"Low",reviewRequired:false,anomalies:[]}]});
  const legacyReceipt={...receipt,schemaVersion:1 as const,playerEncoding:"tuple-v1" as const,players:receipt.players.map(player=>player.slice(0,11) as typeof player)};
  const lock:LockRecord={event:2,lockedAt:capturedAt,dataUpdatedAt:data.updatedAt,predicted:legacyReceipt.squad.predictedTotal,squadIds:[11,22],xiIds:[11],captainId:11,viceId:22,receipt:legacyReceipt};
  const stats=(outPoints:number,inPoints:number)=>({"11":{points:outPoints,minutes:90,starts:1,goals:0,assists:0,cleanSheets:0,bonus:0},"22":{points:inPoints,minutes:90,starts:1,goals:0,assists:0,cleanSheets:0,bonus:0}});
  const result=evaluateProjectionReceipt(lock,[{event:2,points:4,captainId:11,viceCaptainId:22,squad:[{elementId:11,position:1,multiplier:2,isCaptain:true,isViceCaptain:false,elementType:3},{elementId:22,position:12,multiplier:0,isCaptain:false,isViceCaptain:true,elementType:3}],playerStats:stats(2,4)},{event:3,points:5,playerStats:stats(1,6)}]);
  assert.equal(result.status,"evaluated");
  assert.equal(result.transfers[0].actualPlayerSwing,7);
  assert.equal(result.transfers[0].projectedPlayerSwing,null,"v1 did not capture event-by-event horizon forecasts, so the evaluator must not fabricate one");
});

test("projection receipt refuses to label a post-deadline capture as pre-deadline",()=>{
  const player=makePlayer({id:1});
  const deadline="2026-08-23T10:00:00.000Z";
  const data:FplData={updatedAt:deadline,source:"test",seasonStatsThrough:0,players:[player],fixtures:[],events:[],teams:[{id:1,name:"One",short:"ONE"}],rules:makeRules()};
  assert.throws(()=>createProjectionReceipt({data,eventIds:[2],deadline,capturedAt:deadline,squad:[player],xiIds:[1],captainId:1,viceId:1,bank:0,freeTransfers:1,transferRows:[]}),/deadline has passed/i);
});

test("pending, unavailable and legacy evaluations preserve honest model-version provenance",()=>{
  const player=makePlayer({id:1}),deadline="2026-08-23T10:00:00.000Z",capturedAt="2026-08-22T10:00:00.000Z";
  const data:FplData={updatedAt:capturedAt,source:"test",seasonStatsThrough:0,players:[player],fixtures:[],events:[],teams:[{id:1,name:"One",short:"ONE"}],rules:makeRules()};
  const receipt=createProjectionReceipt({data,eventIds:[2],deadline,capturedAt,squad:[player],xiIds:[1],captainId:1,viceId:1,bank:0,freeTransfers:1,transferRows:[]});
  const lock:LockRecord={event:2,lockedAt:capturedAt,dataUpdatedAt:data.updatedAt,predicted:receipt.squad.predictedTotal,squadIds:[1],xiIds:[1],captainId:1,viceId:1,receipt};
  assert.equal(evaluateProjectionReceipt(lock,[]).modelVersion,receipt.modelVersion);
  assert.equal(evaluateProjectionReceipt(lock,[{event:2,points:0,unavailable:true}]).modelVersion,receipt.modelVersion);
  assert.equal(evaluateProjectionReceipt({...lock,receipt:undefined},[]).modelVersion,null);
});

test("accuracy aggregation computes xPts, minutes and probability calibration without mixing denominators",()=>{
  const rows:ProjectionPlayerEvaluationRow[]=[
    {event:2,playerId:1,teamId:1,positionShort:"DEF",projectedPoints:4,actualPoints:6,error:2,signedError:2,expectedMinutes:80,actualMinutes:90,startProbability:.8,started:true,confidence:.8,confidenceBand:"High",calibrationGroup:"established-pl",lowPlContinuityClub:false},
    {event:2,playerId:2,teamId:1,positionShort:"DEF",projectedPoints:.2,actualPoints:0,error:.2,signedError:-.2,expectedMinutes:10,actualMinutes:0,startProbability:.2,started:false,confidence:.4,confidenceBand:"Low",calibrationGroup:"no-pl-prior",lowPlContinuityClub:false},
    {event:2,playerId:3,teamId:2,positionShort:"MID",projectedPoints:3,actualPoints:0,error:3,signedError:-3,expectedMinutes:70,actualMinutes:0,startProbability:.7,started:false,confidence:.6,confidenceBand:"Medium",calibrationGroup:"limited-pl",lowPlContinuityClub:true},
  ];
  const metric=aggregateAccuracy(rows);
  assert.equal(metric.rows,3);
  assert.equal(metric.activeRows,2,"the fringe non-appearance is retained for minutes/start calibration but excluded from active xPts MAE");
  assert.equal(metric.pointsMae,2.5);
  assert.equal(metric.pointsBias,-.5);
  assert.equal(metric.withinTwoPct,50);
  assert.equal(metric.minutesMae,30);
  assert.equal(metric.startBrier,.19);
});

test("confidence bands have stable documented boundaries",()=>{
  assert.equal(projectionConfidenceBand(.75),"High");
  assert.equal(projectionConfidenceBand(.749),"Medium");
  assert.equal(projectionConfidenceBand(.5),"Medium");
  assert.equal(projectionConfidenceBand(.499),"Low");
});

test("transfer accuracy excludes pending routes instead of counting them as zero",()=>{
  const route=(overrides:Partial<ProjectionTransferEvaluation>):ProjectionTransferEvaluation=>({rank:1,outId:1,outName:"Out",incomingId:2,incomingName:"In",completedEvents:1,horizonEvents:5,projectedPlayerSwing:2,actualPlayerSwing:3,actualNetAfterHit:3,projectedFive:6,hitCost:0,reviewRequired:false,...overrides});
  const metric=aggregateTransferAccuracy([route({}),route({rank:2,projectedPlayerSwing:1,actualPlayerSwing:-1,actualNetAfterHit:-5,hitCost:4}),route({rank:3,completedEvents:0,projectedPlayerSwing:null,actualPlayerSwing:null,actualNetAfterHit:null})]);
  assert.equal(metric.rows,2);
  assert.equal(metric.projectedAverage,1.5);
  assert.equal(metric.actualAverage,1);
  assert.equal(metric.netAfterHitAverage,-1);
  assert.equal(metric.positivePct,50);
});

test("reconciliation: every GW/3GW/5GW transfer delta returned by bestTransfers equals IN minus OUT exactly", () => {
  const out = makePlayer({ id: 2, positionId: 3, position: "Midfielder", positionShort: "MID", price: 5.5, teamId: 1, priorMinutes: 1636, priorStarts: 18, priorExpectedGoals: 1.39, priorExpectedAssists: 3.95, priorPointsPerGame: 4.1 });
  const gkps = [1, 2].map((n) => makePlayer({ id: 100 + n, positionId: 1, position: "Goalkeeper", positionShort: "GKP", price: 4.5, teamId: 100 + n }));
  const defs = [1, 2, 3, 4, 5].map((n) => makePlayer({ id: 10 + n, positionId: 2, position: "Defender", positionShort: "DEF", price: 4.5, teamId: 110 + n }));
  const mids = [out, ...[1, 2, 3, 4].map((n) => makePlayer({ id: 20 + n, positionId: 3, position: "Midfielder", positionShort: "MID", price: 5.0, teamId: 120 + n }))];
  const fwds = [1, 2, 3].map((n) => makePlayer({ id: 30 + n, positionId: 4, position: "Forward", positionShort: "FWD", price: 5.5, teamId: 130 + n }));
  const squad = [...gkps, ...defs, ...mids, ...fwds];
  assert.equal(squad.length, 15);

  const incoming = makePlayer({ id: 500, positionId: 3, position: "Midfielder", positionShort: "MID", price: 6.0, teamId: 6, priorMinutes: 2930, priorStarts: 33, priorExpectedGoals: 5.22, priorExpectedAssists: 5.95, priorPointsPerGame: 4.1, selectedBy: 10.7 });

  const fixtures = [1, 2, 3, 4, 5].flatMap((event) => [
    makeFixture({ id: event * 10 + 1, event, teamH: out.teamId, teamA: 900 }),
    makeFixture({ id: event * 10 + 2, event, teamH: incoming.teamId, teamA: 901 }),
  ]);
  const events = [
    { id: 1, name: "Gameweek 1", deadline: new Date(Date.now() + 86400000).toISOString(), current: false, next: true, finished: false, dataChecked: false },
    { id: 2, name: "Gameweek 2", deadline: new Date(Date.now() + 2 * 86400000).toISOString(), current: false, next: false, finished: false, dataChecked: false },
    { id: 3, name: "Gameweek 3", deadline: new Date(Date.now() + 3 * 86400000).toISOString(), current: false, next: false, finished: false, dataChecked: false },
    { id: 4, name: "Gameweek 4", deadline: new Date(Date.now() + 4 * 86400000).toISOString(), current: false, next: false, finished: false, dataChecked: false },
    { id: 5, name: "Gameweek 5", deadline: new Date(Date.now() + 5 * 86400000).toISOString(), current: false, next: false, finished: false, dataChecked: false },
  ];

  const data: FplData = {
    updatedAt: new Date().toISOString(),
    source: "test",
    seasonStatsThrough: 0,
    players: [...squad, incoming],
    fixtures,
    events,
    teams: [...new Set([...squad, incoming].map((p) => p.teamId))].map((id) => ({ id, name: `Team ${id}`, short: `T${id}` })),
    rules: makeRules(),
  };

  assert.equal(isValidSquad(squad, data), true, "test fixture squad must be a legal 15-player squad");

  const rows = bestTransfers(data, squad, 5);
  const row = rows.find((r: Transfer) => r.out.id === out.id && r.incoming.id === incoming.id);
  assert.ok(row, "expected the constructed OUT->IN transfer to appear among candidates");

  const eventIds = [1, 2, 3, 4, 5];
  const outByEvent = eventIds.map((e) => playerProjection(out, e, fixtures, 1));
  const inByEvent = eventIds.map((e) => playerProjection(incoming, e, fixtures, 1));

  assert.ok(Math.abs(row!.individualGain1 - (inByEvent[0] - outByEvent[0])) < 1e-9, "individual GW1 delta must equal IN GW1 minus OUT GW1 exactly");
  assert.ok(Math.abs(row!.individualGain3 - (inByEvent.slice(0, 3).reduce((a, b) => a + b, 0) - outByEvent.slice(0, 3).reduce((a, b) => a + b, 0))) < 1e-9, "individual 3-GW delta must equal IN minus OUT exactly");
  assert.ok(Math.abs(row!.individualGain5 - (inByEvent.reduce((a, b) => a + b, 0) - outByEvent.reduce((a, b) => a + b, 0))) < 1e-9, "individual 5-GW delta must equal IN minus OUT exactly");

  const swapped=squad.map(player=>player.id===out.id?incoming:player);
  const squadDeltas=eventIds.map(event=>bestXi(swapped,event,fixtures,1).total-bestXi(squad,event,fixtures,1).total);
  assert.ok(Math.abs(row!.gain1-squadDeltas[0])<1e-9,"ranked GW1 gain must be the whole-squad XI/captain delta");
  assert.ok(Math.abs(row!.gain3-squadDeltas.slice(0,3).reduce((a,b)=>a+b,0))<1e-9,"ranked 3-GW gain must be the whole-squad delta");
  assert.ok(Math.abs(row!.gain5-squadDeltas.reduce((a,b)=>a+b,0))<1e-9,"ranked 5-GW gain must be the whole-squad delta");

  // Same underlying raw xPts metric on both sides — not weighted, not captain-doubled, not bench-discounted.
  assert.ok(Math.abs(row!.outGw1 - outByEvent[0]) < 1e-9);
  assert.ok(Math.abs(row!.inGw1 - inByEvent[0]) < 1e-9);
});

test("regression: a promoted player with no PL prior cannot turn one live haul into elite future attacking output",()=>{
  const promoted=makePlayer({id:586,name:"Mendy",positionShort:"DEF",positionId:2,priorSource:"position-baseline",priorMinutes:0,priorStarts:0,priorPointsPerGame:15,priorExpectedGoals:0,priorExpectedAssists:0,minutes:0,starts:0,eventMinutes:63,eventPoints:15,selectedBy:1.3,teamStrengthHome:2,teamStrengthAway:2});
  const fixtures=[makeFixture({event:1,teamH:promoted.teamId,teamA:99,teamHDifficulty:3})];
  const metrics=projectionMetrics(promoted,1,fixtures,1);
  assert.ok(metrics.xPts<3,`no-PL-prior promoted defender projected ${metrics.xPts.toFixed(2)} xPts from one provisional haul`);
  assert.ok(metrics.xG<.08&&metrics.xA<.08,`provisional points must not be converted into manufactured xG/xA; got ${metrics.xG.toFixed(2)}/${metrics.xA.toFixed(2)}`);
});

test("calibration groups distinguish established, limited, absent and newly established PL evidence",()=>{
  assert.equal(playerCalibrationProfile(makePlayer({priorSource:"official-pl-history",priorMinutes:1800})).group,"established-pl");
  assert.equal(playerCalibrationProfile(makePlayer({priorSource:"official-pl-history",priorMinutes:63})).group,"limited-pl");
  assert.equal(playerCalibrationProfile(makePlayer({priorSource:"position-baseline",priorMinutes:0,minutes:200})).group,"no-pl-prior");
  assert.equal(playerCalibrationProfile(makePlayer({priorSource:"position-baseline",priorMinutes:0,minutes:900})).group,"current-pl-established");
});

// The route solver's eligibleAt() and this gate's hard floors used to be two independently
// hardcoded copies of .55/45/.35 that happened to agree numerically, not by construction (found
// during retroactive review of 4f8762e). This test drives the boundary off ROLE_SECURITY_FLOOR
// itself rather than restating .55/45/.35 as fresh literals here too -- if evaluateTransferQuality
// ever stops reading the shared constant, this test breaks even though the numbers still "look"
// the same, because it no longer tracks whatever ROLE_SECURITY_FLOOR is changed to.
test("transfer quality gate: the hard floors move with ROLE_SECURITY_FLOOR, not a second hardcoded copy",()=>{
  // Margins are wide enough to clear both the hard floor under test and the separate (higher)
  // watch-level thresholds, so the baseline lands cleanly on "actionable" and only the deliberate
  // hard-floor violations below flip it to "blocked" -- isolating exactly what this test checks.
  const base={gain1:1,gain3:3,gain5:5,weeklyGains:[1,1,1,1,1],expectedMinutes:ROLE_SECURITY_FLOOR.expectedMinutes+40,startProbability:ROLE_SECURITY_FLOOR.startProbability+.3,confidence:ROLE_SECURITY_FLOOR.confidence+.3,calibrationGroup:"established-pl" as const,lowPlContinuityClub:false,anomalyCodes:[]};
  assert.equal(evaluateTransferQuality(base).status,"actionable","clearing every floor with margin must not be blocked");
  assert.equal(evaluateTransferQuality({...base,startProbability:ROLE_SECURITY_FLOOR.startProbability-.01}).status,"blocked","just below the shared start-probability floor must block");
  assert.equal(evaluateTransferQuality({...base,expectedMinutes:ROLE_SECURITY_FLOOR.expectedMinutes-1}).status,"blocked","just below the shared expected-minutes floor must block");
  assert.equal(evaluateTransferQuality({...base,confidence:ROLE_SECURITY_FLOOR.confidence-.01}).status,"blocked","just below the shared confidence floor must block");
});

test("transfer quality gate: a secure established route with multi-week gains is actionable",()=>{
  const quality=evaluateTransferQuality({gain1:1.2,gain3:3.4,gain5:5.7,weeklyGains:[1.2,1.1,1.1,1.2,1.1],expectedMinutes:84,startProbability:.94,confidence:.82,calibrationGroup:"established-pl",lowPlContinuityClub:false,anomalyCodes:[]});
  assert.equal(quality.status,"actionable");
  assert.equal(quality.positiveWeeks,5);
  assert.ok(quality.gainWithoutBestWeek>0);
  assert.ok(quality.score>=70);
});

test("transfer quality gate: the Hull-style huge gain with no PL evidence and insecure minutes is blocked",()=>{
  const quality=evaluateTransferQuality({gain1:15,gain3:19,gain5:23.8,weeklyGains:[15,2,2,2,2.8],expectedMinutes:14,startProbability:.15,confidence:.30,calibrationGroup:"no-pl-prior",lowPlContinuityClub:true,anomalyCodes:["five-gw-gain-anomaly","low-certainty-elite-projection","high-risk-top-recommendation"]});
  assert.equal(quality.status,"blocked");
  assert.ok(quality.score<=39);
  assert.ok(quality.reasons.some(reason=>reason.code==="projection-plausibility"));
  assert.ok(quality.reasons.some(reason=>reason.code==="insufficient-start-probability"));
  assert.ok(quality.reasons.some(reason=>reason.code==="insufficient-expected-minutes"));
});

test("transfer quality gate: one-gameweek upside is watchlist evidence, not a recommendation",()=>{
  const quality=evaluateTransferQuality({gain1:5,gain3:4.8,gain5:4.8,weeklyGains:[5,-.2,0,0,0],expectedMinutes:86,startProbability:.95,confidence:.84,calibrationGroup:"established-pl",lowPlContinuityClub:false,anomalyCodes:[]});
  assert.equal(quality.status,"watchlist");
  assert.ok(quality.reasons.some(reason=>reason.code==="single-week-dependence"));
});

test("transfer quality gate: no genuine PL prior remains watchlist even with a secure projected role",()=>{
  const quality=evaluateTransferQuality({gain1:1,gain3:3,gain5:5,weeklyGains:[1,1,1,1,1],expectedMinutes:82,startProbability:.92,confidence:.58,calibrationGroup:"no-pl-prior",lowPlContinuityClub:true,anomalyCodes:[]});
  assert.equal(quality.status,"watchlist");
  assert.ok(quality.reasons.some(reason=>reason.code==="no-pl-evidence"));
  assert.ok(quality.reasons.some(reason=>reason.code==="low-club-continuity"));
});

test("transfer quality gate: blocked and watchlist rows cannot become the primary recommendation",()=>{
  const out=makePlayer({id:1,name:"Out"}),safeIn=makePlayer({id:2,name:"Safe"}),blockedIn=makePlayer({id:3,name:"Blocked"}),watchIn=makePlayer({id:4,name:"Watch"});
  const row=(incoming:FplPlayer,status:Transfer["qualityStatus"],rankScore:number)=>({out,incoming,qualityStatus:status,rankScore,netDifference:rankScore} as Transfer);
  const blocked=row(blockedIn,"blocked",99),watch=row(watchIn,"watchlist",50),safe=row(safeIn,"actionable",3.1);
  assert.deepEqual(sortTransfersByQuality([blocked,watch,safe]).map(item=>item.incoming.name),["Safe","Watch","Blocked"]);
  assert.equal(selectPrimaryTransfer([blocked,watch,safe])?.incoming.id,safeIn.id);
  assert.equal(selectPrimaryTransfer([blocked,watch]),null);
});

// Overview's "THIS WEEK'S RECOMMENDATION" card and CoachDock's floating-orb summary previously
// re-derived their own "is this transfer good enough to recommend" check with an independently
// hardcoded `rankScore<2.2`/`rankScore>=2.2` comparison, instead of calling the same
// selectPrimaryTransfer() the Transfers page uses. All three agreed by coincidence -- the
// underlying rankScore cap for blocked/watchlist rows happened to keep them under 2.2 too -- but
// nothing enforced that agreement, so a future change to selectPrimaryTransfer's threshold could
// silently desync Overview/CoachDock from Transfers. This locks in that the duplication is gone:
// selectPrimaryTransfer is the only place either 2.2 or a rankScore comparison against it appears.
test("Overview and CoachDock select the primary transfer via selectPrimaryTransfer, not an independently duplicated 2.2 threshold",()=>{
  const source=readFileSync(new URL("../app/components/CoachApp.tsx",import.meta.url),"utf-8");
  const overview=source.slice(source.indexOf("function Overview("),source.indexOf("function WhatChanged("));
  const coachDock=source.slice(source.indexOf("function CoachDock("));
  for(const [name,body] of [["Overview",overview],["CoachDock",coachDock]] as const){
    assert.ok(body.includes("selectPrimaryTransfer("),`${name} must call selectPrimaryTransfer to pick its headline route`);
    assert.ok(!/rankScore\s*[<>]=?\s*2\.2/.test(body),`${name} must not independently compare rankScore against the 2.2 action threshold`);
    assert.ok(!body.includes(".reviewRequired"),`${name} must not re-check .reviewRequired alongside the shared selector -- it is already folded into qualityStatus/rankScore`);
  }
});

test("transfer quality gate: optimizer utility cannot lift a blocked route back into recommendation",()=>{
  const out=makePlayer({id:1,name:"Out"}),incoming=makePlayer({id:2,name:"Blocked"});
  const blocked={out,incoming,qualityStatus:"blocked",rankScore:0,netDifference:20} as Transfer;
  const optimizer={evaluate:(players:FplPlayer[])=>({objective:players[0]?.id===incoming.id?100:0})} as unknown as Parameters<typeof withModelUtilityChange>[2];
  const [adjusted]=withModelUtilityChange([blocked],[out],optimizer);
  assert.equal(adjusted.qualityStatus,"blocked");
  assert.ok(adjusted.rankScore<=0);
  assert.equal(selectPrimaryTransfer([adjusted]),null);
});

test("roster PL continuity identifies low-evidence club context without hardcoding club names",()=>{
  const returning=plRosterContinuity([1800,1800,1800,0]);
  const low=plRosterContinuity([1800,0,0,0]);
  assert.equal(returning,.75);
  assert.equal(low,.25);
  assert.equal(isLowPlContinuity(returning),false);
  assert.equal(isLowPlContinuity(low),true);
});

test("low-PL-continuity context lowers the confidence ceiling for the same limited-prior player",()=>{
  const base=makePlayer({priorSource:"official-pl-history",priorMinutes:899,priorStarts:12,minutes:900,starts:10,teamMatchesPlayed:10,selectedBy:30});
  const fixtures=[makeFixture({event:1,teamH:base.teamId,teamA:99,teamHDifficulty:3})];
  const establishedContext=projectionMetrics({...base,lowPlContinuityClub:false},1,fixtures,1);
  const lowContinuityContext=projectionMetrics({...base,lowPlContinuityClub:true},1,fixtures,1);
  assert.equal(establishedContext.calibrationGroup,"limited-pl");
  assert.equal(establishedContext.confidenceCap,.72);
  assert.equal(lowContinuityContext.confidenceCap,.64);
  assert.ok(lowContinuityContext.confidence<establishedContext.confidence,"promoted/low-continuity context must influence model confidence, not merely add a warning");
});

test("regression: goalkeeper PPG never manufactures attacking xG or xA",()=>{
  const keeper=makePlayer({id:572,positionShort:"GKP",positionId:1,priorSource:"position-baseline",priorMinutes:0,priorStarts:0,priorPointsPerGame:10,minutes:0,starts:0,selectedBy:.6,teamStrengthHome:2,teamStrengthAway:2});
  const metrics=projectionMetrics(keeper,1,[makeFixture({event:1,teamH:keeper.teamId,teamA:99,teamHDifficulty:2})],1);
  assert.ok(metrics.xG<.01&&metrics.xA<.02,`goalkeeper received implausible attacking output: ${metrics.xG.toFixed(3)} xG / ${metrics.xA.toFixed(3)} xA`);
});

test("own-team defensive strength changes clean-sheet probability independently of opponent FDR",()=>{
  const weak=makePlayer({id:300,positionShort:"DEF",positionId:2,teamId:1,teamStrengthHome:2,teamStrengthAway:2});
  const strong=makePlayer({id:301,positionShort:"DEF",positionId:2,teamId:2,teamStrengthHome:5,teamStrengthAway:5});
  const fixtures=[makeFixture({id:1,event:1,teamH:1,teamA:99,teamHDifficulty:3}),makeFixture({id:2,event:1,teamH:2,teamA:98,teamHDifficulty:3})];
  const weakMetrics=projectionMetrics(weak,1,fixtures,1),strongMetrics=projectionMetrics(strong,1,fixtures,1);
  assert.ok(strongMetrics.cleanSheetProbability>weakMetrics.cleanSheetProbability,"strong and weak own defences must not get the same CS probability against equal FDR");
  assert.ok(strongMetrics.xPts>weakMetrics.xPts,"own-team strength must affect defender xPts, not merely annotate it");
});

test("determinism: identical data produces identical projections across repeated calls", () => {
  const player = makePlayer({ id: 42, priorMinutes: 1200, priorStarts: 15, priorExpectedGoals: 4, priorExpectedAssists: 2 });
  const fixtures = [makeFixture({ event: 1, teamH: player.teamId, teamA: 2 })];
  const first = projectionMetrics(player, 1, fixtures, 1);
  const second = projectionMetrics(player, 1, fixtures, 1);
  assert.deepEqual(first, second, "calling projectionMetrics twice with identical inputs must yield byte-identical output");
});

test("identity integrity: clean data reports no conflicts, and a duplicate id with different teams is detected", () => {
  const clean = [makePlayer({ id: 1, teamId: 1 }), makePlayer({ id: 2, teamId: 2 })];
  assert.deepEqual(findIdentityConflicts(clean), []);

  const conflicting = [
    makePlayer({ id: 112, teamId: 6, positionId: 2, positionShort: "DEF" }),
    makePlayer({ id: 112, teamId: 19, positionId: 2, positionShort: "DEF" }),
  ];
  const conflicts = findIdentityConflicts(conflicting);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].issue, /conflicting teams/);
});

test("regression: bonus/DC/saves per-start rates shrink toward a baseline for a 1-start outlier sample, not just xG/xA", () => {
  // A single freak match (1 start) shouldn't set the season-long per-start rate at face value
  // for bonus, defensive contribution or saves either — same class of bug as the xG90 fix.
  const oneStartOutlierDef = makePlayer({ id: 200, positionShort: "DEF", positionId: 2, priorMinutes: 90, priorStarts: 1, priorBonus: 3, priorDefensiveContribution: 15, priorExpectedGoals: 0, priorExpectedAssists: 0 });
  const establishedDef = makePlayer({ id: 201, positionShort: "DEF", positionId: 2, priorMinutes: 3200, priorStarts: 36, priorBonus: 8, priorDefensiveContribution: 300, priorExpectedGoals: 0.5, priorExpectedAssists: 1 });
  const fixtures = [makeFixture({ event: 1, teamH: 1, teamA: 2 })];
  const outlier = projectionMetrics(oneStartOutlierDef, 1, fixtures, 1);
  const established = projectionMetrics({ ...establishedDef, teamId: 1 }, 1, fixtures, 1);
  assert.ok(
    outlier.xPts < established.xPts,
    `a 1-start outlier (bonus=3, DC=15 in that single match) must not outproject an established defender via unshrunk bonus/DC rates; got outlier=${outlier.xPts.toFixed(2)}, established=${established.xPts.toFixed(2)}`,
  );

  const oneStartGkp = makePlayer({ id: 210, positionShort: "GKP", positionId: 1, priorMinutes: 90, priorStarts: 1, priorSaves: 12, priorPenaltiesSaved: 1 });
  const gkpMetrics = projectionMetrics(oneStartGkp, 1, fixtures, 1);
  assert.ok(gkpMetrics.saves < 6, `a 1-start goalkeeper with 12 saves in that single match must not project ~12 saves/match going forward, got ${gkpMetrics.saves.toFixed(2)}`);
});

test("DC scoring is probability-weighted: a low-minutes player with a high per-start action rate does not get full linear credit", () => {
  // Mirrors the real Mosquera case: high mean actions/start (10.56) but low expected minutes (~30).
  const rotationRisk = makePlayer({ id: 11, positionShort: "DEF", positionId: 2, price: 5.5, priorMinutes: 986, priorStarts: 9, priorDefensiveContribution: 95, selectedBy: 6.9 });
  const fixtures = [makeFixture({ event: 1, teamH: rotationRisk.teamId, teamA: 2 })];
  const metrics = projectionMetrics(rotationRisk, 1, fixtures, 1);
  // Old linear formula gave clamp(95/9/10, 0, .9) * sixtyProb ~= 0.9 * ~0.2 = ~0.18-0.2.
  assert.ok(metrics.defensiveContribution < 0.15, `expected low-minutes player's DC credit to be discounted by probability of reaching the match threshold, got ${metrics.defensiveContribution.toFixed(3)}`);
});

test("regression: bench order always keeps the backup GK last, even when they outproject an outfield bench player", () => {
  // Reproduces the real Raya-vs-Gabriel case: a moderately-projected backup GK must never rank
  // above an outfield bench player, since a backup GK can only ever sub in for the starting GK.
  const starterGkp = makePlayer({ id: 1, positionShort: "GKP", positionId: 1, teamId: 1, priorMinutes: 3400, priorStarts: 38, priorSaves: 120, selectedBy: 20 });
  const backupGkp = makePlayer({ id: 2, positionShort: "GKP", positionId: 1, teamId: 2, priorMinutes: 1800, priorStarts: 20, priorSaves: 70, selectedBy: 3 });
  const defs = [1, 2, 3, 4].map((n) => makePlayer({ id: 10 + n, positionShort: "DEF", positionId: 2, teamId: 10 + n, priorMinutes: 3200, priorStarts: 36, priorExpectedGoals: 1, priorExpectedAssists: 1.5, priorDefensiveContribution: 200 }));
  const weakDef = makePlayer({ id: 15, positionShort: "DEF", positionId: 2, teamId: 15, priorMinutes: 0, priorStarts: 0, selectedBy: 0 }); // near-zero projection, should out-rank nobody
  const mids = [1, 2, 3, 4, 5].map((n) => makePlayer({ id: 20 + n, positionShort: "MID", positionId: 3, teamId: 20 + n, priorMinutes: 2800, priorStarts: 32, priorExpectedGoals: 4, priorExpectedAssists: 4 }));
  const fwds = [1, 2, 3].map((n) => makePlayer({ id: 30 + n, positionShort: "FWD", positionId: 4, teamId: 30 + n, priorMinutes: 2600, priorStarts: 30, priorExpectedGoals: 8, priorExpectedAssists: 2 }));
  const squad = [starterGkp, backupGkp, ...defs, weakDef, ...mids, ...fwds];
  assert.equal(squad.length, 15);

  const fixtures = squad.map((p) => makeFixture({ id: p.teamId, event: 1, teamH: p.teamId, teamA: 900 + p.teamId }));
  const events = [{ id: 1, name: "Gameweek 1", deadline: new Date(Date.now() + 86400000).toISOString(), current: false, next: true, finished: false, dataChecked: false }];
  const data: FplData = {
    updatedAt: new Date().toISOString(), source: "test", seasonStatsThrough: 0,
    players: squad, fixtures, events,
    teams: squad.map((p) => ({ id: p.teamId, name: `Team ${p.teamId}`, short: `T${p.teamId}` })),
    rules: makeRules(),
  };

  assert.equal(isValidSquad(squad, data), true, "test fixture squad must be a legal 15-player squad");
  const a = analysis(data, squad)!;
  assert.ok(a, "analysis() must return a result for a valid squad");
  assert.equal(a.bench[a.bench.length - 1].positionShort, "GKP", "the backup GK must always be the last bench entry, regardless of raw xPts");
  // Confirm this isn't vacuous: the backup GK's xPts must genuinely exceed the weakest outfield
  // bench player's, so the GK-last guard is doing real work, not just matching a lucky ordering.
  const gkXpts = playerProjection(backupGkp, 1, fixtures, 1);
  const outfieldBenchXpts = a.bench.filter((p) => p.positionShort !== "GKP").map((p) => playerProjection(p, 1, fixtures, 1));
  assert.ok(outfieldBenchXpts.some((x) => x < gkXpts), "test setup should produce a backup GK who out-projects at least one outfield bench player, otherwise this test doesn't exercise the guard");
});

test("identity-warning wiring: attachIntegrityWarnings (the exact function the API route calls) surfaces conflicts, and is silent on clean data", () => {
  const clean = { players: [makePlayer({ id: 1, teamId: 1 }), makePlayer({ id: 2, teamId: 2 })] };
  const cleanResult = attachIntegrityWarnings(clean);
  assert.deepEqual(cleanResult.dataIntegrityWarnings, []);

  const conflicting = {
    players: [
      makePlayer({ id: 112, teamId: 6, positionId: 2, positionShort: "DEF" }),
      makePlayer({ id: 112, teamId: 19, positionId: 2, positionShort: "DEF" }),
    ],
  };
  const conflictResult = attachIntegrityWarnings(conflicting);
  assert.equal(conflictResult.dataIntegrityWarnings.length, 1);
  assert.match(conflictResult.dataIntegrityWarnings[0], /conflicting teams/);
});
