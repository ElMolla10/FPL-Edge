import assert from "node:assert/strict";
import test from "node:test";
import { FplPlayer } from "../app/lib/fpl.ts";
import { SquadEvaluation } from "../app/lib/optimizer.ts";
import * as squadComparison from "../app/lib/squad-comparison.ts";
import {
  applySandboxTransfer,
  buildSandboxReasoning,
  compareSquads,
  createSandboxState,
  evaluateSandbox,
  resetSandbox,
  sandboxEconomics,
  undoSandboxTransfer,
} from "../app/lib/squad-comparison.ts";

const requiredTransferCount = (baseline: FplPlayer[], current: FplPlayer[]) => {
  assert.equal(typeof squadComparison.requiredTransferCount, "function", "requiredTransferCount must be exported as pure business logic");
  return squadComparison.requiredTransferCount(baseline, current);
};

function player(id: number, name = `Player ${id}`): FplPlayer {
  return { id, name } as FplPlayer;
}

function evaluation(overrides: {
  objective?: number;
  overall?: number;
  weekPoints?: number[];
  scoreChanges?: Partial<SquadEvaluation["scores"]>;
  formation?: string;
  captain?: FplPlayer;
  vice?: FplPlayer;
  xi?: FplPlayer[];
  bench?: FplPlayer[];
  warnings?: string[];
  bank?: number;
} = {}): SquadEvaluation {
  const xi = overrides.xi ?? Array.from({ length: 11 }, (_, index) => player(index + 1));
  const captain = overrides.captain ?? xi[0];
  const vice = overrides.vice ?? xi[1];
  const bench = overrides.bench ?? [player(12), player(13), player(14), player(15)];
  const weekPoints = overrides.weekPoints ?? [50, 50, 50, 50, 50];
  const scores = {
    projectedPoints: 70,
    captaincy: 71,
    fixtures: 72,
    minutesSecurity: 73,
    bench: 74,
    flexibility: 75,
    value: 76,
    risk: 77,
    overall: overrides.overall ?? 78,
    ...overrides.scoreChanges,
  };
  return {
    objective: overrides.objective ?? 100,
    weightedPoints: 200,
    fiveWeekPoints: weekPoints.slice(0, 5).reduce((sum, value) => sum + value, 0),
    weeks: weekPoints.map((points, index) => ({
      eventId: 30 + index,
      xi,
      bench,
      captain,
      vice,
      formation: overrides.formation ?? "3-5-2",
      points,
      captainPoints: 10,
    })),
    flexibility: scores.flexibility,
    benchUtility: 5,
    deadSlots: 0,
    riskPenalty: 1,
    bank: overrides.bank ?? 1,
    scores,
    warnings: overrides.warnings ?? [],
    strategy: { formation: overrides.formation ?? "3-5-2", premiums: [], captain: captain.name, budget: {}, benchSpend: 18, targets: [], risk: "Balanced" },
  };
}

test("squad rating comparison uses scores.overall even when objective moves by a different amount", () => {
  const before = evaluation({ objective: 10, overall: 82 });
  const after = evaluation({ objective: 999, overall: 85 });

  const result = compareSquads([], [], before, after);

  assert.deepEqual(result.rating, { before: 82, after: 85, delta: 3 });
  assert.equal(result.objective.delta, 989, "objective remains available only as a separately labelled secondary metric");
});

test("objective-only movement cannot create a visible squad-rating delta", () => {
  const result = compareSquads([], [], evaluation({ objective: 12, overall: 82 }), evaluation({ objective: 31, overall: 82 }));

  assert.equal(result.rating.delta, 0);
  assert.equal(result.objective.delta, 19);
});

test("next-gameweek, three-gameweek and five-gameweek expected-point deltas use optimized squad totals", () => {
  const result = compareSquads([], [], evaluation({ weekPoints: [10, 20, 30, 40, 50] }), evaluation({ weekPoints: [11, 19, 35, 42, 48] }));

  assert.deepEqual(result.expectedPoints.nextGameweek, { before: 10, after: 11, delta: 1, availableGameweeks: 1 });
  assert.deepEqual(result.expectedPoints.nextThree, { before: 60, after: 65, delta: 5, availableGameweeks: 3 });
  assert.deepEqual(result.expectedPoints.nextFive, { before: 150, after: 155, delta: 5, availableGameweeks: 5 });
});

