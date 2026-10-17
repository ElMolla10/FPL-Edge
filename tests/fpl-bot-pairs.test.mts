import assert from "node:assert/strict";
import test from "node:test";
import { fundingExample } from "./fixtures/funding-example.mts";
import { BOT_ENV, twoTransfersEnabled, parseHitPolicy } from "../app/lib/fpl-bot/config.ts";
import { planGameweek, elementsFromData } from "../app/lib/fpl-bot/planner.ts";
import { buildTransfersPayload } from "../app/lib/fpl-bot/payloads.ts";
import { validateTransfersPayload } from "../app/lib/fpl-bot/validate.ts";
import { compareFreeTransferBundles } from "../app/lib/fpl-bot/two-transfers.ts";
import type { BotMyTeam } from "../app/lib/fpl-bot/types.ts";
import { generateRouteOpeningActions } from "../app/lib/transfer-routes.ts";
import { FIXTURE_BASE_MS, dataFor } from "./fixtures/transfer-pair.mts";
import { botD1 } from "./helpers/bot-d1.mts";
import { importBotKey } from "../app/lib/fpl-bot/crypto.ts";
import { storeBotBootstrap } from "../app/lib/fpl-bot/store.ts";
import { rehearseBot } from "../app/lib/fpl-bot/runner.ts";
import { recommendTransfers } from "../app/lib/transfer-engine/recommend.ts";

function fixture(limit = 2, made = 0) {
  const f = fundingExample();
  const myTeam: BotMyTeam = {
    picks: f.initial.map((p, i) => ({ element: p.id, position: i + 1, multiplier: i < 11 ? 1 : 0,
      is_captain: i === 0, is_vice_captain: i === 1, selling_price: Math.round(f.selling.get(p.id)! * 10), purchase_price: Math.round(p.price * 10) })),
    transfers: { bank: 10, limit, made, cost: 0 }, chips: [],
  };
  const input = { data: f.data, myTeam, event: f.data.events[0], hitPolicy: parseHitPolicy("none"),
    chipPolicy: "none" as const, recentHitPoints: 0, allowTransfers: true };
  return { f, input };
}

test("two-transfer flag defaults off and requires literal true", () => {
  for (const value of [undefined, "", "false", "1", "yes", "typo"]) assert.equal(twoTransfersEnabled({ [BOT_ENV.twoTransfers]: value }), false);
  assert.equal(twoTransfersEnabled({ [BOT_ENV.twoTransfers]: "true" }), true);
});

test("default-off plan equals explicit off; enabled funding bundle is legal and free", () => {
  const { f, input } = fixture();
  assert.deepEqual(planGameweek(input), planGameweek({ ...input, enableTwoTransfers: false }));
  const plan = planGameweek({ ...input, enableTwoTransfers: true });
  assert.deepEqual(plan.legs.map(l => [l.outId, l.inId]).sort((a,b) => a[0]-b[0]), [[2,101],[21,102]]);
  assert.equal(plan.hitCost, 0);
  const elements = elementsFromData(f.data);
  const payload = buildTransfersPayload({ entry: "4242", event: input.event.id, legs: plan.legs, myTeam: input.myTeam, elements, chip: null });
  const validation = validateTransfersPayload(payload, { botEntry: "4242", event: input.event.id, nowMs: 0,
    deadlineMs: Number.MAX_SAFE_INTEGER, deadlineGuardMs: 0, myTeam: input.myTeam, elements,
    freeTransfers: plan.freeTransfers, hitPolicy: input.hitPolicy, recentHitPoints: 0 });
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.bankAfter, 0);
  assert.equal(validation.hitCost, 0);
});

test("remaining FT uses limit minus made, and 0/1 FT preserves existing path", () => {
  for (const [limit, made] of [[2,1],[2,2],[1,0]]) {
    const { input } = fixture(limit, made);
    assert.deepEqual(planGameweek({ ...input, enableTwoTransfers: true }), planGameweek(input));
  }
  const { input } = fixture(3,1);
  assert.equal(planGameweek({ ...input, enableTwoTransfers: true }).legs.length, 2);
});

