import assert from "node:assert/strict";
import test from "node:test";
import {
  Pmf,
  buildPlayerEventOutcomeModel,
  appearancePointsPmf,
  bernoulliPmf,
  blankProbability,
  bonusPointsPmf,
  cleanSheetPointsPmf,
  convolvePmfs,
  defensiveContributionPmf,
  goalsPointsPmf,
  haulProbability,
  negativeBinomialCountPmf,
  negativeBinomialDispersion,
  playerPointsDistribution,
  pmfAtLeast,
  pmfAtMost,
  pmfMean,
  pmfQuantile,
  poissonCountPmf,
  pointsRange,
  savesPointsPmf,
} from "../app/lib/projection-distribution.ts";
import { FplFixture, FplPlayer, ProjectionMetrics, projectionMetrics } from "../app/lib/fpl.ts";
import { playerEventOutcomeKey, sampleDecisionScenario } from "../app/lib/decision-confidence.ts";

const sum = (pmf: Pmf) => pmf.reduce((total, p) => total + p, 0);
const approx = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;

function makeMetrics(overrides: Partial<ProjectionMetrics> = {}): ProjectionMetrics {
  return {
    xPts: 5, expectedMinutes: 80, startProbability: 0.9, sixtyProbability: 0.85, rotationRisk: 0.1,
    xG: 0.3, xA: 0.2, xG90: 0.15, xA90: 0.1, cleanSheetProbability: 0.3, bonus: 0.5, defensiveContribution: 0.2, saves: 0,
    penaltyRole: false, setPieceRole: false, confidence: 0.8,
    ...overrides,
  };
}

// --- PMF primitives ---

test("pmfMean/pmfAtLeast/pmfAtMost read a hand-constructed PMF correctly",()=>{
  const pmf=[.2,.5,.3]; // P(0)=.2 P(1)=.5 P(2)=.3
  assert.ok(approx(pmfMean(pmf),0*.2+1*.5+2*.3));
  assert.ok(approx(pmfAtMost(pmf,0),.2));
  assert.ok(approx(pmfAtMost(pmf,1),.7));
  assert.ok(approx(pmfAtLeast(pmf,1),.8));
  assert.ok(approx(pmfAtLeast(pmf,3),0),"P(X>=3) must be 0 when the PMF has no mass past index 2");
});

test("pmfQuantile returns the smallest k whose cumulative probability clears the target",()=>{
  const pmf=[.1,.2,.4,.3]; // CDF: .1, .3, .7, 1.0
  assert.equal(pmfQuantile(pmf,.05),0);
  assert.equal(pmfQuantile(pmf,.1),0);
  assert.equal(pmfQuantile(pmf,.3),1);
  assert.equal(pmfQuantile(pmf,.5),2);
  assert.equal(pmfQuantile(pmf,.9),3);
});

test("convolvePmfs sums independent components correctly: two dice",()=>{
  const die=[0,1/6,1/6,1/6,1/6,1/6,1/6]; // 1-6, index 0 unused
  const twoDice=convolvePmfs([die,die]);
  assert.ok(approx(sum(twoDice),1));
  assert.ok(approx(twoDice[7],6/36),"7 is the most common sum of two dice, with 6/36 probability"); // 1+6,2+5,3+4,4+3,5+2,6+1
  assert.ok(approx(twoDice[2],1/36),"2 (snake eyes) has exactly 1/36 probability");
  assert.ok(approx(twoDice[12],1/36),"12 (double six) has exactly 1/36 probability");
});

test("bernoulliPmf places (1-p) at 0 and p at the success value",()=>{
  const pmf=bernoulliPmf(.3,4);
  assert.deepEqual(pmf,[.7,0,0,0,.3]);
});

// --- Poisson: hand-computed cross-check ---

test("poissonCountPmf(0.5): P(0 goals) and P(1+ goals) match the closed-form 1-e^-lambda exactly",()=>{
  const pmf=poissonCountPmf(.5,10);
  assert.ok(approx(sum(pmf),1));
  assert.ok(approx(pmf[0],Math.exp(-.5)),`P(0) should be e^-0.5 = ${Math.exp(-.5)}, got ${pmf[0]}`);
  assert.ok(approx(pmfAtLeast(pmf,1),1-Math.exp(-.5)),`P(1+) should be 1-e^-0.5 = ${1-Math.exp(-.5)}, got ${pmfAtLeast(pmf,1)}`);
});

