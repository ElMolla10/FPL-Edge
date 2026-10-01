// "What moves me vs my rivals this GW" -- league-local effective ownership against the user's
// canonical squad/XI/captain. No new optimizer: projections come from the caller (playerProjection).
export type LeverPick = { element: number; position: number; multiplier: number; isCaptain: boolean };
export type LeverRival = { entryId: number; picks: LeverPick[] };
export type LeagueLever = {
  sampled: number;
  userProjection: number;
  leagueAverageProjection: number;
  captains: { playerId: number; pct: number }[];
  lever: { playerId: number; kind: "yours" | "threat"; rivalOwnPct: number; impact: number } | null;
};

export function computeLeagueLever(input: {
  xiIds: readonly number[];
  benchIds: readonly number[];
  captainId: number;
  rivals: readonly LeverRival[];
  projection: (playerId: number) => number;
}): LeagueLever {
  const { rivals, projection } = input;
  const n = rivals.length;
  const userMult = new Map<number, number>();
  for (const id of input.xiIds) userMult.set(id, id === input.captainId ? 2 : 1);
  for (const id of input.benchIds) if (!userMult.has(id)) userMult.set(id, 0);
  const userProjection = [...userMult].reduce((s, [id, m]) => s + projection(id) * m, 0);
  const owned = new Map<number, number>(), eo = new Map<number, number>(), caps = new Map<number, number>();
  let total = 0;
  for (const r of rivals) {
    for (const p of r.picks) {
      owned.set(p.element, (owned.get(p.element) ?? 0) + 1);
      // Rival multipliers are from their last deadline; for this GW treat XI=1, captain=2.
      const m = p.position <= 11 ? (p.isCaptain ? 2 : 1) : 0;
      eo.set(p.element, (eo.get(p.element) ?? 0) + m);
      total += projection(p.element) * m;
      if (p.isCaptain) caps.set(p.element, (caps.get(p.element) ?? 0) + 1);
    }
  }
  const pct = (k: number) => (n ? Math.round((k / n) * 100) : 0);
  const captains = [...caps].map(([playerId, k]) => ({ playerId, pct: pct(k) })).sort((a, b) => b.pct - a.pct).slice(0, 5);
  let lever: LeagueLever["lever"] = null;
  if (n) {
    const ids = new Set([...userMult.keys(), ...owned.keys()]);
    for (const id of ids) {
      const impact = projection(id) * ((userMult.get(id) ?? 0) - (eo.get(id) ?? 0) / n);
      const yours = (userMult.get(id) ?? 0) > 0;
      // "yours": a starter you own that few rivals own; "threat": many rivals own, you don't start.
      if (yours ? impact <= 0 : impact >= 0) continue;
      if (!lever || Math.abs(impact) > Math.abs(lever.impact)) lever = { playerId: id, kind: yours ? "yours" : "threat", rivalOwnPct: pct(owned.get(id) ?? 0), impact: Math.round(impact * 10) / 10 };
    }
  }
  return { sampled: n, userProjection: Math.round(userProjection * 10) / 10, leagueAverageProjection: n ? Math.round((total / n) * 10) / 10 : 0, captains, lever };
}
