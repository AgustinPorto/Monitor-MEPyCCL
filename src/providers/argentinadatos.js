import { toProviderDataError } from "./errors.js";
import {
  validateFciSeriesPayload,
  validateInflacionPayload,
  validatePlazoFijoPayload,
} from "./schemas.js";

export function normalizeProviderRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.rows)) return payload.rows;
    if (payload.result && typeof payload.result === "object") {
      if (Array.isArray(payload.result.data)) return payload.result.data;
      if (Array.isArray(payload.result.items)) return payload.result.items;
      if (Array.isArray(payload.result.rows)) return payload.result.rows;
    }
  }
  return [];
}

export function parseFciSeriesPayload(payload, provider = "argentinadatos_fci") {
  try {
    const safe = validateFciSeriesPayload(payload, provider);
    return normalizeProviderRows(safe);
  } catch (error) {
    throw toProviderDataError(error, { provider, errorType: "schema" });
  }
}

export function parsePlazoFijoPayload(payload, provider = "argentinadatos_plazo_fijo") {
  try {
    const safe = validatePlazoFijoPayload(payload, provider);
    return normalizeProviderRows(safe);
  } catch (error) {
    throw toProviderDataError(error, { provider, errorType: "schema" });
  }
}

export function parseInflacionPayload(payload, provider = "argentinadatos_inflacion") {
  try {
    const safe = validateInflacionPayload(payload, provider);
    return normalizeProviderRows(safe);
  } catch (error) {
    throw toProviderDataError(error, { provider, errorType: "schema" });
  }
}