test("poissonCountPmf(1.2): P(2 goals) matches the closed-form lambda^2*e^-lambda/2! exactly",()=>{
  const pmf=poissonCountPmf(1.2,12);
  const expected=Math.pow(1.2,2)*Math.exp(-1.2)/2;
  assert.ok(approx(pmf[2],expected),`P(2) should be ${expected}, got ${pmf[2]}`);
});

// --- Negative Binomial: mean/variance recovery and Poisson convergence ---

test("negativeBinomialCountPmf recovers its own mean and the theoretical variance mean+mean^2/r exactly",()=>{
  for(const[mean,r]of[[.5,5],[.6,2],[1,50],[.3,40.4]]as[number,number][]){
    const pmf=negativeBinomialCountPmf(mean,r,30);
    assert.ok(approx(sum(pmf),1),`PMF for mean=${mean} r=${r} must sum to 1`);
    const recoveredMean=pmfMean(pmf);
    assert.ok(approx(recoveredMean,mean,1e-4),`mean=${mean} r=${r}: recovered mean ${recoveredMean} should match input`);
    const variance=pmf.reduce((total,p,k)=>total+p*(k-recoveredMean)**2,0);
    const theoretical=mean+mean*mean/r;
    assert.ok(approx(variance,theoretical,1e-3),`mean=${mean} r=${r}: variance ${variance} should match mean+mean^2/r=${theoretical}`);
  }
});

test("negativeBinomialCountPmf converges to Poisson as r grows large (r=50 vs plain Poisson at lambda=1)",()=>{
  const nb=negativeBinomialCountPmf(1,50,15);
  const poisson=poissonCountPmf(1,15);
  const maxDiff=Math.max(...nb.map((v,i)=>Math.abs(v-poisson[i])));
  assert.ok(maxDiff<.005,`NB(r=50) should be nearly indistinguishable from Poisson at lambda=1; max per-cell difference was ${maxDiff}`);
});

test("negativeBinomialCountPmf has strictly more variance at low r than high r, for the same mean (real overdispersion, not just a wider clamp)",()=>{
  const lowR=negativeBinomialCountPmf(.6,4.4,20),highR=negativeBinomialCountPmf(.6,50,20);
  const varOf=(pmf:Pmf)=>{const m=pmfMean(pmf);return pmf.reduce((total,p,k)=>total+p*(k-m)**2,0)};
  assert.ok(varOf(lowR)>varOf(highR),`low-r variance (${varOf(lowR)}) must exceed high-r variance (${varOf(highR)}) at the same mean`);
  assert.ok(approx(pmfMean(lowR),pmfMean(highR),1e-4),"both must preserve the same mean despite the different dispersion");
});

test("negativeBinomialDispersion is linear in confidence and bounded by NB_R_MIN/NB_R_MAX",()=>{
  assert.ok(approx(negativeBinomialDispersion(.05),4.4),"at the real confidence floor .05, r should be 2+48*.05=4.4");
  assert.ok(approx(negativeBinomialDispersion(1),50),"at confidence 1, r should hit its NB_R_MAX ceiling of 50");
  assert.ok(negativeBinomialDispersion(.5)>negativeBinomialDispersion(.05),"r must increase monotonically with confidence");
});

// --- Appearance points: reconciles exactly with the existing continuous xPts formula ---

test("appearancePointsPmf's expectation matches projectionMetrics' own continuous appearance term exactly",()=>{
  for(const[start,sixty]of[[.9,.85],[.5,.4],[.7,.2],[1,1],[0,0]]as[number,number][]){
    const pmf=appearancePointsPmf(start,sixty,1);
    assert.ok(approx(sum(pmf),1),`appearance PMF for start=${start} sixty=${sixty} must sum to 1`);
    const existingContinuousFormula=(1-sixty)*start+sixty*2;
    assert.ok(approx(pmfMean(pmf),existingContinuousFormula),`start=${start} sixty=${sixty}: PMF mean ${pmfMean(pmf)} must equal the existing (1-sixty)*start+sixty*2 formula (${existingContinuousFormula})`);
  }
});

