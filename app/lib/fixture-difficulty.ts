import type { FplData } from "./fpl";
import { futureEvents } from "./fpl";

export type FixtureDifficultyCell = Readonly<{ label: string; attack: number; defence: number; attackMultiplier: number; defenceMultiplier: number }>;
export type ClubFixtureRow = Readonly<{ team: FplData["teams"][number]; cells: readonly FixtureDifficultyCell[]; attack: number; defence: number; swing: number }>;

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

// Extracted verbatim from TeamQualityFixtures (CoachApp.tsx) during the nav restructure round, so
// both the all-20-club Fixtures page and the new squad-scoped "My Fixtures" view compute from
// exactly one real implementation, never two copies that could quietly drift (rule 6). This is
// genuinely a per-CLUB computation, not per-player -- every player at a club shares that club's
// real fixture difficulty (venue, opponent quality), so "squad-scoped" filters these rows down to
// the clubs the squad's players belong to, it never recomputes anything per player. Behavior is
// unchanged from the inline version this replaces -- see tests/fixture-difficulty.test.mts.
export function computeClubFixtureRows(data: FplData, horizon: number): readonly ClubFixtureRow[] {
  const events = futureEvents(data, horizon);
  const teamMap = new Map(data.teams.map(team => [team.id, team]));
  const difficulty = (opportunity: number) => clamp(3 - (opportunity - 1) * 6, 1, 5);
  return data.teams.map(team => {
    const cells: FixtureDifficultyCell[] = events.map(event => {
      const games = data.fixtures.filter(fixture => fixture.event === event.id && (fixture.teamH === team.id || fixture.teamA === team.id));
      if (!games.length) return { label: "BLANK", attack: 5, defence: 5, attackMultiplier: 0, defenceMultiplier: 0 };
      const perGame = games.map(fixture => {
        const home = fixture.teamH === team.id, opponent = teamMap.get(home ? fixture.teamA : fixture.teamH);
        const own = team.quality, opp = opponent?.quality;
        const ownAttack = home ? (own?.effectiveAttackHome ?? 1) : (own?.effectiveAttackAway ?? 1);
        const ownDefence = home ? (own?.effectiveDefenceHome ?? 1) : (own?.effectiveDefenceAway ?? 1);
        const opponentDefence = home ? (opp?.effectiveDefenceAway ?? 1) : (opp?.effectiveDefenceHome ?? 1);
        const opponentAttack = home ? (opp?.effectiveAttackAway ?? 1) : (opp?.effectiveAttackHome ?? 1);
        const attackMultiplier = clamp(ownAttack / Math.max(.6, opponentDefence) * (home ? 1.04 : .96), .65, 1.5);
        const defenceMultiplier = clamp(ownDefence / Math.max(.6, opponentAttack) * (home ? 1.05 : .94), .65, 1.5);
        return { label: `${opponent?.short ?? "—"} ${home ? "H" : "A"}`, attack: difficulty(attackMultiplier), defence: difficulty(defenceMultiplier), attackMultiplier, defenceMultiplier };
      });
      const average = (pick: (game: typeof perGame[number]) => number) => perGame.reduce((sum, game) => sum + pick(game), 0) / perGame.length;
      return { label: perGame.map(game => game.label).join(", "), attack: average(game => game.attack), defence: average(game => game.defence), attackMultiplier: average(game => game.attackMultiplier), defenceMultiplier: average(game => game.defenceMultiplier) };
    });
    const average = (pick: (cell: FixtureDifficultyCell) => number) => cells.reduce((sum, cell) => sum + pick(cell), 0) / Math.max(1, cells.length);
    const split = Math.ceil(cells.length / 2), firstHalf = cells.slice(0, split), secondHalf = cells.slice(split);
    const early = firstHalf.reduce((sum, cell) => sum + cell.attack, 0) / Math.max(1, firstHalf.length), later = secondHalf.reduce((sum, cell) => sum + cell.attack, 0) / Math.max(1, secondHalf.length);
    return { team, cells, attack: average(cell => cell.attack), defence: average(cell => cell.defence), swing: early - later };
  });
}
