import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseFciSeriesPayload,
  parseInflacionPayload,
  parsePlazoFijoPayload,
} from "../../src/providers/argentinadatos.js";
import { ProviderDataError, resolveWithFallback } from "../../src/providers/errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("providers/argentinadatos schema validation", () => {
  it("validates FCI fixture payload", () => {
    const fixturePath = path.resolve(__dirname, "../fixtures/argentinadatos_fci.json");
    const payload = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const rows = parseFciSeriesPayload(payload);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].fecha, "2026-02-27");
  });

  it("validates benchmark fixtures (plazo fijo + inflacion)", () => {
    const fixturePath = path.resolve(__dirname, "../fixtures/argentinadatos_benchmarks.json");
    const payload = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const pfRows = parsePlazoFijoPayload(payload.plazoFijo);
    const infRows = parseInflacionPayload(payload.inflacion);
    assert.equal(pfRows.length, 2);
    assert.equal(infRows.length, 2);
  });

  it("fails fast with typed schema errors for malformed JSON payloads", () => {
    assert.throws(
      () => parseFciSeriesPayload({ data: [{ fecha: 20260227 }] }),
      (error) => error?.name === "ProviderDataError" && error?.errorType === "schema",
    );
    assert.throws(
      () => parseInflacionPayload({ data: [{ fecha: "2026-02", valor: { bad: true } }] }),
      (error) => error?.name === "ProviderDataError" && error?.errorType === "schema",
    );
  });

  it("falls back to last valid value on schema errors (no crash)", () => {
    const lastValidRows = [{ fondo: "FCI Legacy", fecha: "2026-02-26" }];
    const fallback = resolveWithFallback({
      freshValue: null,
      lastValidValue: lastValidRows,
      error: new ProviderDataError({
        provider: "argentinadatos_fci",
        errorType: "schema",
        message: "schema validation failed",
      }),
    });
    assert.equal(fallback.usedFallback, true);
    assert.deepEqual(fallback.value, lastValidRows);
    assert.equal(fallback.error?.errorType, "schema");
  });
});
