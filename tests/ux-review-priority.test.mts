import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildExampleSquad, exampleDeskSummary } from "../app/lib/example-squad.ts";
import { analysis } from "../app/components/coach/CoachCore.tsx";
import { isCompleteSquad, playerProjection, type FplData, type FplPlayer } from "../app/lib/fpl.ts";

function makePlayer(overrides: Partial<FplPlayer> & { id: number; positionId: number; positionShort: string; teamId: number; price: number }): FplPlayer {
  return {
    name: `P${overrides.id}`, firstName: "P", secondName: String(overrides.id),
    teamName: `T${overrides.teamId}`, teamShort: `T${overrides.teamId}`,
    position: overrides.positionShort, status: "a", chance: 100, epNext: 4, form: 3,
    pointsPerGame: 3, priorPointsPerGame: 3, priorMinutes: 2000, priorStarts: 25,
    priorExpectedGoals: 2, priorExpectedAssists: 2, priorBonus: 5, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 50, totalPoints: 20, eventPoints: 0, eventMinutes: 0, eventBonus: 0,
    eventDefensiveContribution: 0, selectedBy: 5, priceChange: 0, priceProjectionToday: 0,
    priceChangeSinceStart: 0, priceOutlook: [], transfersIn: 0, transfersOut: 0, goals: 0, assists: 0,
    expectedGoals: 0.2, expectedAssists: 0.1, expectedGoalInvolvements: 0.3, expectedGoalsConceded: 1,
    cleanSheets: 1, goalsConceded: 5, minutes: 900, starts: 10, bonus: 2, bps: 100, ictIndex: 40,
    influence: 20, creativity: 20, threat: 20, saves: 0, penaltiesSaved: 0, defensiveContribution: 20,
    clearancesBlocksInterceptions: 10, recoveries: 10, tackles: 5, penaltiesOrder: null,
    directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  } as FplPlayer;
}

/** A pool shaped like a real FPL season: cheap GKP/DEF floor, forwards that never cost under 6.0m. */
function realisticPool(): FplData {
  const players: FplPlayer[] = [];
  let id = 1;
  const add = (positionId: number, positionShort: string, count: number, basePrice: number, step: number, epBase: number) => {
    for (let i = 0; i < count; i++) {
      players.push(makePlayer({
        id: id++, positionId, positionShort, position: positionShort, teamId: 1 + (id % 10),
        price: basePrice + (i % 12) * step, epNext: epBase + ((i * 7) % 11) * 0.45,
      }));
    }
  };
  add(1, "GKP", 12, 4.0, 0.3, 1.5);
  add(2, "DEF", 40, 4.0, 0.3, 1.5);
  add(3, "MID", 40, 4.5, 0.9, 1.5);
  add(4, "FWD", 18, 6.0, 1.1, 1.5);
  return {
    updatedAt: new Date().toISOString(),
    players,
    teams: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `T${i + 1}`, short: `T${i + 1}`, code: i + 1, strengthAttackHome: 3, strengthAttackAway: 3, strengthDefenceHome: 3, strengthDefenceAway: 3, pulseId: i + 1 })),
    events: [{ id: 1, name: "Gameweek 1", deadline: new Date(Date.now() + 86400000).toISOString(), averageEntryScore: null, finished: false, dataChecked: false, isCurrent: true, isNext: false, isPrevious: false, chipPlays: [], mostSelected: null, mostTransferredIn: null, topElement: null, topElementInfo: null, transfersMade: 0, mostCaptained: null, mostViceCaptained: null }],
    fixtures: [0, 2, 4, 6, 8].map((i) => ({ id: i + 1, event: 1, teamH: i + 1, teamA: i + 2, teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null })),
    rules: { budget: 100, squadSize: 15, teamLimit: 3, positions: [
      { id: 1, name: "Goalkeepers", short: "GKP", squad: 2, start: 1 },
      { id: 2, name: "Defenders", short: "DEF", squad: 5, start: 3 },
      { id: 3, name: "Midfielders", short: "MID", squad: 5, start: 2 },
      { id: 4, name: "Forwards", short: "FWD", squad: 3, start: 1 },
    ] },
    elementTypes: [],
    seasonStatsThrough: null,
    dataIntegrityWarnings: [],
  } as unknown as FplData;
}