test("five-gameweek comparison safely uses only the future gameweeks that remain", () => {
  const result = compareSquads([], [], evaluation({ weekPoints: [10, 20] }), evaluation({ weekPoints: [12, 23] }));

  assert.deepEqual(result.expectedPoints.nextFive, { before: 30, after: 35, delta: 5, availableGameweeks: 2 });
  assert.deepEqual(result.expectedPoints.nextThree, { before: 30, after: 35, delta: 5, availableGameweeks: 2 });
});

test("all eight /100 rating components are compared independently with their semantic direction", () => {
  const before = evaluation();
  const after = evaluation({ scoreChanges: {
    projectedPoints: 71,
    captaincy: 69,
    fixtures: 72,
    minutesSecurity: 80,
    bench: 70,
    flexibility: 76,
    value: 81,
    risk: 75,
  } });

  const result = compareSquads([], [], before, after);

  assert.deepEqual(result.ratingComponents.map(row => [row.key, row.before, row.after, row.delta, row.state]), [
    ["projectedPoints", 70, 71, 1, "positive"],
    ["captaincy", 71, 69, -2, "negative"],
    ["fixtures", 72, 72, 0, "neutral"],
    ["minutesSecurity", 73, 80, 7, "positive"],
    ["bench", 74, 70, -4, "negative"],
    ["flexibility", 75, 76, 1, "positive"],
    ["value", 76, 81, 5, "positive"],
    ["risk", 77, 75, -2, "negative"],
  ]);
});

test("formation, captain, vice-captain, XI movement and bench reordering are detected", () => {
  const oldCaptain = player(1, "Old captain");
  const oldVice = player(2, "Old vice");
  const newCaptain = player(3, "New captain");
  const newVice = player(4, "New vice");
  const benched = player(11, "Leaves XI");
  const promoted = player(12, "Enters XI");
  const beforeXi = [oldCaptain, oldVice, newCaptain, newVice, ...Array.from({ length: 6 }, (_, index) => player(index + 5)), benched];
  const afterXi = beforeXi.filter(p => p.id !== benched.id).concat(promoted);
  const before = evaluation({ formation: "3-5-2", captain: oldCaptain, vice: oldVice, xi: beforeXi, bench: [promoted, player(13), player(14), player(15)] });
  const after = evaluation({ formation: "4-4-2", captain: newCaptain, vice: newVice, xi: afterXi, bench: [player(13), benched, player(14), player(15)] });

  const changes = compareSquads([...beforeXi, promoted], [...afterXi, benched], before, after).structural;

  assert.deepEqual(changes.formation, { before: "3-5-2", after: "4-4-2" });
  assert.deepEqual(changes.captain, { before: oldCaptain, after: newCaptain });
  assert.deepEqual(changes.viceCaptain, { before: oldVice, after: newVice });
  assert.deepEqual(changes.enteredXi.map(p => p.id), [12]);
  assert.deepEqual(changes.exitedXi.map(p => p.id), [11]);
  assert.deepEqual(changes.benchOrder?.before.map(p => p.id), [12, 13, 14, 15]);
  assert.deepEqual(changes.benchOrder?.after.map(p => p.id), [13, 11, 14, 15]);
});

test("new warnings and resolved warnings are distinguished without repeating unchanged warnings", () => {
  const result = compareSquads(
    [],
    [],
    evaluation({ warnings: ["Unchanged", "Resolved"] }),
    evaluation({ warnings: ["Unchanged", "Introduced"] }),
  );

  assert.deepEqual(result.structural.newWarnings, ["Introduced"]);
  assert.deepEqual(result.structural.resolvedWarnings, ["Resolved"]);
});

