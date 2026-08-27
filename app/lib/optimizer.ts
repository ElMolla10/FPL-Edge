import { FplData, FplPlayer, ProjectionMetrics, futureEvents, isValidSquad, projectionMetrics } from "./fpl";
import { modeledAppearanceProbability } from "./bench-order";

export type HorizonMode="GW1 Attack"|"Next 3 GWs"|"Balanced 5 GWs"|"Long-term 8 GWs";
export type RiskMode="Safe"|"Balanced"|"Aggressive";
export type SquadPhilosophy="Maximum xPts"|"Flexible"|"Strong Bench"|"Premium Heavy"|"Differential";
export type WeekPlan={eventId:number;xi:FplPlayer[];bench:FplPlayer[];captain:FplPlayer;vice:FplPlayer;formation:string;points:number;captainPoints:number};
export type SquadScores={projectedPoints:number;captaincy:number;fixtures:number;minutesSecurity:number;bench:number;flexibility:number;value:number;risk:number;overall:number};
export type SquadEvaluation={objective:number;weightedPoints:number;fiveWeekPoints:number;weeks:WeekPlan[];flexibility:number;benchUtility:number;deadSlots:number;riskPenalty:number;bank:number;scores:SquadScores;warnings:string[];strategy:{formation:string;premiums:string[];captain:string;budget:Record<string,number>;benchSpend:number;targets:string[];risk:RiskMode};};
export type OptimizedResult={squad:FplPlayer[];evaluation:SquadEvaluation;efficiency:number;nearMisses:{player:FplPlayer;difference:number;reason:string}[];explanations:Record<number,string[]>;weights:number[];mode:HorizonMode;risk:RiskMode};
export type ConstrainedSwap={out:FplPlayer;incoming:FplPlayer};
export type ConstrainedOptimizeResult={squad:FplPlayer[];evaluation:SquadEvaluation;changes:ConstrainedSwap[];consideredCombinations:number};

