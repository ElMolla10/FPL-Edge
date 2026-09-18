"use client";

// Local-first persistence: every existing localStorage read call site is left untouched (still
// synchronous, still simple). This module hydrates localStorage from the server on load when
// signed in, and wraps the *write* call sites (persist() replaces localStorage.setItem for the
// keys that sync) to push changes to the server in the background. No new state-management
// paradigm -- localStorage stays the single source of truth the rest of the app already reads;
// this just keeps it in sync with the server underneath.

let signedIn = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
// Serialises the awaited team write against the delayed background push so a tab that
// closes after connect is not the only copy, and an older 800ms payload cannot land last.
let writeChain: Promise<void> = Promise.resolve();

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

export function markSignedIn(value: boolean) {
  signedIn = value;
}

export type AccountTeamWrite = {
  squadIds: number[];
  entry: string | null;
  manager: unknown | null;
};

async function putSquadPayload(payload: ReturnType<typeof collectSyncPayload>): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch("/api/squad", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      let error = "Could not save this team to your account.";
      try {
        const json = await response.json() as { error?: string };
        if (json?.error) error = json.error;
      } catch {
        // The status is enough; the local desk must not claim the team is linked.
      }
      return { ok: false, error };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not save this team to your account." };
  }
}

function applyAccountTeamLocally(team: AccountTeamWrite) {
  localStorage.setItem("fpl-edge-squad", JSON.stringify(team.squadIds));
  if (team.entry) localStorage.setItem("fpl-edge-entry", team.entry);
  else localStorage.removeItem("fpl-edge-entry");
  if (team.manager) localStorage.setItem("fpl-edge-manager", JSON.stringify(team.manager));
  else localStorage.removeItem("fpl-edge-manager");
}

// Connect, switch, and disconnect. Refuses without a session, and only then writes
// localStorage. A failed account write leaves the desk unchanged.
export async function writeAccountTeam(team: AccountTeamWrite): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!signedIn) return { ok: false, error: "Sign in to connect your team." };
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  return enqueueWrite(async () => {
    if (!signedIn) return { ok: false, error: "Sign in to connect your team." };
    const payload = { ...collectSyncPayload(), squadIds: team.squadIds, entry: team.entry, manager: team.manager };
    const result = await putSquadPayload(payload);
    if (!result.ok) return result;
    applyAccountTeamLocally(team);
    return { ok: true as const };
  });
}

function safeParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// Exported for direct testing -- confirming the watchlist/locks/entry/manager sync fields are
// genuinely untouched by the plans addition (not just "probably fine") needs to be a real test, not
// a re-read of the diff by eye.
export function collectSyncPayload() {
  const captainVice: Record<string, { captainId?: number; viceId?: number }> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    const captainMatch = key.match(/^fpl-edge-captain-(\d+)$/);
    const viceMatch = key.match(/^fpl-edge-vice-(\d+)$/);
    if (captainMatch) (captainVice[captainMatch[1]] ??= {}).captainId = Number(localStorage.getItem(key));
    if (viceMatch) (captainVice[viceMatch[1]] ??= {}).viceId = Number(localStorage.getItem(key));
  }
  return {
    squadIds: safeParse<number[]>(localStorage.getItem("fpl-edge-squad"), []),
    watchlist: safeParse<number[]>(localStorage.getItem("fpl-edge-watchlist"), []),
    locks: safeParse<unknown[]>(localStorage.getItem("fpl-edge-locks"), []),
    captainVice,
    entry: localStorage.getItem("fpl-edge-entry"),
    manager: safeParse<unknown | null>(localStorage.getItem("fpl-edge-manager"), null),
    plans: safeParse<unknown[]>(localStorage.getItem("fpl-edge-plans"), []),
    plannedChips: safeParse<unknown[]>(localStorage.getItem("fpl-edge-planned-chips"), []),
  };
}

