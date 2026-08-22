import assert from "node:assert/strict";
import test from "node:test";
import {
  FplData,
  FplFixture,
  FplPlayer,
  PROJECTION_MODEL_VERSION,
  attachIntegrityWarnings,
  bestXi,
  findIdentityConflicts,
  isValidSquad,
  playerProjection,
  projectionMetrics,
} from "../app/lib/fpl.ts";
import { HistoryWeek, LockRecord, ProjectionPlayerEvaluationRow, ProjectionTransferEvaluation, aggregateAccuracy, aggregateTransferAccuracy, analysis, bestTransfers, createProjectionReceipt, evaluateProjectionReceipt, projectionConfidenceBand, Transfer } from "../app/components/CoachApp.tsx";

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Test", firstName: "Test", secondName: "Player", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, status: "a", chance: null,
    epNext: 2, form: 2, pointsPerGame: 3, priorPointsPerGame: 3, priorMinutes: 1500, priorStarts: 20,
    priorExpectedGoals: 3, priorExpectedAssists: 3, priorBonus: 10, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 100, totalPoints: 0, eventPoints: 0, eventMinutes: 0, selectedBy: 10, priceChange: 0, priceProjectionToday: 0,
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
  const transferRows=[{out:captain,incoming:target,gain1:1.2345,gain3:2.3456,gain5:3.4567,individualGain1:1.1111,individualGain3:3.3333,individualGain5:4.5678,rankScore:2.2222,netDifference:3.4567,hitCost:0,startProbIn:.6543,confidenceIn:.4321,risk:"Medium" as const,reviewRequired:true,anomalies:[{code:"test-warning",message:"Test"}]}];
  const receipt=createProjectionReceipt({data,eventIds:[2,3],deadline,capturedAt,squad:[captain],xiIds:[captain.id],captainId:captain.id,viceId:target.id,bank:1.5,freeTransfers:2,transferRows});
  assert.equal(receipt.schemaVersion,3);
  assert.equal(receipt.modelVersion,PROJECTION_MODEL_VERSION);
  assert.equal(receipt.playerEncoding,"tuple-v3");
  assert.deepEqual(receipt.players.map(player=>player[0]),[11,22],"every official player is captured in deterministic id order");
  assert.equal(receipt.players[0][11]?.length,2,"each player freezes the full evaluation horizon");
  assert.equal(receipt.players[0][12],1,"team identity is frozen at prediction time");
  assert.equal(receipt.players[0][13],"MID","position is frozen at prediction time");
  assert.equal(receipt.players[1][3],"position-baseline");
  assert.deepEqual(receipt.eventIds,[2,3]);
  assert.equal(receipt.squad.captainId,11);
  assert.equal(receipt.squad.viceId,22);
  assert.equal(receipt.assumptions.freeTransfers,2);
  assert.equal(receipt.transfers[0].rank,1);
  assert.equal(receipt.transfers[0].incomingId,22);
  assert.equal(receipt.transfers[0].rankScore,2.222);
  assert.deepEqual(receipt.transfers[0].anomalyCodes,["test-warning"]);
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
  assert.equal(result.officialPlanMatch,true);
  assert.equal(result.managerActual,6,"official net points stay visible");
  assert.equal(result.actualBeforeHits,10,"projection accuracy is graded against scoring output before transfer-cost accounting");
  assert.equal(result.completedEvents,2);
  assert.ok(result.population&&result.population.rows===4,"both players across both completed events are calibrated");
  assert.equal(result.captain?.actualRaw,5);
  assert.equal(result.captain?.officialContribution,10);
  assert.equal(result.playerRows.length,2,"the dashboard receives one-step-ahead rows, not hindsight-weighted future rows");
  assert.deepEqual({teamId:result.playerRows[0].teamId,position:result.playerRows[0].positionShort,band:result.playerRows[0].confidenceBand},{teamId:1,position:"MID",band:projectionConfidenceBand(result.playerRows[0].confidence)});
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

test("accuracy aggregation computes xPts, minutes and probability calibration without mixing denominators",()=>{
  const rows:ProjectionPlayerEvaluationRow[]=[
    {event:2,playerId:1,teamId:1,positionShort:"DEF",projectedPoints:4,actualPoints:6,error:2,signedError:2,expectedMinutes:80,actualMinutes:90,startProbability:.8,started:true,confidence:.8,confidenceBand:"High"},
    {event:2,playerId:2,teamId:1,positionShort:"DEF",projectedPoints:.2,actualPoints:0,error:.2,signedError:-.2,expectedMinutes:10,actualMinutes:0,startProbability:.2,started:false,confidence:.4,confidenceBand:"Low"},
    {event:2,playerId:3,teamId:2,positionShort:"MID",projectedPoints:3,actualPoints:0,error:3,signedError:-3,expectedMinutes:70,actualMinutes:0,startProbability:.7,started:false,confidence:.6,confidenceBand:"Medium"},
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
