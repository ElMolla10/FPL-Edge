import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  activateExampleSquad,
  buildExampleSquad,
  clearExampleSquadFlag,
  EXAMPLE_SQUAD_FLAG_KEY,
  EXAMPLE_SQUAD_IDS_KEY,
  EXAMPLE_SQUAD_LABEL,
  isExampleSquadActive,
  readActiveSquadIds,
  readRealSquadIds,
  REAL_SQUAD_KEY,
} from "../app/lib/example-squad.ts";
import { isCompleteSquad, type FplData, type FplPlayer } from "../app/lib/fpl.ts";

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

function miniData(): FplData {
  const players: FplPlayer[] = [];
  let id = 1;
  for (const [positionId, positionShort, count, price] of [
    [1, "GKP", 8, 4.5], [2, "DEF", 20, 4.5], [3, "MID", 20, 5.5], [4, "FWD", 12, 5.5],
  ] as const) {
    for (let i = 0; i < count; i++) {
      players.push(makePlayer({
        id: id++, positionId, positionShort, position: positionShort,
        teamId: 1 + (i % 10), price: price + (i % 5) * 0.5, epNext: 2 + (i % 7) * 0.3,
      }));
    }
  }
  return {
    updatedAt: new Date().toISOString(),
    players,
    teams: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `T${i + 1}`, short: `T${i + 1}`, code: i + 1, strengthAttackHome: 3, strengthAttackAway: 3, strengthDefenceHome: 3, strengthDefenceAway: 3, pulseId: i + 1 })),
    events: [{ id: 1, name: "Gameweek 1", deadline: new Date(Date.now() + 86400000).toISOString(), averageEntryScore: null, finished: false, dataChecked: false, isCurrent: true, isNext: false, isPrevious: false, chipPlays: [], mostSelected: null, mostTransferredIn: null, topElement: null, topElementInfo: null, transfersMade: 0, mostCaptained: null, mostViceCaptained: null }],
    fixtures: [],
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

const memory = new Map<string, string>();
function installMemoryStorage() {
  const store: Storage = {
    get length() { return memory.size; },
    clear() { memory.clear(); },
    getItem(key) { return memory.has(key) ? memory.get(key)! : null; },
    setItem(key, value) { memory.set(key, String(value)); },
    removeItem(key) { memory.delete(key); },
    key(index) { return [...memory.keys()][index] ?? null; },
  };
  (globalThis as any).localStorage = store;
}

test("buildExampleSquad returns a complete legal 15", () => {
  const data = miniData();
  const squad = buildExampleSquad(data);
  assert.equal(squad.length, 15);
  assert.equal(isCompleteSquad(squad, data), true);
  const cost = squad.reduce((s, p) => s + p.price, 0);
  assert.ok(cost <= data.rules.budget + 0.05, `budget ${cost}`);
});

test("Open Demo path and example label are wired in UI sources", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const coach = readFileSync(new URL("../app/components/CoachApp.tsx", import.meta.url), "utf8");
  assert.match(page, /Open Demo/);
  assert.match(page, /startExample/);
  assert.match(page, /Opening the desk/);
  assert.match(coach, /Open Demo/);
  assert.match(coach, /activateExampleSquad/);
  assert.match(coach, /EXAMPLE_SQUAD_LABEL/);
  assert.match(coach, /example-squad-banner/);
  assert.equal(EXAMPLE_SQUAD_FLAG_KEY, "fpl-edge-example-squad");
  assert.match(EXAMPLE_SQUAD_LABEL, /Example squad/);
});

test("activateExampleSquad does not overwrite a saved manual draft", () => {
  installMemoryStorage();
  const manual = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  memory.set(REAL_SQUAD_KEY, JSON.stringify(manual));
  const data = miniData();
  assert.equal(activateExampleSquad(data), true);
  assert.equal(isExampleSquadActive(), true);
  assert.deepEqual(readRealSquadIds(), manual);
  assert.notDeepEqual(readActiveSquadIds(), manual);
  assert.equal(readActiveSquadIds().length, 15);
  assert.ok(memory.has(EXAMPLE_SQUAD_IDS_KEY));
  clearExampleSquadFlag();
  assert.equal(isExampleSquadActive(), false);
  assert.deepEqual(readActiveSquadIds(), manual);
});

test("persistence sync payload ignores example storage keys", () => {
  const src = readFileSync(new URL("../app/lib/persistence.ts", import.meta.url), "utf8");
  assert.match(src, /isExampleSquadActive/);
  assert.match(src, /Never push while the labelled demo is active/);
  assert.match(src, /fpl-edge-example-squad-ids/);
  // collectSyncPayload still reads real draft key only
  assert.match(src, /localStorage\.getItem\("fpl-edge-squad"\)/);
});