// Runtime consistency checks on the optimizer's own output, run in the display layer before Draft
// Lab shows a result -- same shape as fpl.ts's findIdentityConflicts/attachIntegrityWarnings: a pure
// validation function, warnings surfaced in the UI, never just a console.error. Each check below is
// marked GUARD or GAP: GUARD means weekPlan/evaluate already make the failure impossible today by
// construction, and this exists purely as regression protection if a future refactor breaks that
// guarantee; GAP means nothing today actually enforces the invariant, even though it happens to hold
// for the live data this was investigated against. Call this on both manualEvaluation and
// optimized.evaluation in LiveDraftBuilder -- the same function, not two implementations, matching
// how chipScoresForEvent is shared rather than duplicated.
export function validateSquadEvaluation(evaluation:SquadEvaluation,squad:FplPlayer[],data:FplData):string[]{
  const warnings:string[]=[];
  const firstEvent=evaluation.weeks[0]?.eventId;
  for(const week of evaluation.weeks){
    // GUARD: weekPlan's def/mid loop derives fwd as 10-def-mid (never chosen independently) and
    // discards any candidate whose assembled xi.length isn't exactly 11 before it can be selected.
    if(week.xi.length!==11)warnings.push(`GW${week.eventId}: XI has ${week.xi.length} players, not 11.`);
    // GAP: weekPlan's own def:3-5/mid:2-5/fwd:1-3 loop bounds are hardcoded, not derived from
    // data.rules.positions[i].minPlay/maxPlay. They match the live official rules today (verified
    // against the real feed during the Phase-C-adjacent investigation for this feature), but nothing
    // enforces they still would if FPL ever changed squad-formation rules.
    for(const rule of data.rules.positions){
      const count=week.xi.filter(p=>p.positionShort===rule.short).length;
      if(count<rule.minPlay||count>rule.maxPlay)warnings.push(`GW${week.eventId}: ${count} ${rule.short} in the XI, outside the legal ${rule.minPlay}-${rule.maxPlay} range.`);
    }
    // GUARD: captain/vice are picked by sorting the xi array itself (ranked=[...xi].sort(...),
    // captain=ranked[0], vice=ranked[1]) -- both are drawn from xi by construction.
    if(!week.xi.some(p=>p.id===week.captain.id))warnings.push(`GW${week.eventId}: captain ${week.captain.name} is not in the XI.`);
    if(!week.xi.some(p=>p.id===week.vice.id))warnings.push(`GW${week.eventId}: vice-captain ${week.vice.name} is not in the XI.`);
    // MIXED, covers three list items at once (bench points never counted in the XI total, captain
    // counted exactly once/2x not 3x, displayed total reconciles with the sum of individual player
    // values) -- they are facets of one invariant, not three independently checkable things. GUARD in
    // that weekPlan's own points=xi.reduce(...)+score(captain) already only sums xi and adds captain
    // exactly once more; this specifically recomputes from projectionMetrics directly rather than
    // re-reading weekPlan's own output, so it also guards a future weekPlan refactor that breaks the
    // formula without any other check catching it.
    const xiSum=week.xi.reduce((sum,p)=>sum+projectionMetrics(p,week.eventId,data.fixtures,firstEvent).xPts,0);
    const captainScore=projectionMetrics(week.captain,week.eventId,data.fixtures,firstEvent).xPts;
    const expectedPoints=xiSum+captainScore;
    if(Math.abs(week.points-expectedPoints)>.05)warnings.push(`GW${week.eventId}: displayed total ${week.points.toFixed(2)} does not reconcile with the sum of individual XI values plus captain bonus (${expectedPoints.toFixed(2)}).`);
    // GUARD, separate logic from the bench-order.ts autosub GK fix used by Final Check -- Draft Lab
    // never calls optimizeBenchOrder, only modeledAppearanceProbability for scoring. weekPlan's own
    // bench sort explicitly pushes any GKP to the last slot via its own comparator.
    const gkIndex=week.bench.findIndex(p=>p.positionShort==="GKP");
    if(gkIndex!==-1&&gkIndex!==week.bench.length-1)warnings.push(`GW${week.eventId}: backup goalkeeper is not in the final bench slot.`);
  }
  // GAP: cost is one squad.reduce(...), but the displayed per-position budget breakdown is a separate
  // reduce per position, each independently rounded to 1 decimal -- nothing currently asserts they
  // agree. Tolerance covers the max plausible drift from rounding four independent position sums.
  const totalCost=squad.reduce((sum,p)=>sum+p.price,0);
  const budgetSum=Object.values(evaluation.strategy.budget).reduce((sum,value)=>sum+value,0);
  if(Math.abs(totalCost-budgetSum)>.2)warnings.push(`Squad cost £${totalCost.toFixed(1)}m does not reconcile with the displayed per-position budget total £${budgetSum.toFixed(1)}m.`);
  // GUARD: isValidSquad already enforces this -- it is the gate checked before any of this can render
  // (complete=isValidSquad(squad,data)), and re-checked on every swap optimize()'s replace() accepts.
  // This call is also the defense-in-depth for the one path that gate doesn't explicitly re-check:
  // optimize()'s starting baseline from cheapest(), before any isValidSquad-checked swap has run, is
  // exactly what becomes the squad passed here if no restart ever beats it.
  const clubCounts=new Map<number,number>();
  squad.forEach(p=>clubCounts.set(p.teamId,(clubCounts.get(p.teamId)??0)+1));
  for(const[,count]of clubCounts)if(count>data.rules.teamLimit)warnings.push(`${count} players from the same club, exceeding the ${data.rules.teamLimit}-player limit.`);
  return warnings;
}

