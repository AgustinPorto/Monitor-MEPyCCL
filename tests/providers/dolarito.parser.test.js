import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDolaritoHtml } from "../../src/providers/dolarito.js";
import { ProviderDataError, resolveWithFallback } from "../../src/providers/errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("providers/dolarito parser", () => {
  it("parses fixture HTML and validates output", () => {
    const fixturePath = path.resolve(__dirname, "../fixtures/dolarito.html");
    const html = fs.readFileSync(fixturePath, "utf8");
    const parsed = parseDolaritoHtml(html);

    assert.equal(parsed.mepSell, 1243.12);
    assert.equal(parsed.cclSell, 1252.95);
    assert.equal(parsed.mepTimestampMs, 1767101400000);
    assert.equal(parsed.cclTimestampMs, 1767101405000);
  });

  it("returns typed parse error when HTML structure changes", () => {
    assert.throws(
      () => parseDolaritoHtml("<html><body>unexpected format</body></html>"),
      (error) => error?.name === "ProviderDataError" && error?.errorType === "parse",
    );
  });

  it("uses last valid snapshot as fallback on parse error (no crash)", () => {
    const lastValid = { mepSell: 1200, cclSell: 1210 };
    const fallback = resolveWithFallback({
      freshValue: null,
      lastValidValue: lastValid,
      error: new ProviderDataError({
        provider: "dolarito",
        errorType: "parse",
        message: "parse failed",
      }),
    });

    assert.equal(fallback.usedFallback, true);
    assert.deepEqual(fallback.value, lastValid);
    assert.equal(fallback.error?.errorType, "parse");
  });
});
