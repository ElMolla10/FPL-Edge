import type { FplPlayer, ProjectionMetrics } from "./fpl";

export type BenchOrderMetric={xPts:number;appearanceProbability:number};
export type BenchOrderResult={bench:FplPlayer[];expectedAutosubPoints:number;naiveExpectedAutosubPoints:number;improvement:number;scenarios:number};

const clamp=(value:number,min=0,max=1)=>Math.max(min,Math.min(max,value));
const legalOutfieldFormation=(players:FplPlayer[])=>{
  const def=players.filter(player=>player.positionShort==="DEF").length;
  const mid=players.filter(player=>player.positionShort==="MID").length;
  const fwd=players.filter(player=>player.positionShort==="FWD").length;
  return players.length===10&&def>=3&&def<=5&&mid>=2&&mid<=5&&fwd>=1&&fwd<=3;
};

export function modeledAppearanceProbability(player:FplPlayer,metrics:ProjectionMetrics){
  const officialAvailability=player.chance!==null?clamp(player.chance/100):player.status==="a"?1:player.status==="d"?.72:.2;
  // A non-starter can still make a cameo. Keep that chance deliberately modest and let official
  // availability cap the result; this is an autosub probability proxy, not a claimed lineup leak.
  if(officialAvailability===0)return .01;
  return clamp(metrics.startProbability+(1-metrics.startProbability)*.35*officialAvailability,.01,.99);
}

const permutations=<T,>(items:T[]):T[][]=>items.length<=1?[items]:items.flatMap((item,index)=>permutations([...items.slice(0,index),...items.slice(index+1)]).map(rest=>[item,...rest]));

function expectedAutosubValue(xi:FplPlayer[],order:FplPlayer[],metricOf:(player:FplPlayer)=>BenchOrderMetric){
  const xiOutfield=xi.filter(player=>player.positionShort!=="GKP");
  const participants=[...xiOutfield,...order];
  const metrics=new Map(participants.map(player=>[player.id,metricOf(player)]));
  const xiIds=new Set(xiOutfield.map(player=>player.id));
  const scenarios=1<<participants.length;
  let expected=0;
  for(let mask=0;mask<scenarios;mask++){
    let probability=1;
    const appears=new Set<number>();
    for(let index=0;index<participants.length;index++){
      const player=participants[index],appearance=clamp(metrics.get(player.id)?.appearanceProbability??0);
      if(mask&(1<<index)){appears.add(player.id);probability*=appearance}else probability*=1-appearance;
    }
    if(probability<1e-10)continue;
    let effective=[...xiOutfield],contribution=0;
    for(const benchPlayer of order){
      if(!appears.has(benchPlayer.id))continue;
      const missing=effective.filter(player=>xiIds.has(player.id)&&!appears.has(player.id));
      for(const starter of missing){
        const attempt=effective.map(player=>player.id===starter.id?benchPlayer:player);
        if(!legalOutfieldFormation(attempt))continue;
        effective=attempt;
        const metric=metrics.get(benchPlayer.id)!;
        contribution+=Math.min(16,metric.xPts/Math.max(.05,metric.appearanceProbability));
        break;
      }
    }
    expected+=probability*contribution;
  }
  return{expected,scenarios};
}

export function optimizeBenchOrder(xi:FplPlayer[],bench:FplPlayer[],metricOf:(player:FplPlayer)=>BenchOrderMetric):BenchOrderResult{
  const goalkeeper=bench.find(player=>player.positionShort==="GKP");
  const outfield=bench.filter(player=>player.positionShort!=="GKP");
  const fallback=[...outfield.sort((a,b)=>metricOf(b).xPts-metricOf(a).xPts),...(goalkeeper?[goalkeeper]:[])];
  if(xi.length!==11||outfield.length!==3||!goalkeeper)return{bench:fallback,expectedAutosubPoints:0,naiveExpectedAutosubPoints:0,improvement:0,scenarios:0};
  const naive=[...outfield].sort((a,b)=>metricOf(b).xPts-metricOf(a).xPts);
  const candidates=permutations(outfield).map(order=>({order,...expectedAutosubValue(xi,order,metricOf)})).sort((a,b)=>b.expected-a.expected||a.order.map(player=>player.id).join("-").localeCompare(b.order.map(player=>player.id).join("-")));
  const best=candidates[0],naiveValue=expectedAutosubValue(xi,naive,metricOf).expected;
  const starter=xi.find(player=>player.positionShort==="GKP");
  const starterAppearance=starter?metricOf(starter).appearanceProbability:1;
  const keeperMetric=metricOf(goalkeeper);
  const keeperValue=(1-starterAppearance)*keeperMetric.appearanceProbability*Math.min(16,keeperMetric.xPts/Math.max(.05,keeperMetric.appearanceProbability));
  return{bench:[...best.order,goalkeeper],expectedAutosubPoints:best.expected+keeperValue,naiveExpectedAutosubPoints:naiveValue+keeperValue,improvement:best.expected-naiveValue,scenarios:best.scenarios};
}