test("lineup-only and pre-first-deadline paths remain identical with the flag", () => {
  const { input } = fixture();
  assert.deepEqual(planGameweek({ ...input, allowTransfers: false, enableTwoTransfers: true }), planGameweek({ ...input, allowTransfers: false }));
  const pre = { ...input, preFirstDeadline: true, myTeam: { ...input.myTeam, transfers: { ...input.myTeam.transfers, limit: null } } };
  assert.deepEqual(planGameweek({ ...pre, enableTwoTransfers: true }), planGameweek(pre));
});

test("comparison shares type-B HOLD, discounts and confidence scoring; FT awarded once", () => {
  const { f } = fixture();
  const result = compareFreeTransferBundles(f.data, f.initial, f.bank, 2, f.selling, []);
  assert.equal(result.complete, true);
  assert.ok(result.bestPair);
  for (const action of result.actions) {
    assert.equal(action.plan.freeTransfersPath[0], Math.min(5, 3-action.legs.length));
    assert.equal(action.plan.hitCostTotal, 0);
    assert.equal(action.rawNet, action.plan.discountedTotal - result.hold!.discountedTotal);
    assert.equal(action.riskAdjustedNet, action.rawNet > 0 ? action.rawNet * action.riskMultiplier : action.rawNet);
  }
});

test("invalid budget, club count and unavailable incoming reject the funding pair", () => {
  for (const mutate of [
    (f: ReturnType<typeof fundingExample>) => { f.bank = .9; },
    (f: ReturnType<typeof fundingExample>) => { f.upgrade.status = "d"; f.upgrade.chance = 50; },
    (f: ReturnType<typeof fundingExample>) => { f.initial.filter(p => ![2,21].includes(p.id)).slice(0,3).forEach(p => p.teamId=500); f.upgrade.teamId=500; },
  ]) {
    const { f } = fixture(); mutate(f);
    const result = compareFreeTransferBundles(f.data, f.initial, f.bank, 2, f.selling, []);
    assert.equal(result.bestPair, null);
  }
});

test("budget exhaustion discards comparison and does not authorize a pair", () => {
  const { f } = fixture();
  const result = compareFreeTransferBundles(f.data, f.initial, f.bank, 2, f.selling, [], { maxPlanNodes: 1 });
  assert.equal(result.complete, false);
  assert.equal(result.bestPair, null);
});

test("deterministic budget covers preprocessing and cannot return a partial decision", () => {
  const { f } = fixture();
  const result = compareFreeTransferBundles(f.data,f.initial,f.bank,2,f.selling,[],{maxComputationUnits:25});
  assert.equal(result.complete,false);
  assert.equal(result.bestPair,null);
  assert.equal(result.hold,null);
  assert.deepEqual(result.actions,[]);
  assert.ok(result.work.used<=result.work.limit);
  assert.equal(result.work.plansStarted,0,"projection/menu work is charged before any future plan");
});

test("aggregate budget discards already-scored actions when later plans cannot finish", () => {
  const { f } = fixture();
  const options={maxPlanNodes:10};
  const full=compareFreeTransferBundles(f.data,f.initial,f.bank,2,f.selling,[],options);
  assert.equal(full.complete,true);
  assert.ok(full.work.plansStarted>2);
  // This one-event fixture charges one search node per complete plan. Allow
  // preparation, the equal 10-node allowance + 30 cache slots, and one extra unit.
  const limit=full.work.used-full.work.plansStarted+41;
  const exhausted=compareFreeTransferBundles(f.data,f.initial,f.bank,2,f.selling,[],{...options,maxComputationUnits:limit});
  assert.equal(exhausted.complete,false);
  assert.ok(exhausted.work.plansStarted>0);
  assert.ok(exhausted.work.plansStarted<full.work.plansStarted);
  assert.equal(exhausted.hold,null);
  assert.equal(exhausted.bestPair,null);
  assert.deepEqual(exhausted.actions,[]);
  assert.ok(exhausted.work.used<=limit);
});