test("multiple transfers compare the latest step and the cumulative result against the original baseline", () => {
  const a = player(1, "A");
  const b = player(2, "B");
  const c = player(3, "C");
  const d = player(4, "D");
  let state = createSandboxState([a, c]);
  state = applySandboxTransfer(state, a, b);
  state = applySandboxTransfer(state, c, d);
  const ratings = new Map<string, number>([["1,3", 70], ["2,3", 73], ["2,4", 78]]);
  const evaluate = (squad: FplPlayer[]) => evaluation({ overall: ratings.get(squad.map(p => p.id).join(","))! });

  const result = evaluateSandbox(state, evaluate)!;

  assert.equal(result.latest.rating.delta, 5, "latest compares B+C with B+D");
  assert.equal(result.cumulative.rating.delta, 8, "cumulative compares original A+C with current B+D");
  assert.equal(result.sandboxActionCount, 2);
  assert.equal(result.requiredTransferCount, 2);
});

test("sandbox keeps the visible rating evaluation while using a full available-gameweek evaluation for five-GW points", () => {
  const a = player(1, "A");
  const b = player(2, "B");
  const state = applySandboxTransfer(createSandboxState([a]), a, b);
  const visibleEvaluate = (squad: FplPlayer[]) => evaluation({ overall: squad[0].id === 1 ? 80 : 82, weekPoints: squad[0].id === 1 ? [10, 10, 10] : [11, 11, 11] });
  const fullPointsEvaluate = (squad: FplPlayer[]) => evaluation({ overall: 1, weekPoints: squad[0].id === 1 ? [10, 10, 10, 10, 10] : [11, 11, 11, 11, 11] });

  const result = evaluateSandbox(state, visibleEvaluate, fullPointsEvaluate)!;

  assert.equal(result.latest.rating.delta, 2, "rating remains sourced from the visible horizon's evaluation");
  assert.deepEqual(result.latest.expectedPoints.nextFive, { before: 50, after: 55, delta: 5, availableGameweeks: 5 });
});

test("undo restores the exact pre-transfer squad and makes the prior transfer the latest comparison", () => {
  const a = player(1, "A");
  const b = player(2, "B");
  const c = player(3, "C");
  const d = player(4, "D");
  let state = createSandboxState([a, c]);
  state = applySandboxTransfer(state, a, b);
  state = applySandboxTransfer(state, c, d);

  state = undoSandboxTransfer(state);

  assert.deepEqual(state.currentSquad.map(p => p.id), [2, 3]);
  assert.equal(state.history.length, 1);
  const result = evaluateSandbox(state, squad => evaluation({ overall: squad.some(p => p.id === 2) ? 73 : 70 }))!;
  assert.equal(result.latest.rating.delta, 3);
  assert.equal(result.cumulative.rating.delta, 3);
  assert.equal(result.requiredTransferCount, 1);
});

test("reset restores the immutable original sandbox baseline after multiple transfers", () => {
  const a = player(1, "A");
  const b = player(2, "B");
  const c = player(3, "C");
  const d = player(4, "D");
  let state = createSandboxState([a, c]);
  state = applySandboxTransfer(state, a, b);
  state = applySandboxTransfer(state, c, d);

  state = resetSandbox(state);

  assert.deepEqual(state.currentSquad.map(p => p.id), [1, 3]);
  assert.deepEqual(state.baselineSquad.map(p => p.id), [1, 3]);
  assert.equal(state.history.length, 0);
  assert.equal(evaluateSandbox(state, () => evaluation()), null);
});

test("A to B requires one final transfer", () => {
  assert.equal(requiredTransferCount([player(1, "A")], [player(2, "B")]), 1);
});

test("A to B to C in the same slot remains one required final transfer", () => {
  const a = player(1, "A");
  const b = player(2, "B");
  const c = player(3, "C");
  let state = applySandboxTransfer(createSandboxState([a]), a, b);
  state = applySandboxTransfer(state, b, c);

  const result = evaluateSandbox(state, () => evaluation())!;

  assert.equal(result.sandboxActionCount, 2);
  assert.equal(result.previousRequiredTransferCount, 1);
  assert.equal(result.requiredTransferCount, 1);
});

