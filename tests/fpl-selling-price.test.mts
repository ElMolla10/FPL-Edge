import assert from "node:assert/strict";
import test from "node:test";
import {
  conservativeSellingFromSeasonChange,
  deriveSellingPricesMillions,
  fplSellingPriceMillions,
  fplSellingPriceTenths,
  purchaseTenthsFromTransferHistory,
} from "../app/lib/fpl-selling-price.ts";

test("fplSellingPriceTenths: keeps floor(half) of rises, full loss on drops", () => {
  assert.equal(fplSellingPriceTenths(40, 40), 40);
  assert.equal(fplSellingPriceTenths(40, 41), 40);
  assert.equal(fplSellingPriceTenths(40, 42), 41);
  assert.equal(fplSellingPriceTenths(75, 78), 76);
  assert.equal(fplSellingPriceTenths(50, 49), 49);
  assert.equal(fplSellingPriceTenths(97, 97), 97);
});

test("fplSellingPriceMillions rounds to one decimal", () => {
  assert.equal(fplSellingPriceMillions(7.5, 7.8), 7.6);
  assert.equal(fplSellingPriceMillions(6.0, 6.1), 6.0);
});

test("conservativeSellingFromSeasonChange matches season-start purchase formula", () => {
  assert.equal(conservativeSellingFromSeasonChange(7.8, 0.3), 7.6);
  assert.equal(conservativeSellingFromSeasonChange(4.0, 0), 4.0);
  assert.equal(conservativeSellingFromSeasonChange(4.9, -0.1), 4.9);
});

test("purchaseTenthsFromTransferHistory: last buy wins", () => {
  const owned = new Set([154, 453]);
  const map = purchaseTenthsFromTransferHistory(
    [
      { element_in: 154, element_in_cost: 95, element_out: 1, element_out_cost: 90, time: "2026-09-01T00:00:00Z" },
      { element_in: 154, element_in_cost: 97, element_out: 2, element_out_cost: 95, time: "2026-09-12T00:00:00Z" },
      { element_in: 453, element_in_cost: 60, element_out: 3, element_out_cost: 58, time: "2026-09-12T00:00:00Z" },
      { element_in: 999, element_in_cost: 50, element_out: 4, element_out_cost: 50, time: "2026-09-12T00:00:00Z" },
    ],
    owned,
  );
  assert.equal(map.get(154), 97);
  assert.equal(map.get(453), 60);
  assert.equal(map.has(999), false);
});

test("deriveSellingPricesMillions: transfer purchase beats season-start; official beats both", () => {
  const selling = deriveSellingPricesMillions({
    ownedElementIds: [154, 411, 173],
    nowCostTenthsById: new Map([
      [154, 97],
      [411, 156],
      [173, 40],
    ]),
    costChangeStartTenthsById: new Map([
      [154, 2],
      [411, 1],
      [173, 0],
    ]),
    transfers: [
      { element_in: 154, element_in_cost: 97, element_out: 1, element_out_cost: 90, time: "2026-09-12T00:00:00Z" },
    ],
    officialSellingMillionsById: new Map([[411, 15.5]]),
  });
  assert.equal(selling.get(154), 9.7, "transfer purchase 9.7 with no rise since buy");
  assert.equal(selling.get(411), 15.5, "official selling wins");
  assert.equal(selling.get(173), 4.0, "season-start / flat");
});
