export const TEAM_QUALITY_MODEL_VERSION="team-quality-2026.08.23-r1";

export type TeamQualityInput={
  id:number;name:string;short:string;
  officialAttackHome:number;officialAttackAway:number;
  officialDefenceHome:number;officialDefenceAway:number;
  plPriorCoverage:number;lowPlContinuity:boolean;
  matches:number;homeMatches:number;awayMatches:number;
  goalsForHome:number;goalsForAway:number;goalsAgainstHome:number;goalsAgainstAway:number;
  expectedGoalsFor:number;
};

export type TeamQualityProfile={
  id:number;attackHome:number;attackAway:number;defenceHome:number;defenceAway:number;
  effectiveAttackHome:number;effectiveAttackAway:number;effectiveDefenceHome:number;effectiveDefenceAway:number;
  confidence:number;matches:number;currentWeight:number;plPriorCoverage:number;lowPlContinuity:boolean;
  source:"official-prior"|"official-prior+current-pl";modelVersion:string;
};

const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const mean=(values:number[])=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:1;

// Official FPL strength fields are raw league-relative numbers (commonly around 1,000+), not
// the 1–5 FDR scale. Normalize them against the live 20-club league before using them.
function normalizedOfficial(inputs:TeamQualityInput[],pick:(input:TeamQualityInput)=>number):Map<number,number>{
  const valid=inputs.map(pick).filter(value=>Number.isFinite(value)&&value>0);
  const leagueMean=mean(valid);
  return new Map(inputs.map(input=>{const value=pick(input);return[input.id,clamp(value>0?value/leagueMean:1,.72,1.28)]}));
}

const smoothedRate=(total:number,matches:number,leagueRate:number,pseudoMatches=2)=>
  (Math.max(0,total)+leagueRate*pseudoMatches)/Math.max(1,matches+pseudoMatches);

const effective=(rating:number,confidence:number)=>1+(rating-1)*confidence;