// --- Clean sheet: gated on 60+ minutes, position-scaled, zero for FWD ---

test("cleanSheetPointsPmf discounts by sixtyProbability and scales points by position",()=>{
  const def=cleanSheetPointsPmf(.5,.8,"DEF",1);
  assert.ok(approx(sum(def),1));
  assert.ok(approx(def[4],.4),"DEF clean sheet is worth 4 points, at probability .5*.8=.4");
  const mid=cleanSheetPointsPmf(.5,.8,"MID",1);
  assert.ok(approx(mid[1],.4),"MID clean sheet is worth 1 point at the same .4 probability");
  const fwd=cleanSheetPointsPmf(.5,.8,"FWD",1);
  assert.deepEqual(fwd,[1],"FWD clean sheets are worth 0 points -- a degenerate PMF, not a wasted computation");
});

// --- Defensive contribution: exact algebraic recovery from the existing points value ---

test("defensiveContributionPmf recovers the underlying probability by dividing the existing points value by 2",()=>{
  const pmf=defensiveContributionPmf(1.4,"DEF",1); // existing field is already P(threshold)*2
  assert.ok(approx(sum(pmf),1));
  assert.ok(approx(pmf[2],.7),"P(2 DC points) should be 1.4/2=.7, recovered algebraically from the existing field");
  assert.ok(approx(pmf[0],.3));
});

test("defensiveContributionPmf is degenerate zero for goalkeepers, who cannot score DC points",()=>{
  assert.deepEqual(defensiveContributionPmf(1.9,"GKP",1),[1]);
});

// --- Bonus: openly-approximated, exact mean recovery by construction ---

test("bonusPointsPmf's mean exactly equals the input expected value, by construction, across the valid 0-1.6 range",()=>{
  for(const expected of[0,.1,.5,1,1.6]){
    const pmf=bonusPointsPmf(expected,1);
    assert.ok(approx(sum(pmf),1),`bonus PMF for expected=${expected} must sum to 1`);
    assert.ok(approx(pmfMean(pmf),expected),`bonus PMF mean should equal the input expected value ${expected}, got ${pmfMean(pmf)}`);
  }
});

test("bonusPointsPmf weights 1 point as more likely than 2, and 2 more likely than 3, whenever any bonus occurs",()=>{
  const pmf=bonusPointsPmf(1,1);
  assert.ok(pmf[1]>pmf[2]&&pmf[2]>pmf[3],"the 3:2:1 shape must be preserved in the output ordering");
});

// --- Double gameweek awareness: each fixture-shaped component convolved across fixtureCount ---

test("appearancePointsPmf: a double gameweek convolves the same per-fixture PMF twice, giving a real 0-4 range instead of capping at 0-2",()=>{
  const single=appearancePointsPmf(.9,.85,1),double=appearancePointsPmf(.9,.85,2);
  assert.ok(approx(sum(double),1));
  assert.equal(single.length,3,"single fixture: 0,1,2");
  assert.equal(double.length,5,"double fixture: 0,1,2,3,4");
  assert.ok(approx(pmfMean(double),pmfMean(single)*2,1e-6),"mean must exactly double, since each fixture is i.i.d.");
  // Hand check: P(4 points) = P(60+ in both) = sixty^2 exactly, by independence
  assert.ok(approx(double[4],.85*.85),`P(4) should be sixtyProbability^2=.7225, got ${double[4]}`);
});

test("appearancePointsPmf: a blank gameweek (fixtureCount=0) collapses to a certain 0, regardless of start/sixty probability",()=>{
  const blank=appearancePointsPmf(.9,.85,0);
  assert.deepEqual(blank,[1],"zero fixtures means zero possible appearance points, full stop");
});

