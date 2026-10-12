

import { dataFor, makePlayer, squad } from "./transfer-pair.mts";

export function fundingExample() {
  const initial = squad();
  const funder = initial.find(p => p.id === 2)!;
  funder.price = 7;
  const target = initial.find(p => p.id === 21)!;
  Object.assign(target, { epNext: 1, form: 1, pointsPerGame: 1,
    priorPointsPerGame: 1, priorExpectedGoals: 0, priorExpectedAssists: 0 });
  const downgrade = makePlayer({ ...funder, id: 101, name: "Funding keeper", teamId: 101, price: 4 });
  const upgrade = makePlayer({ ...target, id: 102, name: "Premium midfielder", teamId: 102, price: 9,
    epNext: 12, form: 10, pointsPerGame: 9, priorPointsPerGame: 9, priorExpectedGoals: 20, priorExpectedAssists: 15 });
  // Exact official-style selling prices: keeper market 7.0, sale 6.5; mid sale 5.5.
  // Bank 1.0 + 2.5 released = 3.5 upgrade cost. Upgrade alone is unaffordable.
  const selling = new Map(initial.map(p => [p.id, p.price]));
  for (const p of initial.filter(p => p.positionId === 3)) selling.set(p.id, 5);
  selling.set(funder.id, 6.5);
  selling.set(target.id, 5.5);
  return { initial, funder, target, downgrade, upgrade, selling, bank: 1,
    data: dataFor([...initial, downgrade, upgrade], 1) };
}
