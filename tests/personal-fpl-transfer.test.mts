import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildTransferLeg,
  evaluatePersonalAuthManageGate,
  evaluatePersonalTransferGate,
  isEmailAllowlisted,
  isPersonalTransferExecEnabled,
  liveTeamFinanceFromMyTeam,
  parseRefreshTokenInput,
  remainingFreeTransfers,
  resolveAuthoritativeFreeTransfers,
  resolveTransferBankMillions,
} from "../app/lib/personal-fpl-transfer/index.ts";
import {
  deriveSandboxFinancialContext,
  isRankingFinanceUnavailable,
  type ManagerMeta,
} from "../app/lib/squad-comparison.ts";

test("personal transfer kill switch defaults off", () => {
  assert.equal(isPersonalTransferExecEnabled({}), false);
  assert.equal(isPersonalTransferExecEnabled({ FPL_EDGE_PERSONAL_TRANSFER_EXEC: "0" }), false);
  assert.equal(isPersonalTransferExecEnabled({ FPL_EDGE_PERSONAL_TRANSFER_EXEC: "1" }), true);
});

test("allowlist is exact email match and case-insensitive", () => {
  const env = {
    FPL_EDGE_PERSONAL_TRANSFER_EXEC: "1",
    FPL_EDGE_PERSONAL_TRANSFER_ALLOWLIST: "imody10@gmail.com, other@example.com",
  };
  assert.equal(isEmailAllowlisted("imody10@gmail.com", env), true);
  assert.equal(isEmailAllowlisted("Imody10@Gmail.com", env), true);
  assert.equal(isEmailAllowlisted("stranger@example.com", env), false);
});

test("gate requires flag, allowlist, auth, and entry id", () => {
  const base = {
    FPL_EDGE_PERSONAL_TRANSFER_EXEC: "1",
    FPL_EDGE_PERSONAL_TRANSFER_ALLOWLIST: "imody10@gmail.com",
    FPL_EDGE_PERSONAL_FPL_ENTRY_ID: "123456",
  };
  assert.deepEqual(evaluatePersonalTransferGate({}, "imody10@gmail.com"), { ok: false, reason: "disabled" });
  assert.deepEqual(evaluatePersonalTransferGate(base, null), { ok: false, reason: "unauthenticated" });
  assert.deepEqual(evaluatePersonalTransferGate(base, "stranger@example.com"), { ok: false, reason: "not-allowlisted" });
  assert.deepEqual(
    evaluatePersonalTransferGate({ ...base, FPL_EDGE_PERSONAL_FPL_ENTRY_ID: "" }, "imody10@gmail.com"),
    { ok: false, reason: "missing-entry" },
  );
  assert.deepEqual(evaluatePersonalTransferGate(base, "imody10@gmail.com"), { ok: true, entryId: "123456" });
});

test("refresh token parser accepts bare tokens and oidc.user JSON", () => {
  assert.equal(parseRefreshTokenInput("  bare-refresh-token-value  "), "bare-refresh-token-value");
  assert.equal(
    parseRefreshTokenInput(JSON.stringify({ refresh_token: "rotating-token-value", access_token: "x" })),
    "rotating-token-value",
  );
});

test("refresh token parser rejects truncated oidc JSON and extracts complete refresh_token field", async () => {
  const { extractRefreshToken } = await import("../app/lib/personal-fpl-transfer/config.ts");
  assert.equal(extractRefreshToken("{ \"access_token\": \"aaa\", \"refresh_tok"), null);
  assert.equal(
    extractRefreshToken('{ "access_token": "aaa", "refresh_token": "good-refresh-token-value", "id_tok'),
    "good-refresh-token-value",
  );
  assert.equal(extractRefreshToken("{ \"access_token\": \"only\" }"), null);
});

test("buildTransferLeg uses selling price from my-team and rejects missing owned players", () => {
  const myTeam = {
    picks: [
      {
        element: 10,
        position: 1,
        selling_price: 51,
        purchase_price: 50,
        is_captain: false,
        is_vice_captain: false,
        multiplier: 1,
      },
    ],
    transfers: { bank: 5, limit: 1, made: 0, value: 1000 },
  };
  const leg = buildTransferLeg(myTeam, 10, 99, 75);
  assert.deepEqual(leg, { element_out: 10, element_in: 99, selling_price: 51, purchase_price: 75 });
  assert.throws(() => buildTransferLeg(myTeam, 11, 99, 75), /not in the authenticated squad/);
  assert.throws(() => buildTransferLeg(myTeam, 10, 10, 75), /already in the authenticated squad/);
});

