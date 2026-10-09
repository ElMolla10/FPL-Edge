import { sha256Hex } from "./crypto";
import type { PicksPayload, TransfersPayload } from "./payloads";
import type { BotMyTeam } from "./types";

export const BOT_DECISION_VERSION = "bot-v1";

/** Canonical ids-only state of the live team (picks, armbands, pending chip, bank, transfers made). */
export function canonicalTeamState(team: BotMyTeam): string {
  const picks = [...team.picks]
    .sort((a, b) => a.position - b.position)
    .map((p) => `${p.position}:${p.element}${p.is_captain ? "C" : ""}${p.is_vice_captain ? "V" : ""}`)
    .join(",");
  const pending = (team.chips ?? []).filter((c) => c.is_pending).map((c) => c.name).sort().join("+") || "-";
  return `${picks}|chip=${pending}|bank=${team.transfers.bank}|made=${team.transfers.made}|limit=${team.transfers.limit ?? "inf"}`;
}

export function canonicalSquad(ids: readonly number[]): string {
  return [...ids].sort((a, b) => a - b).join(",");
}

/** Lineup target: positions + armbands + team chip (what POST /my-team sets). */
export function canonicalLineup(picks: PicksPayload["picks"], chip: string | null): string {
  return (
    [...picks]
      .sort((a, b) => a.position - b.position)
      .map((p) => `${p.position}:${p.element}${p.is_captain ? "C" : ""}${p.is_vice_captain ? "V" : ""}`)
      .join(",") + `|chip=${chip ?? "-"}`
  );
}

export function canonicalLineupFromTeam(team: BotMyTeam): string {
  const pending = (team.chips ?? []).find((c) => c.is_pending && (c.name === "bboost" || c.name === "3xc"))?.name ?? null;
  return canonicalLineup(
    team.picks.map((p) => ({ element: p.element, position: p.position, is_captain: p.is_captain, is_vice_captain: p.is_vice_captain })),
    pending,
  );
}

export async function hashString(value: string): Promise<string> {
  return sha256Hex(`${BOT_DECISION_VERSION}|${value}`);
}

export async function decisionHash(parts: { gw: number; transfers: TransfersPayload | null; picks: PicksPayload | null; modelVersion: string }): Promise<string> {
  const legs = parts.transfers ? parts.transfers.transfers.map((l) => `${l.element_out}>${l.element_in}`).sort().join(",") : "-";
  const tchip = parts.transfers?.chip ?? "-";
  const lineup = parts.picks ? canonicalLineup(parts.picks.picks, parts.picks.chip) : "-";
  return hashString(`gw=${parts.gw}|t=${legs}|tc=${tchip}|l=${lineup}|m=${parts.modelVersion}`);
}
