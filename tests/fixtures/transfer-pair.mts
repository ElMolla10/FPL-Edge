import type { FplData, FplPlayer } from "../../app/lib/fpl.ts";
export function makePlayer(overrides:Partial<FplPlayer>={}):FplPlayer{return{
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

export function squad():FplPlayer[]{
  const player=(id:number,positionId:number,positionShort:FplPlayer["positionShort"],price=5)=>makePlayer({id,name:`P${id}`,teamId:id,teamName:`Team ${id}`,teamShort:`T${id}`,positionId,positionShort,position:positionShort,price});
  return[
    player(1,1,"GKP",4.5),player(2,1,"GKP",4.5),
    ...[11,12,13,14,15].map(id=>player(id,2,"DEF",4.5)),
    ...[21,22,23,24,25].map(id=>player(id,3,"MID",6)),
    ...[31,32,33].map(id=>player(id,4,"FWD",7)),
  ];
}

/** Start of the current UTC day: GW deadlines stay in the future so this fixture does not age out (was fixed 2026-10-12). */
export const FIXTURE_BASE_MS=Math.floor(Date.now()/86400000)*86400000;

export function dataFor(players:FplPlayer[],count:number=3):FplData{
  const events=Array.from({length:count},(_,index)=>({id:index+1,name:`Gameweek ${index+1}`,deadline:new Date(FIXTURE_BASE_MS+(index+1)*86400000).toISOString(),current:false,next:index===0,finished:false,dataChecked:false}));
  const clubIds=[...new Set(players.map(player=>player.teamId))];
  const fixtures=events.flatMap(event=>clubIds.map((teamId,index)=>({id:event.id*1000+index,event:event.id,teamH:teamId,teamA:1000+teamId,teamHDifficulty:3,teamADifficulty:3,finished:false,kickoff:null,started:false,teamHScore:null,teamAScore:null})));
  return{updatedAt:new Date(FIXTURE_BASE_MS).toISOString(),source:"test",seasonStatsThrough:0,players,fixtures,events,teams:clubIds.map(id=>({id,name:`Team ${id}`,short:`T${id}`})),rules};
}