test("marketing trust copy stays read-only and personal module is isolated", () => {
  const home = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(home, /We never ask for your FPL password/);
  assert.doesNotMatch(home, /Place on my FPL team|personal-transfer|FPL_EDGE_PERSONAL/);
  const readme = readFileSync(new URL("../app/lib/personal-fpl-transfer/README.md", import.meta.url), "utf8");
  assert.match(readme, /FPL_EDGE_PERSONAL_TRANSFER_EXEC/);
  assert.match(readme, /account\.premierleague\.com\/as\/token/);
  assert.match(readme, /\/api\/transfers\//);
  const coach = readFileSync(new URL("../app/components/CoachApp.tsx", import.meta.url), "utf8");
  assert.match(coach, /PersonalTransferPlace/);
  assert.match(coach, /Read-only\. We never ask for your FPL password/);
  assert.match(coach, /Places this ranked route/);
  const draft = readFileSync(new URL("../app/components/LiveDraftBuilder.tsx", import.meta.url), "utf8");
  assert.match(draft, /PersonalTransferPlace/);
  assert.match(draft, /latestSandboxTransfer/);
});

test("resolveTransferBankMillions: live my-team bank beats stale entry_history bank", () => {
  const resolved = resolveTransferBankMillions({
    historyBankMillions: 2.1,
    liveBankMillions: 0.8,
  });
  assert.equal(resolved.bank, 0.8);
  assert.equal(resolved.source, "live-my-team");
});

test("resolveTransferBankMillions: falls back to history when live missing", () => {
  const resolved = resolveTransferBankMillions({
    historyBankMillions: 2.1,
    liveBankMillions: null,
  });
  assert.equal(resolved.bank, 2.1);
  assert.equal(resolved.source, "entry-history");
});

test("liveTeamFinanceFromMyTeam: maps tenths bank/selling and requires 15 picks", () => {
  const picks = Array.from({ length: 15 }, (_, index) => ({
    element: index + 1,
    position: index + 1,
    selling_price: 40 + index,
    purchase_price: 40 + index,
    is_captain: index === 0,
    is_vice_captain: index === 1,
    multiplier: index < 11 ? 1 : 0,
  }));
  const live = liveTeamFinanceFromMyTeam({
    picks,
    transfers: { bank: 8, limit: 1, made: 2, value: 990, cost: 4, status: "cost" },
  });
  assert.ok(live);
  assert.equal(live!.bankMillions, 0.8);
  assert.equal(live!.squadValueMillions, 99.0);
  assert.equal(live!.transfersMade, 2);
  assert.equal(live!.playerIds.length, 15);
  assert.equal(live!.sellingMillionsById.get(1), 4.0);
  assert.equal(liveTeamFinanceFromMyTeam({ picks: picks.slice(0, 14), transfers: { bank: 8, limit: 1, made: 0, value: 1000 } }), null);
});

test("liveTeamFinanceFromMyTeam: still overlays when some selling prices missing", () => {
  const picks = Array.from({ length: 15 }, (_, index) => ({
    element: index + 1,
    position: index + 1,
    selling_price: index === 3 ? Number.NaN : 40 + index,
    purchase_price: 40 + index,
    is_captain: index === 0,
    is_vice_captain: index === 1,
    multiplier: index < 11 ? 1 : 0,
  }));
  const live = liveTeamFinanceFromMyTeam({
    picks,
    transfers: { bank: 8, limit: 1, made: 1, value: 1000 },
  });
  assert.ok(live);
  assert.equal(live!.bankMillions, 0.8);
  assert.equal(live!.playerIds.length, 15);
  assert.ok(live!.sellingMillionsById.size < 15);
});

test("FplOidcError marks invalid_grant as expired", async () => {
  const { FplOidcError } = await import("../app/lib/personal-fpl-transfer/oidc.ts");
  const err = new FplOidcError(400, "invalid_grant", "refresh token expired or revoked");
  assert.equal(err.isInvalidGrant, true);
  assert.match(err.message, /invalid_grant/);
});

test("resolveTransferBankMillions: personal live failure never falls back to history", () => {
  const resolved = resolveTransferBankMillions({
    historyBankMillions: 2.1,
    liveBankMillions: null,
    disallowHistoryFallback: true,
  });
  assert.equal(resolved.bank, null);
  assert.equal(resolved.source, "unavailable");
});

test("evaluatePersonalAuthManageGate: allowlist without EXEC", () => {
  const env = {
    FPL_EDGE_PERSONAL_TRANSFER_ALLOWLIST: "imody10@gmail.com",
    FPL_EDGE_PERSONAL_FPL_ENTRY_ID: "261593",
  };
  assert.deepEqual(evaluatePersonalAuthManageGate(env, null), { ok: false, reason: "unauthenticated" });
  assert.deepEqual(evaluatePersonalAuthManageGate(env, "stranger@example.com"), { ok: false, reason: "not-allowlisted" });
  assert.deepEqual(evaluatePersonalAuthManageGate(env, "imody10@gmail.com"), { ok: true, entryId: "261593" });
});

test("deriveSandboxFinancialContext: unavailable when liveOverlayError / bankSource unavailable", () => {
  const squad = Array.from({ length: 15 }, (_, i) => ({
    id: i + 1,
    price: 5,
    priceChangeSinceStart: 0,
  })) as never;
  const blocked: ManagerMeta = {
    id: 261593,
    name: "M",
    teamName: "T",
    overallPoints: 0,
    overallRank: 0,
    gameweekPoints: 0,
    gameweekRank: 0,
    squadValue: 100,
    bank: 2.1,
    bankSource: "entry-history",
    liveOverlayError: "token-expired",
    transfersMade: 0,
    transferCost: 0,
    captainId: null,
    viceCaptainId: null,
    chip: null,
  };
  assert.equal(isRankingFinanceUnavailable(blocked), true);
  const finance = deriveSandboxFinancialContext(squad, 100, blocked);
  assert.equal(finance.source, "unavailable");
  assert.equal(finance.baselineBank, 0);

  const explicit: ManagerMeta = { ...blocked, bank: null, bankSource: "unavailable", liveOverlayError: "token-expired", rankingFinance: "unavailable" };
  assert.equal(deriveSandboxFinancialContext(squad, 100, explicit).source, "unavailable");
});

test("README documents reconnect path and cron keep-alive", () => {
  const readme = readFileSync(new URL("../app/lib/personal-fpl-transfer/README.md", import.meta.url), "utf8");
  assert.match(readme, /Reconnect FPL|reconnect FPL/i);
  assert.match(readme, /\/api\/personal\/fpl-auth\/reconnect/);
  assert.match(readme, /keepAlivePersonalFplAuth|0 \* \* \* \*/);
  assert.match(readme, /rankingFinance.*unavailable|bankSource.*unavailable/i);
  assert.match(readme, /bookmark|Send FPL session to Edge/i);
  assert.doesNotMatch(readme, /DevTools/);
  const coach = readFileSync(new URL("../app/components/CoachApp.tsx", import.meta.url), "utf8");
  assert.match(coach, /ReconnectFplPanel/);
  assert.match(coach, /ReconnectFplPanel/);
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(wrangler, /0 \* \* \* \*/);
  const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(worker, /keepAlivePersonalFplAuth/);
  assert.match(worker, /scheduled|keepAlivePersonalFplAuth/);
  const panel = readFileSync(new URL("../app/components/ReconnectFplPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /fpl_rt|bookmarklet|Send FPL session to Edge/);
  assert.doesNotMatch(panel, /DevTools/);
});

test("remainingFreeTransfers: limit − made; null limit is unlimited chip", () => {
  assert.equal(remainingFreeTransfers({ freeTransferLimit: 1, transfersMade: 0 }), 1);
  assert.equal(remainingFreeTransfers({ freeTransferLimit: 1, transfersMade: 1 }), 0);
  assert.equal(remainingFreeTransfers({ freeTransferLimit: 2, transfersMade: 3 }), 0);
  assert.equal(remainingFreeTransfers({ freeTransferLimit: null, transfersMade: 5 }), 5);
  assert.equal(remainingFreeTransfers({ freeTransferLimit: undefined, transfersMade: 0 }), null);
});

test("resolveAuthoritativeFreeTransfers: live bankSource wins over local fallback", () => {
  assert.equal(
    resolveAuthoritativeFreeTransfers({
      bankSource: "live-my-team",
      freeTransferLimit: 1,
      transfersMade: 1,
      fallbackFreeTransfers: 2,
    }),
    0,
  );
  assert.equal(
    resolveAuthoritativeFreeTransfers({
      bankSource: "entry-history",
      freeTransferLimit: 1,
      transfersMade: 1,
      fallbackFreeTransfers: 2,
    }),
    2,
  );
});