test("A to B to A returns to baseline with zero required transfers and zero cumulative hit", () => {
  const a = player(1, "A");
  const b = player(2, "B");
  let state = applySandboxTransfer(createSandboxState([a]), a, b);
  state = applySandboxTransfer(state, b, a);
  const result = evaluateSandbox(state, () => evaluation())!;

  const economics = sandboxEconomics(result, 0);

  assert.equal(result.requiredTransferCount, 0);
  assert.equal(economics.cumulativeHitCost, 0);
});

test("changing two different baseline players requires two final transfers", () => {
  const a = player(1, "A");
  const b = player(2, "B");
  const c = player(3, "C");
  const d = player(4, "D");
  let state = applySandboxTransfer(createSandboxState([a, c]), a, b);
  state = applySandboxTransfer(state, c, d);

  assert.equal(evaluateSandbox(state, () => evaluation())!.requiredTransferCount, 2);
});

test("undoing one of two changed baseline slots reduces required transfers", () => {
  const a = player(1, "A");
  const b = player(2, "B");
  const c = player(3, "C");
  const d = player(4, "D");
  let state = applySandboxTransfer(createSandboxState([a, c]), a, b);
  state = applySandboxTransfer(state, c, d);
  state = undoSandboxTransfer(state);

  assert.equal(evaluateSandbox(state, () => evaluation())!.requiredTransferCount, 1);
});

test("with one free transfer changing the candidate in the same slot adds no hit", () => {
  const a = player(1, "A");
  const b = player(2, "B");
  const c = player(3, "C");
  let state = applySandboxTransfer(createSandboxState([a]), a, b);
  state = applySandboxTransfer(state, b, c);
  const result = evaluateSandbox(state, () => evaluation())!;

  const economics = sandboxEconomics(result, 1);

  assert.equal(economics.previousHitCost, 0);
  assert.equal(economics.cumulativeHitCost, 0);
  assert.equal(economics.incrementalHitChange, 0);
});

test("returning one slot to baseline can remove a previously required hit", () => {
  const a = player(1, "A");
  const b = player(2, "B");
  const c = player(3, "C");
  const d = player(4, "D");
  let state = applySandboxTransfer(createSandboxState([a, c]), a, b);
  state = applySandboxTransfer(state, c, d);
  state = applySandboxTransfer(state, d, c);
  const result = evaluateSandbox(state, () => evaluation())!;

  const economics = sandboxEconomics(result, 1);

  assert.equal(result.previousRequiredTransferCount, 2);
  assert.equal(result.requiredTransferCount, 1);
  assert.equal(economics.previousHitCost, 4);
  assert.equal(economics.cumulativeHitCost, 0);
  assert.equal(economics.incrementalHitChange, -4);
  const transfer = { out: d, incoming: c, expectedMinutesOut: 80, expectedMinutesIn: 80, startProbOut: .9, startProbIn: .9, qualityStatus: "watchlist" } as Parameters<typeof buildSandboxReasoning>[1];
  assert.match(buildSandboxReasoning(result.latest, transfer, economics).join(" "), /avoiding 4 points of previously modelled hits/i);
});

test("gross and net points use final required transfers rather than sandbox action count", () => {
  const a = player(1, "A");
  const b = player(2, "B");
  const c = player(3, "C");
  let state = applySandboxTransfer(createSandboxState([a]), a, b);
  state = applySandboxTransfer(state, b, c);
  const evaluate = (squad: FplPlayer[]) => evaluation({ weekPoints: squad[0].id === a.id ? [10, 10, 10, 10, 10] : squad[0].id === b.id ? [10, 10, 10, 10, 10] : [12, 11, 11, 11, 11] });
  const result = evaluateSandbox(state, evaluate)!;

  const economics = sandboxEconomics(result, 0);

  assert.equal(result.sandboxActionCount, 2);
  assert.equal(result.requiredTransferCount, 1);
  assert.equal(economics.grossFiveWeekChange, 6);
  assert.equal(economics.cumulativeHitCost, 4);
  assert.equal(economics.netFiveWeekChange, 2);
});