export function buildTeamQualityProfiles(inputs:TeamQualityInput[]):TeamQualityProfile[]{
  if(!inputs.length)return[];
  const priorAttackHome=normalizedOfficial(inputs,input=>input.officialAttackHome);
  const priorAttackAway=normalizedOfficial(inputs,input=>input.officialAttackAway);
  const priorDefenceHome=normalizedOfficial(inputs,input=>input.officialDefenceHome);
  const priorDefenceAway=normalizedOfficial(inputs,input=>input.officialDefenceAway);
  const leagueHomeFor=mean(inputs.flatMap(input=>input.homeMatches?[input.goalsForHome/input.homeMatches]:[]))||1.45;
  const leagueAwayFor=mean(inputs.flatMap(input=>input.awayMatches?[input.goalsForAway/input.awayMatches]:[]))||1.15;
  const leagueHomeAgainst=mean(inputs.flatMap(input=>input.homeMatches?[input.goalsAgainstHome/input.homeMatches]:[]))||leagueAwayFor;
  const leagueAwayAgainst=mean(inputs.flatMap(input=>input.awayMatches?[input.goalsAgainstAway/input.awayMatches]:[]))||leagueHomeFor;
  const leagueXgFor=mean(inputs.flatMap(input=>input.matches&&input.expectedGoalsFor>0?[input.expectedGoalsFor/input.matches]:[]))||1.35;

  return inputs.map(input=>{
    const conservativePrior=(rating:number,baseline:number)=>input.lowPlContinuity?baseline+(rating-1)*.35:rating;
    const attackHomePrior=conservativePrior(priorAttackHome.get(input.id)??1,.88);
    const attackAwayPrior=conservativePrior(priorAttackAway.get(input.id)??1,.86);
    const defenceHomePrior=conservativePrior(priorDefenceHome.get(input.id)??1,.86);
    const defenceAwayPrior=conservativePrior(priorDefenceAway.get(input.id)??1,.82);
    const xgRate=smoothedRate(input.expectedGoalsFor,input.matches,leagueXgFor,3);
    const xgIndex=clamp(xgRate/leagueXgFor,.58,1.48);
    const attackHomeObserved=input.homeMatches?clamp(.65*(smoothedRate(input.goalsForHome,input.homeMatches,leagueHomeFor)/leagueHomeFor)+.35*xgIndex,.58,1.48):xgIndex;
    const attackAwayObserved=input.awayMatches?clamp(.65*(smoothedRate(input.goalsForAway,input.awayMatches,leagueAwayFor)/leagueAwayFor)+.35*xgIndex,.58,1.48):xgIndex;
    const defenceHomeObserved=input.homeMatches?clamp(leagueHomeAgainst/smoothedRate(input.goalsAgainstHome,input.homeMatches,leagueHomeAgainst),.58,1.48):1;
    const defenceAwayObserved=input.awayMatches?clamp(leagueAwayAgainst/smoothedRate(input.goalsAgainstAway,input.awayMatches,leagueAwayAgainst),.58,1.48):1;
    // One result gets little authority; a half-season sample can move at most 65% away from the
    // official preseason prior. This prevents a promoted side's first clean sheet becoming truth.
    const currentWeight=clamp(input.matches/(input.matches+6),0,.65);
    const blend=(prior:number,current:number)=>clamp(prior*(1-currentWeight)+current*currentWeight,.68,1.32);
    const attackHome=blend(attackHomePrior,attackHomeObserved),attackAway=blend(attackAwayPrior,attackAwayObserved);
    const defenceHome=blend(defenceHomePrior,defenceHomeObserved),defenceAway=blend(defenceAwayPrior,defenceAwayObserved);
    const confidence=clamp((input.lowPlContinuity ? .34 : .58)+Math.min(1,input.matches/12)*(input.lowPlContinuity ? .46 : .32),.25,.9);
    return{id:input.id,attackHome,attackAway,defenceHome,defenceAway,effectiveAttackHome:effective(attackHome,confidence),effectiveAttackAway:effective(attackAway,confidence),effectiveDefenceHome:effective(defenceHome,confidence),effectiveDefenceAway:effective(defenceAway,confidence),confidence,matches:input.matches,currentWeight,plPriorCoverage:input.plPriorCoverage,lowPlContinuity:input.lowPlContinuity,source:input.matches?"official-prior+current-pl":"official-prior",modelVersion:TEAM_QUALITY_MODEL_VERSION};
  });
}

// 0-10 "higher is better" display score for a raw quality multiplier (Source A), scaled against
// the real range of the SAME dimension+venue across every currently-loaded club -- not a fixed
// constant, so it reflects this season's actual spread and updates automatically as ratings blend
// in more real results. Min-max scaling guarantees some club reads 0/10 and some reads 10/10 every
// week, however tight the real underlying spread is -- callers must disclose that next to the
// score (see the "relative to this season's 20 clubs" copy at each render site), not just print
// the number unexplained.
export function qualityScoreOutOf10(value:number,populationValues:readonly number[]):number{
  const min=Math.min(...populationValues),max=Math.max(...populationValues);
  if(!Number.isFinite(min)||!Number.isFinite(max)||max<=min)return 5;
  return clamp((value-min)/(max-min)*10,0,10);
}

// The population a displayed value should be compared against. "home"/"away" match the TEAM
// QUALITY MODEL panel's own home/away columns exactly, so each column's 0/10-every-week guarantee
// holds independently. "overall" (home+away averaged per club) is for values that already blend
// multiple fixtures' home/away mix -- e.g. a transfer candidate's multi-gameweek fixture context --
// where no single club's home-only or away-only number is the right comparison.
export function qualityPopulation(teams:readonly{quality?:TeamQualityProfile}[],dimension:"attack"|"defence",venue:"home"|"away"|"overall"):number[]{
  return teams.flatMap(team=>{
    const q=team.quality;if(!q)return[];
    if(venue==="overall")return[dimension==="attack"?(q.effectiveAttackHome+q.effectiveAttackAway)/2:(q.effectiveDefenceHome+q.effectiveDefenceAway)/2];
    if(dimension==="attack")return[venue==="home"?q.effectiveAttackHome:q.effectiveAttackAway];
    return[venue==="home"?q.effectiveDefenceHome:q.effectiveDefenceAway];
  });
}