test("cleanSheetPointsPmf: a double gameweek can pay out 0, one, or two clean sheets, using the existing per-fixture-averaged probability",()=>{
  const single=cleanSheetPointsPmf(.5,.8,"DEF",1),double=cleanSheetPointsPmf(.5,.8,"DEF",2);
  assert.ok(approx(sum(double),1));
  const p=.5*.8; // per-fixture clean-sheet-and-60-minutes probability
  assert.ok(approx(double[0],(1-p)*(1-p)),`P(0) should be (1-p)^2=${(1-p)*(1-p)}, got ${double[0]}`);
  assert.ok(approx(double[4],2*p*(1-p)),`P(4, exactly one clean sheet) should be 2p(1-p)=${2*p*(1-p)}, got ${double[4]}`);
  assert.ok(approx(double[8],p*p),`P(8, both clean sheets) should be p^2=${p*p}, got ${double[8]}`);
  assert.ok(approx(pmfMean(double),pmfMean(single)*2,1e-6));
});

test("defensiveContributionPmf: a double gameweek's summed points value is correctly un-collapsed back into two independent trials",()=>{
  // 2.6 raw points from two fixtures implies an average per-fixture probability of 2.6/(2*2)=.65
  const double=defensiveContributionPmf(2.6,"DEF",2);
  assert.ok(approx(sum(double),1));
  const p=.65;
  assert.ok(approx(double[0],(1-p)*(1-p)),`P(0) should be (1-p)^2=${(1-p)*(1-p)}, got ${double[0]}`);
  assert.ok(approx(double[4],p*p),`P(4, both fixtures clear the threshold) should be p^2=${p*p}, got ${double[4]}`);
  assert.ok(approx(pmfMean(double),2.6,1e-6),"the mean must still reconcile exactly to the original summed points value");
  // The bug this test guards against: naively dividing the summed value by 2 without accounting for
  // fixtureCount would clamp to Bernoulli(1,2) -- a certain, single 2-point outcome -- losing the
  // entire 0/4-point spread.
  assert.ok(double[0]>0&&double[4]>0,"both the 0-point and 4-point outcomes must have real probability, not be collapsed to a certain 2");
});

test("bonusPointsPmf: a double gameweek's real ceiling is 6 points (3+3), not 3",()=>{
  const double=bonusPointsPmf(3.2,2); // the actual fpl.ts clamp ceiling for a DGW is 1.6*2=3.2
  assert.ok(approx(sum(double),1));
  assert.equal(double.length,7,"double fixture bonus points: 0 through 6");
  assert.ok(approx(pmfMean(double),3.2,1e-6),"mean must reconcile exactly to the summed input expected value");
  assert.ok(double[6]>0,"a maximal double gameweek (3+3 bonus) must have non-zero probability, not be capped at 3");
});

test("all four fixture-shaped components reduce to exactly their old single-fixture behavior at fixtureCount=1 (no regression)",()=>{
  assert.deepEqual(appearancePointsPmf(.7,.5,1),[(1-.7)*(1-.5),.7*(1-.5),.5]);
  assert.deepEqual(cleanSheetPointsPmf(.4,.6,"DEF",1),bernoulliPmf(.4*.6,4));
  assert.deepEqual(defensiveContributionPmf(1.2,"MID",1),bernoulliPmf(.6,2));
  const bonus=bonusPointsPmf(.9,1);
  assert.ok(approx(pmfMean(bonus),.9,1e-9));
});

// --- Saves: Poisson count remapped through floor(saves/3), zero for outfield players ---

test("savesPointsPmf remaps save-count Poisson mass through floor(count/3) correctly",()=>{
  // At mean=4, hand-check P(0 save points) = P(0,1 or 2 saves) via Poisson(4)
  const pmf=savesPointsPmf(4,"GKP");
  const rawCounts=poissonCountPmf(4,12);
  const expectedZeroSavePoints=rawCounts[0]+rawCounts[1]+rawCounts[2];
  assert.ok(approx(sum(pmf),1));
  assert.ok(approx(pmf[0],expectedZeroSavePoints,1e-6),`P(0 save points) should equal P(0,1 or 2 raw saves)=${expectedZeroSavePoints}, got ${pmf[0]}`);
});

test("savesPointsPmf is degenerate zero for outfield players",()=>{
  assert.deepEqual(savesPointsPmf(4,"DEF"),[1]);
});

// --- Full distribution: sums to 1, and the specific defender/goalkeeper generalization claim ---

