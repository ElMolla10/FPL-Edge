import { exchangeRefreshToken } from "./oidc";

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
  transfers: Readonly<{ bank: number; limit: number | null; made: number; value: number }>;
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
  getAccessToken(): Promise<string>;
};

export async function createRotatingTokenProvider(
  initialRefreshToken: string,
  persistRefreshToken: (token: string) => Promise<void>,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenProvider> {
  let refreshToken = initialRefreshToken;
  let accessToken: string | null = null;
  let expiresAt = 0;

  const refresh = async () => {
    const next = await exchangeRefreshToken(refreshToken, fetchImpl);
    accessToken = next.accessToken;
    expiresAt = Date.now() + next.expiresInSeconds * 1000 - 15_000;
    if (next.refreshToken !== refreshToken) {
      refreshToken = next.refreshToken;
      await persistRefreshToken(refreshToken);
    }
    return accessToken;
  };

  return {
    async getAccessToken() {
      if (accessToken && Date.now() < expiresAt) return accessToken;
      return refresh();
    },
  };
}

async function authedFetch(
  path: string,
  tokens: TokenProvider,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const once = async () =>
    fetchImpl(`${FPL_API}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        "X-API-Authorization": `Bearer ${await tokens.getAccessToken()}`,
        Accept: "application/json",
        "User-Agent": "fpl-edge-personal/0.1",
      },
    });
  let response = await once();
  if (response.status === 401 || response.status === 403) {
    response = await once();
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
