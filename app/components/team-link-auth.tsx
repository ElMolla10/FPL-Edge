"use client";

import { createContext, useContext } from "react";

// loading: /api/auth/me has not answered yet. out: no account. in: email session.
// The desk starts as "unknown" and only becomes visitor/free/season from AccountBar.
export type TeamLinkAuth = "loading" | "out" | "in";

export const TEAM_SIGN_IN_HREF = "/signin?return_to=%2F%3Fapp%3D1";

const TeamLinkAuthContext = createContext<TeamLinkAuth>("out");

export const TeamLinkAuthProvider = TeamLinkAuthContext.Provider;

export function useTeamLinkAuth() {
  return useContext(TeamLinkAuthContext);
}