test("playerPointsDistribution always sums to 1 across a spread of realistic and edge-case metrics",()=>{
  const cases:[ProjectionMetrics,string][]=[
    [makeMetrics({xG:.87,xA:.15}),"FWD"],
    [makeMetrics({xG:.03,xA:.02,cleanSheetProbability:.65,defensiveContribution:1.6}),"DEF"],
    [makeMetrics({xG:0,xA:0,cleanSheetProbability:.6,saves:3.5}),"GKP"],
    [makeMetrics({xG:0,xA:0,startProbability:.03,sixtyProbability:.02,cleanSheetProbability:0,defensiveContribution:0,bonus:0}),"FWD"],
    [makeMetrics({xG:3,xA:3,cleanSheetProbability:.9,defensiveContribution:1.9,bonus:1.6,saves:8}),"GKP"],
  ];
  for(const[metrics,position]of cases){
    const pmf=playerPointsDistribution(metrics,position);
    assert.ok(approx(sum(pmf),1,1e-6),`distribution for position=${position} xG=${metrics.xG} must sum to 1, got ${sum(pmf)}`);
  }
});

// This is the specific limitation the design round flagged: the old captainReturnHaul formula
// (xG*45+xA*25) never looked at clean sheet, DC or bonus at all, so a defender's haul chance was
// structurally floored near its 2% clamp regardless of how nailed-on their clean sheet/DC actually
// was. The new engine must produce a real, meaningfully differentiated haul chance for a defender
// whose upside comes from clean sheet + DC + bonus stacking, not attacking threat.
test("a nailed-on defender with a strong clean-sheet/DC/bonus profile has a real haul chance despite near-zero xG/xA",()=>{
  const weakDefender=makeMetrics({xG:.06,xA:.05,cleanSheetProbability:.1,defensiveContribution:.1,bonus:.2});
  const strongDefender=makeMetrics({xG:.03,xA:.02,cleanSheetProbability:.65,defensiveContribution:1.6,bonus:.6,startProbability:.95,sixtyProbability:.92});
  const weakHaul=haulProbability(playerPointsDistribution(weakDefender,"DEF"));
  const strongHaul=haulProbability(playerPointsDistribution(strongDefender,"DEF"));
  assert.ok(strongHaul>.08,`a nailed-on, high-clean-sheet, high-DC defender should have a real double-digit-adjacent haul chance -- got ${(strongHaul*100).toFixed(1)}%, the old formula would have floored near 2%`);
  assert.ok(strongHaul>weakHaul*5,`strong defender (${(strongHaul*100).toFixed(1)}%) should clearly exceed a weak one (${(weakHaul*100).toFixed(1)}%) despite both having minimal attacking threat`);
});

test("a busy, nailed-on goalkeeper has a real haul chance from clean sheet + saves + bonus, not xG/xA",()=>{
  const keeper=makeMetrics({xG:0,xA:0,cleanSheetProbability:.6,defensiveContribution:0,bonus:.5,saves:3.5,startProbability:.97,sixtyProbability:.95});
  const haul=haulProbability(playerPointsDistribution(keeper,"GKP"));
  assert.ok(haul>.02,`a busy nailed-on keeper should have a non-trivial haul chance -- got ${(haul*100).toFixed(1)}%`);
});

test("a player who essentially never plays (realistically low xG/xA to match near-zero expected minutes) has near-total blank probability and near-zero haul",()=>{
  const benched=makeMetrics({xG:.02,xA:.01,startProbability:.03,sixtyProbability:.02,cleanSheetProbability:.05,defensiveContribution:0,bonus:.02});
  const pmf=playerPointsDistribution(benched,"FWD");
  assert.ok(blankProbability(pmf)>.9,`an essentially-benched player should almost always blank -- got ${(blankProbability(pmf)*100).toFixed(1)}%`);
  assert.ok(haulProbability(pmf)<.01,`an essentially-benched player should have a near-zero haul chance -- got ${(haulProbability(pmf)*100).toFixed(1)}%`);
});

