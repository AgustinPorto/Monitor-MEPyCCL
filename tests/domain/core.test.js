import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calcSpreadAbs,
  calcSpreadPctRatio,
  calcStalenessSeconds,
  isMarketOpen,
  isSimilar,
  toPercent,
} from "../../src/domain/core.js";

describe("domain/core", () => {
  it("calcSpreadAbs returns absolute spread for normal values", () => {
    assert.equal(calcSpreadAbs(1250, 1260), 10);
    assert.equal(calcSpreadAbs(1260, 1250), 10);
  });

  it("calcSpreadAbs handles null/undefined/NaN defensively", () => {
    assert.equal(Number.isNaN(calcSpreadAbs(null, 10)), true);
    assert.equal(Number.isNaN(calcSpreadAbs(undefined, 10)), true);
    assert.equal(Number.isNaN(calcSpreadAbs(Number.NaN, 10)), true);
  });

  it("calcSpreadPctRatio uses ratio units only", () => {
    const ratio = calcSpreadPctRatio(100, 101);
    assert.ok(Math.abs(ratio - 0.0099502487) < 1e-8);
    assert.ok(Math.abs(toPercent(ratio) - 0.99502487) < 1e-6);
  });

  it("calcSpreadPctRatio returns NaN on invalid inputs and division by zero", () => {
    assert.equal(Number.isNaN(calcSpreadPctRatio(null, 10)), true);
    assert.equal(Number.isNaN(calcSpreadPctRatio(undefined, 10)), true);
    assert.equal(Number.isNaN(calcSpreadPctRatio(Number.NaN, 10)), true);
    assert.equal(Number.isNaN(calcSpreadPctRatio(0, 0)), true);
  });

  it("toPercent converts ratio into human percent", () => {
    assert.equal(toPercent(0.01), 1);
    assert.ok(Math.abs(toPercent(0.0123) - 1.23) < 1e-8);
  });

  it("isSimilar can be true by percentage threshold", () => {
    assert.equal(isSimilar(100, 101, { pctThreshold: 0.01, absThreshold: 0 }), true);
    assert.equal(isSimilar(100, 101, { pctThreshold: 0.0001, absThreshold: 0 }), false);
  });

  it("isSimilar can be true by absolute threshold", () => {
    assert.equal(isSimilar(100, 110, { pctThreshold: 0.01, absThreshold: 10 }), true);
    assert.equal(isSimilar(100, 111, { pctThreshold: 0.01, absThreshold: 10 }), false);
  });

  it("unit mix guard catches ratio-vs-percent confusion (0.01 vs 1)", () => {
    const ratio = calcSpreadPctRatio(100, 101);
    assert.equal(ratio < 0.02, true);
    assert.equal(Math.abs(ratio - 1) < 1e-4, false);
  });

  it("calcStalenessSeconds handles normal and invalid values", () => {
    const now = new Date("2026-03-02T14:00:00Z");
    const last = new Date("2026-03-02T13:59:15Z");
    assert.equal(calcStalenessSeconds(now, last), 45);
    assert.equal(calcStalenessSeconds(now, null), null);
    assert.equal(calcStalenessSeconds(null, last), null);
  });

  it("isMarketOpen respects ART market boundaries with fixed UTC dates", () => {
    assert.equal(isMarketOpen(new Date("2026-03-02T13:29:00Z")), false); // Mon 10:29 ART
    assert.equal(isMarketOpen(new Date("2026-03-02T13:30:00Z")), true); // Mon 10:30 ART
    assert.equal(isMarketOpen(new Date("2026-03-02T20:59:00Z")), true); // Mon 17:59 ART
    assert.equal(isMarketOpen(new Date("2026-03-02T21:00:00Z")), false); // Mon 18:00 ART
    assert.equal(isMarketOpen(new Date("2026-03-07T15:00:00Z")), false); // Sat 12:00 ART
  });
});
