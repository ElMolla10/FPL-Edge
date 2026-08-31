"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createMiniLeagueRequestManager, parseLeagueIdInput } from "../lib/mini-league-client";
import type { MiniLeagueUiState } from "../lib/mini-league";

export function useMiniLeagueWarRoom(connectedEntryId: number | null) {
  const [leagueId, setLeagueId] = useState("");
  const [state, setState] = useState<MiniLeagueUiState>({ status: "idle" });
  const [activeLeagueId, setActiveLeagueId] = useState<number | null>(null);
  const requestManager = useMemo(() => createMiniLeagueRequestManager(), []);

  useEffect(() => {
    requestManager.cancel();
    setState({ status: "idle" });
    setActiveLeagueId(null);
    return () => requestManager.cancel();
  }, [connectedEntryId, requestManager]);

  const importLeague = useCallback(() => {
    if (connectedEntryId === null) return;
    const parsed = parseLeagueIdInput(leagueId);
    if (parsed === null) {
      requestManager.cancel();
      setState({ status: "error", kind: "invalid", reason: "League ID must be a positive integer." });
      return;
    }
    setActiveLeagueId(parsed);
    void requestManager.load({ leagueId: parsed, entryId: connectedEntryId }, setState);
  }, [connectedEntryId, leagueId, requestManager]);

  const loadPage = useCallback((page: number) => {
    if (connectedEntryId === null || activeLeagueId === null || page < 1) return;
    void requestManager.load({ leagueId: activeLeagueId, entryId: connectedEntryId, page }, setState);
  }, [activeLeagueId, connectedEntryId, requestManager]);

  return { leagueId, setLeagueId, state, importLeague, loadPage };
}