test("item 2: the landing example is the decision desk's demo headline (same squad, XI, captain, points)", () => {
  const data = realisticPool();
  const summary = exampleDeskSummary(data);
  assert.ok(summary, "a summary exists for a complete pool");

  // What the desk's Overview computes for the demo squad: analysis() -> bestXi, XI sum + captain counted twice.
  const squad = buildExampleSquad(data);
  const a = analysis(data, squad);
  assert.ok(a, "the demo squad is analysable by the desk");
  const captain = a.xi.captain ?? a.xi.players[0];
  const captainTerm = playerProjection(captain, a.first, data.fixtures, a.first);
  const deskProjected = a.xi.players.reduce((sum, p) => sum + playerProjection(p, a.first, data.fixtures, a.first), 0) + captainTerm;

  assert.equal(summary.captain.id, captain.id, "landing captain === desk captain");
  assert.equal(summary.captainPoints.toFixed(1), captainTerm.toFixed(1));
  assert.equal(summary.total.toFixed(1), deskProjected.toFixed(1), "landing points === desk PROJECTED GW");
});

test("item 2: the homepage takes its example from the shared demo fixture, not its own picker", () => {
  const home = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(home, /exampleDeskSummary/);
  assert.match(home, /from "\.\/lib\/example-squad"/);
  assert.doesNotMatch(home, /function exampleDesk\(/, "the old best-XI-from-the-whole-pool picker is gone");
  assert.doesNotMatch(home, /const formations/);
});

test("item 2: the demo squad spends the budget instead of falling back to the bargain bin", () => {
  const data = realisticPool();
  const squad = buildExampleSquad(data);
  assert.equal(isCompleteSquad(squad, data), true);
  const cost = squad.reduce((sum, p) => sum + p.price, 0);
  assert.ok(cost <= data.rules.budget + 0.05, `within budget (${cost.toFixed(1)})`);
  // The cheapest-possible fallback costs ~£66m on a pool like this; a real greedy fill lands near the cap.
  assert.ok(cost > 85, `demo squad is a real squad, not the cheap fallback (cost ${cost.toFixed(1)})`);
  const best = Math.max(...data.players.filter((p) => p.positionShort === "MID").map((p) => playerProjection(p, 1, data.fixtures, 1)));
  assert.ok(squad.some((p) => p.positionShort === "MID" && playerProjection(p, 1, data.fixtures, 1) === best), "the top midfielder is in the demo squad");
});

test("item 1/5: the mobile dock has a trust line and the page clears the dock plus the safe area", () => {
  const home = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(home, /Official FPL data · No password needed/);
  assert.match(home, /className="paper-dock-trust"/);
  assert.match(css, /\.paper\{padding-bottom:calc\(132px \+ env\(safe-area-inset-bottom\)\)\}/);
  assert.match(css, /scroll-padding-bottom:calc\(132px \+ env\(safe-area-inset-bottom\)\)/);
});

test("item 4: empty desk screens share one structured card with a single primary button", () => {
  const core = readFileSync(new URL("../app/components/coach/CoachCore.tsx", import.meta.url), "utf8");
  const card = core.slice(core.indexOf("export function EmptyDeskState"), core.indexOf("export function ConnectTeam"));
  assert.equal((card.match(/<button/g) ?? []).length, 1, "exactly one button in the empty-state card");
  for (const file of ["TeamPanel", "CoachPanel", "ResearchPanels"]) {
    const src = readFileSync(new URL(`../app/components/coach/${file}.tsx`, import.meta.url), "utf8");
    assert.match(src, /<EmptyDeskState /, `${file} uses the shared empty state`);
  }
  const team = readFileSync(new URL("../app/components/coach/TeamPanel.tsx", import.meta.url), "utf8");
  const pitch = team.slice(team.indexOf("function PitchOutline"), team.indexOf("function PitchOutline") + 600);
  assert.doesNotMatch(pitch, /<button/, "the pitch preview no longer carries its own button");
});

test("item 6: the phone field is not rendered until the session is confirmed; Paymob logic untouched", () => {
  const src = readFileSync(new URL("../app/components/SeasonPass.tsx", import.meta.url), "utf8");
  assert.match(src, /\{signedIn === true && <label className="paper-field">/);
  assert.match(src, /disabled=\{busy \|\| signedIn !== true\}/);
  assert.match(src, /aria-label="Checkout steps"/);
  assert.match(src, /fetch\("\/api\/season-pass\/checkout"/);
  assert.match(src, /body: JSON\.stringify\(\{ phone \}\)/);
  assert.match(src, /window\.location\.assign\(json\.checkoutUrl\)/);
});