test("deterministic sandbox reasoning covers drivers, XI role, minutes concerns, quality status and hits", () => {
  const incoming = player(99, "Incoming");
  const outgoing = player(11, "Outgoing");
  const beforeXi = Array.from({ length: 11 }, (_, index) => player(index + 1));
  const afterXi = beforeXi.filter(p => p.id !== outgoing.id).concat(incoming);
  const comparison = compareSquads(
    [...beforeXi, incoming],
    [...afterXi, outgoing],
    evaluation({ xi: beforeXi, weekPoints: [50, 50, 50, 50, 50] }),
    evaluation({ xi: afterXi, weekPoints: [51, 51, 51, 51, 51], scoreChanges: { captaincy: 76, minutesSecurity: 68 } }),
  );
  const transfer = {
    out: outgoing,
    incoming,
    expectedMinutesOut: 80,
    expectedMinutesIn: 55,
    startProbOut: .9,
    startProbIn: .64,
    qualityStatus: "watchlist",
  } as Parameters<typeof buildSandboxReasoning>[1];

  const result = { latest: comparison, cumulative: comparison, sandboxActionCount: 1, requiredTransferCount: 1, previousRequiredTransferCount: 0 };
  const reasoning = buildSandboxReasoning(comparison, transfer, sandboxEconomics(result, 0));
  const copy = reasoning.join(" ");

  assert.match(copy, /improves/i);
  assert.match(copy, /reduces minutes security/i);
  assert.match(copy, /enters the starting XI/i);
  assert.match(copy, /55 expected minutes.*64% start probability/i);
  assert.match(copy, /Watchlist/);
  assert.match(copy, /not worthwhile after hits/i);
});

test("reasoning names a negative five-gameweek projection even when no /100 component falls", () => {
  const outgoing = player(1, "Outgoing");
  const incoming = player(2, "Incoming");
  const comparison = compareSquads(
    [outgoing],
    [incoming],
    evaluation({ weekPoints: [50, 50, 50, 50, 50] }),
    evaluation({ weekPoints: [49, 49, 49, 49, 49] }),
  );
  const transfer = { out: outgoing, incoming, expectedMinutesOut: 80, expectedMinutesIn: 80, startProbOut: .9, startProbIn: .9, qualityStatus: "watchlist" } as Parameters<typeof buildSandboxReasoning>[1];

  const result = { latest: comparison, cumulative: comparison, sandboxActionCount: 1, requiredTransferCount: 1, previousRequiredTransferCount: 0 };
  const copy = buildSandboxReasoning(comparison, transfer, sandboxEconomics(result, 1)).join(" ");

  assert.match(copy, /reduces the 5-gameweek squad projection by 5\.0 points/i);
});

function pricedPlayer(id: number, price: number, name = `Player ${id}`): FplPlayer {
  return { id, name, price } as FplPlayer;
}

function deriveFinancialContext(baseline: FplPlayer[], budget: number, manager: unknown) {
  assert.equal(typeof squadComparison.deriveSandboxFinancialContext, "function", "financial-context derivation must be exported pure business logic");
  return squadComparison.deriveSandboxFinancialContext(baseline, budget, manager as never);
}

function calculateFinances(context: unknown, baseline: FplPlayer[], proposed: FplPlayer[]) {
  assert.equal(typeof squadComparison.calculateSandboxFinances, "function", "baseline-to-final finance calculation must be exported pure business logic");
  return squadComparison.calculateSandboxFinances(context as never, baseline, proposed);
}

function officialManager(baseline: FplPlayer[], bank: number, sellingOverrides = new Map<number, number>()) {
  return {
    bank,
    picks: baseline.map((picked, index) => ({
      elementId: picked.id,
      position: index + 1,
      multiplier: index < 11 ? 1 : 0,
      isCaptain: index === 0,
      isViceCaptain: index === 1,
      sellingPrice: sellingOverrides.get(picked.id) ?? picked.price,
    })),
  };
}

test("A to B to C is priced as the final baseline move A to C", () => {
  const a = pricedPlayer(1, 8, "A");
  const b = pricedPlayer(2, 5, "B");
  const c = pricedPlayer(3, 7, "C");
  const context = { baselineBank: 1, baselineSellingPrices: new Map([[a.id, 6]]), source: "official" as const };
  let state = applySandboxTransfer(createSandboxState([a]), a, b);
  state = applySandboxTransfer(state, b, c);

  const finances = calculateFinances(context, state.baselineSquad, state.currentSquad);

  assert.equal(finances.sellingValue, 6, "only A's original official selling value is released");
  assert.equal(finances.buyingValue, 7, "only final incoming C is bought");
  assert.equal(finances.finalBank, 0);
});

