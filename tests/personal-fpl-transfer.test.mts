import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildTransferLeg,
  evaluatePersonalTransferGate,
  isEmailAllowlisted,
  isPersonalTransferExecEnabled,
  parseRefreshTokenInput,
} from "../app/lib/personal-fpl-transfer/index.ts";

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
  assert.equal(parseRefreshTokenInput("  abc.def  "), "abc.def");
  assert.equal(
    parseRefreshTokenInput(JSON.stringify({ refresh_token: "rotating-token", access_token: "x" })),
    "rotating-token",
  );
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
});