const clamp=(n:number,min=0,max=100)=>Math.max(min,Math.min(max,n));
const weightsFor=(mode:HorizonMode,count:number)=>{const source=mode==="GW1 Attack"?[1,.55,.35,.2,.1]:mode==="Next 3 GWs"?[1,.92,.78]:mode==="Long-term 8 GWs"?[1,.96,.92,.88,.84,.8,.76,.72]:[1,.9,.8,.7,.6];return Array.from({length:count},(_,i)=>source[i]??Math.max(.45,1-i*.07))};
const hash=(text:string)=>[...text].reduce((h,c)=>(h*31+c.charCodeAt(0))>>>0,2166136261);
const rngFactory=(seed:number)=>()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296};

export function createOptimizer(data:FplData,mode:HorizonMode="Balanced 5 GWs",risk:RiskMode="Balanced",philosophy:SquadPhilosophy="Maximum xPts"){
  const events=futureEvents(data,mode==="Long-term 8 GWs"?8:mode==="Next 3 GWs"?3:5);const eventIds=events.map(e=>e.id);const weights=weightsFor(mode,eventIds.length);const metricCache=new Map<string,ProjectionMetrics>();const metrics=(p:FplPlayer,eventId:number)=>{const key=`${p.id}:${eventId}`;if(!metricCache.has(key))metricCache.set(key,projectionMetrics(p,eventId,data.fixtures,eventIds[0]));return metricCache.get(key)!};
  const teamName=new Map(data.teams.map(t=>[t.id,t.name]));
  const fixtureDifficultyCache=new Map<string,number>();const fixtureDifficulty=(teamId:number,eventId:number)=>{const key=`${teamId}:${eventId}`;if(!fixtureDifficultyCache.has(key)){const games=data.fixtures.filter(f=>f.event===eventId&&(f.teamH===teamId||f.teamA===teamId));fixtureDifficultyCache.set(key,games.length?games.reduce((s,g)=>s+(g.teamH===teamId?g.teamHDifficulty:g.teamADifficulty),0)/games.length:4)}return fixtureDifficultyCache.get(key)!};
  const weekPlan=(squad:FplPlayer[],eventId:number):WeekPlan=>{const score=(p:FplPlayer)=>metrics(p,eventId).xPts;const conditionalBenchScore=(p:FplPlayer)=>score(p)/Math.max(.05,modeledAppearanceProbability(p,metrics(p,eventId)));let best:WeekPlan|null=null;const keepers=squad.filter(p=>p.positionShort==="GKP").sort((a,b)=>score(b)-score(a));for(let def=3;def<=5;def++)for(let mid=2;mid<=5;mid++){const fwd=10-def-mid;if(fwd<1||fwd>3)continue;const xi=[keepers[0],...squad.filter(p=>p.positionShort==="DEF").sort((a,b)=>score(b)-score(a)).slice(0,def),...squad.filter(p=>p.positionShort==="MID").sort((a,b)=>score(b)-score(a)).slice(0,mid),...squad.filter(p=>p.positionShort==="FWD").sort((a,b)=>score(b)-score(a)).slice(0,fwd)].filter(Boolean);if(xi.length!==11)continue;const ranked=[...xi].sort((a,b)=>score(b)-score(a));const captain=ranked[0],vice=ranked[1];const bench=squad.filter(p=>!xi.some(x=>x.id===p.id)).sort((a,b)=>{if(a.positionShort==="GKP")return 1;if(b.positionShort==="GKP")return-1;return conditionalBenchScore(b)-conditionalBenchScore(a)});const points=xi.reduce((s,p)=>s+score(p),0)+score(captain);if(!best||points>best.points)best={eventId,xi,bench,captain,vice,formation:`${def}-${mid}-${fwd}`,points,captainPoints:score(captain)}}return best!};
  const pricePointScore=(squad:FplPlayer[])=>{const checks=[["DEF",5,5.5],["MID",6,6.5],["MID",7,8],["FWD",6,7.5]] as [string,number,number][];return checks.filter(([pos,min,max])=>squad.some(p=>p.positionShort===pos&&p.price>=min&&p.price<=max)).length/checks.length*100};
  const evaluate=(squad:FplPlayer[]):SquadEvaluation=>{const weeks=eventIds.map(id=>weekPlan(squad,id));const weightedPoints=weeks.reduce((s,w,i)=>s+w.points*weights[i],0);const fiveWeekPoints=weeks.slice(0,5).reduce((s,w)=>s+w.points,0);let benchUtility=0;weeks.forEach((week,i)=>week.bench.forEach((p,index)=>{const factor=p.positionShort==="GKP"?.06:[.27,.14,.07][index]??.05;benchUtility+=metrics(p,week.eventId).xPts*factor*weights[i]}));const security=squad.reduce((s,p)=>s+metrics(p,eventIds[0]).startProbability,0)/15;const deadOutfield=squad.filter(p=>p.positionShort!=="GKP"&&(metrics(p,eventIds[0]).expectedMinutes<45||metrics(p,eventIds[0]).startProbability<.52));const deadForwards=deadOutfield.filter(p=>p.positionShort==="FWD").length;const deadSlots=deadOutfield.length;const uncertain=squad.filter(p=>metrics(p,eventIds[0]).startProbability<.68).length;const cost=squad.reduce((s,p)=>s+p.price,0);const bank=data.rules.budget-cost;const benchSpend=weeks[0].bench.reduce((s,p)=>s+p.price,0);const formationOptions=["3-4-3","3-5-2","4-4-2","4-3-3","4-5-1","5-4-1","5-3-2","5-2-3"].filter(f=>{const[d,m,a]=f.split("-").map(Number);return squad.filter(p=>p.positionShort==="DEF"&&metrics(p,eventIds[0]).startProbability>.62).length>=d&&squad.filter(p=>p.positionShort==="MID"&&metrics(p,eventIds[0]).startProbability>.62).length>=m&&squad.filter(p=>p.positionShort==="FWD"&&metrics(p,eventIds[0]).startProbability>.62).length>=a}).length;const flexibility=clamp(pricePointScore(squad)*.42+formationOptions/8*100*.28+clamp(100-Math.abs(bank-.8)*25)*.15+clamp(100-uncertain*11)*.15);const rotationRisk=squad.reduce((s,p)=>s+metrics(p,eventIds[0]).rotationRisk,0);const riskWeight=risk==="Safe"?1.35:risk==="Aggressive"?.38:.78;const riskPenalty=(rotationRisk+Math.max(0,deadSlots-1)*2.4+(deadForwards>=2?5:0))*riskWeight+Math.max(0,benchSpend-20)*(philosophy==="Strong Bench"?.12:.45)+(weeks[0].captainPoints<6.5?5:0);const upside=risk==="Aggressive"?squad.reduce((s,p)=>s+Math.max(0,metrics(p,eventIds[0]).xPts-p.priorPointsPerGame),0)*.25:0;const philosophyBonus=philosophy==="Flexible"?flexibility*.035:philosophy==="Strong Bench"?benchUtility*.55:philosophy==="Premium Heavy"?squad.filter(p=>p.price>=9).length*.7:philosophy==="Differential"?squad.reduce((s,p)=>s+Math.max(0,10-p.selectedBy),0)*.025:0;const objective=weightedPoints+benchUtility+flexibility*.045+upside+philosophyBonus-riskPenalty;const fixtureAvg=weeks.reduce((s,w)=>s+w.xi.reduce((a,p)=>a+fixtureDifficulty(p.teamId,w.eventId),0)/11,0)/Math.max(1,weeks.length);const captaincy=clamp(weeks.reduce((s,w)=>s+w.captainPoints,0)/Math.max(1,weeks.length)/9*100);const benchScore=clamp(48+benchUtility/Math.max(1,weights.reduce((a,b)=>a+b,0))*13-deadSlots*9-Math.max(0,benchSpend-20)*2);const projectedScore=clamp(fiveWeekPoints/350*100);const securityScore=clamp(security*100);const fixtureScore=clamp((5.7-fixtureAvg)/3.2*100);const valueScore=clamp(weightedPoints/Math.max(1,cost)*22);const riskScore=clamp(100-rotationRisk/15*100-deadSlots*7);const overall=Math.round(clamp(projectedScore*.3+captaincy*.17+fixtureScore*.1+securityScore*.15+benchScore*.09+flexibility*.1+valueScore*.06+riskScore*.03,20,96));const warnings:string[]=[];if(deadForwards>=2)warnings.push("Two forwards currently project as weak or unreliable playing slots.");if(deadSlots>1)warnings.push(`${deadSlots} outfield players have weak autosub reliability.`);if(benchSpend>20)warnings.push(`£${benchSpend.toFixed(1)}m is tied up on the bench in the primary XI.`);if(weeks[0].captainPoints<6.5)warnings.push("No elite GW1 captain projection.");if(uncertain>=4)warnings.push(`${uncertain} players carry meaningful role or minutes uncertainty.`);if(formationOptions<3)warnings.push("Limited formation flexibility if team news changes.");const clubs=[...new Set(squad.map(p=>p.teamId))].map(id=>({id,count:squad.filter(p=>p.teamId===id).length,points:squad.filter(p=>p.teamId===id).reduce((s,p)=>s+metrics(p,eventIds[0]).xPts,0)})).sort((a,b)=>b.points-a.points);const budget=Object.fromEntries(["GKP","DEF","MID","FWD"].map(pos=>[pos,Number(squad.filter(p=>p.positionShort===pos).reduce((s,p)=>s+p.price,0).toFixed(1))]));const scores={projectedPoints:Math.round(projectedScore),captaincy:Math.round(captaincy),fixtures:Math.round(fixtureScore),minutesSecurity:Math.round(securityScore),bench:Math.round(benchScore),flexibility:Math.round(flexibility),value:Math.round(valueScore),risk:Math.round(riskScore),overall};return{objective,weightedPoints,fiveWeekPoints,weeks,flexibility,benchUtility,deadSlots,riskPenalty,bank,scores,warnings,strategy:{formation:weeks[0].formation,premiums:squad.filter(p=>p.price>=9).map(p=>p.name),captain:weeks[0].captain.name,budget,benchSpend,risk,targets:clubs.slice(0,3).map(c=>teamName.get(c.id)??"Unknown")}}};
  const projectionValue=(p:FplPlayer)=>eventIds.reduce((s,id,i)=>s+metrics(p,id).xPts*weights[i],0)/Math.max(3,p.price)+metrics(p,eventIds[0]).startProbability*1.8;const poolByPosition=new Map<number,FplPlayer[]>();for(const rule of data.rules.positions){const all=data.players.filter(p=>p.positionId===rule.id&&p.status!=="u");const combined=[...all.sort((a,b)=>projectionValue(b)-projectionValue(a)).slice(0,42),...all.sort((a,b)=>a.price-b.price).slice(0,12)];poolByPosition.set(rule.id,[...new Map(combined.map(p=>[p.id,p])).values()])}
  const cheapest=()=>{const squad:FplPlayer[]=[];const clubs=new Map<number,number>();for(const rule of data.rules.positions)for(const p of [...(poolByPosition.get(rule.id)??[])].sort((a,b)=>a.price-b.price||projectionValue(b)-projectionValue(a))){if(squad.filter(x=>x.positionId===rule.id).length>=rule.squad)break;if((clubs.get(p.teamId)??0)>=3)continue;squad.push(p);clubs.set(p.teamId,(clubs.get(p.teamId)??0)+1)}return squad};
  const replace=(squad:FplPlayer[],index:number,candidate:FplPlayer)=>{if(squad.some(p=>p.id===candidate.id)||candidate.positionId!==squad[index].positionId)return null;const next=[...squad];next[index]=candidate;return isValidSquad(next,data)?next:null};
  // Extracted so any result -- optimize()'s full rebuild or optimizeConstrained()'s bounded search --
  // can explain its own squad in the "WHY THIS PLAYER?" panel, not just Pure Optimum. Pure
  // presentation over metrics(), no search-mode-specific assumptions.
  const explainSquad=(squad:FplPlayer[]):Record<number,string[]>=>{const explanations:Record<number,string[]>={};squad.forEach(p=>{const m=metrics(p,eventIds[0]);const five=eventIds.slice(0,5).reduce((s,id)=>s+metrics(p,id).xPts,0);const reasons=[`${five.toFixed(1)} projected points over five gameweeks`,`${Math.round(m.startProbability*100)}% GW1 start probability · ${Math.round(m.expectedMinutes)} expected minutes`];if(m.penaltyRole)reasons.push("first-choice penalty role");if(m.setPieceRole)reasons.push("first-choice set-piece role");if(p.positionShort==="DEF"||p.positionShort==="GKP")reasons.push(`${Math.round(m.cleanSheetProbability*100)}% modeled GW1 clean-sheet probability`);if(m.xG>.25)reasons.push(`${m.xG.toFixed(2)} fixture-specific GW1 xG`);if(m.xA>.18)reasons.push(`${m.xA.toFixed(2)} fixture-specific GW1 xA`);explanations[p.id]=reasons.slice(0,4)});return explanations};
  const optimize=():OptimizedResult=>{const rng=rngFactory(hash(`${mode}:${risk}:${data.updatedAt.slice(0,13)}`));let global=cheapest();let globalEval=evaluate(global);const restarts=24,steps=520;for(let restart=0;restart<restarts;restart++){let current=[...cheapest()];for(let j=0;j<80;j++){const index=Math.floor(rng()*15);const pool=poolByPosition.get(current[index].positionId)??[];const next=replace(current,index,pool[Math.floor(rng()*pool.length)]);if(next)current=next}let currentEval=evaluate(current);for(let step=0;step<steps;step++){const index=Math.floor(rng()*15);const pool=poolByPosition.get(current[index].positionId)??[];const candidate=pool[Math.floor(rng()*pool.length)];const next=replace(current,index,candidate);if(!next)continue;const nextEval=evaluate(next);const temperature=Math.max(.12,4.5*(1-step/steps));if(nextEval.objective>currentEval.objective||Math.exp((nextEval.objective-currentEval.objective)/temperature)>rng()){current=next;currentEval=nextEval}if(currentEval.objective>globalEval.objective){global=[...current];globalEval=currentEval}}}
    const selected=new Set(global.map(p=>p.id));const nearCandidates=data.players.filter(p=>!selected.has(p.id)&&p.status!=="u").map(player=>{let bestDifference=Infinity;for(let i=0;i<global.length;i++){if(global[i].positionId!==player.positionId)continue;const next=replace(global,i,player);if(!next)continue;bestDifference=Math.min(bestDifference,globalEval.objective-evaluate(next).objective)}return{player,difference:bestDifference,reason:Number.isFinite(bestDifference)?`Best legal swap still reduced the risk-adjusted objective by ${Math.max(0,bestDifference).toFixed(2)}.`:"No legal one-player swap fit the budget and club limits."}}).filter(x=>Number.isFinite(x.difference)).sort((a,b)=>a.difference-b.difference).slice(0,5);return{squad:global,evaluation:globalEval,efficiency:100,nearMisses:nearCandidates,explanations:explainSquad(global),weights,mode,risk}};
  // One-shot combinatorial search shared by Practical Upgrade (maxChanges caps how many slots may
  // change, no exclusions) and Keep Core (lockedPlayerIds excludes specific players from ever being
  // an "out" candidate; maxChanges still bounds the combinatorial search -- literal "no cap" is not
  // tractable via this enumeration technique, so Keep Core's caller is expected to pass a pragmatic
  // bound like 4, disclosed to the user as "up to N simultaneous changes", never "unlimited").
  // Seeded from the real current squad, not cheapest() -- optimize() cannot do this: it has no
  // baseline-squad concept and its burn-in phase actively destroys any relationship to a starting
  // point before real search begins (design-checkpoint investigation, this feature).
  //
  // Shortlist + combination technique mirrors transfer-routes.ts's per-week proposal/shortlist/apply
  // shape, generalized from single/pair to 1..maxChanges-way combinations, scored with the real
  // multi-week evaluate() (not transfer-routes.ts's single-week weekTotal). The incoming pool is
  // pre-filtered against the CURRENT squad's club counts before ranking by gain -- without this, a
  // shortlist built by raw gain alone can degenerate into a handful of clubs that happen to rank
  // well, which then fail isValidSquad's club-limit check almost universally once combined with an
  // already-tight squad. Found empirically during the design-checkpoint verification: against a
  // squad already at the 3-per-club cap in two clubs, 0 of 1351 raw combos were legal without this
  // filter. Same check bestTransfers() already applies per-swap in app/lib/transfers.ts.
  //
  // Precondition: squad must already satisfy isValidSquad(squad,data), same precondition evaluate()
  // and optimize() rely on -- enforced at the call site by "complete" gating, not re-checked here.
  const optimizeConstrained=(squad:FplPlayer[],options:{maxChanges:number;lockedPlayerIds?:Set<number>;shortlistSize?:number}):ConstrainedOptimizeResult=>{
    const lockedPlayerIds=options.lockedPlayerIds??new Set<number>();
    const shortlistSize=options.shortlistSize??20;
    const unlockedCount=squad.filter(p=>!lockedPlayerIds.has(p.id)).length;
    const maxChanges=Math.max(0,Math.min(options.maxChanges,unlockedCount));
    const owned=new Set(squad.map(p=>p.id));
    const clubCount=new Map<number,number>();squad.forEach(p=>clubCount.set(p.teamId,(clubCount.get(p.teamId)??0)+1));
    const proposals:{out:FplPlayer;incoming:FplPlayer;gain:number}[]=[];
    for(const out of squad){
      if(lockedPlayerIds.has(out.id))continue;
      for(const incoming of poolByPosition.get(out.positionId)??[]){
        if(owned.has(incoming.id))continue;
        if(incoming.teamId!==out.teamId&&(clubCount.get(incoming.teamId)??0)>=3)continue;
        proposals.push({out,incoming,gain:projectionValue(incoming)-projectionValue(out)});
      }
    }
    proposals.sort((a,b)=>b.gain-a.gain);
    const shortlist=proposals.slice(0,shortlistSize);
    let best:{squad:FplPlayer[];evaluation:SquadEvaluation;changes:ConstrainedSwap[]}={squad,evaluation:evaluate(squad),changes:[]};
    let consideredCombinations=0;
    const tryCombo=(combo:ConstrainedSwap[])=>{
      if(combo.length===0)return;
      const outIds=new Set(combo.map(c=>c.out.id)),incomingIds=new Set(combo.map(c=>c.incoming.id));
      if(outIds.size!==combo.length||incomingIds.size!==combo.length)return;
      const replacements=new Map(combo.map(c=>[c.out.id,c.incoming]));
      const candidate=squad.map(p=>replacements.get(p.id)??p);
      if(!isValidSquad(candidate,data))return;
      consideredCombinations++;
      const candidateEval=evaluate(candidate);
      if(candidateEval.objective>best.evaluation.objective)best={squad:candidate,evaluation:candidateEval,changes:combo};
    };
    const build=(start:number,current:ConstrainedSwap[])=>{
      if(current.length>0)tryCombo(current);
      if(current.length>=maxChanges)return;
      for(let i=start;i<shortlist.length;i++)build(i+1,[...current,shortlist[i]]);
    };
    build(0,[]);
    return{...best,consideredCombinations};
  };
  return{events,eventIds,weights,metrics,evaluate,optimize,optimizeConstrained,explainSquad};
}
