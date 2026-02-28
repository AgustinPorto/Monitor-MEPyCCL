import { ProviderDataError } from "./errors.js";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assert(condition, message, provider = "unknown") {
  if (!condition) {
    throw new ProviderDataError({
      provider,
      errorType: "schema",
      message,
    });
  }
}

function extractRowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload)) {
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.rows)) return payload.rows;
    if (isRecord(payload.result)) {
      if (Array.isArray(payload.result.data)) return payload.result.data;
      if (Array.isArray(payload.result.items)) return payload.result.items;
      if (Array.isArray(payload.result.rows)) return payload.result.rows;
    }
  }
  return null;
}

export function validateDolaritoParsedPayload(value, provider = "dolarito") {
  assert(isRecord(value), "Parsed dolarito payload must be an object", provider);
  assert(Number.isFinite(value.mepSell), "mepSell must be a finite number", provider);
  assert(Number.isFinite(value.cclSell), "cclSell must be a finite number", provider);
  assert(
    value.mepTimestampMs === null || Number.isFinite(value.mepTimestampMs),
    "mepTimestampMs must be finite or null",
    provider,
  );
  assert(
    value.cclTimestampMs === null || Number.isFinite(value.cclTimestampMs),
    "cclTimestampMs must be finite or null",
    provider,
  );
  return value;
}

export function validateFciSeriesPayload(payload, provider = "argentinadatos_fci") {
  const rows = extractRowsFromPayload(payload);
  assert(Array.isArray(rows), "FCI payload must expose an array in data/items/rows", provider);
  for (const row of rows) {
    assert(isRecord(row), "FCI row must be an object", provider);
    if (row.fecha !== undefined && row.fecha !== null) {
      assert(typeof row.fecha === "string", "FCI row.fecha must be a string when present", provider);
    }
  }
  return payload;
}

export function validatePlazoFijoPayload(payload, provider = "argentinadatos_plazo_fijo") {
  const rows = extractRowsFromPayload(payload);
  assert(Array.isArray(rows), "Plazo fijo payload must expose an array in data/items/rows", provider);
  for (const row of rows) {
    assert(isRecord(row), "Plazo fijo row must be an object", provider);
    const hasName = [row.entidad, row.banco, row.nombre].some((v) => v === undefined || v === null || typeof v === "string");
    assert(hasName, "Plazo fijo row name fields must be string-like", provider);
    if (row.tnaClientes !== undefined && row.tnaClientes !== null) {
      const type = typeof row.tnaClientes;
      assert(type === "number" || type === "string", "tnaClientes must be number|string when present", provider);
    }
  }
  return payload;
}

export function validateInflacionPayload(payload, provider = "argentinadatos_inflacion") {
  const rows = extractRowsFromPayload(payload);
  assert(Array.isArray(rows), "Inflacion payload must expose an array in data/items/rows", provider);
  for (const row of rows) {
    assert(isRecord(row), "Inflacion row must be an object", provider);
    if (row.fecha !== undefined && row.fecha !== null) {
      assert(typeof row.fecha === "string", "Inflacion row.fecha must be string when present", provider);
    }
    if (row.date !== undefined && row.date !== null) {
      assert(typeof row.date === "string", "Inflacion row.date must be string when present", provider);
    }
    if (row.valor !== undefined && row.valor !== null) {
      const type = typeof row.valor;
      assert(type === "number" || type === "string", "Inflacion row.valor must be number|string when present", provider);
    }
  }
  return payload;
}