test("increasing xG strictly increases a forward's haul probability, holding everything else fixed",()=>{
  const low=haulProbability(playerPointsDistribution(makeMetrics({xG:.2,xA:.05,cleanSheetProbability:0,defensiveContribution:0}),"FWD"));
  const high=haulProbability(playerPointsDistribution(makeMetrics({xG:.9,xA:.05,cleanSheetProbability:0,defensiveContribution:0}),"FWD"));
  assert.ok(high>low,`expected haul probability to increase with xG: low=${(low*100).toFixed(1)}%, high=${(high*100).toFixed(1)}%`);
});

test("pointsRange returns a monotonic floor <= median <= ceiling and reflects real spread for an explosive attacker",()=>{
  const elite=playerPointsDistribution(makeMetrics({xG:.87,xA:.15,confidence:.8}),"FWD");
  const range=pointsRange(elite);
  assert.ok(range.floor<=range.median&&range.median<=range.ceiling,`range must be monotonic: ${JSON.stringify(range)}`);
  assert.ok(range.ceiling>range.floor,`an explosive attacker should show real spread between floor and ceiling, got ${JSON.stringify(range)}`);
});

// --- goalsPointsPmf / assistsPointsPmf: confidence widens the distribution without moving the mean ---

test("goalsPointsPmf's mean tracks xG*goalPoints regardless of confidence, while low confidence widens the spread",()=>{
  const highConfidence=goalsPointsPmf(.5,.95,"FWD"),lowConfidence=goalsPointsPmf(.5,.05,"FWD");
  assert.ok(approx(pmfMean(highConfidence),.5*4,1e-4));
  assert.ok(approx(pmfMean(lowConfidence),.5*4,1e-4),"mean must stay anchored to xG*goalPoints even as confidence changes -- only the spread should move");
  const varOf=(pmf:Pmf)=>{const m=pmfMean(pmf);return pmf.reduce((total,p,k)=>total+p*(k-m)**2,0)};
  assert.ok(varOf(lowConfidence)>varOf(highConfidence),"low-confidence goals distribution must be more spread out than high-confidence at the same xG");
});

// --- End-to-end double gameweek test through the REAL fpl.ts pipeline ---
// Same synthetic-fixture-data discipline as tests/dgw.test.mts's own "clamp(0,16) ceiling must
// scale with fixture count" tests: real projectionMetrics() output from two identical-quality
// fixtures in one event, not a hand-built ProjectionMetrics mock. This is the test that would have
// caught the bug -- component-level unit tests above prove each PMF builder is correct in
// isolation, but only a real double-gameweek projectionMetrics() call proves fixtureCount actually
// reaches playerPointsDistribution correctly through the full pipeline.