test("returning to baseline restores the original bank", () => {
  const a = pricedPlayer(1, 8, "A");
  const b = pricedPlayer(2, 7, "B");
  const context = { baselineBank: 1.4, baselineSellingPrices: new Map([[a.id, 6]]), source: "official" as const };

  const finances = calculateFinances(context, [a], [a]);

  assert.equal(finances.finalBank, 1.4);
  assert.equal(finances.sellingValue, 0);
  assert.equal(finances.buyingValue, 0);
});

test("two final changes combine both baseline selling prices and both buying prices", () => {
  const a = pricedPlayer(1, 9, "A");
  const b = pricedPlayer(2, 8, "B");
  const c = pricedPlayer(3, 6.5, "C");
  const d = pricedPlayer(4, 7.2, "D");
  const context = { baselineBank: 1, baselineSellingPrices: new Map([[a.id, 7], [b.id, 6]]), source: "official" as const };

  const finances = calculateFinances(context, [a, b], [c, d]);

  assert.equal(finances.sellingValue, 13);
  assert.equal(finances.buyingValue, 13.7);
  assert.equal(finances.finalBank, .3);
});

test("undo and reset restore finance derived from their restored final squads", () => {
  const a = pricedPlayer(1, 8, "A");
  const b = pricedPlayer(2, 7, "B");
  const c = pricedPlayer(3, 5, "C");
  const d = pricedPlayer(4, 5.5, "D");
  const context = { baselineBank: 2, baselineSellingPrices: new Map([[a.id, 6], [c.id, 5]]), source: "official" as const };
  let state = applySandboxTransfer(createSandboxState([a, c]), a, b);
  state = applySandboxTransfer(state, c, d);

  const afterUndo = undoSandboxTransfer(state);
  const afterReset = resetSandbox(state);

  assert.equal(calculateFinances(context, afterUndo.baselineSquad, afterUndo.currentSquad).finalBank, 1);
  assert.equal(calculateFinances(context, afterReset.baselineSquad, afterReset.currentSquad).finalBank, 2);
});

test("official manager prices are selected only when all 15 manager IDs exactly match the baseline", () => {
  const baseline = Array.from({ length: 15 }, (_, index) => pricedPlayer(index + 1, 6));
  const manager = officialManager(baseline, 2.3, new Map([[1, 4.8]]));

  const context = deriveFinancialContext(baseline, 100, manager);

  assert.equal(context.source, "official");
  assert.equal(context.baselineBank, 2.3);
  assert.equal(context.baselineSellingPrices.get(1), 4.8);
});

test("stale manager data with a mismatched player ID falls back atomically to current prices", () => {
  const baseline = Array.from({ length: 15 }, (_, index) => pricedPlayer(index + 1, 6));
  const staleBaseline = baseline.map((picked, index) => index === 14 ? pricedPlayer(99, 6) : picked);
  const manager = officialManager(staleBaseline, 9, new Map([[1, 1]]));

  const context = deriveFinancialContext(baseline, 100, manager);

  assert.equal(context.source, "current-price-assumption");
  assert.equal(context.baselineBank, 10);
  assert.equal(context.baselineSellingPrices.get(1), 6, "no stale official selling price may leak into the fallback context");
});

test("manual squad context retains the £100m current-price behavior", () => {
  const baseline = [pricedPlayer(1, 60), pricedPlayer(2, 39)];
  const incoming = pricedPlayer(3, 40.1);
  const context = deriveFinancialContext(baseline, 100, null);

  const finances = calculateFinances(context, baseline, [baseline[0], incoming]);

  assert.equal(context.source, "current-price-assumption");
  assert.equal(context.baselineBank, 1);
  assert.equal(finances.finalBank, -.1);
  assert.equal(finances.affordable, false);
});
