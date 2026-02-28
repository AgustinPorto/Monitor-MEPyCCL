const ALLOWED_ERROR_TYPES = new Set(["fetch", "schema", "parse", "unknown"]);

export class ProviderDataError extends Error {
  constructor({ provider, errorType = "unknown", message, cause = null, meta = null }) {
    super(message);
    this.name = "ProviderDataError";
    this.provider = provider || "unknown";
    this.errorType = ALLOWED_ERROR_TYPES.has(errorType) ? errorType : "unknown";
    this.cause = cause;
    this.meta = meta;
  }
}

function normalizeMessage(error) {
  if (error instanceof Error && typeof error.message === "string") return error.message;
  return String(error || "unknown error");
}

export function toProviderDataError(error, { provider, errorType = "unknown" } = {}) {
  if (error instanceof ProviderDataError) return error;
  return new ProviderDataError({
    provider: provider || "unknown",
    errorType,
    message: normalizeMessage(error),
    cause: error,
  });
}

export function classifyFetchError(error) {
  const message = normalizeMessage(error).toLowerCase();
  if (message.includes("abort") || message.includes("timeout") || message.includes("network")) return "fetch";
  if (message.includes("http")) return "fetch";
  return "unknown";
}

export function sanitizeProviderError(error) {
  const providerError = toProviderDataError(error);
  return {
    provider: providerError.provider,
    error_type: providerError.errorType,
    message: providerError.message.slice(0, 180),
  };
}

export function resolveWithFallback({ freshValue, lastValidValue, error }) {
  if (freshValue !== null && freshValue !== undefined) {
    return { value: freshValue, usedFallback: false, error: null };
  }
  if (lastValidValue !== null && lastValidValue !== undefined) {
    return { value: lastValidValue, usedFallback: true, error: toProviderDataError(error) };
  }
  throw toProviderDataError(error);
}