function makeDefender(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Reliable Defender", firstName: "Reliable", secondName: "Defender", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 2, position: "Defender", positionShort: "DEF", price: 5.5, status: "a", chance: null,
    epNext: 4, form: 4, pointsPerGame: 5, priorPointsPerGame: 5, priorMinutes: 3000, priorStarts: 34,
    priorExpectedGoals: 2, priorExpectedAssists: 3, priorBonus: 12, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 340, totalPoints: 0, eventPoints: 0, eventMinutes: 0, selectedBy: 25, priceChange: 0, priceProjectionToday: 0,
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0,
    starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

function makeRealFixture(overrides: Partial<FplFixture> = {}): FplFixture {
  return {
    id: 1, event: 1, teamH: 1, teamA: 2, teamHDifficulty: 3, teamADifficulty: 3,
    finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null,
    ...overrides,
  };
}

test("end-to-end: a genuine double gameweek through real projectionMetrics() roughly doubles the points distribution's mean, not just xPts",()=>{
  const player=makeDefender();
  const single=[makeRealFixture({id:1,event:10,teamH:1,teamA:2,teamHDifficulty:3,teamADifficulty:3})];
  const double=[
    makeRealFixture({id:2,event:11,teamH:1,teamA:3,teamHDifficulty:3,teamADifficulty:3}),
    makeRealFixture({id:3,event:11,teamH:1,teamA:4,teamHDifficulty:3,teamADifficulty:3}),
  ];
  const singleMetrics=projectionMetrics(player,10,single,10);
  const doubleMetrics=projectionMetrics(player,11,double,10);
  assert.equal(singleMetrics.fixtureCount,1,"single gameweek must report fixtureCount=1");
  assert.equal(doubleMetrics.fixtureCount,2,"double gameweek must report fixtureCount=2");

  const singlePmf=playerPointsDistribution(singleMetrics,"DEF");
  const doublePmf=playerPointsDistribution(doubleMetrics,"DEF");
  assert.ok(approx(sum(singlePmf),1,1e-6));
  assert.ok(approx(sum(doublePmf),1,1e-6));

  const ratio=pmfMean(doublePmf)/pmfMean(singlePmf);
  assert.ok(ratio>1.85&&ratio<2.15,`two identical-quality fixtures should roughly double the points distribution's mean -- got ${ratio.toFixed(2)}x (single mean=${pmfMean(singlePmf).toFixed(2)}, double mean=${pmfMean(doublePmf).toFixed(2)})`);

  // The specific regression this round fixes: before the fix, appearance/CS/DC/bonus were all
  // silently capped at single-fixture ceilings regardless of fixtureCount, so a double gameweek's
  // haul chance barely moved even though the player has two genuine chances to return. It must now
  // be meaningfully higher, not just marginally.
  const singleHaul=haulProbability(singlePmf),doubleHaul=haulProbability(doublePmf);
  assert.ok(doubleHaul>singleHaul*1.5,`double-gameweek haul probability (${(doubleHaul*100).toFixed(1)}%) should be meaningfully higher than a single gameweek's (${(singleHaul*100).toFixed(1)}%), not barely moved by a silently-capped distribution`);
});

test("end-to-end: a blank gameweek through real projectionMetrics() collapses the distribution to a certain 0, matching xPts",()=>{
  const player=makeDefender();
  const metrics=projectionMetrics(player,99,[],10);
  assert.equal(metrics.xPts,0);
  assert.equal(metrics.fixtureCount,0);
  const pmf=playerPointsDistribution(metrics,"DEF");
  // Component builders like goalsPointsPmf remap through a fixed-length array regardless of actual
  // content, so a genuine blank's combined PMF can be longer than 1 (all-zero past index 0) rather
  // than literally [1] -- checking the content (100% mass at 0) is the correct invariant, not the
  // array's raw length.
  assert.ok(approx(pmf[0],1),`a genuine blank must have 100% probability at 0 points, got P(0)=${pmf[0]}`);
  assert.ok(approx(pmfMean(pmf),0),"a genuine blank's mean must be exactly 0, not a residual distribution left over from startProbability/sixtyProbability");
});

test("event outcome model reconciles an epNext-only first-event change to the full visible xPts target",()=>{
  const fixture=makeRealFixture({id:41,event:20});
  const lower=makeDefender({epNext:2});
  const higher=makeDefender({epNext:8});
  const lowModel=buildPlayerEventOutcomeModel(lower,20,[fixture],20);
  const highModel=buildPlayerEventOutcomeModel(higher,20,[fixture],20);
  assert.equal(lowModel.status,"available");
  assert.equal(highModel.status,"available");
  if(lowModel.status!=="available"||highModel.status!=="available")return;
  const visibleLow=projectionMetrics(lower,20,[fixture],20).xPts;
  const visibleHigh=projectionMetrics(higher,20,[fixture],20).xPts;
  assert.ok(visibleHigh>visibleLow,"the precondition must isolate a positive epNext-only target change");
  assert.ok(approx(lowModel.audit.targetExpectedPoints,visibleLow));
  assert.ok(approx(highModel.audit.targetExpectedPoints,visibleHigh));
  assert.ok(approx(highModel.audit.reconciledModeledMean-lowModel.audit.reconciledModeledMean,visibleHigh-visibleLow));
});

test("DGW event model builds the epNext blend once from the complete fixture list",()=>{
  const p=makeDefender({epNext:8});
  const fixtures=[makeRealFixture({id:51,event:21,teamA:3}),makeRealFixture({id:52,event:21,teamA:4})];
  const model=buildPlayerEventOutcomeModel(p,21,fixtures,21);
  assert.equal(model.status,"available");
  if(model.status!=="available")return;
  const fullTarget=projectionMetrics(p,21,fixtures,21).xPts;
  const incorrectlyRepeatedBlend=fixtures.reduce((sum,fixture)=>sum+projectionMetrics(p,21,[fixture],21).xPts,0);
  assert.ok(approx(model.audit.targetExpectedPoints,fullTarget));
  assert.ok(incorrectlyRepeatedBlend-fullTarget>1,
    `test precondition: per-fixture epNext blending must materially overcount the full-event target; full=${fullTarget}, repeated=${incorrectlyRepeatedBlend}`);
  assert.ok(approx(model.audit.reconciledModeledMean,fullTarget));
});

test("blank event outcome model remains exactly zero with an auditable zero target",()=>{
  const model=buildPlayerEventOutcomeModel(makeDefender({epNext:12}),99,[],99);
  assert.equal(model.status,"available");
  if(model.status!=="available")return;
  assert.equal(model.fixtures.length,0);
  assert.deepEqual({target:model.audit.targetExpectedPoints,raw:model.audit.rawModeledMean,reconciled:model.audit.reconciledModeledMean,gap:model.audit.reconciliationGap},
    {target:0,raw:0,reconciled:0,gap:0});
});

test("an honestly unreconcilable target returns unavailable instead of suppressing guaranteed appearance points",()=>{
  const player=makeDefender({
    positionId:4,position:"Forward",positionShort:"FWD",epNext:.01,selectedBy:0,
    priorExpectedGoals:0,priorExpectedAssists:0,priorBonus:0,priorDefensiveContribution:0,
    form:0,pointsPerGame:0,priorPointsPerGame:0,
  });
  const fixture=makeRealFixture({id:55,event:24,teamHDifficulty:5});
  const model=buildPlayerEventOutcomeModel(player,24,[fixture],24);
  assert.equal(model.status,"unavailable");
  if(model.status!=="unavailable")return;
  assert.match(model.reason,/below appearance and clean-sheet mean/);
});

test("goalkeeper event model retains discrete save points and the existing penalty-save expectation",()=>{
  const keeper=makeDefender({
    id:2,positionId:1,position:"Goalkeeper",positionShort:"GKP",priorSaves:150,priorPenaltiesSaved:5,
    priorExpectedGoals:0,priorExpectedAssists:0,priorDefensiveContribution:0,
  });
  const fixture=makeRealFixture({id:61,event:22,teamHDifficulty:4});
  const metrics=projectionMetrics(keeper,22,[fixture],22);
  const model=buildPlayerEventOutcomeModel(keeper,22,[fixture],22);
  assert.equal(model.status,"available");
  if(model.status!=="available")return;
  assert.ok((metrics.penaltySavePoints??0)>0,"the existing point model must expose its penalty-save expectation");
  assert.ok(model.audit.components.discreteSavePoints>0,"save counts must still be discretized through floor(saves/3)");
  assert.ok(model.audit.components.penaltySavePoints>0,"penalty-save expected points must not disappear from the scenario model");
  assert.ok(approx(model.audit.reconciledModeledMean,metrics.xPts));
});

test("real player/event scenario samples stay close to displayed xPts after exact analytic reconciliation",()=>{
  const p=makeDefender({epNext:6});
  const fixtures=[makeRealFixture({id:71,event:23,teamA:3}),makeRealFixture({id:72,event:23,teamA:4})];
  const model=buildPlayerEventOutcomeModel(p,23,fixtures,23);
  assert.equal(model.status,"available");
  if(model.status!=="available")return;
  const scenarioCount=1024;
  let total=0;
  for(let scenario=0;scenario<scenarioCount;scenario++){
    total+=sampleDecisionScenario([model],scenario,scenarioCount).get(playerEventOutcomeKey(23,p.id))!.points;
  }
  const sampledMean=total/scenarioCount;
  assert.ok(approx(model.audit.reconciledModeledMean,model.audit.targetExpectedPoints,model.audit.tolerance));
  assert.ok(Math.abs(sampledMean-model.audit.targetExpectedPoints)<=model.audit.sampledMeanTolerance,
    `sample mean ${sampledMean} must stay within documented tolerance ${model.audit.sampledMeanTolerance} of xPts ${model.audit.targetExpectedPoints}`);
});
