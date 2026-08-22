import assert from "node:assert/strict";
import test from "node:test";
import { FplPlayer } from "../app/lib/fpl.ts";
import { OfficialScoringAuthority, resolveCaptainMultiplier, resolveLiveScoring } from "../app/components/CoachApp.tsx";

function makePlayer(id:number,name:string,positionShort:string,eventPoints=1,eventMinutes=90):FplPlayer{
  const positionId=positionShort==="GKP"?1:positionShort==="DEF"?2:positionShort==="MID"?3:4;
  return{id,name,firstName:name,secondName:"",teamId:id,teamName:`Team ${id}`,teamShort:`T${id}`,positionId,position:positionShort,positionShort,price:5,status:"a",chance:null,epNext:4,form:4,pointsPerGame:4,priorPointsPerGame:4,priorMinutes:1800,priorStarts:20,priorExpectedGoals:2,priorExpectedAssists:2,priorBonus:5,priorSaves:0,priorPenaltiesSaved:0,priorDefensiveContribution:0,totalPoints:0,eventPoints,eventMinutes,selectedBy:10,priceChange:0,priceProjectionToday:0,transfersIn:0,transfersOut:0,goals:0,assists:0,expectedGoals:0,expectedAssists:0,expectedGoalInvolvements:0,expectedGoalsConceded:0,cleanSheets:0,goalsConceded:0,minutes:0,starts:0,bonus:0,bps:0,ictIndex:0,influence:0,creativity:0,threat:0,saves:0,penaltiesSaved:0,defensiveContribution:0,clearancesBlocksInterceptions:0,recoveries:0,tackles:0,penaltiesOrder:null,directFreekicksOrder:null,cornersOrder:null,scoutRisks:[],news:"",newsAdded:null};
}

function makeSquad(){
  const xi=[
    makePlayer(1,"GK","GKP"),
    makePlayer(2,"DEF1","DEF"),makePlayer(3,"DEF2","DEF"),makePlayer(4,"DEF3","DEF"),makePlayer(5,"DEF4","DEF"),
    makePlayer(6,"MID1","MID",4),makePlayer(7,"MID2","MID"),makePlayer(8,"MID3","MID"),makePlayer(9,"MID4","MID"),
    makePlayer(10,"Captain","FWD",5),makePlayer(11,"FWD2","FWD"),
  ];
  const bench=[makePlayer(12,"Bench GK","GKP",2),makePlayer(13,"Bench DEF","DEF",3),makePlayer(14,"Bench MID","MID",4),makePlayer(15,"Bench FWD","FWD",5)];
  return{xi,bench};
}

const authority=(chip:string|null,event=1,captainId=10,viceCaptainId=6):OfficialScoringAuthority=>({event,chip,captainId,viceCaptainId});
const resolve=(options:Partial<Parameters<typeof resolveLiveScoring>[0]>={})=>{
  const{xi,bench}=makeSquad();
  return resolveLiveScoring({xi,bench,localCaptainId:10,localViceId:6,eventId:1,deadlinePassed:true,official:authority(null),finalizeAutosubs:false,...options});
};

test("normal captaincy applies x2 from the shared resolver",()=>{
  const result=resolve();
  assert.equal(result.captainMultiplier,2);
  assert.equal(result.captainBonus,5);
  assert.equal(result.liveTotal,result.effectiveXi.reduce((sum,p)=>sum+p.eventPoints,0)+5);
});

test("Triple Captain uses the official 3xc code and applies x3",()=>{
  const result=resolve({official:authority("3xc")});
  assert.equal(resolveCaptainMultiplier(true,"3xc"),3);
  assert.equal(result.captainMultiplier,3);
  assert.equal(result.captainBonus,10);
});

test("Triple Captain transfers the x3 multiplier to a playing vice when the captain records zero minutes",()=>{
  const{xi,bench}=makeSquad();
  xi.find(p=>p.id===10)!.eventMinutes=0;
  const result=resolveLiveScoring({xi,bench,localCaptainId:10,localViceId:6,eventId:1,deadlinePassed:true,official:authority("3xc"),finalizeAutosubs:true});
  assert.equal(result.armbandPassedToVice,true);
  assert.equal(result.effectiveCaptainId,6);
  assert.equal(result.captainMultiplier,3);
  assert.equal(result.captainBonus,8);
});

test("captain and vice both recording zero minutes removes the captain multiplier",()=>{
  const{xi,bench}=makeSquad();
  xi.find(p=>p.id===10)!.eventMinutes=0;
  xi.find(p=>p.id===6)!.eventMinutes=0;
  const result=resolveLiveScoring({xi,bench,localCaptainId:10,localViceId:6,eventId:1,deadlinePassed:true,official:authority("3xc"),finalizeAutosubs:true});
  assert.equal(result.captaincyLost,true);
  assert.equal(result.effectiveCaptainId,null);
  assert.equal(result.captainMultiplier,1);
  assert.equal(result.captainBonus,0);
});

test("Bench Boost adds every displayed bench player's raw points exactly once",()=>{
  const result=resolve({official:authority("bboost")});
  const expectedBench=result.displayedBench.reduce((sum,p)=>sum+p.eventPoints,0);
  assert.equal(result.benchBoostPoints,expectedBench);
  assert.equal(result.liveTotal,result.effectiveXi.reduce((sum,p)=>sum+p.eventPoints,0)+result.captainBonus+expectedBench);
  assert.equal(result.captainMultiplier,2);
});

test("a different active chip leaves standard captaincy at x2",()=>{
  const result=resolve({official:authority("wildcard")});
  assert.equal(result.captainMultiplier,2);
  assert.equal(result.benchBoostPoints,0);
});

test("an unconnected account defaults honestly to x2, never guessed up to x3",()=>{
  const result=resolve({official:null});
  assert.equal(result.captaincySource,"local");
  assert.equal(result.activeChip,null);
  assert.equal(result.captainMultiplier,2);
});

test("post-deadline official captaincy overrides a conflicting local captain",()=>{
  const result=resolve({localCaptainId:10,localViceId:6,official:authority(null,1,6,10)});
  assert.equal(result.captaincySource,"official");
  assert.equal(result.captainId,6);
  assert.equal(result.effectiveCaptainId,6);
  assert.equal(result.captainBonus,4);
});

test("before the deadline, local captaincy remains editable planning data",()=>{
  const result=resolve({deadlinePassed:false,localCaptainId:10,official:authority("3xc",1,6,10)});
  assert.equal(result.captaincySource,"local");
  assert.equal(result.captainId,10);
  assert.equal(result.activeChip,null);
  assert.equal(result.captainMultiplier,2);
});

test("a chip stored for another gameweek never affects the displayed event",()=>{
  const result=resolve({official:authority("3xc",2)});
  assert.equal(result.activeChip,null);
  assert.equal(result.captaincySource,"local");
  assert.equal(result.captainMultiplier,2);
});
