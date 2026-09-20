import { exchangeRefreshToken, FplOidcError } from "./oidc";
import type { PersonalAuthSession } from "./store";

const FPL_API = "https://fantasy.premierleague.com/api";

export type MyTeamPick = Readonly<{
  element: number;
  position: number;
  selling_price: number;
  purchase_price: number;
  is_captain: boolean;
  is_vice_captain: boolean;
  multiplier: number;
}>;

export type MyTeamResponse = Readonly<{
  picks: MyTeamPick[];
  transfers: Readonly<{ bank: number; limit: number | null; made: number; value: number; cost?: number; status?: string }>;
}>;

export type TransferLeg = Readonly<{
  element_in: number;
  element_out: number;
  purchase_price: number;
  selling_price: number;
}>;

export type TransferRequestBody = Readonly<{
  chip: null;
  entry: number;
  event: number;
  transfers: readonly TransferLeg[];
  confirmed: boolean;
}>;

export type TokenProvider = {
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
};

export type TokenProviderHooks = {
  /** Persist after a successful PingOne exchange (CAS preferred). */
  persistSession: (expectedRefreshToken: string, session: PersonalAuthSession) => Promise<boolean>;
  /** After invalid_grant: reload D1 session (another isolate may have rotated). */
  reloadSession: () => Promise<PersonalAuthSession | null>;
  /** After invalid_grant and unchanged D1: try Worker secret seed if different. */
  adoptEnvSeed?: (failedRefreshToken: string) => Promise<PersonalAuthSession | null>;
};

export async function createRotatingTokenProvider(
  initial: PersonalAuthSession | string,
  persistOrHooks:
    | ((token: string) => Promise<void>)
    | TokenProviderHooks,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenProvider> {
  // Back-compat: execute path still passes (refreshTokenString, persistRefreshToken).
  const hooks: TokenProviderHooks =
    typeof persistOrHooks === "function"
      ? {
          persistSession: async (_expected, session) => {
            await persistOrHooks(session.refreshToken);
            return true;
          },
          reloadSession: async () => null,
        }
      : persistOrHooks;

  let session: PersonalAuthSession =
    typeof initial === "string"
      ? { refreshToken: initial, accessToken: null, accessExpiresAtMs: null }
      : { ...initial };

  const refresh = async (fromToken: string): Promise<string> => {
    try {
      const next = await exchangeRefreshToken(fromToken, fetchImpl);
      const nextSession: PersonalAuthSession = {
        refreshToken: next.refreshToken,
        accessToken: next.accessToken,
        accessExpiresAtMs: Date.now() + next.expiresInSeconds * 1000 - 15_000,
      };
      const saved = await hooks.persistSession(fromToken, nextSession);
      if (!saved) {
        const raced = await hooks.reloadSession();
        if (raced?.accessToken && raced.accessExpiresAtMs && Date.now() < raced.accessExpiresAtMs) {
          session = raced;
          return raced.accessToken;
        }
        if (raced?.refreshToken && raced.refreshToken !== fromToken) {
          session = raced;
          return refresh(raced.refreshToken);
        }
      }
      session = nextSession;
      return next.accessToken;
    } catch (error) {
      if (error instanceof FplOidcError && error.isInvalidGrant) {
        const raced = await hooks.reloadSession();
        if (raced?.refreshToken && raced.refreshToken !== fromToken) {
          session = raced;
          if (raced.accessToken && raced.accessExpiresAtMs && Date.now() < raced.accessExpiresAtMs) {
            return raced.accessToken;
          }
          return refresh(raced.refreshToken);
        }
        if (hooks.adoptEnvSeed) {
          const seeded = await hooks.adoptEnvSeed(fromToken);
          if (seeded?.refreshToken) {
            session = seeded;
            return refresh(seeded.refreshToken);
          }
        }
      }
      throw error;
    }
  };

  return {
    async getAccessToken(options) {
      if (
        !options?.forceRefresh &&
        session.accessToken &&
        session.accessExpiresAtMs !== null &&
        Date.now() < session.accessExpiresAtMs
      ) {
        return session.accessToken;
      }
      return refresh(session.refreshToken);
    },
  };
}

async function authedFetch(
  path: string,
  tokens: TokenProvider,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const once = async (forceRefresh = false) =>
    fetchImpl(`${FPL_API}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        "X-API-Authorization": `Bearer ${await tokens.getAccessToken({ forceRefresh })}`,
        Accept: "application/json",
        "User-Agent": "fpl-edge-personal/0.1",
      },
    });
  let response = await once(false);
  if (response.status === 401 || response.status === 403) {
    response = await once(true);
  }
  return response;
}

export async function fetchMyTeam(
  entryId: string,
  tokens: TokenProvider,
  fetchImpl: typeof fetch = fetch,
): Promise<MyTeamResponse> {
  const response = await authedFetch(`/my-team/${entryId}/`, tokens, { method: "GET" }, fetchImpl);
  if (!response.ok) {
    throw new Error(`FPL my-team failed: ${response.status}`);
  }
  return (await response.json()) as MyTeamResponse;
}

export async function postTransfers(
  body: TransferRequestBody,
  tokens: TokenProvider,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: unknown }> {
  const response = await authedFetch(
    "/transfers/",
    tokens,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://fantasy.premierleague.com",
        Referer: "https://fantasy.premierleague.com/transfers",
      },
      body: JSON.stringify(body),
    },
    fetchImpl,
  );
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
  }
  return { status: response.status, body: parsed };
}

export function buildTransferLeg(
  myTeam: MyTeamResponse,
  elementOut: number,
  elementIn: number,
  purchasePriceTenths: number,
): TransferLeg {
  const outPick = myTeam.picks.find((pick) => pick.element === elementOut);
  if (!outPick) throw new Error(`Player ${elementOut} is not in the authenticated squad.`);
  if (myTeam.picks.some((pick) => pick.element === elementIn)) {
    throw new Error(`Player ${elementIn} is already in the authenticated squad.`);
  }
  return {
    element_out: elementOut,
    element_in: elementIn,
    selling_price: outPick.selling_price,
    purchase_price: purchasePriceTenths,
  };
}