test("frozen and rapidly advancing clocks produce identical complete comparisons", t => {
  const { f } = fixture();
  const clock=t.mock.method(performance,"now",()=>0);
  const frozen=compareFreeTransferBundles(f.data,f.initial,f.bank,2,f.selling,[]);
  assert.equal(frozen.complete,true);
  let tick=0;
  clock.mock.mockImplementation(()=>tick+=1_000_000_000);
  const advancing=compareFreeTransferBundles(f.data,f.initial,f.bank,2,f.selling,[]);
  assert.deepEqual(advancing,frozen);
});

test("equal-score bundle tie-break is bytewise and never calls localeCompare", t => {
  const { f } = fixture();
  f.data.players.push({...f.downgrade,id:103,name:"Equal funding keeper",teamId:103});
  const reference=compareFreeTransferBundles(f.data,f.initial,f.bank,2,f.selling,[]);
  assert.ok(reference.bestPair);
  assert.ok(reference.bestPair.legs.some(l=>l.incoming.id===101));
  t.mock.method(String.prototype,"localeCompare",()=>{throw new Error("locale collation forbidden");});
  f.data.players.reverse();
  const result=compareFreeTransferBundles(f.data,f.initial,f.bank,2,f.selling,[]);
  assert.deepEqual(result,reference);
});

test("oversized player universe safely keeps the legacy fallback without preprocessing", () => {
  const { f } = fixture();
  for(let id=200;f.data.players.length<=1000;id++)f.data.players.push({...f.upgrade,id,teamId:id});
  const result=compareFreeTransferBundles(f.data,f.initial,f.bank,2,f.selling,[]);
  assert.equal(result.complete,false);
  assert.equal(result.bestPair,null);
  assert.equal(result.work.used,0);
});

test("repeated and reversed player pools choose the same bundle", () => {
  const { input } = fixture();
  const run = () => planGameweek({ ...input, enableTwoTransfers: true });
  const first = run();
  assert.deepEqual(run(), first);
  input.data.players.reverse();
  assert.deepEqual(run().legs, first.legs);
});

test("negative-projection funding leg survives more than 20 competing upgrade proposals", () => {
  const { f } = fixture();
  const distractors = Array.from({length:25},(_,i)=>({ ...f.upgrade, id:200+i, teamId:200+i, price:25 }));
  f.data.players.push(...distractors);
  const actions = generateRouteOpeningActions(f.data,f.initial,f.bank,f.selling,
    p=>p.id===101 ? -5 : p.id>=200 ? 100 : p.id===102 ? 20 : 0, p=>p.status==="a");
  // Cheap funding leg is retained even though all its individual deltas are negative.
  assert.ok(actions.some(a=>a.some(l=>l.incoming.id===101 && l.horizonGain<0)));
  // Full projection scoring (not the toy ordering above) still finds the affordable pair.
  const result = compareFreeTransferBundles(f.data,f.initial,f.bank,2,f.selling,[]);
  assert.ok(result.bestPair);
  assert.ok(result.bestPair.legs.some(l=>l.incoming.id===101));
});

