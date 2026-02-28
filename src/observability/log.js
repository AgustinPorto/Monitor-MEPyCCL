function randomToken() {
  return Math.random().toString(36).slice(2, 10);
}

export function createRequestId(existing = null) {
  const value = typeof existing === "string" ? existing.trim() : "";
  if (value) return value;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req_${Date.now()}_${randomToken()}`;
}

export function logStructured({
  requestId,
  route,
  provider,
  latencyMs,
  outcome,
  errorType = null,
  snapshotTimestamp = null,
}) {
  console.log(JSON.stringify({
    request_id: requestId || null,
    route: route || "unknown",
    provider: provider || "unknown",
    latency_ms: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
    outcome: outcome || "unknown",
    error_type: errorType,
    snapshot_timestamp: snapshotTimestamp || null,
  }));
}
