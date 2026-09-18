// PingOne OIDC for fantasy.premierleague.com (account.premierleague.com).
// Email/password cookie login at users.premierleague.com is retired.

export const FPL_OIDC_TOKEN_URL = "https://account.premierleague.com/as/token";
// Public SPA client id used by the official FPL site (no client secret).
export const FPL_OIDC_CLIENT_ID = "bfcbaf69-aade-4c1b-8f00-c1cb8a193030";

export type OidcTokenResult = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}>;

export async function exchangeRefreshToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcTokenResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: FPL_OIDC_CLIENT_ID,
  });
  const response = await fetchImpl(FPL_OIDC_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "fpl-edge-personal/0.1",
    },
    body: body.toString(),
  });
  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(
      `FPL OIDC refresh failed (${response.status}): ${payload.error ?? "unknown"}${payload.error_description ? ` — ${payload.error_description}` : ""}`,
    );
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token && payload.refresh_token.length > 0 ? payload.refresh_token : refreshToken,
    expiresInSeconds: typeof payload.expires_in === "number" ? payload.expires_in : 300,
  };
}