test("five-GW comparison allows future free moves on HOLD and scores bundle on same horizon", () => {
  const { f } = fixture();
  f.bank = 4;
  f.data = dataFor(f.data.players,5);
  const result = compareFreeTransferBundles(f.data,f.initial,f.bank,2,f.selling,[]);
  assert.equal(result.complete,true);
  assert.equal(result.hold!.steps.length,5);
  assert.ok(result.hold!.steps.slice(1).some(w=>w.action==="TRANSFER"));
  assert.ok(result.actions.some(a=>a.legs.length===1));
  assert.ok(result.actions.some(a=>a.legs.length===2));
  assert.ok(result.actions.every(a=>a.plan.steps.length===5));
  const engine = recommendTransfers(f.data,f.initial,f.bank,2,f.selling,{mode:"deep",limit:100,
    rules:{planTimeBudgetMs:120_000,maxPlanNodes:100_000,maxSameIncomingInResults:100,maxSameOutgoingInResults:100}});
  const comparison = compareFreeTransferBundles(f.data,f.initial,f.bank,2,f.selling,[],{maxPlanNodes:100_000});
  assert.equal(comparison.hold!.discountedTotal,engine.hold.discountedTotal);
  for(const action of comparison.actions.filter(a=>a.legs.length===1)) {
    const rec = engine.recommendations.find(r=>r.net.legs[0]?.out.id===action.legs[0].out.id&&r.net.legs[0]?.incoming.id===action.legs[0].incoming.id);
    assert.ok(rec,"same single move is present in the existing engine");
    assert.equal(action.rawNet,rec.net.fiveGwNetVsHold);
    assert.equal(action.riskAdjustedNet,rec.net.riskAdjustedFiveGwNetVsHold);
  }
});

test("a pair with no extra score cannot displace the affordable single; empty menu retains HOLD", () => {
  const { f } = fixture();
  const singleWins = compareFreeTransferBundles(f.data,f.initial,4,2,f.selling,[]);
  assert.equal(singleWins.complete,true);
  assert.equal(singleWins.bestPair,null);
  f.data.players = [...f.initial];
  const hold = compareFreeTransferBundles(f.data,f.initial,f.bank,2,f.selling,[]);
  assert.equal(hold.complete,true);
  assert.equal(hold.bestPair,null);
  assert.deepEqual(hold.actions,[]);
});

test("mocked runner honors env flag, builds one two-leg payload, and makes no writes", async () => {
  const { input } = fixture();
  const { db } = botD1();
  const tokenKey = Buffer.alloc(32,9).toString("base64");
  const now = FIXTURE_BASE_MS;
  await storeBotBootstrap(db,await importBotKey(tokenKey), { refreshToken:"fake-refresh",accessToken:"fake-access",accessExpiresAtMs:Date.now()+3_600_000 }, "4242",now);
  const calls: string[]=[];
  const elements = input.data.players.map(p=>({ id:p.id,element_type:p.positionId,team:p.teamId,status:p.status,
    chance_of_playing_next_round:p.chance,now_cost:Math.round(p.price*10) }));
  // Freshness guard needs >=300 official-shaped rows; padding is validation-only,
  // never supplied to projection data or used as invented planner candidates.
  for(let id=1000;elements.length<300;id++) elements.push({id,element_type:3,team:900,status:"a",chance_of_playing_next_round:null,now_cost:50});
  const deps = { db, env: { FPL_EDGE_BOT_FPL_ENTRY_ID:"4242", FPL_EDGE_BOT_TOKEN_KEY:tokenKey,
      FPL_EDGE_BOT_CHIP_POLICY:"none", FPL_EDGE_BOT_HIT_POLICY:"none" },
    loadData:async()=>input.data, now:()=>now, sleep:async()=>{}, log:()=>{},
    fetchPublicJson:async()=>({elements}),
    fetchImpl:(async (request: RequestInfo | URL, init?:RequestInit) => {
      const url=String(request); const method=init?.method??"GET";calls.push(method);
      assert.equal(method,"GET","no actual FPL POST can escape this test");
      return new Response(JSON.stringify(url.includes("/api/me/")?{player:{entry:4242}}:input.myTeam));
    }) as typeof fetch };
  const off = await rehearseBot(deps);
  const on = await rehearseBot({...deps,env:{...deps.env,FPL_EDGE_BOT_TWO_TRANSFERS:"true"}});
  assert.equal(off.ok,true); assert.equal(on.ok,true);
  if(!off.ok||!on.ok)return;
  assert.ok(off.legs.length<=1);
  assert.equal(on.legs.length,2);
  assert.equal(on.transfersPayload?.transfers.length,2);
  assert.deepEqual(on.transferErrors,[]);
  assert.equal(on.hitCost,0);
  assert.ok(calls.every(m=>m==="GET"));
});