async function pushToServer() {
  await enqueueWrite(async () => {
    if (!signedIn) return;
    try {
      await putSquadPayload(collectSyncPayload());
    } catch {
      // Best-effort background sync -- localStorage already has the write, nothing is lost;
      // it'll push again on the next write or the next sign-in.
    }
  });
}

function schedulePush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(pushToServer, 800);
}

// Drop-in replacement for localStorage.setItem at the write call sites that should sync.
// Read call sites are unchanged -- they keep reading localStorage directly.
export function persist(key: string, value: string) {
  localStorage.setItem(key, value);
  if (signedIn) schedulePush();
}

// Moved from CoachApp.tsx so LiveDraftBuilder.tsx (Draft Lab's recommended-changes section) can
// read the same free-transfer count Transfers already persists, without importing back through
// CoachApp.tsx (which already imports LiveDraftBuilder, and would cycle).
export function readFreeTransfers(): number {
  try {
    const raw = localStorage.getItem("fpl-edge-free-transfers");
    // Number(null) is 0, not NaN -- a raw-string check is required so a key that was never set
    // (the common case for a user who has never touched the Transfers page selector) falls through
    // to the intended default of 1 free transfer, instead of silently defaulting to 0 (assume a hit).
    if (raw === null || raw === "") return 1;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 && value <= 5 ? value : 1;
  } catch {
    return 1;
  }
}

export function hydrateFromServer(server: {
  squadIds: number[];
  watchlist: number[];
  locks: unknown[];
  captainVice: Record<string, { captainId?: number; viceId?: number }>;
  entry: string | null;
  manager: unknown | null;
  plans: unknown[];
  plannedChips: unknown[];
}) {
  localStorage.setItem("fpl-edge-squad", JSON.stringify(server.squadIds));
  localStorage.setItem("fpl-edge-watchlist", JSON.stringify(server.watchlist));
  localStorage.setItem("fpl-edge-locks", JSON.stringify(server.locks));
  if (server.entry) localStorage.setItem("fpl-edge-entry", server.entry);
  if (server.manager) localStorage.setItem("fpl-edge-manager", JSON.stringify(server.manager));
  localStorage.setItem("fpl-edge-plans", JSON.stringify(server.plans ?? []));
  localStorage.setItem("fpl-edge-planned-chips", JSON.stringify(server.plannedChips ?? []));
  for (const [eventId, cv] of Object.entries(server.captainVice ?? {})) {
    if (cv.captainId) localStorage.setItem(`fpl-edge-captain-${eventId}`, String(cv.captainId));
    if (cv.viceId) localStorage.setItem(`fpl-edge-vice-${eventId}`, String(cv.viceId));
  }
}

export function hasMeaningfulData(payload: ReturnType<typeof collectSyncPayload> | { squadIds: number[]; watchlist: number[]; entry: string | null; plans?: unknown[]; plannedChips?: unknown[] }) {
  return payload.squadIds.length > 0 || payload.watchlist.length > 0 || !!payload.entry || !!payload.plans?.length || !!payload.plannedChips?.length;
}

// Called once on app mount, and again right after a successful sign-in/sign-up. Returns true
// if it changed localStorage (so the caller can bump a revision to force a re-render).
export async function syncWithServer(): Promise<boolean> {
  try {
    const meRes = await fetch("/api/auth/me", { cache: "no-store" });
    const me = (await meRes.json()) as { user: { email: string } | null };
    signedIn = !!me.user;
    if (!signedIn) return false;

    const squadRes = await fetch("/api/squad", { cache: "no-store" });
    if (!squadRes.ok) return false;
    const server = await squadRes.json();

    if (hasMeaningfulData(server)) {
      hydrateFromServer(server);
      return true;
    }

    // No server data yet: one-time migration, regardless of which auth method this is --
    // push whatever's already in this browser's localStorage so it isn't lost.
    const local = collectSyncPayload();
    if (hasMeaningfulData(local)) await pushToServer();
    return false;
  } catch {
    return false;
  }
}

export function isSignedIn() {
  return signedIn;
}
