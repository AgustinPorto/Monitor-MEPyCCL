import {
  calcSpreadAbs,
  calcSpreadPctRatio,
  calcStalenessSeconds,
  isMarketOpen,
  isSimilar,
  toPercent,
} from "./domain/core.js";
import { createRequestId, logStructured } from "./observability/log.js";
import {
  parseFciSeriesPayload,
  parseInflacionPayload,
  parsePlazoFijoPayload,
} from "./providers/argentinadatos.js";
import { parseDolaritoHtml } from "./providers/dolarito.js";
import { ProviderDataError, sanitizeProviderError } from "./providers/errors.js";

const ART_TZ = "America/Argentina/Buenos_Aires";
const ART_LABEL = "GMT-3 (Buenos Aires)";
const ART_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: ART_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  weekday: "short",
});
const SOURCE_URL = "https://www.dolarito.ar/cotizacion/dolar-hoy";
const FCI_RF_API_BASE = "https://api.argentinadatos.com/v1/finanzas/fci/rentaFija";
const FCI_RV_API_BASE = "https://api.argentinadatos.com/v1/finanzas/fci/rentaVariable";
const PLAZO_FIJO_API_URL = "https://api.argentinadatos.com/v1/finanzas/tasas/plazoFijo";
const INFLACION_API_URL = "https://api.argentinadatos.com/v1/finanzas/indices/inflacion";
const STATE_KEY = "mep_ccl_state_v1";
const HISTORY_KEY = "mep_ccl_history_v1";
const SNAPSHOT_PREFIX = "mep_ccl_snapshot_";
const FCI_LAST_KEY = "fci_renta_fija_ultimo_v1";
const FCI_PREV_KEY = "fci_renta_fija_penultimo_v1";
const FCI_BASE30_KEY = "fci_renta_fija_base30_v1";
const FCI_STATE_KEY = "fci_renta_fija_state_v1";
const FCI_SNAPSHOT_PREFIX = "fci_renta_fija_snapshot_";
const FCI_RV_LAST_KEY = "fci_renta_variable_ultimo_v1";
const FCI_RV_PREV_KEY = "fci_renta_variable_penultimo_v1";
const FCI_RV_BASE30_KEY = "fci_renta_variable_base30_v1";
const FCI_RV_STATE_KEY = "fci_renta_variable_state_v1";
const FCI_RV_SNAPSHOT_PREFIX = "fci_renta_variable_snapshot_";
const PLAZO_FIJO_BENCH_KEY = "bench_plazo_fijo_v1";
const INFLACION_BENCH_KEY = "bench_inflacion_v1";
const BENCHMARK_STATE_KEY = "bench_state_v1";
const API_BUNDLE_KEY = "dashboard_api_bundle_v1";
const UX_REDESIGN_DATE = "2026-02-26";
const MAX_HISTORY_ITEMS = 4000;
const THRESHOLDS = {
  maxAbsDiffArs: 12,
  maxSpreadPctRatio: 0.01,
  maxSpreadPctPercent: 1.0,
  maxPctDiff: 1.0,
};
const DEFAULT_ALERT_COOLDOWN_MINUTES = 120;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const requestId = createRequestId(request.headers.get("x-request-id"));
    const routeStartedAt = Date.now();
    const respond = (response, { provider = "worker_route", outcome = "ok", errorType = null, snapshotTimestamp = null } = {}) => {
      response.headers.set("X-Request-Id", requestId);
      logStructured({
        requestId,
        route: path,
        provider,
        latencyMs: Date.now() - routeStartedAt,
        outcome,
        errorType,
        snapshotTimestamp,
      });
      return response;
    };

    if (path === "/" || path === "/dashboard.html") {
      return respond(htmlResponse(renderDashboardHtml()), { provider: "dashboard_html" });
    }

    if (path === "/api/data") {
      let state = normalizeState(await loadState(env));
      if (!state || !isUsableState(state)) {
        state = await runUpdate(env, { requestId, route: path });
      }
      if (!state.history?.length) {
        const recoveredHistory = await loadHistory(env);
        if (recoveredHistory.length) {
          state.history = recoveredHistory;
          state.metrics24h = computeMetrics24h(recoveredHistory, Math.floor(Date.now() / 1000));
        }
      }
      const decorated = decorateOperationalState(state);
      return respond(jsonResponse(decorated, false), {
        provider: "api_data",
        snapshotTimestamp: decorated?.updatedAtIso || null,
      });
    }

    if (path === "/api/health") {
      const state = await loadState(env);
      return respond(jsonResponse(
        {
          ok: Boolean(state),
          updatedAtHumanArt: state?.updatedAtHumanArt || null,
          sourceStatus: state?.sourceStatus || null,
        },
        false,
      ), {
        provider: "api_health",
        snapshotTimestamp: state?.updatedAtIso || null,
      });
    }

    if (path === "/api/fci/renta-fija/ultimo") {
      let payload = await loadFciPayload(env, FCI_LAST_KEY);
      if (!payload) {
        await safeRefresh(() => refreshFciRentaFijaData(env, { requestId, route: path }));
        payload = await loadFciPayload(env, FCI_LAST_KEY);
      }
      return respond(jsonResponse(payload || buildEmptyFciPayload("ultimo"), false), {
        provider: "fci_renta_fija_ultimo",
        snapshotTimestamp: payload?.fetchedAtIso || null,
      });
    }

    if (path === "/api/fci/renta-fija/penultimo") {
      let payload = await loadFciPayload(env, FCI_PREV_KEY);
      if (!payload) {
        await safeRefresh(() => refreshFciRentaFijaData(env, { requestId, route: path }));
        payload = await loadFciPayload(env, FCI_PREV_KEY);
      }
      return respond(jsonResponse(payload || buildEmptyFciPayload("penultimo"), false), {
        provider: "fci_renta_fija_penultimo",
        snapshotTimestamp: payload?.fetchedAtIso || null,
      });
    }

    if (path === "/api/fci/renta-fija/mes-base") {
      let payload = await loadFciPayload(env, FCI_BASE30_KEY);
      if (!payload) {
        await safeRefresh(() => refreshFciRentaFijaData(env, { requestId, route: path }));
        payload = await loadFciPayload(env, FCI_BASE30_KEY);
      }
      return respond(jsonResponse(payload || buildEmptyFciPayload("base30"), false), {
        provider: "fci_renta_fija_base30",
        snapshotTimestamp: payload?.fetchedAtIso || null,
      });
    }

    if (path === "/api/fci/status") {
      const status = await loadFciStatus(env);
      return respond(jsonResponse(status || buildEmptyFciStatus(), false), {
        provider: "fci_renta_fija_status",
        snapshotTimestamp: status?.updatedAtIso || null,
      });
    }

    if (path === "/api/fci/renta-variable/ultimo") {
      let payload = await loadFciPayload(env, FCI_RV_LAST_KEY);
      if (!payload) {
        await safeRefresh(() => refreshFciRentaVariableData(env, { requestId, route: path }));
        payload = await loadFciPayload(env, FCI_RV_LAST_KEY);
      }
      return respond(jsonResponse(payload || buildEmptyFciPayload("ultimo"), false), {
        provider: "fci_renta_variable_ultimo",
        snapshotTimestamp: payload?.fetchedAtIso || null,
      });
    }

    if (path === "/api/fci/renta-variable/penultimo") {
      let payload = await loadFciPayload(env, FCI_RV_PREV_KEY);
      if (!payload) {
        await safeRefresh(() => refreshFciRentaVariableData(env, { requestId, route: path }));
        payload = await loadFciPayload(env, FCI_RV_PREV_KEY);
      }
      return respond(jsonResponse(payload || buildEmptyFciPayload("penultimo"), false), {
        provider: "fci_renta_variable_penultimo",
        snapshotTimestamp: payload?.fetchedAtIso || null,
      });
    }

    if (path === "/api/fci/renta-variable/mes-base") {
      let payload = await loadFciPayload(env, FCI_RV_BASE30_KEY);
      if (!payload) {
        await safeRefresh(() => refreshFciRentaVariableData(env, { requestId, route: path }));
        payload = await loadFciPayload(env, FCI_RV_BASE30_KEY);
      }
      return respond(jsonResponse(payload || buildEmptyFciPayload("base30"), false), {
        provider: "fci_renta_variable_base30",
        snapshotTimestamp: payload?.fetchedAtIso || null,
      });
    }

    if (path === "/api/fci/renta-variable/status") {
      const status = await loadFciStatus(env, FCI_RV_STATE_KEY);
      return respond(jsonResponse(status || buildEmptyFciStatus(), false), {
        provider: "fci_renta_variable_status",
        snapshotTimestamp: status?.updatedAtIso || null,
      });
    }

    if (path === "/api/benchmark/plazo-fijo") {
      let payload = await loadFciPayload(env, PLAZO_FIJO_BENCH_KEY);
      if (!payload) {
        await safeRefresh(() => refreshBenchmarkData(env, { requestId, route: path }));
        payload = await loadFciPayload(env, PLAZO_FIJO_BENCH_KEY);
      }
      return respond(jsonResponse(payload || buildEmptyBenchmarkPayload("plazo_fijo"), false), {
        provider: "benchmark_plazo_fijo",
        snapshotTimestamp: payload?.fetchedAtIso || null,
      });
    }

    if (path === "/api/benchmark/inflacion") {
      let payload = await loadFciPayload(env, INFLACION_BENCH_KEY);
      if (!payload) {
        await safeRefresh(() => refreshBenchmarkData(env, { requestId, route: path }));
        payload = await loadFciPayload(env, INFLACION_BENCH_KEY);
      }
      return respond(jsonResponse(payload || buildEmptyBenchmarkPayload("inflacion"), false), {
        provider: "benchmark_inflacion",
        snapshotTimestamp: payload?.fetchedAtIso || null,
      });
    }

    if (path === "/api/benchmark/status") {
      const status = await loadFciPayload(env, BENCHMARK_STATE_KEY);
      return respond(jsonResponse(status || buildEmptyBenchmarkStatus(), false), {
        provider: "benchmark_status",
        snapshotTimestamp: status?.updatedAtIso || null,
      });
    }

    if (path === "/api/bundle") {
      let bundle = await loadFciPayload(env, API_BUNDLE_KEY);
      if (!bundle) {
        bundle = await refreshApiBundle(env);
      }
      return respond(jsonResponse(bundle || buildEmptyApiBundle(), false), {
        provider: "api_bundle",
        snapshotTimestamp: bundle?.mepCcl?.updatedAtIso || null,
      });
    }

    if (path === "/api/snapshots") {
      const snapshots = await listSnapshots(env, 60);
      return respond(jsonResponse({ count: snapshots.length, snapshots }, false), {
        provider: "api_snapshots",
      });
    }

    if (path === "/api/recovery-check") {
      const state = normalizeState(await loadState(env));
      const history = state?.history?.length ? state.history : await loadHistory(env);
      const snapshots = await listSnapshots(env, 365);
      return respond(jsonResponse(buildRecoveryCheck(history, snapshots), false), {
        provider: "api_recovery_check",
        snapshotTimestamp: state?.updatedAtIso || null,
      });
    }

    if (path === "/favicon.ico") {
      return respond(new Response(null, { status: 204 }), {
        provider: "favicon",
      });
    }

    return respond(new Response("Not Found", { status: 404 }), {
      provider: "route_not_found",
      outcome: "fail",
      errorType: "unknown",
    });
  },

  async scheduled(event, env, ctx) {
    const tickDate = getScheduledDate(event);
    const requestId = createRequestId(`scheduled_${String(event?.scheduledTime || Date.now())}`);
    const route = "scheduled";
    const tasks = [runUpdate(env, { requestId, route })];

    // FCI: hourly during the 5-minute cron window.
    if (shouldRefreshFciOnTick(tickDate)) {
      tasks.push(
        refreshFciRentaFijaData(env, { requestId, route }),
        refreshFciRentaVariableData(env, { requestId, route }),
      );
    }

    // Benchmarks: once per business day at first market tick (13:30 UTC / 10:30 ART).
    if (shouldRefreshBenchmarkOnTick(tickDate)) {
      tasks.push(refreshBenchmarkData(env, { requestId, route }));
    }

    ctx.waitUntil((async () => {
      await Promise.allSettled(tasks);
      await refreshApiBundle(env);
      logStructured({
        requestId,
        route,
        provider: "scheduled_tick",
        latencyMs: 0,
        outcome: "ok",
        errorType: null,
        snapshotTimestamp: new Date().toISOString(),
      });
    })());
  },
};

function getScheduledDate(event) {
  const ms = Number(event?.scheduledTime);
  if (Number.isFinite(ms) && ms > 0) return new Date(ms);
  return new Date();
}

function shouldRefreshFciOnTick(date) {
  return date.getUTCMinutes() === 30;
}

function shouldRefreshBenchmarkOnTick(date) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  return date.getUTCHours() === 13 && date.getUTCMinutes() === 30;
}

async function safeRefresh(taskFn) {
  try {
    await taskFn();
  } catch (error) {
    console.log(JSON.stringify({
      level: "warn",
      event: "refresh_fallback",
      error: sanitizeError(error),
      at: new Date().toISOString(),
    }));
  }
}

async function runUpdate(env, context = {}) {
  const now = new Date();
  const nowEpoch = Math.floor(now.getTime() / 1000);

  const previous = normalizeState((await loadState(env)) || buildEmptyState(now));
  if (!previous.history?.length) {
    previous.history = await loadHistory(env);
  }
  const next = {
    ...previous,
    version: Number(previous.version || 0) + 1,
    updatedAtEpoch: nowEpoch,
    updatedAtIso: now.toISOString(),
    updatedAtHumanArt: formatArtDate(now),
    sourceUrl: SOURCE_URL,
    thresholds: THRESHOLDS,
    market: getMarketStatus(now),
  };

  try {
    const html = await fetchSourceHtml(SOURCE_URL, {
      ...context,
      provider: "dolarito_html",
      snapshotTimestamp: next.updatedAtIso,
    });
    const parsed = parseDolaritoHtml(html, "dolarito_html");
    const mep = parsed.mepSell;
    const ccl = parsed.cclSell;
    const mepTs = parsed.mepTimestampMs;
    const cclTs = parsed.cclTimestampMs;

    const spreadAbsArs = round2(calcSpreadAbs(mep, ccl));
    const spreadPctRatio = calcSpreadPctRatio(mep, ccl);
    const spreadPctPercent = round2(toPercent(spreadPctRatio));
    const similar = isSimilar(mep, ccl, {
      pctThreshold: THRESHOLDS.maxSpreadPctRatio,
      absThreshold: THRESHOLDS.maxAbsDiffArs,
    });

    const history = Array.isArray(previous.history) ? previous.history.slice() : [];
    history.push({
      epoch: nowEpoch,
      label: formatArtDate(now),
      mep: round2(mep),
      ccl: round2(ccl),
      abs_diff: spreadAbsArs,
      spread_abs_ars: spreadAbsArs,
      pct_diff: spreadPctPercent,
      spread_pct_percent: spreadPctPercent,
      spread_pct_ratio: Number.isFinite(spreadPctRatio) ? spreadPctRatio : null,
      similar,
    });

    const trimmedHistory = history.slice(-MAX_HISTORY_ITEMS);
    const metrics24h = computeMetrics24h(trimmedHistory, nowEpoch);
    const freshness = computeFreshness(mepTs, cclTs, nowEpoch);

    next.history = trimmedHistory;
    next.metrics24h = metrics24h;
    next.current = {
      mep: round2(mep),
      ccl: round2(ccl),
      absDiff: spreadAbsArs,
      spreadAbsArs,
      pctDiff: spreadPctPercent,
      spreadPctPercent,
      spreadPctRatio: Number.isFinite(spreadPctRatio) ? spreadPctRatio : null,
      similar,
      mepTsMs: mepTs,
      cclTsMs: cclTs,
      mepTsHuman: formatSourceTs(mepTs),
      cclTsHuman: formatSourceTs(cclTs),
    };
    next.sourceStatus = {
      ok: true,
      text: "OK",
      error: null,
      freshLabel: freshness.label,
      freshWarn: freshness.warn,
      sourceAgeMinutes: freshness.ageMinutes,
      latestSourceTsMs: freshness.latestTsMs,
      stalenessSeconds: freshness.stalenessSeconds,
    };
    next.status = deriveStatus(true, similar);
    next.operational = {
      ...(previous.operational || {}),
      lastSuccessAtHumanArt: formatArtDate(now),
      lastSuccessAtIso: now.toISOString(),
      dataConfidence: deriveDataConfidence(true, freshness.stalenessSeconds),
      stalenessSeconds: freshness.stalenessSeconds,
      nextRunAtHumanArt: formatArtDate(computeNextScheduledRun(new Date(now.getTime() + 60 * 1000))),
    };
    next.alerting = await maybeSendSimilarEmailAlert(env, previous, next, now, nowEpoch);
    next.lastError = null;
    next.lastErrorAtIso = null;
  } catch (error) {
    const trimmedHistory = Array.isArray(previous.history) ? previous.history.slice(-MAX_HISTORY_ITEMS) : [];
    const metrics24h = computeMetrics24h(trimmedHistory, nowEpoch);
    const freshness = computeFreshness(previous?.current?.mepTsMs, previous?.current?.cclTsMs, nowEpoch);
    const safeError = error instanceof ProviderDataError ? error : null;
    const errorDetails = safeError ? sanitizeProviderError(safeError) : null;
    const hasSnapshot = Boolean(previous?.current);

    next.history = trimmedHistory;
    next.metrics24h = metrics24h;
    next.current = previous.current || null;
    next.sourceStatus = {
      ok: false,
      text: "ERROR DE FUENTE",
      error: errorDetails || sanitizeError(error),
      freshLabel: freshness.label,
      freshWarn: freshness.warn,
      sourceAgeMinutes: freshness.ageMinutes,
      latestSourceTsMs: freshness.latestTsMs,
      stalenessSeconds: freshness.stalenessSeconds,
    };
    next.status = deriveStatus(false, Boolean(previous?.current?.similar));
    next.operational = {
      ...(previous.operational || {}),
      dataConfidence: deriveDataConfidence(hasSnapshot, freshness.stalenessSeconds),
      stalenessSeconds: freshness.stalenessSeconds,
      nextRunAtHumanArt: formatArtDate(computeNextScheduledRun(new Date(now.getTime() + 60 * 1000))),
    };
    next.alerting = {
      ...(previous.alerting || {}),
      enabled: isAlertsEnabled(env),
      lastRunAtHumanArt: formatArtDate(now),
      lastDecision: "skip_source_error",
    };
    next.lastError = errorDetails || sanitizeError(error);
    next.lastErrorAtIso = now.toISOString();
  }

  await env.MONITOR_KV.put(STATE_KEY, JSON.stringify(next));
  if (Array.isArray(next.history) && next.history.length) {
    await saveHistory(env, next.history);
    await saveDailySnapshot(env, next, now);
  }
  return next;
}

async function loadState(env) {
  const raw = await env.MONITOR_KV.get(STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadHistory(env) {
  const raw = await env.MONITOR_KV.get(HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-MAX_HISTORY_ITEMS);
  } catch {
    return [];
  }
}

async function saveHistory(env, history) {
  const safe = Array.isArray(history) ? history.slice(-MAX_HISTORY_ITEMS) : [];
  await env.MONITOR_KV.put(HISTORY_KEY, JSON.stringify(safe));
}

function snapshotKeyForDate(date) {
  const p = getArtParts(date);
  return SNAPSHOT_PREFIX + `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

async function saveDailySnapshot(env, state, now) {
  const key = snapshotKeyForDate(now);
  const payload = {
    dateArt: key.replace(SNAPSHOT_PREFIX, ""),
    savedAtHumanArt: formatArtDate(now),
    updatedAtHumanArt: state.updatedAtHumanArt,
    current: state.current,
    metrics24h: state.metrics24h,
    historyCount: Array.isArray(state.history) ? state.history.length : 0,
    history: Array.isArray(state.history) ? state.history.slice(-MAX_HISTORY_ITEMS) : [],
  };
  await env.MONITOR_KV.put(key, JSON.stringify(payload));
}

async function listSnapshots(env, limit = 30) {
  const listed = await env.MONITOR_KV.list({ prefix: SNAPSHOT_PREFIX, limit });
  const out = [];
  for (const k of listed.keys || []) {
    out.push({ key: k.name });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

async function loadFciPayload(env, key) {
  const raw = await env.MONITOR_KV.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function buildEmptyFciPayload(kind) {
  return {
    source: "argentinadatos",
    kind,
    fetchedAtIso: null,
    fetchedAtHumanArt: null,
    date: null,
    rowsCount: 0,
    data: [],
  };
}

function buildEmptyFciStatus() {
  return {
    source: "argentinadatos",
    ok: false,
    updatedAtIso: null,
    updatedAtHumanArt: null,
    lastDecision: "no_data",
    lastError: null,
    ultimoRows: 0,
    penultimoRows: 0,
    snapshotKey: null,
  };
}

function buildEmptyBenchmarkPayload(kind) {
  return {
    source: "argentinadatos",
    kind,
    fetchedAtIso: null,
    fetchedAtHumanArt: null,
    data: null,
  };
}

function buildEmptyBenchmarkStatus() {
  return {
    source: "argentinadatos",
    ok: false,
    updatedAtIso: null,
    updatedAtHumanArt: null,
    lastDecision: "no_data",
    lastError: null,
  };
}

function buildEmptyApiBundle() {
  return {
    timestamp: Date.now(),
    mepCcl: null,
    fciRentaFija: null,
    fciRentaFijaPenultimo: null,
    fciRentaFijaMesBase: null,
    fciRentaVariable: null,
    fciRentaVariablePenultimo: null,
    fciRentaVariableMesBase: null,
    benchmarkPlazoFijo: null,
    benchmarkInflacion: null,
  };
}

async function refreshApiBundle(env) {
  const [
    rawState,
    fciRentaFija,
    fciRentaFijaPenultimo,
    fciRentaFijaMesBase,
    fciRentaVariable,
    fciRentaVariablePenultimo,
    fciRentaVariableMesBase,
    benchmarkPlazoFijo,
    benchmarkInflacion,
  ] = await Promise.all([
    loadState(env),
    loadFciPayload(env, FCI_LAST_KEY),
    loadFciPayload(env, FCI_PREV_KEY),
    loadFciPayload(env, FCI_BASE30_KEY),
    loadFciPayload(env, FCI_RV_LAST_KEY),
    loadFciPayload(env, FCI_RV_PREV_KEY),
    loadFciPayload(env, FCI_RV_BASE30_KEY),
    loadFciPayload(env, PLAZO_FIJO_BENCH_KEY),
    loadFciPayload(env, INFLACION_BENCH_KEY),
  ]);

  const normalized = normalizeState(rawState);
  const mepCcl = normalized ? decorateOperationalState(normalized) : null;
  const payload = {
    timestamp: Date.now(),
    mepCcl,
    fciRentaFija,
    fciRentaFijaPenultimo,
    fciRentaFijaMesBase,
    fciRentaVariable,
    fciRentaVariablePenultimo,
    fciRentaVariableMesBase,
    benchmarkPlazoFijo,
    benchmarkInflacion,
  };
  await env.MONITOR_KV.put(API_BUNDLE_KEY, JSON.stringify(payload));
  return payload;
}

async function loadFciStatus(env, key = FCI_STATE_KEY) {
  const raw = await env.MONITOR_KV.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeFciPayload(kind, sourcePayload, now) {
  const rows = parseFciSeriesPayload(sourcePayload, "argentinadatos_fci");
  const firstDate = rows.find((row) => row && typeof row === "object" && row.fecha)?.fecha || null;
  return {
    source: "argentinadatos",
    kind,
    fetchedAtIso: now.toISOString(),
    fetchedAtHumanArt: formatArtDate(now),
    date: firstDate,
    rowsCount: rows.length,
    data: rows,
  };
}

async function fetchJsonSource(
  url,
  {
    provider = "argentinadatos",
    timeoutMs = 25000,
    requestId = null,
    route = "unknown",
    snapshotTimestamp = null,
  } = {},
) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; mep-ccl-monitor/1.0)",
        "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
      },
    });
    if (!response.ok) {
      throw new ProviderDataError({
        provider,
        errorType: "fetch",
        message: `Fuente ${provider} respondió ${response.status}`,
      });
    }
    const payload = await response.json();
    logStructured({
      requestId,
      route,
      provider,
      latencyMs: Date.now() - startedAt,
      outcome: "ok",
      errorType: null,
      snapshotTimestamp,
    });
    return payload;
  } catch (error) {
    const providerError = error instanceof ProviderDataError ? error : new ProviderDataError({
      provider,
      errorType: "fetch",
      message: sanitizeError(error),
      cause: error,
    });
    logStructured({
      requestId,
      route,
      provider,
      latencyMs: Date.now() - startedAt,
      outcome: "fail",
      errorType: providerError.errorType,
      snapshotTimestamp,
    });
    throw providerError;
  } finally {
    clearTimeout(timeoutId);
  }
}

function snapshotKeyDateArt(now) {
  const p = getArtParts(now);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function artDateStringFromDate(date) {
  const p = getArtParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function parseArtDateToUtc(dateStr) {
  if (typeof dateStr !== "string") return null;
  const m = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function previousMonthEndFromAnchor(anchorDateStr, fallbackNow) {
  const anchor = parseArtDateToUtc(anchorDateStr) || fallbackNow;
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  const prevMonthEnd = new Date(Date.UTC(y, m, 0));
  return artDateStringFromDate(prevMonthEnd);
}

async function saveFciDailySnapshot(env, snapshotPrefix, ultimoPayload, penultimoPayload, now) {
  const key = snapshotPrefix + snapshotKeyDateArt(now);
  const payload = {
    dateArt: key.replace(snapshotPrefix, ""),
    savedAtHumanArt: formatArtDate(now),
    ultimoDate: ultimoPayload?.date || null,
    penultimoDate: penultimoPayload?.date || null,
    ultimoRows: Number(ultimoPayload?.rowsCount || 0),
    penultimoRows: Number(penultimoPayload?.rowsCount || 0),
    ultimo: ultimoPayload?.data || [],
    penultimo: penultimoPayload?.data || [],
  };
  await env.MONITOR_KV.put(key, JSON.stringify(payload));
  return key;
}

function normalizePercentValue(value) {
  let n = Number(value);
  if (!Number.isFinite(n) && typeof value === "string") {
    const trimmed = value.trim().replace(/%/g, "").replace(/\s+/g, "");
    if (trimmed) {
      const lastComma = trimmed.lastIndexOf(",");
      const lastDot = trimmed.lastIndexOf(".");
      let normalized = trimmed;
      if (lastComma !== -1 && lastDot !== -1) {
        if (lastComma > lastDot) normalized = trimmed.replace(/\./g, "").replace(",", ".");
        else normalized = trimmed.replace(/,/g, "");
      } else if (lastComma !== -1) {
        normalized = trimmed.replace(",", ".");
      } else {
        normalized = trimmed;
      }
      n = Number(normalized);
    }
  }
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) <= 1.5) return n * 100;
  return n;
}

function computePlazoFijoBenchmark(sourcePayload, now) {
  const rows = parsePlazoFijoPayload(sourcePayload, "argentinadatos_plazo_fijo")
    .map((item) => {
      const banco = String(item?.entidad || item?.banco || item?.nombre || "").trim();
      const tnaClientesPct = normalizePercentValue(item?.tnaClientes);
      return { banco, tnaClientesPct };
    })
    .filter((row) => row.banco && row.tnaClientesPct !== null);
  const avgTnaPct = rows.length
    ? rows.reduce((acc, row) => acc + row.tnaClientesPct, 0) / rows.length
    : null;
  const monthlyPct = avgTnaPct !== null ? ((Math.pow(1 + avgTnaPct / 100, 30 / 365) - 1) * 100) : null;
  return {
    source: "argentinadatos",
    kind: "plazo_fijo",
    fetchedAtIso: now.toISOString(),
    fetchedAtHumanArt: formatArtDate(now),
    rowsCount: rows.length,
    data: {
      avgTnaPct: avgTnaPct !== null ? round2(avgTnaPct) : null,
      monthlyPct: monthlyPct !== null ? round2(monthlyPct) : null,
      topBanco: rows.length ? rows.slice().sort((a, b) => b.tnaClientesPct - a.tnaClientesPct)[0].banco : null,
      topTnaPct: rows.length ? round2(Math.max(...rows.map((x) => x.tnaClientesPct))) : null,
    },
  };
}

function computeInflacionBenchmark(sourcePayload, now) {
  const rows = parseInflacionPayload(sourcePayload, "argentinadatos_inflacion")
    .map((item) => {
      const fecha = String(item?.fecha || item?.date || "").trim();
      const valorPct = normalizePercentValue(item?.valor);
      return { fecha, valorPct };
    })
    .filter((row) => row.fecha && row.valorPct !== null);
  rows.sort((a, b) => a.fecha.localeCompare(b.fecha));
  const latest = rows.length ? rows[rows.length - 1] : null;
  return {
    source: "argentinadatos",
    kind: "inflacion",
    fetchedAtIso: now.toISOString(),
    fetchedAtHumanArt: formatArtDate(now),
    rowsCount: rows.length,
    data: latest
      ? {
          date: latest.fecha,
          monthlyPct: round2(latest.valorPct),
        }
      : {
          date: null,
          monthlyPct: null,
        },
  };
}

async function refreshBenchmarkData(env, context = {}) {
  const now = new Date();
  const [pfRes, infRes] = await Promise.allSettled([
    fetchJsonSource(PLAZO_FIJO_API_URL, { provider: "argentinadatos_plazo_fijo", ...context }),
    fetchJsonSource(INFLACION_API_URL, { provider: "argentinadatos_inflacion", ...context }),
  ]);

  let pfPayload = await loadFciPayload(env, PLAZO_FIJO_BENCH_KEY);
  let infPayload = await loadFciPayload(env, INFLACION_BENCH_KEY);
  let lastError = null;
  let okCount = 0;

  if (pfRes.status === "fulfilled") {
    try {
      pfPayload = computePlazoFijoBenchmark(pfRes.value, now);
      await env.MONITOR_KV.put(PLAZO_FIJO_BENCH_KEY, JSON.stringify(pfPayload));
      okCount += 1;
    } catch (error) {
      lastError = sanitizeError(error);
    }
  } else {
    lastError = sanitizeError(pfRes.reason);
  }

  if (infRes.status === "fulfilled") {
    try {
      infPayload = computeInflacionBenchmark(infRes.value, now);
      await env.MONITOR_KV.put(INFLACION_BENCH_KEY, JSON.stringify(infPayload));
      okCount += 1;
    } catch (error) {
      lastError = sanitizeError(error);
    }
  } else {
    lastError = sanitizeError(infRes.reason);
  }

  const status = {
    source: "argentinadatos",
    ok: okCount === 2,
    updatedAtIso: now.toISOString(),
    updatedAtHumanArt: formatArtDate(now),
    lastDecision: okCount === 2 ? "updated" : okCount > 0 ? "partial_update" : "error",
    lastError: lastError || null,
    plazoFijoMonthlyPct: pfPayload?.data?.monthlyPct ?? null,
    inflacionMonthlyPct: infPayload?.data?.monthlyPct ?? null,
  };
  await env.MONITOR_KV.put(BENCHMARK_STATE_KEY, JSON.stringify(status));
  return { plazoFijo: pfPayload, inflacion: infPayload, status };
}

async function refreshFciSeriesData(env, config, context = {}) {
  const now = new Date();
  const urls = {
    ultimo: `${config.apiBase}/ultimo`,
    penultimo: `${config.apiBase}/penultimo`,
  };

  let ultimoPayload = null;
  let penultimoPayload = null;
  let errorCount = 0;
  let lastError = null;

  const [ultimoRes, penultimoRes] = await Promise.allSettled([
    fetchJsonSource(urls.ultimo, { provider: `${config.stateKey}_ultimo`, ...context }),
    fetchJsonSource(urls.penultimo, { provider: `${config.stateKey}_penultimo`, ...context }),
  ]);

  if (ultimoRes.status === "fulfilled") {
    try {
      ultimoPayload = normalizeFciPayload("ultimo", ultimoRes.value, now);
      await env.MONITOR_KV.put(config.lastKey, JSON.stringify(ultimoPayload));
    } catch (error) {
      errorCount += 1;
      lastError = sanitizeError(error);
    }
  } else {
    errorCount += 1;
    lastError = sanitizeError(ultimoRes.reason);
  }

  if (penultimoRes.status === "fulfilled") {
    try {
      penultimoPayload = normalizeFciPayload("penultimo", penultimoRes.value, now);
      await env.MONITOR_KV.put(config.prevKey, JSON.stringify(penultimoPayload));
    } catch (error) {
      errorCount += 1;
      lastError = sanitizeError(error);
    }
  } else {
    errorCount += 1;
    lastError = sanitizeError(penultimoRes.reason);
  }

  const anchorDate = ultimoPayload?.date || penultimoPayload?.date || artDateStringFromDate(now);
  const baseTargetStr = previousMonthEndFromAnchor(anchorDate, now);
  const baseTargetDate = parseArtDateToUtc(baseTargetStr) || now;
  const baseCandidates = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(baseTargetDate.getTime() - i * 24 * 60 * 60 * 1000);
    return artDateStringFromDate(d);
  });

  let base30Payload = null;
  let baseDateUsed = null;
  for (const candidate of baseCandidates) {
    try {
      const data = await fetchJsonSource(`${config.apiBase}/${candidate}`, {
        provider: `${config.stateKey}_base30`,
        ...context,
      });
      base30Payload = normalizeFciPayload("base30", data, now);
      base30Payload.baseDate = candidate;
      base30Payload.baseTargetDate = baseTargetStr;
      baseDateUsed = candidate;
      await env.MONITOR_KV.put(config.base30Key, JSON.stringify(base30Payload));
      break;
    } catch (error) {
      lastError = sanitizeError(error);
    }
  }

  if (!ultimoPayload) ultimoPayload = await loadFciPayload(env, config.lastKey);
  if (!penultimoPayload) penultimoPayload = await loadFciPayload(env, config.prevKey);
  if (!base30Payload) base30Payload = await loadFciPayload(env, config.base30Key);
  if (!baseDateUsed) baseDateUsed = base30Payload?.baseDate || null;

  const status = {
    source: "argentinadatos",
    ok: Boolean(ultimoPayload && penultimoPayload),
    updatedAtIso: now.toISOString(),
    updatedAtHumanArt: formatArtDate(now),
    lastDecision: errorCount === 0 ? "updated" : (ultimoPayload || penultimoPayload) ? "partial_update" : "error",
    lastError: lastError || null,
    ultimoRows: Number(ultimoPayload?.rowsCount || 0),
    penultimoRows: Number(penultimoPayload?.rowsCount || 0),
    baseDate: baseDateUsed,
    baseTargetDate: baseTargetStr,
    baseRows: Number(base30Payload?.rowsCount || 0),
    snapshotKey: null,
  };

  if (ultimoPayload || penultimoPayload) {
    status.snapshotKey = await saveFciDailySnapshot(env, config.snapshotPrefix, ultimoPayload, penultimoPayload, now);
  }
  await env.MONITOR_KV.put(config.stateKey, JSON.stringify(status));
  return { ultimo: ultimoPayload, penultimo: penultimoPayload, base30: base30Payload, status };
}

async function refreshFciRentaFijaData(env, context = {}) {
  return refreshFciSeriesData(env, {
    apiBase: FCI_RF_API_BASE,
    lastKey: FCI_LAST_KEY,
    prevKey: FCI_PREV_KEY,
    base30Key: FCI_BASE30_KEY,
    stateKey: FCI_STATE_KEY,
    snapshotPrefix: FCI_SNAPSHOT_PREFIX,
  }, context);
}

async function refreshFciRentaVariableData(env, context = {}) {
  return refreshFciSeriesData(env, {
    apiBase: FCI_RV_API_BASE,
    lastKey: FCI_RV_LAST_KEY,
    prevKey: FCI_RV_PREV_KEY,
    base30Key: FCI_RV_BASE30_KEY,
    stateKey: FCI_RV_STATE_KEY,
    snapshotPrefix: FCI_RV_SNAPSHOT_PREFIX,
  }, context);
}

function buildRecoveryCheck(history, snapshots) {
  const entries = Array.isArray(history) ? history : [];
  const epochs = entries.map((x) => Number(x.epoch)).filter((x) => Number.isFinite(x));
  const oldestEpoch = epochs.length ? Math.min(...epochs) : null;
  const newestEpoch = epochs.length ? Math.max(...epochs) : null;
  const oldestIso = oldestEpoch ? new Date(oldestEpoch * 1000).toISOString() : null;
  const newestIso = newestEpoch ? new Date(newestEpoch * 1000).toISOString() : null;
  const oldestArt = oldestEpoch ? formatArtDate(new Date(oldestEpoch * 1000)) : null;
  const newestArt = newestEpoch ? formatArtDate(new Date(newestEpoch * 1000)) : null;
  const uxEpoch = Math.floor(new Date(`${UX_REDESIGN_DATE}T00:00:00Z`).getTime() / 1000);
  const hasHistoryBeforeUx = Boolean(oldestEpoch && oldestEpoch < uxEpoch);
  const hasSnapshotsBeforeUx = snapshots.some((s) => {
    const d = String(s.key || "").replace(SNAPSHOT_PREFIX, "");
    return d && d < UX_REDESIGN_DATE;
  });
  return {
    uxRedesignDate: UX_REDESIGN_DATE,
    historyCount: entries.length,
    oldestHistoryIso: oldestIso,
    oldestHistoryArt: oldestArt,
    newestHistoryIso: newestIso,
    newestHistoryArt: newestArt,
    snapshotCount: snapshots.length,
    firstSnapshotKey: snapshots[0]?.key || null,
    lastSnapshotKey: snapshots[snapshots.length - 1]?.key || null,
    hasHistoryBeforeUx,
    hasSnapshotsBeforeUx,
    recoverablePreUx: hasHistoryBeforeUx || hasSnapshotsBeforeUx,
  };
}

function normalizeState(state) {
  if (!state || typeof state !== "object") return null;
  const base = buildEmptyState(new Date());
  const merged = {
    ...base,
    ...state,
    status: { ...base.status, ...(state.status || {}) },
    sourceStatus: { ...base.sourceStatus, ...(state.sourceStatus || {}) },
    metrics24h: { ...base.metrics24h, ...(state.metrics24h || {}) },
    operational: { ...base.operational, ...(state.operational || {}) },
    alerting: { ...base.alerting, ...(state.alerting || {}) },
  };
  if (!Array.isArray(merged.history)) merged.history = [];
  if (merged.current === undefined) merged.current = null;
  return merged;
}

function isUsableState(state) {
  return Boolean(
    state &&
      typeof state.updatedAtHumanArt === "string" &&
      state.status &&
      typeof state.status.text === "string" &&
      state.sourceStatus &&
      typeof state.sourceStatus.text === "string" &&
      Array.isArray(state.history),
  );
}

function buildEmptyState(now) {
  const nowEpoch = Math.floor(now.getTime() / 1000);
  return {
    version: 0,
    updatedAtEpoch: nowEpoch,
    updatedAtIso: now.toISOString(),
    updatedAtHumanArt: formatArtDate(now),
    sourceUrl: SOURCE_URL,
    thresholds: THRESHOLDS,
    market: getMarketStatus(now),
    status: deriveStatus(false, false),
    sourceStatus: {
      ok: false,
      text: "SIN DATOS",
      error: null,
      freshLabel: "N/D",
      freshWarn: false,
      sourceAgeMinutes: null,
      latestSourceTsMs: null,
      stalenessSeconds: null,
    },
    current: null,
    metrics24h: {
      count: 0,
      similarCount: 0,
      minPct: null,
      maxPct: null,
      avgPct: null,
    },
    operational: {
      lastSuccessAtHumanArt: null,
      lastSuccessAtIso: null,
      dataConfidence: "NO_DATA",
      stalenessSeconds: null,
      nextRunAtHumanArt: formatArtDate(computeNextScheduledRun(new Date(now.getTime() + 60 * 1000))),
    },
    alerting: {
      enabled: false,
      lastRunAtHumanArt: null,
      lastDecision: "disabled",
      cooldownMinutes: DEFAULT_ALERT_COOLDOWN_MINUTES,
      lastEmailAtEpoch: null,
      lastEmailAtHumanArt: null,
      lastEmailStatus: null,
      lastEmailError: null,
      lastFingerprint: null,
    },
    history: [],
    lastError: null,
    lastErrorAtIso: null,
  };
}

function decorateOperationalState(state) {
  const now = new Date();
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const freshness = computeFreshness(state?.current?.mepTsMs, state?.current?.cclTsMs, nowEpoch);
  const hasValidSnapshot = Boolean(state?.current);
  return {
    ...state,
    sourceStatus: {
      ...(state.sourceStatus || {}),
      freshLabel: freshness.label,
      freshWarn: freshness.warn,
      sourceAgeMinutes: freshness.ageMinutes,
      latestSourceTsMs: freshness.latestTsMs,
      stalenessSeconds: freshness.stalenessSeconds,
    },
    operational: {
      ...(state.operational || {}),
      dataConfidence: deriveDataConfidence(hasValidSnapshot, freshness.stalenessSeconds),
      stalenessSeconds: freshness.stalenessSeconds,
      nextRunAtHumanArt: formatArtDate(computeNextScheduledRun(new Date(now.getTime() + 60 * 1000))),
    },
  };
}

function isAlertsEnabled(env) {
  return String(env.EMAIL_ALERTS_ENABLED || "false").toLowerCase() === "true";
}

function alertCooldownMinutes(env) {
  const parsed = Number(env.ALERT_COOLDOWN_MINUTES || DEFAULT_ALERT_COOLDOWN_MINUTES);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ALERT_COOLDOWN_MINUTES;
  return Math.floor(parsed);
}

function toAlertingStatus(now, previousAlerting = {}) {
  return {
    ...previousAlerting,
    enabled: true,
    lastRunAtHumanArt: formatArtDate(now),
    cooldownMinutes: previousAlerting.cooldownMinutes || DEFAULT_ALERT_COOLDOWN_MINUTES,
  };
}

async function maybeSendSimilarEmailAlert(env, previousState, nextState, now, nowEpoch) {
  const prevAlerting = previousState.alerting || {};
  const enabled = isAlertsEnabled(env);
  if (!enabled) {
    return {
      ...prevAlerting,
      enabled: false,
      lastRunAtHumanArt: formatArtDate(now),
      lastDecision: "disabled",
    };
  }

  const status = toAlertingStatus(now, prevAlerting);
  const cooldownMinutes = alertCooldownMinutes(env);
  status.cooldownMinutes = cooldownMinutes;

  const toEmail = String(env.ALERT_TO_EMAIL || "").trim();
  const fromEmail = String(env.ALERT_FROM_EMAIL || "").trim();
  const resendKey = String(env.RESEND_API_KEY || "").trim();
  const dashboardUrl = String(env.WORKER_PUBLIC_URL || "").trim() || "https://monitor-mep-ccl.agustin-esteban-porto.workers.dev";
  if (!toEmail || !fromEmail || !resendKey) {
    return {
      ...status,
      lastDecision: "skip_missing_config",
      lastEmailStatus: "missing_config",
    };
  }

  if (!nextState.current || !nextState.sourceStatus?.ok) {
    return {
      ...status,
      lastDecision: "skip_no_data",
    };
  }
  if (!nextState.current.similar) {
    return {
      ...status,
      lastDecision: "skip_not_similar",
    };
  }

  const fingerprint = `${nextState.current.mep}|${nextState.current.ccl}|${nextState.current.absDiff}|${nextState.current.pctDiff}`;
  const lastEmailAtEpoch = Number(prevAlerting.lastEmailAtEpoch || 0);
  const inCooldown = lastEmailAtEpoch > 0 && (nowEpoch - lastEmailAtEpoch) < cooldownMinutes * 60;
  if (inCooldown) {
    return {
      ...status,
      lastDecision: "skip_cooldown",
      lastFingerprint: prevAlerting.lastFingerprint || null,
    };
  }

  const subject = `Radar MEP/CCL: SIMILAR (${nextState.current.absDiff.toFixed(2)} ARS)`;
  const html = [
    "<h2>Alerta MEP/CCL</h2>",
    "<p>Se detectó estado <strong>SIMILAR</strong>.</p>",
    "<ul>",
    `<li>MEP: $${nextState.current.mep.toFixed(2)}</li>`,
    `<li>CCL: $${nextState.current.ccl.toFixed(2)}</li>`,
    `<li>Diferencia: $${nextState.current.absDiff.toFixed(2)} (${nextState.current.pctDiff.toFixed(2)}%)</li>`,
    `<li>Chequeado: ${nextState.updatedAtHumanArt}</li>`,
    "</ul>",
    `<p>Dashboard: <a href="${dashboardUrl}/">abrir</a></p>`,
  ].join("");

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject,
        html,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      return {
        ...status,
        lastDecision: "error_send",
        lastEmailStatus: `http_${response.status}`,
        lastEmailError: sanitizeError(body),
      };
    }

    return {
      ...status,
      lastDecision: "sent",
      lastEmailAtEpoch: nowEpoch,
      lastEmailAtHumanArt: formatArtDate(now),
      lastEmailStatus: "sent",
      lastEmailError: null,
      lastFingerprint: fingerprint,
    };
  } catch (error) {
    return {
      ...status,
      lastDecision: "error_send",
      lastEmailStatus: "network_error",
      lastEmailError: sanitizeError(error),
    };
  }
}

async function fetchSourceHtml(url, context = {}) {
  const startedAt = Date.now();
  const provider = context.provider || "dolarito_html";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; mep-ccl-monitor/1.0)",
        "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
      },
    });
    if (!response.ok) {
      throw new ProviderDataError({
        provider,
        errorType: "fetch",
        message: `Fuente ${provider} respondió ${response.status}`,
      });
    }
    const html = await response.text();
    logStructured({
      requestId: context.requestId || null,
      route: context.route || "unknown",
      provider,
      latencyMs: Date.now() - startedAt,
      outcome: "ok",
      errorType: null,
      snapshotTimestamp: context.snapshotTimestamp || null,
    });
    return html;
  } catch (error) {
    const providerError = error instanceof ProviderDataError ? error : new ProviderDataError({
      provider,
      errorType: "fetch",
      message: sanitizeError(error),
      cause: error,
    });
    logStructured({
      requestId: context.requestId || null,
      route: context.route || "unknown",
      provider,
      latencyMs: Date.now() - startedAt,
      outcome: "fail",
      errorType: providerError.errorType,
      snapshotTimestamp: context.snapshotTimestamp || null,
    });
    throw providerError;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getMarketStatus(date) {
  const isOpen = isMarketOpen(date, ART_TZ, "10:30", "18:00", true);
  return {
    status: isOpen ? "ABIERTO" : "CERRADO",
    isOpen,
    windowLabel: "Lun-Vie 10:30-17:59 GMT-3 (Buenos Aires)",
  };
}

function computeFreshness(mepTsMs, cclTsMs, nowEpoch) {
  const candidates = [mepTsMs, cclTsMs].filter((v) => Number.isFinite(v));
  const now = new Date(nowEpoch * 1000);
  if (!candidates.length) {
    return { label: "N/D", warn: false, ageMinutes: null, latestTsMs: null, stalenessSeconds: null };
  }

  const latestTsMs = Math.max(...candidates);
  const stalenessSeconds = calcStalenessSeconds(now, new Date(latestTsMs));
  const ageMinutes = Number.isFinite(stalenessSeconds) ? Math.max(0, Math.floor(stalenessSeconds / 60)) : null;
  const label = ageMinutes === null ? "N/D" : ageMinutes < 60 ? `${ageMinutes} min` : `${(ageMinutes / 60).toFixed(1)} h`;
  return {
    label,
    warn: ageMinutes > 60,
    ageMinutes,
    latestTsMs,
    stalenessSeconds,
  };
}

function deriveDataConfidence(hasValidSnapshot, stalenessSeconds) {
  if (!hasValidSnapshot) return "NO_DATA";
  if (!Number.isFinite(stalenessSeconds)) return "DELAYED";
  if (stalenessSeconds <= 10 * 60) return "OK";
  return "DELAYED";
}

function computeMetrics24h(history, nowEpoch) {
  const cutoff = nowEpoch - 86400;
  const rows = history.filter((item) => Number(item.epoch) >= cutoff);
  if (!rows.length) {
    return { count: 0, similarCount: 0, minPct: null, maxPct: null, avgPct: null };
  }

  const pctValues = rows
    .map((r) => Number(r.spread_pct_percent ?? r.pct_diff))
    .filter((v) => Number.isFinite(v));
  const similarCount = rows.filter((r) => Boolean(r.similar)).length;
  const sum = pctValues.reduce((acc, v) => acc + v, 0);

  return {
    count: rows.length,
    similarCount,
    minPct: pctValues.length ? round2(Math.min(...pctValues)) : null,
    maxPct: pctValues.length ? round2(Math.max(...pctValues)) : null,
    avgPct: pctValues.length ? round2(sum / pctValues.length) : null,
  };
}

function computeNextScheduledRun(fromDate) {
  let cursor = new Date(fromDate.getTime());
  cursor.setUTCSeconds(0, 0);

  for (let i = 0; i < 60 * 24 * 8; i++) {
    if (isScheduledUtcTick(cursor)) {
      return cursor;
    }
    cursor = new Date(cursor.getTime() + 60 * 1000);
  }
  return cursor;
}

function isScheduledUtcTick(date) {
  const day = date.getUTCDay(); // 0=Sun ... 6=Sat
  if (day === 0 || day === 6) return false;

  const h = date.getUTCHours();
  const m = date.getUTCMinutes();
  if (h === 13) return m >= 30 && m <= 59 && m % 5 === 0;
  if (h >= 14 && h <= 20) return m % 5 === 0;
  return false;
}

function deriveStatus(sourceOk, similar) {
  if (!sourceOk) {
    return { text: "SIN DATOS", color: "#7c3f00" };
  }
  if (similar) {
    return { text: "SIMILARES", color: "#0f7a36" };
  }
  return { text: "NO SIMILAR", color: "#a61b1b" };
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function formatSourceTs(tsMs) {
  if (!Number.isFinite(tsMs)) return "s/dato";
  return formatArtDate(new Date(tsMs));
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatArtDate(date) {
  const p = getArtParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)} ${ART_LABEL}`;
}

function getArtParts(date) {
  const out = {};
  for (const part of ART_FORMATTER.formatToParts(date)) {
    if (part.type !== "literal") out[part.type] = part.value;
  }

  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: weekdayToNum(out.weekday),
  };
}

function weekdayToNum(shortName) {
  const map = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  return map[shortName] || 0;
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 180);
}

function jsonResponse(data, cache = false) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cache ? "public, max-age=30" : "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self' https://dolarito.ar https://argentinadatos.com https://api.argentinadatos.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

const DASHBOARD_HTML_B64 = `PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVzIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+UmFkYXIgTUVQL0NDTCDCtyBNZXJjYWRvIEFSRzwvdGl0bGU+CjxsaW5rIHJlbD0icHJlY29ubmVjdCIgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbSI+CjxsaW5rIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20vY3NzMj9mYW1pbHk9U3BhY2UrTW9ubzp3Z2h0QDQwMDs3MDAmZmFtaWx5PVN5bmU6d2dodEA0MDA7NjAwOzcwMDs4MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c3R5bGU+Ci8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBUT0tFTlMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCjpyb290IHsKICAtLWJnOiAgICAgICAjMDgwYjBlOwogIC0tc3VyZjogICAgICMwZjEzMTg7CiAgLS1zdXJmMjogICAgIzE2MWIyMjsKICAtLXN1cmYzOiAgICAjMWMyMzMwOwogIC0tYm9yZGVyOiAgICMxZTI1MzA7CiAgLS1ib3JkZXJCOiAgIzJhMzQ0NDsKCiAgLS1ncmVlbjogICAgIzAwZTY3NjsKICAtLWdyZWVuLWQ6ICByZ2JhKDAsMjMwLDExOCwuMDkpOwogIC0tZ3JlZW4tZzogIHJnYmEoMCwyMzAsMTE4LC4yMik7CiAgLS1yZWQ6ICAgICAgI2ZmNDc1NzsKICAtLXJlZC1kOiAgICByZ2JhKDI1NSw3MSw4NywuMDkpOwogIC0teWVsbG93OiAgICNmZmMgYzAwOwogIC0teWVsbG93OiAgICNmZmNjMDA7CiAgLS15ZWxsb3ctZDogcmdiYSgyNTUsMjA0LDAsLjA5KTsKCiAgLS1tZXA6ICAgICAgIzI5YjZmNjsKICAtLWNjbDogICAgICAjYjM5ZGRiOwogIC0tdGV4dDogICAgICNkZGU0ZWU7CiAgLS1tdXRlZDogICAgIzU1NjA3MDsKICAtLW11dGVkMjogICAjN2E4ZmE4OwoKICAtLW1vbm86ICdTcGFjZSBNb25vJywgbW9ub3NwYWNlOwogIC0tc2FuczogJ1N5bmUnLCBzYW5zLXNlcmlmOwoKICAtLWRyYXdlci13OiA0MDBweDsKICAtLWhlYWRlci1oOiA1NHB4Owp9CgoqLCAqOjpiZWZvcmUsICo6OmFmdGVyIHsgYm94LXNpemluZzogYm9yZGVyLWJveDsgbWFyZ2luOiAwOyBwYWRkaW5nOiAwOyB9CgpodG1sIHsgc2Nyb2xsLWJlaGF2aW9yOiBzbW9vdGg7IH0KCmJvZHkgewogIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgZm9udC1mYW1pbHk6IHZhcigtLW1vbm8pOwogIG1pbi1oZWlnaHQ6IDEwMHZoOwogIG92ZXJmbG93LXg6IGhpZGRlbjsKfQoKYm9keTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogZml4ZWQ7IGluc2V0OiAwOwogIGJhY2tncm91bmQtaW1hZ2U6CiAgICBsaW5lYXItZ3JhZGllbnQocmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KSwKICAgIGxpbmVhci1ncmFkaWVudCg5MGRlZywgcmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KTsKICBiYWNrZ3JvdW5kLXNpemU6IDQ0cHggNDRweDsKICBwb2ludGVyLWV2ZW50czogbm9uZTsgei1pbmRleDogMDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIExBWU9VVCBTSEVMTArilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmFwcCB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBtaW4taGVpZ2h0OiAxMDB2aDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEhFQURFUgrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KaGVhZGVyIHsKICBwb3NpdGlvbjogc3RpY2t5OyB0b3A6IDA7IHotaW5kZXg6IDIwMDsKICBoZWlnaHQ6IHZhcigtLWhlYWRlci1oKTsKICBiYWNrZ3JvdW5kOiByZ2JhKDgsMTEsMTQsLjkzKTsKICBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMThweCk7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogMCAyMnB4OwogIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKfQoKLmxvZ28gewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6IDgwMDsgZm9udC1zaXplOiAxNXB4OwogIGxldHRlci1zcGFjaW5nOiAuMDVlbTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA5cHg7Cn0KCi5saXZlLWRvdCB7CiAgd2lkdGg6IDdweDsgaGVpZ2h0OiA3cHg7IGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbik7CiAgYm94LXNoYWRvdzogMCAwIDhweCB2YXIoLS1ncmVlbik7CiAgYW5pbWF0aW9uOiBibGluayAyLjJzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9CkBrZXlmcmFtZXMgYmxpbmsgewogIDAlLDEwMCV7b3BhY2l0eToxO2JveC1zaGFkb3c6MCAwIDhweCB2YXIoLS1ncmVlbik7fQogIDUwJXtvcGFjaXR5Oi4zNTtib3gtc2hhZG93OjAgMCAzcHggdmFyKC0tZ3JlZW4pO30KfQoKLmhlYWRlci1yaWdodCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTJweDsgfQoKLmZyZXNoLWJhZGdlIHsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDVweDsKICBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAyMHB4OyBwYWRkaW5nOiAzcHggMTFweDsKfQouZnJlc2gtZG90IHsgd2lkdGg6NXB4O2hlaWdodDo1cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDp2YXIoLS1ncmVlbik7YW5pbWF0aW9uOmJsaW5rIDIuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmZldGNoaW5nIHsgYW5pbWF0aW9uOiBiYWRnZVB1bHNlIDEuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmVycm9yIHsgY29sb3I6I2ZmZDBkMDsgYm9yZGVyLWNvbG9yOnJnYmEoMjU1LDgyLDgyLC40NSk7IGJhY2tncm91bmQ6cmdiYSgyNTUsODIsODIsLjEyKTsgY3Vyc29yOnBvaW50ZXI7IH0KQGtleWZyYW1lcyBiYWRnZVB1bHNlIHsKICAwJSwxMDAlIHsgb3BhY2l0eToxOyB9CiAgNTAlIHsgb3BhY2l0eTouNjU7IH0KfQoKLnRhZy1tZXJjYWRvIHsKICBmb250LWZhbWlseTogdmFyKC0tc2Fucyk7IGZvbnQtc2l6ZToxMHB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsKICBwYWRkaW5nOjNweCA5cHg7IGJvcmRlci1yYWRpdXM6NHB4Owp9Ci50YWctbWVyY2Fkby5jbG9zZWQgeyBiYWNrZ3JvdW5kOnZhcigtLW11dGVkKTsgY29sb3I6IzBhMGMwZjsgfQoKLmJ0biB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOyBmb250LXNpemU6MTFweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4wN2VtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgYm9yZGVyLXJhZGl1czo2cHg7IHBhZGRpbmc6NnB4IDE0cHg7IGN1cnNvcjpwb2ludGVyOwogIGJvcmRlcjpub25lOyB0cmFuc2l0aW9uOiBhbGwgLjE4czsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo2cHg7Cn0KLmJ0bi1hbGVydCB7IGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4pOyBjb2xvcjojMDAwOyB9Ci5idG4tYWxlcnQ6aG92ZXIgeyBiYWNrZ3JvdW5kOiMwMGZmODg7IHRyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpOyB9CgouYnRuLXRhc2FzIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMik7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6IHZhcigtLXRleHQpOwp9Ci5idG4tdGFzYXM6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMyk7IGJvcmRlci1jb2xvcjogdmFyKC0tbXV0ZWQyKTsgfQouYnRuLXRhc2FzLmFjdGl2ZSB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZjMpOwogIGJvcmRlci1jb2xvcjogdmFyKC0teWVsbG93KTsKICBjb2xvcjogdmFyKC0teWVsbG93KTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIE1BSU4gKyBEUkFXRVIgTEFZT1VUCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouYm9keS13cmFwIHsKICBmbGV4OiAxOwogIGRpc3BsYXk6IGZsZXg7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIHotaW5kZXg6IDE7CiAgdHJhbnNpdGlvbjogbm9uZTsKfQoKLm1haW4tY29udGVudCB7CiAgZmxleDogMTsKICBtYXgtd2lkdGg6IDEwMCU7CiAgcGFkZGluZzogMjJweCAyMnB4IDYwcHg7CiAgdHJhbnNpdGlvbjogbWFyZ2luLXJpZ2h0IC4zNXMgY3ViaWMtYmV6aWVyKC40LDAsLjIsMSk7Cn0KCi5ib2R5LXdyYXAuZHJhd2VyLW9wZW4gLm1haW4tY29udGVudCB7CiAgbWFyZ2luLXJpZ2h0OiB2YXIoLS1kcmF3ZXItdyk7Cn0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBEUkFXRVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5kcmF3ZXIgewogIHBvc2l0aW9uOiBmaXhlZDsKICB0b3A6IHZhcigtLWhlYWRlci1oKTsKICByaWdodDogMDsKICB3aWR0aDogdmFyKC0tZHJhd2VyLXcpOwogIGhlaWdodDogY2FsYygxMDB2aCAtIHZhcigtLWhlYWRlci1oKSk7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZik7CiAgYm9yZGVyLWxlZnQ6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHRyYW5zZm9ybTogdHJhbnNsYXRlWCgxMDAlKTsKICB0cmFuc2l0aW9uOiB0cmFuc2Zvcm0gLjM1cyBjdWJpYy1iZXppZXIoLjQsMCwuMiwxKTsKICBvdmVyZmxvdy15OiBhdXRvOwogIHotaW5kZXg6IDE1MDsKICBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwp9CgouZHJhd2VyLm9wZW4geyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMCk7IH0KCi5kcmF3ZXItcmVzaXplciB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IC00cHg7CiAgdG9wOiAwOwogIHdpZHRoOiA4cHg7CiAgaGVpZ2h0OiAxMDAlOwogIGN1cnNvcjogY29sLXJlc2l6ZTsKICB6LWluZGV4OiAxODA7Cn0KLmRyYXdlci1yZXNpemVyOjpiZWZvcmUgewogIGNvbnRlbnQ6ICcnOwogIHBvc2l0aW9uOiBhYnNvbHV0ZTsKICBsZWZ0OiAzcHg7CiAgdG9wOiAwOwogIHdpZHRoOiAycHg7CiAgaGVpZ2h0OiAxMDAlOwogIGJhY2tncm91bmQ6IHRyYW5zcGFyZW50OwogIHRyYW5zaXRpb246IGJhY2tncm91bmQgLjE1czsKfQouZHJhd2VyLXJlc2l6ZXI6aG92ZXI6OmJlZm9yZSwKLmRyYXdlci1yZXNpemVyLmFjdGl2ZTo6YmVmb3JlIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1tdXRlZDIpOwp9CgouZHJhd2VyLWhlYWRlciB7CiAgcG9zaXRpb246IHN0aWNreTsgdG9wOiAwOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYpOwogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHBhZGRpbmc6IDE2cHggMjBweDsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgei1pbmRleDogMTA7Cn0KCi5kcmF3ZXItdGl0bGUgewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6IDgwMDsgZm9udC1zaXplOiAxM3B4OwogIGxldHRlci1zcGFjaW5nOi4wNGVtOyBjb2xvcjogdmFyKC0tdGV4dCk7CiAgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6OHB4Owp9CgouZHJhd2VyLXNvdXJjZSB7CiAgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgZm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7Cn0KCi5idG4tY2xvc2UgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgY29sb3I6dmFyKC0tbXV0ZWQyKTsgYm9yZGVyLXJhZGl1czo2cHg7IHBhZGRpbmc6NXB4IDEwcHg7CiAgY3Vyc29yOnBvaW50ZXI7IGZvbnQtc2l6ZToxM3B4OyB0cmFuc2l0aW9uOiBhbGwgLjE1czsKfQouYnRuLWNsb3NlOmhvdmVyIHsgY29sb3I6dmFyKC0tdGV4dCk7IGJvcmRlci1jb2xvcjp2YXIoLS1tdXRlZDIpOyB9CgouZHJhd2VyLWJvZHkgeyBwYWRkaW5nOiAxNnB4IDIwcHg7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogMjJweDsgfQoKLmNvbnRleHQtYm94IHsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyMDQsMCwuMDYpOwogIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjU1LDIwNCwwLC4yKTsKICBib3JkZXItcmFkaXVzOiA5cHg7CiAgcGFkZGluZzogMTNweCAxNXB4OwogIGZvbnQtc2l6ZTogMTFweDsKICBsaW5lLWhlaWdodDoxLjY1OwogIGNvbG9yOnZhcigtLW11dGVkMik7Cn0KLmNvbnRleHQtYm94IHN0cm9uZyB7IGNvbG9yOnZhcigtLXllbGxvdyk7IH0KCi5mY2ktaGVhZGVyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBiYXNlbGluZTsKICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgZ2FwOiAxMHB4Owp9Ci5mY2ktdGl0bGUgewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsKICBmb250LXNpemU6IDEycHg7CiAgZm9udC13ZWlnaHQ6IDcwMDsKICBsZXR0ZXItc3BhY2luZzogLjA1ZW07CiAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsKICBjb2xvcjogdmFyKC0tdGV4dCk7Cn0KLmZjaS10aXRsZS13cmFwIHsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgZ2FwOiA4cHg7Cn0KLmZjaS10YWJzIHsKICBkaXNwbGF5OiBmbGV4OwogIGdhcDogOHB4OwogIGZsZXgtd3JhcDogd3JhcDsKfQouZmNpLXRhYi1idG4gewogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsKICBjb2xvcjogdmFyKC0tbXV0ZWQyKTsKICBib3JkZXItcmFkaXVzOiA5OTlweDsKICBmb250LXNpemU6IDEwcHg7CiAgZm9udC13ZWlnaHQ6IDcwMDsKICBsZXR0ZXItc3BhY2luZzogLjA1ZW07CiAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsKICBwYWRkaW5nOiA0cHggMTBweDsKICBjdXJzb3I6IHBvaW50ZXI7Cn0KLmZjaS10YWItYnRuLmFjdGl2ZSB7CiAgY29sb3I6IHZhcigtLXllbGxvdyk7CiAgYm9yZGVyLWNvbG9yOiB2YXIoLS15ZWxsb3cpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LCAyMDQsIDAsIC4wOCk7Cn0KLmZjaS1tZXRhIHsKICBmb250LXNpemU6IDEwcHg7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKfQouZmNpLXRhYmxlLXdyYXAgewogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czogMTBweDsKICBvdmVyZmxvdzogYXV0bzsKfQouZmNpLXRhYmxlIHsKICB3aWR0aDogMTAwJTsKICBtaW4td2lkdGg6IDk4MHB4OwogIGJvcmRlci1jb2xsYXBzZTogY29sbGFwc2U7CiAgdGFibGUtbGF5b3V0OiBmaXhlZDsKfQouZmNpLXRhYmxlIHRoZWFkIHRoIHsKICBwb3NpdGlvbjogc3RpY2t5OwogIHRvcDogMDsKICB6LWluZGV4OiA1OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsKICBjb2xvcjogdmFyKC0tbXV0ZWQyKTsKICBmb250LXNpemU6IDEwcHg7CiAgbGV0dGVyLXNwYWNpbmc6IC4wOGVtOwogIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7CiAgdGV4dC1hbGlnbjogbGVmdDsKICBwYWRkaW5nOiA5cHggMTBweDsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouZmNpLXRhYmxlIHRoZWFkIHRoOmhvdmVyIHsKICB6LWluZGV4OiA4MDsKfQouZmNpLXRhYmxlIHRib2R5IHRyIHsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouZmNpLXRhYmxlIHRib2R5IHRyOmxhc3QtY2hpbGQgewogIGJvcmRlci1ib3R0b206IG5vbmU7Cn0KLmZjaS10YWJsZSB0ZCB7CiAgZm9udC1zaXplOiAxMXB4OwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBwYWRkaW5nOiA5cHggMTBweDsKICBvdmVyZmxvdzogaGlkZGVuOwogIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7Cn0KLmZjaS10YWJsZSB0ZC5mY2ktc2lnbmFsLWNlbGwgewogIHdoaXRlLXNwYWNlOiBub3JtYWw7CiAgb3ZlcmZsb3c6IHZpc2libGU7CiAgdGV4dC1vdmVyZmxvdzogY2xpcDsKfQouZmNpLWNvbC1sYWJlbCB7CiAgcGFkZGluZy1yaWdodDogMTBweDsKICBkaXNwbGF5OiBpbmxpbmUtYmxvY2s7Cn0KLmZjaS1jb2wtcmVzaXplciB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIHRvcDogMDsKICByaWdodDogLTRweDsKICB3aWR0aDogOHB4OwogIGhlaWdodDogMTAwJTsKICBjdXJzb3I6IGNvbC1yZXNpemU7CiAgdXNlci1zZWxlY3Q6IG5vbmU7CiAgdG91Y2gtYWN0aW9uOiBub25lOwogIHotaW5kZXg6IDM7Cn0KLmZjaS1jb2wtcmVzaXplcjo6YWZ0ZXIgewogIGNvbnRlbnQ6ICcnOwogIHBvc2l0aW9uOiBhYnNvbHV0ZTsKICB0b3A6IDZweDsKICBib3R0b206IDZweDsKICBsZWZ0OiAzcHg7CiAgd2lkdGg6IDFweDsKICBiYWNrZ3JvdW5kOiByZ2JhKDEyMiwxNDMsMTY4LC4yOCk7Cn0KLmZjaS1jb2wtcmVzaXplcjpob3Zlcjo6YWZ0ZXIsCi5mY2ktY29sLXJlc2l6ZXIuYWN0aXZlOjphZnRlciB7CiAgYmFja2dyb3VuZDogcmdiYSgxMjIsMTQzLDE2OCwuNzUpOwp9Ci5mY2ktZW1wdHkgewogIGZvbnQtc2l6ZTogMTFweDsKICBjb2xvcjogdmFyKC0tbXV0ZWQyKTsKICBwYWRkaW5nOiAxMnB4OwogIGJvcmRlcjogMXB4IGRhc2hlZCB2YXIoLS1ib3JkZXJCKTsKICBib3JkZXItcmFkaXVzOiAxMHB4Owp9Ci5mY2ktY29udHJvbHMgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgZ2FwOiAxMHB4Owp9Ci5mY2ktc2VhcmNoIHsKICB3aWR0aDogMTAwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMik7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6IHZhcigtLXRleHQpOwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBwYWRkaW5nOiA4cHggMTBweDsKICBmb250LXNpemU6IDExcHg7CiAgb3V0bGluZTogbm9uZTsKfQouZmNpLXNlYXJjaDpmb2N1cyB7CiAgYm9yZGVyLWNvbG9yOiB2YXIoLS1tdXRlZDIpOwp9Ci5mY2ktcGFnaW5hdGlvbiB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogOHB4OwogIGZsZXgtc2hyaW5rOiAwOwp9Ci5mY2ktcGFnZS1idG4gewogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgYm9yZGVyLXJhZGl1czogNnB4OwogIGZvbnQtc2l6ZTogMTBweDsKICBmb250LXdlaWdodDogNzAwOwogIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7CiAgbGV0dGVyLXNwYWNpbmc6IC4wNmVtOwogIHBhZGRpbmc6IDVweCA4cHg7CiAgY3Vyc29yOiBwb2ludGVyOwp9Ci5mY2ktcGFnZS1idG46ZGlzYWJsZWQgewogIG9wYWNpdHk6IC40OwogIGN1cnNvcjogZGVmYXVsdDsKfQouZmNpLXBhZ2UtaW5mbyB7CiAgZm9udC1zaXplOiAxMHB4OwogIGNvbG9yOiB2YXIoLS1tdXRlZDIpOwp9Ci5mY2ktYmVuY2ggewogIGZvbnQtc2l6ZTogMTBweDsKICBjb2xvcjogdmFyKC0tbXV0ZWQyKTsKICBwYWRkaW5nOiA2cHggMnB4IDA7Cn0KLmZjaS1iZW5jaCBzdHJvbmcgewogIGNvbG9yOiB2YXIoLS10ZXh0KTsKfQouZmNpLXRyZW5kIHsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNXB4Owp9Ci5mY2ktdHJlbmQtaWNvbiB7CiAgZm9udC1zaXplOiAxMHB4OwogIGZvbnQtd2VpZ2h0OiA3MDA7Cn0KLmZjaS10cmVuZC51cCAuZmNpLXRyZW5kLWljb24geyBjb2xvcjogdmFyKC0tZ3JlZW4pOyB9Ci5mY2ktdHJlbmQuZG93biAuZmNpLXRyZW5kLWljb24geyBjb2xvcjogdmFyKC0tcmVkKTsgfQouZmNpLXRyZW5kLmZsYXQgLmZjaS10cmVuZC1pY29uIHsgY29sb3I6IHZhcigtLW11dGVkMik7IH0KLmZjaS10cmVuZC5uYSAuZmNpLXRyZW5kLWljb24geyBjb2xvcjogdmFyKC0tbXV0ZWQpOyB9Ci5mY2ktc2lnbmFsIHsKICBkaXNwbGF5OiBpbmxpbmUtYmxvY2s7CiAgYm9yZGVyLXJhZGl1czogOTk5cHg7CiAgZm9udC1zaXplOiAxMHB4OwogIGZvbnQtd2VpZ2h0OiA3MDA7CiAgbGV0dGVyLXNwYWNpbmc6IC4wNGVtOwogIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7CiAgcGFkZGluZzogMnB4IDhweDsKfQouZmNpLXNpZ25hbC5nb29kIHsKICBjb2xvcjogdmFyKC0tZ3JlZW4pOwogIGJhY2tncm91bmQ6IHZhcigtLWdyZWVuLWQpOwogIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMCwyMzAsMTE4LC4yNSk7Cn0KLmZjaS1zaWduYWwud2FybiB7CiAgY29sb3I6IHZhcigtLXllbGxvdyk7CiAgYmFja2dyb3VuZDogcmdiYSgyNTUsMjA0LDAsLjEwKTsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwyMDQsMCwuMjUpOwp9Ci5mY2ktc2lnbmFsLm9qbyB7CiAgY29sb3I6ICNmZmI4NmI7CiAgYmFja2dyb3VuZDogcmdiYSgyNTUsIDE0MCwgMCwgLjE0KTsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwgMTYyLCA3OCwgLjMwKTsKfQouZmNpLXNpZ25hbC5pbmZvIHsKICBjb2xvcjogIzdiYzZmZjsKICBiYWNrZ3JvdW5kOiByZ2JhKDQxLDE4MiwyNDYsLjEyKTsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDQxLDE4MiwyNDYsLjMpOwp9Ci5mY2ktc2lnbmFsLmJhZCB7CiAgY29sb3I6ICNmZjdmOGE7CiAgYmFja2dyb3VuZDogdmFyKC0tcmVkLWQpOwogIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjU1LDcxLDg3LC4yNSk7Cn0KLmZjaS1zaWduYWwubmEgewogIGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6IHJnYmEoMTIyLDE0MywxNjgsLjEwKTsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDEyMiwxNDMsMTY4LC4yNSk7Cn0KLmZjaS1zaWduYWwtd3JhcCB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBhbGlnbi1pdGVtczogZmxleC1zdGFydDsKICBnYXA6IDNweDsKfQouZmNpLXNpZ25hbC1zdHJlYWsgewogIGZvbnQtc2l6ZTogOXB4OwogIGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGxldHRlci1zcGFjaW5nOiAuMDJlbTsKICBsaW5lLWhlaWdodDogMS4yNTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIFNUQVRVUyBCQU5ORVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5zdGF0dXMtYmFubmVyIHsKICBib3JkZXItcmFkaXVzOjExcHg7IHBhZGRpbmc6MThweCAyNHB4OyBtYXJnaW4tYm90dG9tOjIwcHg7CiAgYm9yZGVyOjFweCBzb2xpZDsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgYW5pbWF0aW9uOmZhZGVJbiAuNHMgZWFzZTsKICBvdmVyZmxvdzpoaWRkZW47IHBvc2l0aW9uOnJlbGF0aXZlOwp9Ci5zdGF0dXMtYmFubmVyLnNpbWlsYXIgewogIGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4tZCk7IGJvcmRlci1jb2xvcjpyZ2JhKDAsMjMwLDExOCwuMjgpOwp9Ci5zdGF0dXMtYmFubmVyLnNpbWlsYXI6OmFmdGVyIHsKICBjb250ZW50OicnOyBwb3NpdGlvbjphYnNvbHV0ZTsgcmlnaHQ6LTUwcHg7IHRvcDo1MCU7CiAgdHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTUwJSk7IHdpZHRoOjIwMHB4OyBoZWlnaHQ6MjAwcHg7CiAgYm9yZGVyLXJhZGl1czo1MCU7CiAgYmFja2dyb3VuZDpyYWRpYWwtZ3JhZGllbnQoY2lyY2xlLHZhcigtLWdyZWVuLWcpIDAlLHRyYW5zcGFyZW50IDcwJSk7CiAgcG9pbnRlci1ldmVudHM6bm9uZTsKfQouc3RhdHVzLWJhbm5lci5uby1zaW1pbGFyIHsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSw4Miw4MiwuMDgpOwogIGJvcmRlci1jb2xvcjogcmdiYSgyNTUsODIsODIsLjM1KTsKfQouc3RhdHVzLWJhbm5lci5uby1zaW1pbGFyOjphZnRlciB7CiAgY29udGVudDonJzsKICBwb3NpdGlvbjphYnNvbHV0ZTsKICByaWdodDotNTBweDsKICB0b3A6NTAlOwogIHRyYW5zZm9ybTp0cmFuc2xhdGVZKC01MCUpOwogIHdpZHRoOjIwMHB4OwogIGhlaWdodDoyMDBweDsKICBib3JkZXItcmFkaXVzOjUwJTsKICBiYWNrZ3JvdW5kOnJhZGlhbC1ncmFkaWVudChjaXJjbGUscmdiYSgyNTUsODIsODIsLjE4KSAwJSx0cmFuc3BhcmVudCA3MCUpOwogIHBvaW50ZXItZXZlbnRzOm5vbmU7Cn0KCi5zLWxlZnQge30KLnMtdGl0bGUgewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo4MDA7IGZvbnQtc2l6ZToyNnB4OwogIGxldHRlci1zcGFjaW5nOi0uMDJlbTsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDoxMnB4Owp9Ci5zLWJhZGdlIHsKICBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOyBsZXR0ZXItc3BhY2luZzouMWVtOwogIHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgcGFkZGluZzoycHggOXB4OyBib3JkZXItcmFkaXVzOjRweDsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsgYWxpZ24tc2VsZjpjZW50ZXI7Cn0KLnMtYmFkZ2Uubm9zaW0geyBiYWNrZ3JvdW5kOiB2YXIoLS1yZWQpOyBjb2xvcjogI2ZmZjsgfQoucy1zdWIgeyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgbWFyZ2luLXRvcDo0cHg7IH0KCi5lcnJvci1iYW5uZXIgewogIGRpc3BsYXk6bm9uZTsKICBtYXJnaW46IDAgMCAxNHB4IDA7CiAgcGFkZGluZzogMTBweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSw4Miw4MiwuNDUpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDgyLDgyLC4xMik7CiAgY29sb3I6ICNmZmQwZDA7CiAgZm9udC1zaXplOiAxMXB4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOwogIGdhcDogMTBweDsKfQouZXJyb3ItYmFubmVyLnNob3cgeyBkaXNwbGF5OmZsZXg7IH0KLmVycm9yLWJhbm5lciBidXR0b24gewogIGJvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsODIsODIsLjUpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDgyLDgyLC4xNSk7CiAgY29sb3I6I2ZmZGVkZTsKICBib3JkZXItcmFkaXVzOjZweDsKICBwYWRkaW5nOjRweCAxMHB4OwogIGZvbnQtc2l6ZToxMHB4OwogIGZvbnQtd2VpZ2h0OjcwMDsKICB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgbGV0dGVyLXNwYWNpbmc6LjA2ZW07CiAgY3Vyc29yOnBvaW50ZXI7Cn0KCi5za2VsZXRvbiB7CiAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDkwZGVnLCAjMWMyMzMwIDI1JSwgIzJhMzQ0NCA1MCUsICMxYzIzMzAgNzUlKTsKICBiYWNrZ3JvdW5kLXNpemU6IDIwMCUgMTAwJTsKICBhbmltYXRpb246IHNoaW1tZXIgMS40cyBpbmZpbml0ZTsKICBib3JkZXItcmFkaXVzOiA0cHg7CiAgY29sb3I6IHRyYW5zcGFyZW50OwogIHVzZXItc2VsZWN0OiBub25lOwp9CkBrZXlmcmFtZXMgc2hpbW1lciB7CiAgMCUgICB7IGJhY2tncm91bmQtcG9zaXRpb246IDIwMCUgMDsgfQogIDEwMCUgeyBiYWNrZ3JvdW5kLXBvc2l0aW9uOiAtMjAwJSAwOyB9Cn0KCi52YWx1ZS1jaGFuZ2VkIHsKICBhbmltYXRpb246IGZsYXNoVmFsdWUgNjAwbXMgZWFzZTsKfQpAa2V5ZnJhbWVzIGZsYXNoVmFsdWUgewogIDAlICAgeyBjb2xvcjogI2ZmY2MwMDsgfQogIDEwMCUgeyBjb2xvcjogaW5oZXJpdDsgfQp9Cgoucy1yaWdodCB7IHRleHQtYWxpZ246cmlnaHQ7IGZvbnQtc2l6ZToxMXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IGxpbmUtaGVpZ2h0OjEuOTsgfQoucy1yaWdodCBzdHJvbmcgeyBjb2xvcjp2YXIoLS1tdXRlZDIpOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgSEVSTyBDQVJEUwrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmhlcm8tZ3JpZCB7CiAgZGlzcGxheTpncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmciAxZnI7CiAgZ2FwOjE0cHg7IG1hcmdpbi1ib3R0b206MjBweDsKfQoKLmhjYXJkIHsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBwYWRkaW5nOjIwcHggMjJweDsKICBwb3NpdGlvbjpyZWxhdGl2ZTsgb3ZlcmZsb3c6aGlkZGVuOwogIHRyYW5zaXRpb246Ym9yZGVyLWNvbG9yIC4xOHM7CiAgYW5pbWF0aW9uOiBmYWRlVXAgLjVzIGVhc2UgYm90aDsKfQouaGNhcmQ6bnRoLWNoaWxkKDEpe2FuaW1hdGlvbi1kZWxheTouMDhzO30KLmhjYXJkOm50aC1jaGlsZCgyKXthbmltYXRpb24tZGVsYXk6LjE2czt9Ci5oY2FyZDpudGgtY2hpbGQoMyl7YW5pbWF0aW9uLWRlbGF5Oi4yNHM7fQouaGNhcmQ6aG92ZXIgeyBib3JkZXItY29sb3I6dmFyKC0tYm9yZGVyQik7IH0KCi5oY2FyZCAuYmFyIHsgcG9zaXRpb246YWJzb2x1dGU7IHRvcDowO2xlZnQ6MDtyaWdodDowOyBoZWlnaHQ6MnB4OyB9Ci5oY2FyZC5tZXAgLmJhciB7IGJhY2tncm91bmQ6dmFyKC0tbWVwKTsgfQouaGNhcmQuY2NsIC5iYXIgeyBiYWNrZ3JvdW5kOnZhcigtLWNjbCk7IH0KLmhjYXJkLmdhcCAuYmFyIHsgYmFja2dyb3VuZDp2YXIoLS15ZWxsb3cpOyB9CgouaGNhcmQtbGFiZWwgewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4xMmVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IGNvbG9yOnZhcigtLW11dGVkKTsKICBtYXJnaW4tYm90dG9tOjlweDsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo1cHg7Cn0KLmhjYXJkLWxhYmVsIC5kb3QgeyB3aWR0aDo1cHg7aGVpZ2h0OjVweDtib3JkZXItcmFkaXVzOjUwJTsgfQoubWVwIC5kb3R7YmFja2dyb3VuZDp2YXIoLS1tZXApO30KLmNjbCAuZG90e2JhY2tncm91bmQ6dmFyKC0tY2NsKTt9Ci5nYXAgLmRvdHtiYWNrZ3JvdW5kOnZhcigtLXllbGxvdyk7fQoKLmhjYXJkLXZhbCB7CiAgZm9udC1zaXplOjM0cHg7IGZvbnQtd2VpZ2h0OjcwMDsgbGV0dGVyLXNwYWNpbmc6LS4wMmVtOyBsaW5lLWhlaWdodDoxOwp9Ci5tZXAgLmhjYXJkLXZhbHtjb2xvcjp2YXIoLS1tZXApO30KLmNjbCAuaGNhcmQtdmFse2NvbG9yOnZhcigtLWNjbCk7fQoKLmhjYXJkLXBjdCB7IGZvbnQtc2l6ZToyMHB4OyBjb2xvcjp2YXIoLS15ZWxsb3cpOyBmb250LXdlaWdodDo3MDA7IG1hcmdpbi10b3A6M3B4OyB9Ci5oY2FyZC1kZWx0YSB7CiAgZm9udC1zaXplOjEwcHg7CiAgY29sb3I6dmFyKC0tbXV0ZWQyKTsKICBtYXJnaW4tdG9wOjVweDsKICBmb250LWZhbWlseTp2YXIoLS1tb25vKTsKfQouaGNhcmQtZGVsdGEudXAgeyBjb2xvcjojZmY2ZjdmOyB9Ci5oY2FyZC1kZWx0YS5kb3duIHsgY29sb3I6dmFyKC0tZ3JlZW4pOyB9Ci5oY2FyZC1zdWIgeyBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tdG9wOjdweDsgfQoKLyogdG9vbHRpcCAqLwoudGlwIHsgcG9zaXRpb246cmVsYXRpdmU7IGN1cnNvcjpoZWxwOyB9Ci50aXA6OmFmdGVyIHsKICBjb250ZW50OmF0dHIoZGF0YS10KTsKICBwb3NpdGlvbjphYnNvbHV0ZTsgYm90dG9tOmNhbGMoMTAwJSArIDdweCk7IGxlZnQ6NTAlOwogIHRyYW5zZm9ybTp0cmFuc2xhdGVYKC01MCUpOwogIGJhY2tncm91bmQ6IzFhMjIzMjsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsKICBjb2xvcjp2YXIoLS10ZXh0KTsgZm9udC1zaXplOjEwcHg7IHBhZGRpbmc6NXB4IDlweDsKICBib3JkZXItcmFkaXVzOjZweDsgd2hpdGUtc3BhY2U6bm93cmFwOwogIG9wYWNpdHk6MDsgcG9pbnRlci1ldmVudHM6bm9uZTsgdHJhbnNpdGlvbjpvcGFjaXR5IC4xOHM7IHotaW5kZXg6OTk7Cn0KLnRpcDpob3Zlcjo6YWZ0ZXJ7b3BhY2l0eToxO30KLnRpcC50aXAtZG93bjo6YWZ0ZXIgewogIGRpc3BsYXk6IG5vbmU7Cn0KCi5zbWFydC10aXAgewogIHBvc2l0aW9uOiBmaXhlZDsKICBsZWZ0OiAwOwogIHRvcDogMDsKICBtYXgtd2lkdGg6IG1pbigyODBweCwgY2FsYygxMDB2dyAtIDE2cHgpKTsKICBiYWNrZ3JvdW5kOiAjMWEyMjMyOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlckIpOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBmb250LXNpemU6IDEwcHg7CiAgbGluZS1oZWlnaHQ6IDEuNDU7CiAgcGFkZGluZzogNnB4IDlweDsKICBib3JkZXItcmFkaXVzOiA2cHg7CiAgei1pbmRleDogNDAwOwogIG9wYWNpdHk6IDA7CiAgcG9pbnRlci1ldmVudHM6IG5vbmU7CiAgdHJhbnNpdGlvbjogb3BhY2l0eSAuMTJzOwp9Ci5zbWFydC10aXAuc2hvdyB7CiAgb3BhY2l0eTogMTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIENIQVJUCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouY2hhcnQtY2FyZCB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmKTsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6MTFweDsgcGFkZGluZzoyMnB4OyBtYXJnaW4tYm90dG9tOjIwcHg7CiAgYW5pbWF0aW9uOmZhZGVVcCAuNXMgLjMycyBlYXNlIGJvdGg7Cn0KLmNoYXJ0LXRvcCB7CiAgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGp1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuOwogIG1hcmdpbi1ib3R0b206MTZweDsKfQouY2hhcnQtdHRsIHsgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtd2VpZ2h0OjcwMDsgZm9udC1zaXplOjEzcHg7IH0KCi5waWxscyB7IGRpc3BsYXk6ZmxleDsgZ2FwOjVweDsgfQoucGlsbCB7CiAgZm9udC1zaXplOjEwcHg7IHBhZGRpbmc6M3B4IDExcHg7IGJvcmRlci1yYWRpdXM6MjBweDsKICBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlckIpOyBjb2xvcjp2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6dHJhbnNwYXJlbnQ7IGN1cnNvcjpwb2ludGVyOyBmb250LWZhbWlseTp2YXIoLS1tb25vKTsKICB0cmFuc2l0aW9uOmFsbCAuMTNzOwp9Ci5waWxsLm9uIHsgYmFja2dyb3VuZDp2YXIoLS1tZXApOyBib3JkZXItY29sb3I6dmFyKC0tbWVwKTsgY29sb3I6IzAwMDsgZm9udC13ZWlnaHQ6NzAwOyB9CgoubGVnZW5kcyB7IGRpc3BsYXk6ZmxleDsgZ2FwOjE4cHg7IG1hcmdpbi1ib3R0b206MTRweDsgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkMik7IH0KLmxlZyB7IGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6NXB4OyB9Ci5sZWctbGluZSB7IHdpZHRoOjE4cHg7IGhlaWdodDoycHg7IGJvcmRlci1yYWRpdXM6MnB4OyB9CgpzdmcuY2hhcnQgeyB3aWR0aDoxMDAlOyBoZWlnaHQ6MTcwcHg7IG92ZXJmbG93OnZpc2libGU7IH0KLnRyZW5kLWhpbnQgewogIG1hcmdpbi10b3A6OHB4OwogIGZvbnQtc2l6ZToxMHB4OwogIGNvbG9yOnZhcigtLW11dGVkKTsKICBmb250LXN0eWxlOml0YWxpYzsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIE1FVFJJQ1MK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5tZXRyaWNzLWdyaWQgewogIGRpc3BsYXk6Z3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCg0LDFmcik7CiAgZ2FwOjEycHg7IG1hcmdpbi1ib3R0b206MjBweDsKfQoubWNhcmQgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czo5cHg7IHBhZGRpbmc6MTRweCAxNnB4OwogIGFuaW1hdGlvbjpmYWRlVXAgLjVzIGVhc2UgYm90aDsKfQoubWNhcmQ6bnRoLWNoaWxkKDEpe2FuaW1hdGlvbi1kZWxheTouMzhzO30KLm1jYXJkOm50aC1jaGlsZCgyKXthbmltYXRpb24tZGVsYXk6LjQzczt9Ci5tY2FyZDpudGgtY2hpbGQoMyl7YW5pbWF0aW9uLWRlbGF5Oi40OHM7fQoubWNhcmQ6bnRoLWNoaWxkKDQpe2FuaW1hdGlvbi1kZWxheTouNTNzO30KLm1jYXJkLWxhYmVsIHsKICBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC1zaXplOjlweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4xZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tYm90dG9tOjdweDsKfQoubWNhcmQtdmFsIHsgZm9udC1zaXplOjIwcHg7IGZvbnQtd2VpZ2h0OjcwMDsgfQoubWNhcmQtc3ViIHsgZm9udC1zaXplOjlweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tdG9wOjNweDsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIFRBQkxFCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwoudGFibGUtY2FyZCB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmKTsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6MTFweDsgb3ZlcmZsb3c6aGlkZGVuOwogIGFuaW1hdGlvbjpmYWRlVXAgLjVzIC41NnMgZWFzZSBib3RoOwp9Ci50YWJsZS10b3AgewogIHBhZGRpbmc6MTRweCAyMnB4OyBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKfQoudGFibGUtdHRsIHsgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtd2VpZ2h0OjcwMDsgZm9udC1zaXplOjEzcHg7IH0KLnRhYmxlLXJpZ2h0IHsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDoxMHB4OyB9Ci50YWJsZS1jYXAgeyBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyB9Ci5idG4tZG93bmxvYWQgewogIGRpc3BsYXk6aW5saW5lLWZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsgZ2FwOjZweDsKICBoZWlnaHQ6MjZweDsgcGFkZGluZzowIDEwcHg7IGJvcmRlci1yYWRpdXM6N3B4OwogIGJvcmRlcjoxcHggc29saWQgIzJmNGY2ODsgYmFja2dyb3VuZDpyZ2JhKDQxLDE4MiwyNDYsMC4wNik7CiAgY29sb3I6IzhmZDhmZjsgY3Vyc29yOnBvaW50ZXI7IGZvbnQtZmFtaWx5OnZhcigtLW1vbm8pOyBmb250LXNpemU6MTBweDsKICBsZXR0ZXItc3BhY2luZzouMDJlbTsKICB0cmFuc2l0aW9uOmJvcmRlci1jb2xvciAuMTVzIGVhc2UsIGJhY2tncm91bmQgLjE1cyBlYXNlLCBjb2xvciAuMTVzIGVhc2UsIGJveC1zaGFkb3cgLjE1cyBlYXNlOwp9Ci5idG4tZG93bmxvYWQgc3ZnIHsKICB3aWR0aDoxMnB4OyBoZWlnaHQ6MTJweDsgc3Ryb2tlOmN1cnJlbnRDb2xvcjsgZmlsbDpub25lOyBzdHJva2Utd2lkdGg6MS44Owp9Ci5idG4tZG93bmxvYWQ6aG92ZXIgewogIGJvcmRlci1jb2xvcjojNGZjM2Y3OyBiYWNrZ3JvdW5kOnJnYmEoNDEsMTgyLDI0NiwwLjE2KTsKICBjb2xvcjojYzZlY2ZmOyBib3gtc2hhZG93OjAgMCAwIDFweCByZ2JhKDc5LDE5NSwyNDcsLjE4KSBpbnNldDsKfQoKLmhpc3RvcnktdGFibGUtd3JhcCB7IG92ZXJmbG93LXg6YXV0bzsgfQouaGlzdG9yeS10YWJsZS13cmFwIHRhYmxlIHsKICBtaW4td2lkdGg6IDg2MHB4Owp9CnRhYmxlIHsgd2lkdGg6MTAwJTsgYm9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlOyB0YWJsZS1sYXlvdXQ6Zml4ZWQ7IH0KdGhlYWQgdGggewogIGZvbnQtc2l6ZTo5cHg7IGxldHRlci1zcGFjaW5nOi4xZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBjb2xvcjp2YXIoLS1tdXRlZCk7IHBhZGRpbmc6OXB4IDIycHg7IHRleHQtYWxpZ246bGVmdDsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYyKTsgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtd2VpZ2h0OjYwMDsKICBwb3NpdGlvbjpyZWxhdGl2ZTsKfQp0Ym9keSB0ciB7IGJvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7IHRyYW5zaXRpb246YmFja2dyb3VuZCAuMTJzOyB9CnRib2R5IHRyOmhvdmVyIHsgYmFja2dyb3VuZDpyZ2JhKDQxLDE4MiwyNDYsLjA0KTsgfQp0Ym9keSB0cjpsYXN0LWNoaWxkIHsgYm9yZGVyLWJvdHRvbTpub25lOyB9CnRib2R5IHRkIHsKICBwYWRkaW5nOjExcHggMjJweDsgZm9udC1zaXplOjEycHg7CiAgb3ZlcmZsb3c6aGlkZGVuOyB0ZXh0LW92ZXJmbG93OmVsbGlwc2lzOyB3aGl0ZS1zcGFjZTpub3dyYXA7Cn0KdGQuZGltIHsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgZm9udC1zaXplOjExcHg7IH0KdGQuZGltIC50cy1kYXkgeyBmb250LXNpemU6OXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IGxpbmUtaGVpZ2h0OjEuMTsgfQp0ZC5kaW0gLnRzLWhvdXIgeyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgbGluZS1oZWlnaHQ6MS4yOyBtYXJnaW4tdG9wOjJweDsgfQouY29sLWxhYmVsIHsgcGFkZGluZy1yaWdodDoxMHB4OyBkaXNwbGF5OmlubGluZS1ibG9jazsgfQouY29sLXJlc2l6ZXIgewogIHBvc2l0aW9uOmFic29sdXRlOwogIHRvcDowOwogIHJpZ2h0Oi00cHg7CiAgd2lkdGg6OHB4OwogIGhlaWdodDoxMDAlOwogIGN1cnNvcjpjb2wtcmVzaXplOwogIHVzZXItc2VsZWN0Om5vbmU7CiAgdG91Y2gtYWN0aW9uOm5vbmU7CiAgei1pbmRleDoyOwp9Ci5jb2wtcmVzaXplcjo6YWZ0ZXIgewogIGNvbnRlbnQ6Jyc7CiAgcG9zaXRpb246YWJzb2x1dGU7CiAgdG9wOjZweDsKICBib3R0b206NnB4OwogIGxlZnQ6M3B4OwogIHdpZHRoOjFweDsKICBiYWNrZ3JvdW5kOnJnYmEoMTIyLDE0MywxNjgsLjI4KTsKfQouY29sLXJlc2l6ZXI6aG92ZXI6OmFmdGVyLAouY29sLXJlc2l6ZXIuYWN0aXZlOjphZnRlciB7CiAgYmFja2dyb3VuZDpyZ2JhKDEyMiwxNDMsMTY4LC43NSk7Cn0KCi5zYmFkZ2UgewogIGRpc3BsYXk6aW5saW5lLWJsb2NrOyBmb250LXNpemU6OXB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHBhZGRpbmc6MnB4IDdweDsgYm9yZGVyLXJhZGl1czo0cHg7CiAgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOwp9Ci5zYmFkZ2Uuc2ltIHsgYmFja2dyb3VuZDp2YXIoLS1ncmVlbi1kKTsgY29sb3I6dmFyKC0tZ3JlZW4pOyBib3JkZXI6MXB4IHNvbGlkIHJnYmEoMCwyMzAsMTE4LC4yKTsgfQouc2JhZGdlLm5vc2ltIHsgYmFja2dyb3VuZDp2YXIoLS1yZWQtZCk7IGNvbG9yOnZhcigtLXJlZCk7IGJvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsNzEsODcsLjIpOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgRk9PVEVSIC8gR0xPU0FSSU8K4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5nbG9zYXJpbyB7CiAgbWFyZ2luLXRvcDoyMHB4OyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBvdmVyZmxvdzpoaWRkZW47CiAgYW5pbWF0aW9uOmZhZGVVcCAuNXMgLjZzIGVhc2UgYm90aDsKfQouZ2xvcy1idG4gewogIHdpZHRoOjEwMCU7IGJhY2tncm91bmQ6dmFyKC0tc3VyZik7IGJvcmRlcjpub25lOwogIGNvbG9yOnZhcigtLW11dGVkMik7IGZvbnQtZmFtaWx5OnZhcigtLW1vbm8pOyBmb250LXNpemU6MTFweDsKICBwYWRkaW5nOjEzcHggMjJweDsgdGV4dC1hbGlnbjpsZWZ0OyBjdXJzb3I6cG9pbnRlcjsKICBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgdHJhbnNpdGlvbjpjb2xvciAuMTVzOwp9Ci5nbG9zLWJ0bjpob3ZlciB7IGNvbG9yOnZhcigtLXRleHQpOyB9CgouZ2xvcy1ncmlkIHsKICBkaXNwbGF5Om5vbmU7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyOwogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOyBib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9Ci5nbG9zLWdyaWQub3BlbiB7IGRpc3BsYXk6Z3JpZDsgfQoKLmdpIHsKICBwYWRkaW5nOjE0cHggMjJweDsgYm9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmlnaHQ6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmdpOm50aC1jaGlsZChldmVuKXtib3JkZXItcmlnaHQ6bm9uZTt9Ci5naS10ZXJtIHsKICBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC1zaXplOjEwcHg7IGZvbnQtd2VpZ2h0OjcwMDsKICBsZXR0ZXItc3BhY2luZzouMDhlbTsgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOyBjb2xvcjp2YXIoLS1tdXRlZDIpOyBtYXJnaW4tYm90dG9tOjNweDsKfQouZ2ktZGVmIHsgZm9udC1zaXplOjExcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgbGluZS1oZWlnaHQ6MS41OyB9Cgpmb290ZXIgewogIHRleHQtYWxpZ246Y2VudGVyOyBwYWRkaW5nOjIycHg7IGZvbnQtc2l6ZToxMHB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7CiAgYm9yZGVyLXRvcDoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQpmb290ZXIgYSB7IGNvbG9yOnZhcigtLW11dGVkMik7IHRleHQtZGVjb3JhdGlvbjpub25lOyB9CmZvb3RlciBhOmhvdmVyIHsgY29sb3I6dmFyKC0tdGV4dCk7IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBBTklNQVRJT05TCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwpAa2V5ZnJhbWVzIGZhZGVJbiB7IGZyb217b3BhY2l0eTowO310b3tvcGFjaXR5OjE7fSB9CkBrZXlmcmFtZXMgZmFkZVVwIHsgZnJvbXtvcGFjaXR5OjA7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoMTBweCk7fXRve29wYWNpdHk6MTt0cmFuc2Zvcm06dHJhbnNsYXRlWSgwKTt9IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBSRVNQT05TSVZFCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwpAbWVkaWEobWF4LXdpZHRoOjkwMHB4KXsKICA6cm9vdHsgLS1kcmF3ZXItdzogMTAwdnc7IH0KICAuYm9keS13cmFwLmRyYXdlci1vcGVuIC5tYWluLWNvbnRlbnQgeyBtYXJnaW4tcmlnaHQ6MDsgfQogIC5kcmF3ZXIgeyB3aWR0aDoxMDB2dzsgfQogIC5kcmF3ZXItcmVzaXplciB7IGRpc3BsYXk6bm9uZTsgfQp9CkBtZWRpYShtYXgtd2lkdGg6NzAwcHgpewogIC5oZXJvLWdyaWR7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyOyB9CiAgLmhjYXJkLmdhcHsgZ3JpZC1jb2x1bW46c3BhbiAyOyB9CiAgLm1ldHJpY3MtZ3JpZHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7IH0KICAuaGNhcmQtdmFseyBmb250LXNpemU6MjZweDsgfQogIC5waWxsc3sgZmxleC13cmFwOndyYXA7IH0KICAudGFibGUtcmlnaHQgeyBnYXA6OHB4OyB9CiAgLmJ0bi1kb3dubG9hZCB7IHBhZGRpbmc6MCA4cHg7IH0KICB0aGVhZCB0aDpudGgtY2hpbGQoNCksIHRib2R5IHRkOm50aC1jaGlsZCg0KXsgZGlzcGxheTpub25lOyB9CiAgLnMtcmlnaHQgeyBkaXNwbGF5Om5vbmU7IH0KICB0ZC5kaW0gLnRzLWRheSB7IGZvbnQtc2l6ZTo4cHg7IH0KICB0ZC5kaW0gLnRzLWhvdXIgeyBmb250LXNpemU6MTBweDsgfQp9CkBtZWRpYShtYXgtd2lkdGg6NDgwcHgpewogIC5oZXJvLWdyaWR7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnI7IH0KICAuaGNhcmQuZ2FweyBncmlkLWNvbHVtbjpzcGFuIDE7IH0KICBoZWFkZXJ7IHBhZGRpbmc6MCAxNHB4OyB9CiAgLnRhZy1tZXJjYWRveyBkaXNwbGF5Om5vbmU7IH0KICAuYnRuLXRhc2FzIHNwYW4ubGFiZWwtbG9uZyB7IGRpc3BsYXk6bm9uZTsgfQp9CgovKiBEUkFXRVIgT1ZFUkxBWSAobW9iaWxlKSAqLwoub3ZlcmxheSB7CiAgZGlzcGxheTpub25lOwogIHBvc2l0aW9uOmZpeGVkOyBpbnNldDowOyB6LWluZGV4OjE0MDsKICBiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjU1KTsKICBiYWNrZHJvcC1maWx0ZXI6Ymx1cigycHgpOwp9CkBtZWRpYShtYXgtd2lkdGg6OTAwcHgpewogIC5vdmVybGF5LnNob3cgeyBkaXNwbGF5OmJsb2NrOyB9Cn0KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KPGRpdiBjbGFzcz0iYXBwIj4KCjwhLS0g4pSA4pSAIEhFQURFUiDilIDilIAgLS0+CjxoZWFkZXI+CiAgPGRpdiBjbGFzcz0ibG9nbyI+CiAgICA8c3BhbiBjbGFzcz0ibGl2ZS1kb3QiPjwvc3Bhbj4KICAgIFJBREFSIE1FUC9DQ0wKICA8L2Rpdj4KICA8ZGl2IGNsYXNzPSJoZWFkZXItcmlnaHQiPgogICAgPGRpdiBjbGFzcz0iZnJlc2gtYmFkZ2UiIGlkPSJmcmVzaC1iYWRnZSI+CiAgICAgIDxzcGFuIGNsYXNzPSJmcmVzaC1kb3QiPjwvc3Bhbj4KICAgICAgPHNwYW4gaWQ9ImZyZXNoLWJhZGdlLXRleHQiPkFjdHVhbGl6YW5kb+KApjwvc3Bhbj4KICAgIDwvZGl2PgogICAgPHNwYW4gY2xhc3M9InRhZy1tZXJjYWRvIGNsb3NlZCIgaWQ9InRhZy1tZXJjYWRvIj5NZXJjYWRvIGNlcnJhZG88L3NwYW4+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLXRhc2FzIiBpZD0iYnRuVGFzYXMiIG9uY2xpY2s9InRvZ2dsZURyYXdlcigpIj4KICAgICAg8J+TiiA8c3BhbiBjbGFzcz0ibGFiZWwtbG9uZyI+Rm9uZG9zIENvbXVuZXMgZGUgSW52ZXJzacOzbjwvc3Bhbj4KICAgIDwvYnV0dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1hbGVydCI+8J+UlCBBbGVydGFzPC9idXR0b24+CiAgPC9kaXY+CjwvaGVhZGVyPgoKPCEtLSDilIDilIAgT1ZFUkxBWSAobW9iaWxlKSDilIDilIAgLS0+CjxkaXYgY2xhc3M9Im92ZXJsYXkiIGlkPSJvdmVybGF5IiBvbmNsaWNrPSJ0b2dnbGVEcmF3ZXIoKSI+PC9kaXY+Cgo8IS0tIOKUgOKUgCBCT0RZIFdSQVAg4pSA4pSAIC0tPgo8ZGl2IGNsYXNzPSJib2R5LXdyYXAiIGlkPSJib2R5V3JhcCI+CgogIDwhLS0g4pWQ4pWQ4pWQ4pWQIE1BSU4g4pWQ4pWQ4pWQ4pWQIC0tPgogIDxkaXYgY2xhc3M9Im1haW4tY29udGVudCI+CgogICAgPCEtLSBTVEFUVVMgQkFOTkVSIC0tPgogICAgPGRpdiBjbGFzcz0ic3RhdHVzLWJhbm5lciBzaW1pbGFyIiBpZD0ic3RhdHVzLWJhbm5lciI+CiAgICAgIDxkaXYgY2xhc3M9InMtbGVmdCI+CiAgICAgICAgPGRpdiBjbGFzcz0icy10aXRsZSI+CiAgICAgICAgICA8c3BhbiBpZD0ic3RhdHVzLWxhYmVsIj5NRVAg4omIIENDTDwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJzLWJhZGdlIiBpZD0ic3RhdHVzLWJhZGdlIj5TaW1pbGFyPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InMtc3ViIj5MYSBicmVjaGEgZXN0w6EgZGVudHJvIGRlbCB1bWJyYWwg4oCUIGxvcyBwcmVjaW9zIHNvbiBjb21wYXJhYmxlczwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icy1yaWdodCI+CiAgICAgICAgPGRpdj7Dmmx0aW1hIGNvcnJpZGE6IDxzdHJvbmcgaWQ9Imxhc3QtcnVuLXRpbWUiPuKAlDwvc3Ryb25nPjwvZGl2PgogICAgICAgIDxkaXYgaWQ9ImNvdW50ZG93bi10ZXh0Ij5QcsOzeGltYSBhY3R1YWxpemFjacOzbiBlbiA1OjAwPC9kaXY+CiAgICAgICAgPGRpdj5Dcm9uIEdNVC0zIMK3IEx1buKAk1ZpZSAxMDozMOKAkzE4OjAwPC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJlcnJvci1iYW5uZXIiIGlkPSJlcnJvci1iYW5uZXIiPgogICAgICA8c3BhbiBpZD0iZXJyb3ItYmFubmVyLXRleHQiPkVycm9yIGFsIGFjdHVhbGl6YXIgwrcgUmVpbnRlbnRhcjwvc3Bhbj4KICAgICAgPGJ1dHRvbiBpZD0iZXJyb3ItcmV0cnktYnRuIiB0eXBlPSJidXR0b24iPlJlaW50ZW50YXI8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDwhLS0gSEVSTyBDQVJEUyAtLT4KICAgIDxkaXYgY2xhc3M9Imhlcm8tZ3JpZCI+CiAgICAgIDxkaXYgY2xhc3M9ImhjYXJkIG1lcCI+CiAgICAgICAgPGRpdiBjbGFzcz0iYmFyIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1sYWJlbCI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0iZG90Ij48L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGlwIiBkYXRhLXQ9IkTDs2xhciBCb2xzYSDigJQgY29tcHJhL3ZlbnRhIGRlIGJvbm9zIGVuICRBUlMgeSBVU0QiPk1FUCB2ZW50YSDik5g8L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtdmFsIiBpZD0ibWVwLXZhbCI+JDEuMjY0PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtc3ViIj5kb2xhcml0by5hciDCtyB2ZW50YTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGNhcmQgY2NsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJiYXIiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLWxhYmVsIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJkb3QiPjwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0aXAiIGRhdGEtdD0iQ29udGFkbyBjb24gTGlxdWlkYWNpw7NuIOKAlCBzaW1pbGFyIGFsIE1FUCBjb24gZ2lybyBhbCBleHRlcmlvciI+Q0NMIHZlbnRhIOKTmDwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC12YWwiIGlkPSJjY2wtdmFsIj4kMS4yNzE8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1zdWIiPmRvbGFyaXRvLmFyIMK3IHZlbnRhPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoY2FyZCBnYXAiPgogICAgICAgIDxkaXYgY2xhc3M9ImJhciI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtbGFiZWwiPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImRvdCI+PC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRpcCIgZGF0YS10PSJCcmVjaGEgcmVsYXRpdmEgY29udHJhIGVsIHByb21lZGlvIGVudHJlIE1FUCB5IENDTCI+QnJlY2hhIOKTmDwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC12YWwiIGlkPSJicmVjaGEtYWJzIj4kNzwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXBjdCIgaWQ9ImJyZWNoYS1wY3QiPjAuNTUlPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtZGVsdGEiIGlkPSJicmVjaGEtaG91cmx5LWRlbHRhIj52cyBoYWNlIDFoIOKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXN1YiI+ZGlmZXJlbmNpYSBhYnNvbHV0YSDCtyBwb3JjZW50dWFsPC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPCEtLSBDSEFSVCAtLT4KICAgIDxkaXYgY2xhc3M9ImNoYXJ0LWNhcmQiPgogICAgICA8ZGl2IGNsYXNzPSJjaGFydC10b3AiPgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXR0bCIgaWQ9InRyZW5kLXRpdGxlIj5UZW5kZW5jaWEgTUVQL0NDTCDigJQgMSBkw61hPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icGlsbHMiPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0icGlsbCBvbiIgZGF0YS1maWx0ZXI9IjFkIj4xIETDrWE8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9InBpbGwiIGRhdGEtZmlsdGVyPSIxdyI+MSBTZW1hbmE8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9InBpbGwiIGRhdGEtZmlsdGVyPSIxbSI+MSBNZXM8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImxlZ2VuZHMiPgogICAgICAgIDxkaXYgY2xhc3M9ImxlZyI+PGRpdiBjbGFzcz0ibGVnLWxpbmUiIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLW1lcCkiPjwvZGl2Pk1FUDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImxlZyI+PGRpdiBjbGFzcz0ibGVnLWxpbmUiIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLWNjbCkiPjwvZGl2PkNDTDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImxlZyI+PGRpdiBjbGFzcz0ibGVnLWxpbmUiIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLXllbGxvdykiPjwvZGl2PkJyZWNoYSAoaG92ZXIpPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8c3ZnIGNsYXNzPSJjaGFydCIgaWQ9InRyZW5kLWNoYXJ0IiB2aWV3Qm94PSIwIDAgODYwIDE2MCIgcHJlc2VydmVBc3BlY3RSYXRpbz0ibm9uZSI+CiAgICAgICAgPGxpbmUgeDE9IjAiIHkxPSI0MCIgeDI9Ijg2MCIgeTI9IjQwIiBzdHJva2U9IiMxZTI1MzAiIHN0cm9rZS13aWR0aD0iMSIvPgogICAgICAgIDxsaW5lIHgxPSIwIiB5MT0iODAiIHgyPSI4NjAiIHkyPSI4MCIgc3Ryb2tlPSIjMWUyNTMwIiBzdHJva2Utd2lkdGg9IjEiLz4KICAgICAgICA8bGluZSB4MT0iMCIgeTE9IjEyMCIgeDI9Ijg2MCIgeTI9IjEyMCIgc3Ryb2tlPSIjMWUyNTMwIiBzdHJva2Utd2lkdGg9IjEiLz4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteS10b3AiIHg9IjIiIHk9IjM3IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXktbWlkIiB4PSIyIiB5PSI3NyIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI4IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC15LWxvdyIgeD0iMiIgeT0iMTE3IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHBvbHlsaW5lIGlkPSJ0cmVuZC1tZXAtbGluZSIgcG9pbnRzPSIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzI5YjZmNiIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgICAgICAgPHBvbHlsaW5lIGlkPSJ0cmVuZC1jY2wtbGluZSIgcG9pbnRzPSIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2IzOWRkYiIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgICAgICAgPGxpbmUgaWQ9InRyZW5kLWhvdmVyLWxpbmUiIHgxPSIwIiB5MT0iMTgiIHgyPSIwIiB5Mj0iMTMyIiBzdHJva2U9IiMyYTM0NDQiIHN0cm9rZS13aWR0aD0iMSIgb3BhY2l0eT0iMCIvPgogICAgICAgIDxjaXJjbGUgaWQ9InRyZW5kLWhvdmVyLW1lcCIgY3g9IjAiIGN5PSIwIiByPSIzLjUiIGZpbGw9IiMyOWI2ZjYiIG9wYWNpdHk9IjAiLz4KICAgICAgICA8Y2lyY2xlIGlkPSJ0cmVuZC1ob3Zlci1jY2wiIGN4PSIwIiBjeT0iMCIgcj0iMy41IiBmaWxsPSIjYjM5ZGRiIiBvcGFjaXR5PSIwIi8+CiAgICAgICAgPGcgaWQ9InRyZW5kLXRvb2x0aXAiIG9wYWNpdHk9IjAiPgogICAgICAgICAgPHJlY3QgaWQ9InRyZW5kLXRvb2x0aXAtYmciIHg9IjAiIHk9IjAiIHdpZHRoPSIxODgiIGhlaWdodD0iNTYiIHJ4PSI2IiBmaWxsPSIjMTYxYjIyIiBzdHJva2U9IiMyYTM0NDQiLz4KICAgICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC10aXAtdGltZSIgeD0iMTAiIHk9IjE0IiBmaWxsPSIjNTU2MDcwIiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgICA8dGV4dCBpZD0idHJlbmQtdGlwLW1lcCIgeD0iMTAiIHk9IjI4IiBmaWxsPSIjMjliNmY2IiBmb250LXNpemU9IjkiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj5NRVAg4oCUPC90ZXh0PgogICAgICAgICAgPHRleHQgaWQ9InRyZW5kLXRpcC1jY2wiIHg9IjEwIiB5PSI0MCIgZmlsbD0iI2IzOWRkYiIgZm9udC1zaXplPSI5IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+Q0NMIOKAlDwvdGV4dD4KICAgICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC10aXAtZ2FwIiB4PSIxMCIgeT0iNTIiIGZpbGw9IiNmZmNjMDAiIGZvbnQtc2l6ZT0iOCIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPkJyZWNoYSDigJQ8L3RleHQ+CiAgICAgICAgPC9nPgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTEiIHg9IjI4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC0yIiB4PSIyMTgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTMiIHg9IjQxOCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtNCIgeD0iNjA4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC01IiB4PSI3OTgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICA8L3N2Zz4KICAgICAgPGRpdiBjbGFzcz0idHJlbmQtaGludCI+UGFzw6EgZWwgY3Vyc29yIHBvciBlbCBncsOhZmljbyBwYXJhIHZlciBNRVAsIENDTCB5IGJyZWNoYSBlbiBjYWRhIG1vbWVudG8uPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8IS0tIE1FVFJJQ1MgLS0+CiAgICA8ZGl2IGNsYXNzPSJtZXRyaWNzLWdyaWQiPgogICAgICA8ZGl2IGNsYXNzPSJtY2FyZCI+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtbGFiZWwiIGlkPSJtZXRyaWMtY291bnQtbGFiZWwiPk11ZXN0cmFzIDEgZMOtYTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXZhbCIgaWQ9Im1ldHJpYy1jb3VudC0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiIgaWQ9Im1ldHJpYy1jb3VudC1zdWIiPnJlZ2lzdHJvcyBkZWwgcGVyw61vZG8gZmlsdHJhZG88L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im1jYXJkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1sYWJlbCIgaWQ9Im1ldHJpYy1zaW1pbGFyLWxhYmVsIj5WZWNlcyBzaW1pbGFyPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtdmFsIiBzdHlsZT0iY29sb3I6dmFyKC0tZ3JlZW4pIiBpZD0ibWV0cmljLXNpbWlsYXItMjRoIj7igJQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1zdWIiIGlkPSJtZXRyaWMtc2ltaWxhci1zdWIiPm1vbWVudG9zIGVuIHpvbmEg4omkMSUgbyDiiaQkMTA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im1jYXJkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1sYWJlbCIgaWQ9Im1ldHJpYy1taW4tbGFiZWwiPkJyZWNoYSBtw61uLjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXZhbCIgaWQ9Im1ldHJpYy1taW4tMjRoIj7igJQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1zdWIiIGlkPSJtZXRyaWMtbWluLXN1YiI+bcOtbmltYSBkZWwgcGVyw61vZG8gZmlsdHJhZG88L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im1jYXJkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1sYWJlbCIgaWQ9Im1ldHJpYy1tYXgtbGFiZWwiPkJyZWNoYSBtw6F4LjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXZhbCIgc3R5bGU9ImNvbG9yOnZhcigtLXllbGxvdykiIGlkPSJtZXRyaWMtbWF4LTI0aCI+4oCUPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtc3ViIiBpZD0ibWV0cmljLW1heC1zdWIiPm3DoXhpbWEgZGVsIHBlcsOtb2RvIGZpbHRyYWRvPC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPCEtLSBUQUJMRSAtLT4KICAgIDxkaXYgY2xhc3M9InRhYmxlLWNhcmQiPgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS10b3AiPgogICAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXR0bCI+SGlzdG9yaWFsIGRlIHJlZ2lzdHJvczwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXJpZ2h0Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9InRhYmxlLWNhcCIgaWQ9Imhpc3RvcnktY2FwIj7Dmmx0aW1hcyDigJQgbXVlc3RyYXM8L2Rpdj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0bi1kb3dubG9hZCIgaWQ9ImJ0bi1kb3dubG9hZC1jc3YiIHR5cGU9ImJ1dHRvbiIgYXJpYS1sYWJlbD0iRGVzY2FyZ2FyIENTViI+CiAgICAgICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBhcmlhLWhpZGRlbj0idHJ1ZSI+CiAgICAgICAgICAgICAgPHBhdGggZD0iTTEyIDR2MTAiPjwvcGF0aD4KICAgICAgICAgICAgICA8cGF0aCBkPSJNOCAxMGw0IDQgNC00Ij48L3BhdGg+CiAgICAgICAgICAgICAgPHBhdGggZD0iTTUgMTloMTQiPjwvcGF0aD4KICAgICAgICAgICAgPC9zdmc+CiAgICAgICAgICAgIERlc2NhcmdhciBDU1YKICAgICAgICAgIDwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGlzdG9yeS10YWJsZS13cmFwIj4KICAgICAgPHRhYmxlIGlkPSJoaXN0b3J5LXRhYmxlIj4KICAgICAgICA8Y29sZ3JvdXAgaWQ9Imhpc3RvcnktY29sZ3JvdXAiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iMCI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSIxIj4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjIiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iMyI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSI0Ij4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjUiPgogICAgICAgIDwvY29sZ3JvdXA+CiAgICAgICAgPHRoZWFkPgogICAgICAgICAgPHRyPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+RMOtYSAvIEhvcmE8L3NwYW4+PHNwYW4gY2xhc3M9ImNvbC1yZXNpemVyIiBkYXRhLWNvbC1pbmRleD0iMCIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIETDrWEgLyBIb3JhIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPk1FUDwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSIxIiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgTUVQIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPkNDTDwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSIyIiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgQ0NMIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPkRpZiAkPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjMiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBEaWYgJCI+PC9zcGFuPjwvdGg+CiAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iY29sLWxhYmVsIj5EaWYgJTwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSI0IiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgRGlmICUiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+RXN0YWRvPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjUiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBFc3RhZG8iPjwvc3Bhbj48L3RoPgogICAgICAgICAgPC90cj4KICAgICAgICA8L3RoZWFkPgogICAgICAgIDx0Ym9keSBpZD0iaGlzdG9yeS1yb3dzIj48L3Rib2R5PgogICAgICA8L3RhYmxlPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDwhLS0gR0xPU0FSSU8gLS0+CiAgICA8ZGl2IGNsYXNzPSJnbG9zYXJpbyI+CiAgICAgIDxidXR0b24gY2xhc3M9Imdsb3MtYnRuIiBvbmNsaWNrPSJ0b2dnbGVHbG9zKHRoaXMpIj4KICAgICAgICA8c3Bhbj7wn5OWIEdsb3NhcmlvIGRlIHTDqXJtaW5vczwvc3Bhbj4KICAgICAgICA8c3BhbiBpZD0iZ2xvc0Fycm93Ij7ilr48L3NwYW4+CiAgICAgIDwvYnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJnbG9zLWdyaWQiIGlkPSJnbG9zR3JpZCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPk1FUCB2ZW50YTwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+UHJlY2lvIGRlIHZlbnRhIGRlbCBkw7NsYXIgTUVQIChNZXJjYWRvIEVsZWN0csOzbmljbyBkZSBQYWdvcykgdsOtYSBjb21wcmEvdmVudGEgZGUgYm9ub3MgZW4gJEFSUyB5IFVTRC48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+Q0NMIHZlbnRhPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5Db250YWRvIGNvbiBMaXF1aWRhY2nDs24g4oCUIHNpbWlsYXIgYWwgTUVQIHBlcm8gcGVybWl0ZSB0cmFuc2ZlcmlyIGZvbmRvcyBhbCBleHRlcmlvci4gU3VlbGUgY290aXphciBsZXZlbWVudGUgcG9yIGVuY2ltYS48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+RGlmZXJlbmNpYSAlPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5CcmVjaGEgcmVsYXRpdmEgY2FsY3VsYWRhIGNvbnRyYSBlbCBwcm9tZWRpbyBlbnRyZSBNRVAgeSBDQ0wuIFVtYnJhbCBTSU1JTEFSOiDiiaQgMSUgbyDiiaQgJDEwIEFSUy48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+RnJlc2N1cmEgZGVsIGRhdG88L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPlRpZW1wbyBkZXNkZSBlbCDDumx0aW1vIHRpbWVzdGFtcCBkZSBkb2xhcml0by5hci4gRWwgY3JvbiBjb3JyZSBjYWRhIDUgbWluIGVuIGTDrWFzIGjDoWJpbGVzLjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5Fc3RhZG8gU0lNSUxBUjwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+Q3VhbmRvIE1FUCB5IENDTCBlc3TDoW4gZGVudHJvIGRlbCB1bWJyYWwg4oCUIG1vbWVudG8gaWRlYWwgcGFyYSBvcGVyYXIgYnVzY2FuZG8gcGFyaWRhZCBlbnRyZSBhbWJvcyB0aXBvcy48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+TWVyY2FkbyBBUkc8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPlZlbnRhbmEgb3BlcmF0aXZhOiBsdW5lcyBhIHZpZXJuZXMgZGUgMTA6MzAgYSAxNzo1OSAoR01ULTMsIEJ1ZW5vcyBBaXJlcykuPC9kaXY+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPGZvb3Rlcj4KICAgICAgRnVlbnRlOiA8YSBocmVmPSIjIj5kb2xhcml0by5hcjwvYT4gwrcgPGEgaHJlZj0iIyI+YXJnZW50aW5hZGF0b3MuY29tPC9hPiDCtyBEYXRvcyBjYWRhIDUgbWluIGVuIGTDrWFzIGjDoWJpbGVzIMK3IDxhIGhyZWY9IiMiPlJlcG9ydGFyIHByb2JsZW1hPC9hPgogICAgPC9mb290ZXI+CgogIDwvZGl2PjwhLS0gL21haW4tY29udGVudCAtLT4KCiAgPCEtLSDilZDilZDilZDilZAgRFJBV0VSIOKVkOKVkOKVkOKVkCAtLT4KICA8ZGl2IGNsYXNzPSJkcmF3ZXIiIGlkPSJkcmF3ZXIiPgogICAgPGRpdiBjbGFzcz0iZHJhd2VyLXJlc2l6ZXIiIGlkPSJkcmF3ZXItcmVzaXplciIgYXJpYS1oaWRkZW49InRydWUiPjwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImRyYXdlci1oZWFkZXIiPgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImRyYXdlci10aXRsZSI+8J+TiiBGb25kb3MgQ29tdW5lcyBkZSBJbnZlcnNpw7NuPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZHJhd2VyLXNvdXJjZSI+RnVlbnRlczogYXJnZW50aW5hZGF0b3MuY29tPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4tY2xvc2UiIG9uY2xpY2s9InRvZ2dsZURyYXdlcigpIj7inJU8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImRyYXdlci1ib2R5Ij4KICAgICAgPGRpdiBjbGFzcz0iZmNpLWhlYWRlciI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmNpLXRpdGxlLXdyYXAiPgogICAgICAgICAgPGRpdiBjbGFzcz0iZmNpLXRpdGxlIiBpZD0iZmNpLXRpdGxlIj5SZW50YSBmaWphIChGQ0kgQXJnZW50aW5hKTwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZmNpLXRhYnMiPgogICAgICAgICAgICA8YnV0dG9uIGlkPSJmY2ktdGFiLWZpamEiIGNsYXNzPSJmY2ktdGFiLWJ0biBhY3RpdmUiIHR5cGU9ImJ1dHRvbiI+UmVudGEgZmlqYTwvYnV0dG9uPgogICAgICAgICAgICA8YnV0dG9uIGlkPSJmY2ktdGFiLXZhcmlhYmxlIiBjbGFzcz0iZmNpLXRhYi1idG4iIHR5cGU9ImJ1dHRvbiI+UmVudGEgdmFyaWFibGU8L2J1dHRvbj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZjaS1tZXRhIiBpZD0iZmNpLWxhc3QtZGF0ZSI+RmVjaGE6IOKAlDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmNpLWNvbnRyb2xzIj4KICAgICAgICA8aW5wdXQgaWQ9ImZjaS1zZWFyY2giIGNsYXNzPSJmY2ktc2VhcmNoIiB0eXBlPSJ0ZXh0IiBwbGFjZWhvbGRlcj0iQnVzY2FyIGZvbmRvLi4uIiAvPgogICAgICAgIDxkaXYgY2xhc3M9ImZjaS1wYWdpbmF0aW9uIj4KICAgICAgICAgIDxidXR0b24gaWQ9ImZjaS1wcmV2IiBjbGFzcz0iZmNpLXBhZ2UtYnRuIiB0eXBlPSJidXR0b24iPuKXgDwvYnV0dG9uPgogICAgICAgICAgPGRpdiBpZD0iZmNpLXBhZ2UtaW5mbyIgY2xhc3M9ImZjaS1wYWdlLWluZm8iPjEgLyAxPC9kaXY+CiAgICAgICAgICA8YnV0dG9uIGlkPSJmY2ktbmV4dCIgY2xhc3M9ImZjaS1wYWdlLWJ0biIgdHlwZT0iYnV0dG9uIj7ilrY8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZjaS10YWJsZS13cmFwIj4KICAgICAgICA8dGFibGUgY2xhc3M9ImZjaS10YWJsZSI+CiAgICAgICAgICA8Y29sZ3JvdXAgaWQ9ImZjaS1jb2xncm91cCI+CiAgICAgICAgICAgIDxjb2wgc3R5bGU9IndpZHRoOjI4MHB4Ij4KICAgICAgICAgICAgPGNvbCBzdHlsZT0id2lkdGg6MTUwcHgiPgogICAgICAgICAgICA8Y29sIHN0eWxlPSJ3aWR0aDoxOTBweCI+CiAgICAgICAgICAgIDxjb2wgc3R5bGU9IndpZHRoOjE5MHB4Ij4KICAgICAgICAgICAgPGNvbCBzdHlsZT0id2lkdGg6MTIwcHgiPgogICAgICAgICAgICA8Y29sIHN0eWxlPSJ3aWR0aDoxNjBweCI+CiAgICAgICAgICA8L2NvbGdyb3VwPgogICAgICAgICAgPHRoZWFkPgogICAgICAgICAgICA8dHI+CiAgICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJmY2ktY29sLWxhYmVsIj48c3BhbiBjbGFzcz0idGlwIHRpcC1kb3duIiBkYXRhLXQ9Ik5vbWJyZSBkZWwgRm9uZG8gQ29tw7puIGRlIEludmVyc2nDs24uIj5Gb25kbyDik5g8L3NwYW4+PC9zcGFuPjxzcGFuIGNsYXNzPSJmY2ktY29sLXJlc2l6ZXIiIGRhdGEtZmNpLWNvbC1pbmRleD0iMCIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIEZvbmRvIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImZjaS1jb2wtbGFiZWwiPjxzcGFuIGNsYXNzPSJ0aXAgdGlwLWRvd24iIGRhdGEtdD0iVkNQIOKAlCBWYWxvciBDdW90YXBhcnRlLiBQcmVjaW8gdW5pdGFyaW8gZGUgY2FkYSBjdW90YXBhcnRlLiBVc2FsbyBwYXJhIGNvbXBhcmFyIHJlbmRpbWllbnRvIGVudHJlIGZlY2hhcy4iPlZDUCDik5g8L3NwYW4+PC9zcGFuPjxzcGFuIGNsYXNzPSJmY2ktY29sLXJlc2l6ZXIiIGRhdGEtZmNpLWNvbC1pbmRleD0iMSIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIFZDUCI+PC9zcGFuPjwvdGg+CiAgICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJmY2ktY29sLWxhYmVsIj48c3BhbiBjbGFzcz0idGlwIHRpcC1kb3duIiBkYXRhLXQ9IkNDUCDigJQgQ2FudGlkYWQgZGUgQ3VvdGFwYXJ0ZXMuIFRvdGFsIGRlIGN1b3RhcGFydGVzIGVtaXRpZGFzLiBTdWJlIGN1YW5kbyBlbnRyYW4gaW52ZXJzb3JlcywgYmFqYSBjdWFuZG8gcmVzY2F0YW4uIj5DQ1Ag4pOYPC9zcGFuPjwvc3Bhbj48c3BhbiBjbGFzcz0iZmNpLWNvbC1yZXNpemVyIiBkYXRhLWZjaS1jb2wtaW5kZXg9IjIiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBDQ1AiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iZmNpLWNvbC1sYWJlbCI+PHNwYW4gY2xhc3M9InRpcCB0aXAtZG93biIgZGF0YS10PSJQYXRyaW1vbmlvIOKAlCBWQ1Agw5cgQ0NQLiBWYWxvciB0b3RhbCBhZG1pbmlzdHJhZG8gcG9yIGVsIGZvbmRvIGVuIHBlc29zIGEgZXNhIGZlY2hhLiI+UGF0cmltb25pbyDik5g8L3NwYW4+PC9zcGFuPjxzcGFuIGNsYXNzPSJmY2ktY29sLXJlc2l6ZXIiIGRhdGEtZmNpLWNvbC1pbmRleD0iMyIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIFBhdHJpbW9uaW8iPjwvc3Bhbj48L3RoPgogICAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iZmNpLWNvbC1sYWJlbCI+PHNwYW4gY2xhc3M9InRpcCB0aXAtZG93biIgZGF0YS10PSJIb3Jpem9udGUgZGUgaW52ZXJzacOzbiBzdWdlcmlkbyAoY29ydG8sIG1lZGlvIG8gbGFyZ28pLiI+SG9yaXpvbnRlIOKTmDwvc3Bhbj48L3NwYW4+PHNwYW4gY2xhc3M9ImZjaS1jb2wtcmVzaXplciIgZGF0YS1mY2ktY29sLWluZGV4PSI0IiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgSG9yaXpvbnRlIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImZjaS1jb2wtbGFiZWwiPjxzcGFuIGNsYXNzPSJ0aXAgdGlwLWRvd24iIGRhdGEtdD0iU2XDsWFsIHLDoXBpZGEgdXNhbmRvIHJlbmRpbWllbnRvIG1lbnN1YWwgZXN0aW1hZG8gcG9yIFZDUCB2cyBiZW5jaG1hcmsgZGUgcGxhem8gZmlqbyBlIGluZmxhY2nDs24uIj5TZcOxYWwg4pOYPC9zcGFuPjwvc3Bhbj48c3BhbiBjbGFzcz0iZmNpLWNvbC1yZXNpemVyIiBkYXRhLWZjaS1jb2wtaW5kZXg9IjUiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBTZcOxYWwiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8L3RyPgogICAgICAgICAgPC90aGVhZD4KICAgICAgICAgIDx0Ym9keSBpZD0iZmNpLXJvd3MiPgogICAgICAgICAgICA8dHI+PHRkIGNvbHNwYW49IjYiIGNsYXNzPSJkaW0iPkNhcmdhbmRv4oCmPC90ZD48L3RyPgogICAgICAgICAgPC90Ym9keT4KICAgICAgICA8L3RhYmxlPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmNpLWJlbmNoIiBpZD0iZmNpLWJlbmNoLWluZm8iPkJlbmNobWFyazogY2FyZ2FuZG/igKY8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmNpLWVtcHR5IiBpZD0iZmNpLWVtcHR5IiBzdHlsZT0iZGlzcGxheTpub25lIj4KICAgICAgICBObyBoYXkgZGF0b3MgZGUgRkNJIGRpc3BvbmlibGVzIGVuIGVzdGUgbW9tZW50by4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImNvbnRleHQtYm94Ij4KICAgICAgICA8c3Ryb25nPlRpcDo8L3N0cm9uZz48YnI+CiAgICAgICAgU2UgbGlzdGFuIGxvcyBmb25kb3MgZGUgbGEgc2VyaWUgc2VsZWNjaW9uYWRhIG9yZGVuYWRvcyBwb3IgcGF0cmltb25pbyAoZGUgbWF5b3IgYSBtZW5vcikuPGJyPgogICAgICAgIEVuIGxhcyBjb2x1bW5hcyA8c3Ryb25nPlZDUCwgQ0NQIHkgUGF0cmltb25pbzwvc3Ryb25nPjog4payIHN1YmUgwrcg4pa8IGJhamEgwrcgPSBzaW4gY2FtYmlvcyAodnMgZMOtYSBhbnRlcmlvcikuPGJyPgogICAgICAgIEVuIGxhIGNvbHVtbmEgPHN0cm9uZz5TZcOxYWw8L3N0cm9uZz4gKHNlbcOhZm9ybyBtZW5zdWFsKTo8YnI+CiAgICAgICAg8J+UtCBQRVJESUVORE8gcmluZGUgbWVub3MgcXVlIHBsYXpvIGZpam8geSBxdWUgaW5mbGFjacOzbi48YnI+CiAgICAgICAg8J+foCBPSk8gbGUgZ2FuYSBhbCBwbGF6byBmaWpvLCBwZXJvIHBpZXJkZSBjb250cmEgaW5mbGFjacOzbi48YnI+CiAgICAgICAg8J+foSBBQ0VQVEFCTEUgbGUgZ2FuYSBhIGluZmxhY2nDs24gcG9yIG1lbm9zIGRlIDAuNSBwcC48YnI+CiAgICAgICAg8J+foiBHQU5BTkRPIGxlIGdhbmEgYSBwbGF6byBmaWpvIGUgaW5mbGFjacOzbiBwb3IgbcOhcyBkZSAwLjUgcHAuPGJyPgogICAgICAgIEVzdGEgc2VjY2nDs24gc2UgYWN0dWFsaXphIGF1dG9tw6F0aWNhbWVudGUgY2FkYSB+NSBtaW51dG9zIGVuIGhvcmFyaW8gZGUgbWVyY2FkbyAoTHVuLVZpZSAxMDozMCBhIDE4OjAwLCBHTVQtMykuPGJyPgogICAgICAgIFNpIGZhbHRhIGJhc2UgZGUgY2llcnJlIG1lbnN1YWwgbyBiZW5jaG1hcmssIGxhIHNlw7FhbCBzZSBtdWVzdHJhIGNvbW8gPHN0cm9uZz5zL2RhdG88L3N0cm9uZz4uCiAgICAgIDwvZGl2PgogICAgPC9kaXY+PCEtLSAvZHJhd2VyLWJvZHkgLS0+CiAgPC9kaXY+PCEtLSAvZHJhd2VyIC0tPgoKPC9kaXY+PCEtLSAvYm9keS13cmFwIC0tPgo8L2Rpdj48IS0tIC9hcHAgLS0+CjxkaXYgY2xhc3M9InNtYXJ0LXRpcCIgaWQ9InNtYXJ0LXRpcCIgcm9sZT0idG9vbHRpcCIgYXJpYS1oaWRkZW49InRydWUiPjwvZGl2PgoKPHNjcmlwdD4KICAvLyAxKSBDb25zdGFudGVzIHkgY29uZmlndXJhY2nDs24KICBjb25zdCBFTkRQT0lOVFMgPSB7CiAgICBidW5kbGU6ICcvYXBpL2J1bmRsZScKICB9OwogIGNvbnN0IEFSR19UWiA9ICdBbWVyaWNhL0FyZ2VudGluYS9CdWVub3NfQWlyZXMnOwogIGNvbnN0IEZFVENIX0lOVEVSVkFMX01TID0gMzAwMDAwOwogIGNvbnN0IENBQ0hFX0tFWSA9ICdyYWRhcl9jYWNoZSc7CiAgY29uc3QgSElTVE9SWV9DT0xTX0tFWSA9ICdyYWRhcl9oaXN0b3J5X2NvbF93aWR0aHNfdjEnOwogIGNvbnN0IEZDSV9DT0xTX0tFWSA9ICdyYWRhcl9mY2lfY29sX3dpZHRoc192MSc7CiAgY29uc3QgRFJBV0VSX1dJRFRIX0tFWSA9ICdyYWRhcl9kcmF3ZXJfd2lkdGhfdjEnOwogIGNvbnN0IEZDSV9TSUdOQUxfU1RSRUFLX0tFWSA9ICdyYWRhcl9mY2lfc2lnbmFsX3N0cmVha3NfdjEnOwogIGNvbnN0IENBQ0hFX1RUTF9NUyA9IDE1ICogNjAgKiAxMDAwOwogIGNvbnN0IFJFVFJZX0RFTEFZUyA9IFsxMDAwMCwgMzAwMDAsIDYwMDAwXTsKICBjb25zdCBTSU1JTEFSX1BDVF9USFJFU0hPTEQgPSAxOwogIGNvbnN0IFNJTUlMQVJfQVJTX1RIUkVTSE9MRCA9IDEwOwogIGNvbnN0IFRSRU5EX01BWF9QT0lOVFMgPSAyNDA7CiAgY29uc3QgRkNJX1BBR0VfU0laRSA9IDEwOwogIGNvbnN0IERSQVdFUl9NSU5fVyA9IDM0MDsKICBjb25zdCBEUkFXRVJfTUFYX1cgPSA3NjA7CiAgY29uc3QgSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFMgPSBbMTcwLCAxNjAsIDE2MCwgMTIwLCAxMjAsIDE3MF07CiAgY29uc3QgSElTVE9SWV9NSU5fQ09MX1dJRFRIUyA9IFsxMjAsIDExMCwgMTEwLCA5MCwgOTAsIDEyMF07CiAgY29uc3QgRkNJX0RFRkFVTFRfQ09MX1dJRFRIUyA9IFsyODAsIDE1MCwgMTkwLCAxOTAsIDEyMCwgMTYwXTsKICBjb25zdCBGQ0lfTUlOX0NPTF9XSURUSFMgPSBbMjIwLCAxMjAsIDE1MCwgMTUwLCAxMDAsIDEzMF07CiAgY29uc3QgTlVNRVJJQ19JRFMgPSBbCiAgICAnbWVwLXZhbCcsICdjY2wtdmFsJywgJ2JyZWNoYS1hYnMnLCAnYnJlY2hhLXBjdCcKICBdOwogIGNvbnN0IHN0YXRlID0gewogICAgcmV0cnlJbmRleDogMCwKICAgIHJldHJ5VGltZXI6IG51bGwsCiAgICBsYXN0U3VjY2Vzc0F0OiAwLAogICAgaXNGZXRjaGluZzogZmFsc2UsCiAgICBmaWx0ZXJNb2RlOiAnMWQnLAogICAgbGFzdE1lcFBheWxvYWQ6IG51bGwsCiAgICB0cmVuZFJvd3M6IFtdLAogICAgdHJlbmRIb3ZlckJvdW5kOiBmYWxzZSwKICAgIGhpc3RvcnlSZXNpemVCb3VuZDogZmFsc2UsCiAgICBmY2lSZXNpemVCb3VuZDogZmFsc2UsCiAgICBoaXN0b3J5Q29sV2lkdGhzOiBbXSwKICAgIGZjaUNvbFdpZHRoczogW10sCiAgICBzb3VyY2VUc01zOiBudWxsLAogICAgZnJlc2hCYWRnZU1vZGU6ICdpZGxlJywKICAgIGZyZXNoVGlja2VyOiBudWxsLAogICAgZGF0YUNvbmZpZGVuY2U6ICdOT19EQVRBJywKICAgIHNvdXJjZVN0YXR1c09rOiBmYWxzZSwKICAgIGZjaVR5cGU6ICdmaWphJywKICAgIGZjaVJvd3NCeVR5cGU6IHsgZmlqYTogW10sIHZhcmlhYmxlOiBbXSB9LAogICAgZmNpUHJldmlvdXNCeUZvbmRvQnlUeXBlOiB7IGZpamE6IG5ldyBNYXAoKSwgdmFyaWFibGU6IG5ldyBNYXAoKSB9LAogICAgZmNpQmFzZUJ5Rm9uZG9CeVR5cGU6IHsgZmlqYTogbmV3IE1hcCgpLCB2YXJpYWJsZTogbmV3IE1hcCgpIH0sCiAgICBmY2lCYXNlRGF0ZUJ5VHlwZTogeyBmaWphOiBudWxsLCB2YXJpYWJsZTogbnVsbCB9LAogICAgZmNpQmFzZVRhcmdldERhdGVCeVR5cGU6IHsgZmlqYTogbnVsbCwgdmFyaWFibGU6IG51bGwgfSwKICAgIGZjaURhdGVCeVR5cGU6IHsgZmlqYTogJ+KAlCcsIHZhcmlhYmxlOiAn4oCUJyB9LAogICAgZmNpU2lnbmFsU3RyZWFrczogeyBmaWphOiB7fSwgdmFyaWFibGU6IHt9IH0sCiAgICBmY2lTaWduYWxTdHJlYWtzRGlydHk6IGZhbHNlLAogICAgYmVuY2htYXJrOiB7CiAgICAgIHBsYXpvRmlqb01vbnRobHlQY3Q6IG51bGwsCiAgICAgIGluZmxhY2lvbk1vbnRobHlQY3Q6IG51bGwsCiAgICAgIGluZmxhY2lvbkRhdGU6IG51bGwsCiAgICAgIHVwZGF0ZWRBdEh1bWFuQXJ0OiBudWxsCiAgICB9LAogICAgZmNpUXVlcnk6ICcnLAogICAgZmNpUGFnZTogMSwKICAgIHNtYXJ0VGlwQm91bmQ6IGZhbHNlLAogICAgZHJhd2VyUmVzaXplQm91bmQ6IGZhbHNlLAogICAgbGF0ZXN0OiB7CiAgICAgIG1lcDogbnVsbCwKICAgICAgY2NsOiBudWxsLAogICAgICBicmVjaGFBYnM6IG51bGwsCiAgICAgIGJyZWNoYVBjdDogbnVsbAogICAgfQogIH07CgogIC8vIDIpIEhlbHBlcnMKICBjb25zdCBmbXRBcmdUaW1lID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VzLUFSJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIGhvdXI6ICcyLWRpZ2l0JywKICAgIG1pbnV0ZTogJzItZGlnaXQnCiAgfSk7CiAgY29uc3QgZm10QXJnVGltZVNlYyA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlcy1BUicsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICBob3VyOiAnMi1kaWdpdCcsCiAgICBtaW51dGU6ICcyLWRpZ2l0JywKICAgIHNlY29uZDogJzItZGlnaXQnCiAgfSk7CiAgY29uc3QgZm10QXJnSG91ciA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlcy1BUicsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICBob3VyOiAnMi1kaWdpdCcsCiAgICBtaW51dGU6ICcyLWRpZ2l0JywKICAgIGhvdXIxMjogZmFsc2UKICB9KTsKICBjb25zdCBmbXRBcmdEYXlNb250aCA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlcy1BUicsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICBkYXk6ICcyLWRpZ2l0JywKICAgIG1vbnRoOiAnMi1kaWdpdCcKICB9KTsKICBjb25zdCBmbXRBcmdEYXRlID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VuLUNBJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIHllYXI6ICdudW1lcmljJywKICAgIG1vbnRoOiAnMi1kaWdpdCcsCiAgICBkYXk6ICcyLWRpZ2l0JwogIH0pOwogIGNvbnN0IGZtdEFyZ1dlZWtkYXkgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tVVMnLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgd2Vla2RheTogJ3Nob3J0JwogIH0pOwogIGNvbnN0IGZtdEFyZ1BhcnRzID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VuLVVTJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIHdlZWtkYXk6ICdzaG9ydCcsCiAgICBob3VyOiAnMi1kaWdpdCcsCiAgICBtaW51dGU6ICcyLWRpZ2l0JywKICAgIHNlY29uZDogJzItZGlnaXQnLAogICAgaG91cjEyOiBmYWxzZQogIH0pOwogIGNvbnN0IFdFRUtEQVkgPSB7IE1vbjogMSwgVHVlOiAyLCBXZWQ6IDMsIFRodTogNCwgRnJpOiA1LCBTYXQ6IDYsIFN1bjogNyB9OwoKICBmdW5jdGlvbiB0b051bWJlcih2YWx1ZSkgewogICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkgcmV0dXJuIHZhbHVlOwogICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHsKICAgICAgY29uc3Qgbm9ybWFsaXplZCA9IHZhbHVlLnJlcGxhY2UoL1xzL2csICcnKS5yZXBsYWNlKCcsJywgJy4nKS5yZXBsYWNlKC9bXlxkLi1dL2csICcnKTsKICAgICAgY29uc3QgcGFyc2VkID0gTnVtYmVyKG5vcm1hbGl6ZWQpOwogICAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHBhcnNlZCkgPyBwYXJzZWQgOiBudWxsOwogICAgfQogICAgcmV0dXJuIG51bGw7CiAgfQogIGZ1bmN0aW9uIGdldFBhdGgob2JqLCBwYXRoKSB7CiAgICByZXR1cm4gcGF0aC5yZWR1Y2UoKGFjYywga2V5KSA9PiAoYWNjICYmIGFjY1trZXldICE9PSB1bmRlZmluZWQgPyBhY2Nba2V5XSA6IHVuZGVmaW5lZCksIG9iaik7CiAgfQogIGZ1bmN0aW9uIHBpY2tOdW1iZXIob2JqLCBwYXRocykgewogICAgZm9yIChjb25zdCBwYXRoIG9mIHBhdGhzKSB7CiAgICAgIGNvbnN0IHYgPSBnZXRQYXRoKG9iaiwgcGF0aCk7CiAgICAgIGNvbnN0IG4gPSB0b051bWJlcih2KTsKICAgICAgaWYgKG4gIT09IG51bGwpIHJldHVybiBuOwogICAgfQogICAgcmV0dXJuIG51bGw7CiAgfQogIGZ1bmN0aW9uIHBpY2tCeUtleUhpbnQob2JqLCBoaW50KSB7CiAgICBpZiAoIW9iaiB8fCB0eXBlb2Ygb2JqICE9PSAnb2JqZWN0JykgcmV0dXJuIG51bGw7CiAgICBjb25zdCBsb3dlciA9IGhpbnQudG9Mb3dlckNhc2UoKTsKICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKG9iaikpIHsKICAgICAgaWYgKGsudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhsb3dlcikpIHsKICAgICAgICBjb25zdCBuID0gdG9OdW1iZXIodik7CiAgICAgICAgaWYgKG4gIT09IG51bGwpIHJldHVybiBuOwogICAgICAgIGlmICh2ICYmIHR5cGVvZiB2ID09PSAnb2JqZWN0JykgewogICAgICAgICAgY29uc3QgZGVlcCA9IHBpY2tCeUtleUhpbnQodiwgaGludCk7CiAgICAgICAgICBpZiAoZGVlcCAhPT0gbnVsbCkgcmV0dXJuIGRlZXA7CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmICh2ICYmIHR5cGVvZiB2ID09PSAnb2JqZWN0JykgewogICAgICAgIGNvbnN0IGRlZXAgPSBwaWNrQnlLZXlIaW50KHYsIGhpbnQpOwogICAgICAgIGlmIChkZWVwICE9PSBudWxsKSByZXR1cm4gZGVlcDsKICAgICAgfQogICAgfQogICAgcmV0dXJuIG51bGw7CiAgfQogIGZ1bmN0aW9uIGdldEFyZ05vd1BhcnRzKGRhdGUgPSBuZXcgRGF0ZSgpKSB7CiAgICBjb25zdCBwYXJ0cyA9IGZtdEFyZ1BhcnRzLmZvcm1hdFRvUGFydHMoZGF0ZSkucmVkdWNlKChhY2MsIHApID0+IHsKICAgICAgYWNjW3AudHlwZV0gPSBwLnZhbHVlOwogICAgICByZXR1cm4gYWNjOwogICAgfSwge30pOwogICAgcmV0dXJuIHsKICAgICAgd2Vla2RheTogV0VFS0RBWVtwYXJ0cy53ZWVrZGF5XSB8fCAwLAogICAgICBob3VyOiBOdW1iZXIocGFydHMuaG91ciB8fCAnMCcpLAogICAgICBtaW51dGU6IE51bWJlcihwYXJ0cy5taW51dGUgfHwgJzAnKSwKICAgICAgc2Vjb25kOiBOdW1iZXIocGFydHMuc2Vjb25kIHx8ICcwJykKICAgIH07CiAgfQogIGZ1bmN0aW9uIGJyZWNoYVBlcmNlbnQobWVwLCBjY2wpIHsKICAgIGlmIChtZXAgPT09IG51bGwgfHwgY2NsID09PSBudWxsKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGF2ZyA9IChtZXAgKyBjY2wpIC8gMjsKICAgIGlmICghYXZnKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiAoTWF0aC5hYnMobWVwIC0gY2NsKSAvIGF2ZykgKiAxMDA7CiAgfQogIGZ1bmN0aW9uIGZvcm1hdE1vbmV5KHZhbHVlLCBkaWdpdHMgPSAwKSB7CiAgICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiAn4oCUJzsKICAgIHJldHVybiAnJCcgKyB2YWx1ZS50b0xvY2FsZVN0cmluZygnZXMtQVInLCB7CiAgICAgIG1pbmltdW1GcmFjdGlvbkRpZ2l0czogZGlnaXRzLAogICAgICBtYXhpbXVtRnJhY3Rpb25EaWdpdHM6IGRpZ2l0cwogICAgfSk7CiAgfQogIGZ1bmN0aW9uIGZvcm1hdFBlcmNlbnQodmFsdWUsIGRpZ2l0cyA9IDIpIHsKICAgIGlmICh2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuICfigJQnOwogICAgcmV0dXJuIHZhbHVlLnRvRml4ZWQoZGlnaXRzKSArICclJzsKICB9CiAgZnVuY3Rpb24gZm9ybWF0Q29tcGFjdE1vbmV5KHZhbHVlLCBkaWdpdHMgPSAyKSB7CiAgICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiAn4oCUJzsKICAgIHJldHVybiB2YWx1ZS50b0xvY2FsZVN0cmluZygnZXMtQVInLCB7CiAgICAgIG1pbmltdW1GcmFjdGlvbkRpZ2l0czogZGlnaXRzLAogICAgICBtYXhpbXVtRnJhY3Rpb25EaWdpdHM6IGRpZ2l0cwogICAgfSk7CiAgfQogIGZ1bmN0aW9uIGVzY2FwZUh0bWwodmFsdWUpIHsKICAgIHJldHVybiBTdHJpbmcodmFsdWUgPz8gJycpLnJlcGxhY2UoL1smPD4iJ10vZywgKGNoYXIpID0+ICgKICAgICAgeyAnJic6ICcmYW1wOycsICc8JzogJyZsdDsnLCAnPic6ICcmZ3Q7JywgJyInOiAnJnF1b3Q7JywgIiciOiAnJiMzOTsnIH1bY2hhcl0KICAgICkpOwogIH0KICBmdW5jdGlvbiBzZXRUZXh0KGlkLCB0ZXh0LCBvcHRpb25zID0ge30pIHsKICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwogICAgaWYgKCFlbCkgcmV0dXJuOwogICAgY29uc3QgbmV4dCA9IFN0cmluZyh0ZXh0KTsKICAgIGNvbnN0IHByZXYgPSBlbC50ZXh0Q29udGVudDsKICAgIGVsLnRleHRDb250ZW50ID0gbmV4dDsKICAgIGVsLmNsYXNzTGlzdC5yZW1vdmUoJ3NrZWxldG9uJyk7CiAgICBpZiAob3B0aW9ucy5jaGFuZ2VDbGFzcyAmJiBwcmV2ICE9PSBuZXh0KSB7CiAgICAgIGVsLmNsYXNzTGlzdC5hZGQoJ3ZhbHVlLWNoYW5nZWQnKTsKICAgICAgc2V0VGltZW91dCgoKSA9PiBlbC5jbGFzc0xpc3QucmVtb3ZlKCd2YWx1ZS1jaGFuZ2VkJyksIDYwMCk7CiAgICB9CiAgfQogIGZ1bmN0aW9uIHNldERhc2goaWRzKSB7CiAgICBpZHMuZm9yRWFjaCgoaWQpID0+IHNldFRleHQoaWQsICfigJQnKSk7CiAgfQogIGZ1bmN0aW9uIHNldExvYWRpbmcoaWRzLCBpc0xvYWRpbmcpIHsKICAgIGlkcy5mb3JFYWNoKChpZCkgPT4gewogICAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTsKICAgICAgaWYgKCFlbCkgcmV0dXJuOwogICAgICBlbC5jbGFzc0xpc3QudG9nZ2xlKCdza2VsZXRvbicsIGlzTG9hZGluZyk7CiAgICB9KTsKICB9CiAgZnVuY3Rpb24gc2V0RnJlc2hCYWRnZSh0ZXh0LCBtb2RlKSB7CiAgICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmcmVzaC1iYWRnZScpOwogICAgY29uc3QgbGFiZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZnJlc2gtYmFkZ2UtdGV4dCcpOwogICAgaWYgKCFiYWRnZSB8fCAhbGFiZWwpIHJldHVybjsKICAgIGxhYmVsLnRleHRDb250ZW50ID0gdGV4dDsKICAgIHN0YXRlLmZyZXNoQmFkZ2VNb2RlID0gbW9kZSB8fCAnaWRsZSc7CiAgICBiYWRnZS5jbGFzc0xpc3QudG9nZ2xlKCdmZXRjaGluZycsIG1vZGUgPT09ICdmZXRjaGluZycpOwogICAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZSgnZXJyb3InLCBtb2RlID09PSAnZXJyb3InKTsKICAgIGJhZGdlLm9uY2xpY2sgPSBtb2RlID09PSAnZXJyb3InID8gKCkgPT4gZmV0Y2hBbGwoeyBtYW51YWw6IHRydWUgfSkgOiBudWxsOwogIH0KICBmdW5jdGlvbiBub3JtYWxpemVEYXRhQ29uZmlkZW5jZSh2YWx1ZSkgewogICAgY29uc3Qgbm9ybWFsaXplZCA9IFN0cmluZyh2YWx1ZSB8fCAnJykudG9VcHBlckNhc2UoKTsKICAgIGlmIChub3JtYWxpemVkID09PSAnT0snIHx8IG5vcm1hbGl6ZWQgPT09ICdERUxBWUVEJyB8fCBub3JtYWxpemVkID09PSAnTk9fREFUQScpIHJldHVybiBub3JtYWxpemVkOwogICAgcmV0dXJuIG51bGw7CiAgfQogIGZ1bmN0aW9uIGZvcm1hdFNvdXJjZUFnZUxhYmVsKHRzTXMpIHsKICAgIGxldCBuID0gdG9OdW1iZXIodHNNcyk7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShuKSkgcmV0dXJuIG51bGw7CiAgICBpZiAobiA8IDFlMTIpIG4gKj0gMTAwMDsKICAgIGNvbnN0IGFnZU1pbiA9IE1hdGgubWF4KDAsIE1hdGguZmxvb3IoKERhdGUubm93KCkgLSBuKSAvIDYwMDAwKSk7CiAgICBpZiAoYWdlTWluIDwgNjApIHJldHVybiBgJHthZ2VNaW59IG1pbmA7CiAgICBjb25zdCBoID0gTWF0aC5mbG9vcihhZ2VNaW4gLyA2MCk7CiAgICBjb25zdCBtID0gYWdlTWluICUgNjA7CiAgICByZXR1cm4gbSA9PT0gMCA/IGAke2h9IGhgIDogYCR7aH0gaCAke219IG1pbmA7CiAgfQogIGZ1bmN0aW9uIGFwcGx5RGF0YUNvbmZpZGVuY2VTdGF0ZShyb290LCB7IGZvcmNlQmFkZ2UgPSBmYWxzZSB9ID0ge30pIHsKICAgIGNvbnN0IGNvbmZpZGVuY2UgPSBub3JtYWxpemVEYXRhQ29uZmlkZW5jZShyb290Py5vcGVyYXRpb25hbD8uZGF0YUNvbmZpZGVuY2UpCiAgICAgIHx8IChyb290Py5jdXJyZW50ID8gJ0RFTEFZRUQnIDogJ05PX0RBVEEnKTsKICAgIHN0YXRlLmRhdGFDb25maWRlbmNlID0gY29uZmlkZW5jZTsKICAgIHN0YXRlLnNvdXJjZVN0YXR1c09rID0gcm9vdD8uc291cmNlU3RhdHVzPy5vayA9PT0gdHJ1ZTsKICAgIGNvbnN0IGFnZUxhYmVsID0gTnVtYmVyLmlzRmluaXRlKHN0YXRlLnNvdXJjZVRzTXMpID8gZm9ybWF0U291cmNlQWdlTGFiZWwoc3RhdGUuc291cmNlVHNNcykgOiBudWxsOwoKICAgIGlmIChjb25maWRlbmNlID09PSAnTk9fREFUQScpIHsKICAgICAgc2V0RXJyb3JCYW5uZXIodHJ1ZSwgJ05PX0RBVEEgwrcgTm8gaGF5IHNuYXBzaG90IHbDoWxpZG8gZGlzcG9uaWJsZS4nKTsKICAgICAgaWYgKGZvcmNlQmFkZ2UpIHNldEZyZXNoQmFkZ2UoJ05PX0RBVEEgwrcgU2luIGRhdG9zIHbDoWxpZG9zJywgJ2lkbGUnKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGlmIChjb25maWRlbmNlID09PSAnREVMQVlFRCcpIHsKICAgICAgY29uc3QgZXJyb3JUeXBlID0gdHlwZW9mIHJvb3Q/LnNvdXJjZVN0YXR1cz8uZXJyb3I/LmVycm9yX3R5cGUgPT09ICdzdHJpbmcnCiAgICAgICAgPyByb290LnNvdXJjZVN0YXR1cy5lcnJvci5lcnJvcl90eXBlCiAgICAgICAgOiBudWxsOwogICAgICBjb25zdCBkZXRhaWwgPSBlcnJvclR5cGUgPyBgIMK3IGVycm9yIGZ1ZW50ZTogJHtlcnJvclR5cGV9YCA6ICcnOwogICAgICBzZXRFcnJvckJhbm5lcih0cnVlLCBgREVMQVlFRCDCtyBNb3N0cmFuZG8gw7psdGltbyBzbmFwc2hvdCB2w6FsaWRvJHtkZXRhaWx9LmApOwogICAgICBpZiAoZm9yY2VCYWRnZSkgewogICAgICAgIGNvbnN0IGxhYmVsID0gYWdlTGFiZWwgPyBgw5psdGltYSBhY3R1YWxpemFjacOzbiBoYWNlOiAke2FnZUxhYmVsfWAgOiAnTW9zdHJhbmRvIMO6bHRpbW8gc25hcHNob3QgdsOhbGlkbyc7CiAgICAgICAgc2V0RnJlc2hCYWRnZShgREVMQVlFRCDCtyAke2xhYmVsfWAsICdpZGxlJyk7CiAgICAgIH0KICAgICAgcmV0dXJuOwogICAgfQoKICAgIHNldEVycm9yQmFubmVyKGZhbHNlKTsKICAgIGlmIChmb3JjZUJhZGdlKSB7CiAgICAgIGlmIChhZ2VMYWJlbCkgc2V0RnJlc2hCYWRnZShgT0sgwrcgw5psdGltYSBhY3R1YWxpemFjacOzbiBoYWNlOiAke2FnZUxhYmVsfWAsICdpZGxlJyk7CiAgICAgIGVsc2Ugc2V0RnJlc2hCYWRnZShgT0sgwrcgQWN0dWFsaXphZG8gwrcgJHtmbXRBcmdUaW1lLmZvcm1hdChuZXcgRGF0ZSgpKX1gLCAnaWRsZScpOwogICAgfQogIH0KICBmdW5jdGlvbiByZWZyZXNoRnJlc2hCYWRnZUZyb21Tb3VyY2UoKSB7CiAgICBpZiAoc3RhdGUuZnJlc2hCYWRnZU1vZGUgPT09ICdmZXRjaGluZycgfHwgc3RhdGUuZnJlc2hCYWRnZU1vZGUgPT09ICdlcnJvcicpIHJldHVybjsKICAgIGlmIChzdGF0ZS5kYXRhQ29uZmlkZW5jZSA9PT0gJ05PX0RBVEEnKSB7CiAgICAgIHNldEZyZXNoQmFkZ2UoJ05PX0RBVEEgwrcgU2luIGRhdG9zIHbDoWxpZG9zJywgJ2lkbGUnKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc3QgYWdlTGFiZWwgPSBOdW1iZXIuaXNGaW5pdGUoc3RhdGUuc291cmNlVHNNcykgPyBmb3JtYXRTb3VyY2VBZ2VMYWJlbChzdGF0ZS5zb3VyY2VUc01zKSA6IG51bGw7CiAgICBpZiAoc3RhdGUuZGF0YUNvbmZpZGVuY2UgPT09ICdERUxBWUVEJykgewogICAgICBjb25zdCBsYWJlbCA9IGFnZUxhYmVsID8gYMOabHRpbWEgYWN0dWFsaXphY2nDs24gaGFjZTogJHthZ2VMYWJlbH1gIDogJ01vc3RyYW5kbyDDumx0aW1vIHNuYXBzaG90IHbDoWxpZG8nOwogICAgICBzZXRGcmVzaEJhZGdlKGBERUxBWUVEIMK3ICR7bGFiZWx9YCwgJ2lkbGUnKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKGFnZUxhYmVsKSBzZXRGcmVzaEJhZGdlKGBPSyDCtyDDmmx0aW1hIGFjdHVhbGl6YWNpw7NuIGhhY2U6ICR7YWdlTGFiZWx9YCwgJ2lkbGUnKTsKICB9CiAgZnVuY3Rpb24gc3RhcnRGcmVzaFRpY2tlcigpIHsKICAgIGlmIChzdGF0ZS5mcmVzaFRpY2tlcikgcmV0dXJuOwogICAgc3RhdGUuZnJlc2hUaWNrZXIgPSBzZXRJbnRlcnZhbChyZWZyZXNoRnJlc2hCYWRnZUZyb21Tb3VyY2UsIDMwMDAwKTsKICB9CiAgZnVuY3Rpb24gc2V0TWFya2V0VGFnKGlzT3BlbikgewogICAgY29uc3QgdGFnID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RhZy1tZXJjYWRvJyk7CiAgICBpZiAoIXRhZykgcmV0dXJuOwogICAgdGFnLnRleHRDb250ZW50ID0gaXNPcGVuID8gJ01lcmNhZG8gYWJpZXJ0bycgOiAnTWVyY2FkbyBjZXJyYWRvJzsKICAgIHRhZy5jbGFzc0xpc3QudG9nZ2xlKCdjbG9zZWQnLCAhaXNPcGVuKTsKICB9CiAgZnVuY3Rpb24gc2V0RXJyb3JCYW5uZXIoc2hvdywgdGV4dCkgewogICAgY29uc3QgYmFubmVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Vycm9yLWJhbm5lcicpOwogICAgY29uc3QgbGFiZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXJyb3ItYmFubmVyLXRleHQnKTsKICAgIGlmICghYmFubmVyKSByZXR1cm47CiAgICBpZiAodGV4dCAmJiBsYWJlbCkgbGFiZWwudGV4dENvbnRlbnQgPSB0ZXh0OwogICAgYmFubmVyLmNsYXNzTGlzdC50b2dnbGUoJ3Nob3cnLCAhIXNob3cpOwogIH0KICBmdW5jdGlvbiBleHRyYWN0Um9vdChqc29uKSB7CiAgICByZXR1cm4ganNvbiAmJiB0eXBlb2YganNvbiA9PT0gJ29iamVjdCcgPyAoanNvbi5kYXRhIHx8IGpzb24ucmVzdWx0IHx8IGpzb24pIDoge307CiAgfQogIGZ1bmN0aW9uIG5vcm1hbGl6ZUZjaVJvd3MocGF5bG9hZCkgewogICAgY29uc3Qgcm9vdCA9IGV4dHJhY3RSb290KHBheWxvYWQpOwogICAgaWYgKEFycmF5LmlzQXJyYXkocm9vdCkpIHJldHVybiByb290OwogICAgaWYgKEFycmF5LmlzQXJyYXkocm9vdD8uaXRlbXMpKSByZXR1cm4gcm9vdC5pdGVtczsKICAgIGlmIChBcnJheS5pc0FycmF5KHJvb3Q/LnJvd3MpKSByZXR1cm4gcm9vdC5yb3dzOwogICAgcmV0dXJuIFtdOwogIH0KICBmdW5jdGlvbiBub3JtYWxpemVGY2lGb25kb0tleSh2YWx1ZSkgewogICAgcmV0dXJuIFN0cmluZyh2YWx1ZSB8fCAnJykKICAgICAgLnRvTG93ZXJDYXNlKCkKICAgICAgLm5vcm1hbGl6ZSgnTkZEJykKICAgICAgLnJlcGxhY2UoL1tcdTAzMDAtXHUwMzZmXS9nLCAnJykKICAgICAgLnJlcGxhY2UoL1xzKy9nLCAnICcpCiAgICAgIC50cmltKCk7CiAgfQogIGZ1bmN0aW9uIGZjaVRyZW5kRGlyKGN1cnJlbnQsIHByZXZpb3VzKSB7CiAgICBjb25zdCBjdXJyID0gdG9OdW1iZXIoY3VycmVudCk7CiAgICBjb25zdCBwcmV2ID0gdG9OdW1iZXIocHJldmlvdXMpOwogICAgaWYgKGN1cnIgPT09IG51bGwgfHwgcHJldiA9PT0gbnVsbCkgcmV0dXJuICduYSc7CiAgICBpZiAoTWF0aC5hYnMoY3VyciAtIHByZXYpIDwgMWUtOSkgcmV0dXJuICdmbGF0JzsKICAgIHJldHVybiBjdXJyID4gcHJldiA/ICd1cCcgOiAnZG93bic7CiAgfQogIGZ1bmN0aW9uIGZjaVRyZW5kTGFiZWwoZGlyKSB7CiAgICBpZiAoZGlyID09PSAndXAnKSByZXR1cm4gJ1N1YmnDsyB2cyBkw61hIGFudGVyaW9yJzsKICAgIGlmIChkaXIgPT09ICdkb3duJykgcmV0dXJuICdCYWrDsyB2cyBkw61hIGFudGVyaW9yJzsKICAgIGlmIChkaXIgPT09ICdmbGF0JykgcmV0dXJuICdTaW4gY2FtYmlvcyB2cyBkw61hIGFudGVyaW9yJzsKICAgIHJldHVybiAnU2luIGRhdG8gZGVsIGTDrWEgYW50ZXJpb3InOwogIH0KICBmdW5jdGlvbiByZW5kZXJGY2lUcmVuZFZhbHVlKHZhbHVlLCBkaXIpIHsKICAgIGNvbnN0IGRpcmVjdGlvbiA9IGRpciB8fCAnbmEnOwogICAgY29uc3QgaWNvbiA9IGRpcmVjdGlvbiA9PT0gJ3VwJyA/ICfilrInIDogZGlyZWN0aW9uID09PSAnZG93bicgPyAn4pa8JyA6IGRpcmVjdGlvbiA9PT0gJ2ZsYXQnID8gJz0nIDogJ8K3JzsKICAgIHJldHVybiBgPHNwYW4gY2xhc3M9ImZjaS10cmVuZCAke2RpcmVjdGlvbn0iIHRpdGxlPSIke2VzY2FwZUh0bWwoZmNpVHJlbmRMYWJlbChkaXJlY3Rpb24pKX0iPjxzcGFuIGNsYXNzPSJmY2ktdHJlbmQtaWNvbiI+JHtpY29ufTwvc3Bhbj48c3Bhbj4ke2Zvcm1hdENvbXBhY3RNb25leSh2YWx1ZSwgMil9PC9zcGFuPjwvc3Bhbj5gOwogIH0KICBmdW5jdGlvbiByb3VuZDJuKHZhbHVlKSB7CiAgICBjb25zdCBuID0gTnVtYmVyKHZhbHVlKTsKICAgIGlmICghTnVtYmVyLmlzRmluaXRlKG4pKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiBNYXRoLnJvdW5kKG4gKiAxMDApIC8gMTAwOwogIH0KICBmdW5jdGlvbiBjb21wdXRlTW9udGhseVBjdCh2Y3AsIGJhc2VWY3ApIHsKICAgIGNvbnN0IGN1cnIgPSB0b051bWJlcih2Y3ApOwogICAgY29uc3QgcHJldiA9IHRvTnVtYmVyKGJhc2VWY3ApOwogICAgaWYgKGN1cnIgPT09IG51bGwgfHwgcHJldiA9PT0gbnVsbCB8fCBwcmV2IDw9IDApIHJldHVybiBudWxsOwogICAgcmV0dXJuIHJvdW5kMm4oKChjdXJyIC0gcHJldikgLyBwcmV2KSAqIDEwMCk7CiAgfQogIGZ1bmN0aW9uIGZvcm1hdFBjdFZhbCh2YWx1ZSkgewogICAgcmV0dXJuIHZhbHVlID09PSBudWxsID8gJ+KAlCcgOiBgJHt2YWx1ZS50b0ZpeGVkKDIpfSVgOwogIH0KICBmdW5jdGlvbiB0b01vbnRoS2V5KGRhdGVTdHIpIHsKICAgIGlmICh0eXBlb2YgZGF0ZVN0ciAhPT0gJ3N0cmluZycpIHJldHVybiBudWxsOwogICAgY29uc3QgY2xlYW4gPSBkYXRlU3RyLnRyaW0oKTsKICAgIGlmICgvXlxkezR9LVxkezJ9LVxkezJ9JC8udGVzdChjbGVhbikpIHJldHVybiBjbGVhbi5zbGljZSgwLCA3KTsKICAgIHJldHVybiBudWxsOwogIH0KICBmdW5jdGlvbiBsb2FkRmNpU2lnbmFsU3RyZWFrcygpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJhdyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKEZDSV9TSUdOQUxfU1RSRUFLX0tFWSk7CiAgICAgIGlmICghcmF3KSByZXR1cm4geyBmaWphOiB7fSwgdmFyaWFibGU6IHt9IH07CiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTsKICAgICAgcmV0dXJuIHsKICAgICAgICBmaWphOiBwYXJzZWQ/LmZpamEgJiYgdHlwZW9mIHBhcnNlZC5maWphID09PSAnb2JqZWN0JyA/IHBhcnNlZC5maWphIDoge30sCiAgICAgICAgdmFyaWFibGU6IHBhcnNlZD8udmFyaWFibGUgJiYgdHlwZW9mIHBhcnNlZC52YXJpYWJsZSA9PT0gJ29iamVjdCcgPyBwYXJzZWQudmFyaWFibGUgOiB7fQogICAgICB9OwogICAgfSBjYXRjaCB7CiAgICAgIHJldHVybiB7IGZpamE6IHt9LCB2YXJpYWJsZToge30gfTsKICAgIH0KICB9CiAgZnVuY3Rpb24gc2F2ZUZjaVNpZ25hbFN0cmVha3MoKSB7CiAgICBpZiAoIXN0YXRlLmZjaVNpZ25hbFN0cmVha3NEaXJ0eSkgcmV0dXJuOwogICAgdHJ5IHsKICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oRkNJX1NJR05BTF9TVFJFQUtfS0VZLCBKU09OLnN0cmluZ2lmeShzdGF0ZS5mY2lTaWduYWxTdHJlYWtzKSk7CiAgICAgIHN0YXRlLmZjaVNpZ25hbFN0cmVha3NEaXJ0eSA9IGZhbHNlOwogICAgfSBjYXRjaCB7fQogIH0KICBmdW5jdGlvbiByZXNvbHZlRmNpU2lnbmFsU3RyZWFrKHR5cGUsIGZvbmRvS2V5LCBsZXZlbCwgbW9udGhLZXkpIHsKICAgIGlmICghdHlwZSB8fCAhZm9uZG9LZXkgfHwgIW1vbnRoS2V5IHx8ICFsZXZlbCB8fCBsZXZlbCA9PT0gJ25hJykgcmV0dXJuIG51bGw7CiAgICBjb25zdCBieVR5cGUgPSBzdGF0ZS5mY2lTaWduYWxTdHJlYWtzW3R5cGVdIHx8IChzdGF0ZS5mY2lTaWduYWxTdHJlYWtzW3R5cGVdID0ge30pOwogICAgY29uc3QgY3VycmVudCA9IGJ5VHlwZVtmb25kb0tleV07CiAgICBpZiAoIWN1cnJlbnQpIHsKICAgICAgYnlUeXBlW2ZvbmRvS2V5XSA9IHsgbGV2ZWwsIG1vbnRoS2V5LCBtb250aHM6IDEgfTsKICAgICAgc3RhdGUuZmNpU2lnbmFsU3RyZWFrc0RpcnR5ID0gdHJ1ZTsKICAgICAgcmV0dXJuIDE7CiAgICB9CiAgICBjb25zdCBwcmV2TW9udGhzID0gTnVtYmVyLmlzRmluaXRlKE51bWJlcihjdXJyZW50Lm1vbnRocykpID8gTnVtYmVyKGN1cnJlbnQubW9udGhzKSA6IDE7CiAgICBpZiAoY3VycmVudC5tb250aEtleSA9PT0gbW9udGhLZXkpIHsKICAgICAgaWYgKGN1cnJlbnQubGV2ZWwgIT09IGxldmVsKSB7CiAgICAgICAgY3VycmVudC5sZXZlbCA9IGxldmVsOwogICAgICAgIGN1cnJlbnQubW9udGhzID0gMTsKICAgICAgICBzdGF0ZS5mY2lTaWduYWxTdHJlYWtzRGlydHkgPSB0cnVlOwogICAgICAgIHJldHVybiAxOwogICAgICB9CiAgICAgIHJldHVybiBwcmV2TW9udGhzOwogICAgfQogICAgY3VycmVudC5tb250aHMgPSBjdXJyZW50LmxldmVsID09PSBsZXZlbCA/IHByZXZNb250aHMgKyAxIDogMTsKICAgIGN1cnJlbnQubGV2ZWwgPSBsZXZlbDsKICAgIGN1cnJlbnQubW9udGhLZXkgPSBtb250aEtleTsKICAgIHN0YXRlLmZjaVNpZ25hbFN0cmVha3NEaXJ0eSA9IHRydWU7CiAgICByZXR1cm4gY3VycmVudC5tb250aHM7CiAgfQogIGZ1bmN0aW9uIHJlbmRlckZjaVNpZ25hbEJhZGdlKHNpZ25hbCkgewogICAgY29uc3QgcyA9IHNpZ25hbCB8fCB7IGtpbmQ6ICduYScsIGxhYmVsOiAncy9kYXRvJywgZGV0YWlsOiAnJywgc3RyZWFrTW9udGhzOiBudWxsIH07CiAgICBjb25zdCBzdHJlYWtWYWx1ZSA9IE51bWJlcihzLnN0cmVha01vbnRocyk7CiAgICBjb25zdCBzdHJlYWsgPSBOdW1iZXIuaXNGaW5pdGUoc3RyZWFrVmFsdWUpICYmIHN0cmVha1ZhbHVlID49IDEKICAgICAgPyBgPHNwYW4gY2xhc3M9ImZjaS1zaWduYWwtc3RyZWFrIj5MbGV2YSAke3Muc3RyZWFrTW9udGhzfSAke051bWJlcihzLnN0cmVha01vbnRocykgPT09IDEgPyAnbWVzJyA6ICdtZXNlcyd9IGVuIGVzdGUgZXN0YWRvLjwvc3Bhbj5gCiAgICAgIDogJyc7CiAgICByZXR1cm4gYDxzcGFuIGNsYXNzPSJmY2ktc2lnbmFsLXdyYXAiPjxzcGFuIGNsYXNzPSJmY2ktc2lnbmFsICR7cy5raW5kfSIgdGl0bGU9IiR7ZXNjYXBlSHRtbChzLmRldGFpbCB8fCBzLmxhYmVsKX0iPiR7ZXNjYXBlSHRtbChzLmxhYmVsKX08L3NwYW4+JHtzdHJlYWt9PC9zcGFuPmA7CiAgfQogIGZ1bmN0aW9uIGNvbXB1dGVGY2lTaWduYWwocm93LCB0eXBlKSB7CiAgICBjb25zdCBtb250aGx5UGN0ID0gdG9OdW1iZXIocm93Lm1vbnRobHlQY3QpOwogICAgY29uc3QgcGYgPSB0b051bWJlcihzdGF0ZS5iZW5jaG1hcmsucGxhem9GaWpvTW9udGhseVBjdCk7CiAgICBjb25zdCBpbmYgPSB0b051bWJlcihzdGF0ZS5iZW5jaG1hcmsuaW5mbGFjaW9uTW9udGhseVBjdCk7CiAgICBpZiAobW9udGhseVBjdCA9PT0gbnVsbCB8fCBwZiA9PT0gbnVsbCB8fCBpbmYgPT09IG51bGwpIHsKICAgICAgcmV0dXJuIHsga2luZDogJ25hJywgbGV2ZWw6ICduYScsIGxhYmVsOiAncy9kYXRvJywgZGV0YWlsOiAnRGF0byBpbnN1ZmljaWVudGUgcGFyYSBzZcOxYWwgcm9idXN0YSBtZW5zdWFsIChzZSByZXF1aWVyZSBiYXNlIGRlIGNpZXJyZSBtZW5zdWFsICsgUEYgKyBpbmZsYWNpw7NuKS4nLCBzdHJlYWtNb250aHM6IG51bGwgfTsKICAgIH0KICAgIGNvbnN0IG1hcmdpblZzSW5mID0gcm91bmQybihtb250aGx5UGN0IC0gaW5mKTsKICAgIGNvbnN0IGRldGFpbCA9IGBSZW5kLiBtZW5zdWFsIEZDSSAoY2llcnJlIG1lbnN1YWwpOiAke2Zvcm1hdFBjdFZhbChtb250aGx5UGN0KX0gwrcgUEYgbWVuc3VhbCAoVEVNKTogJHtmb3JtYXRQY3RWYWwocGYpfSDCtyBJbmZsYWNpw7NuIG1lbnN1YWw6ICR7Zm9ybWF0UGN0VmFsKGluZil9YDsKICAgIGxldCBzaWduYWwgPSBudWxsOwogICAgaWYgKG1vbnRobHlQY3QgPCBwZiAmJiBtb250aGx5UGN0IDwgaW5mKSB7CiAgICAgIHNpZ25hbCA9IHsga2luZDogJ2JhZCcsIGxldmVsOiAncGVyZGllbmRvJywgbGFiZWw6ICfwn5S0IFBFUkRJRU5ETycsIGRldGFpbCB9OwogICAgfSBlbHNlIGlmIChtb250aGx5UGN0ID49IHBmICYmIG1vbnRobHlQY3QgPCBpbmYpIHsKICAgICAgc2lnbmFsID0geyBraW5kOiAnb2pvJywgbGV2ZWw6ICdvam8nLCBsYWJlbDogJ/Cfn6AgT0pPJywgZGV0YWlsIH07CiAgICB9IGVsc2UgaWYgKG1vbnRobHlQY3QgPj0gaW5mICYmIG1hcmdpblZzSW5mIDw9IDAuNSkgewogICAgICBzaWduYWwgPSB7IGtpbmQ6ICd3YXJuJywgbGV2ZWw6ICdhY2VwdGFibGUnLCBsYWJlbDogJ/Cfn6EgQUNFUFRBQkxFJywgZGV0YWlsIH07CiAgICB9IGVsc2UgaWYgKG1vbnRobHlQY3QgPiBwZiAmJiBtYXJnaW5Wc0luZiA+IDAuNSkgewogICAgICBzaWduYWwgPSB7IGtpbmQ6ICdnb29kJywgbGV2ZWw6ICdnYW5hbmRvJywgbGFiZWw6ICfwn5+iIEdBTkFORE8nLCBkZXRhaWwgfTsKICAgIH0gZWxzZSB7CiAgICAgIHNpZ25hbCA9IHsga2luZDogJ3dhcm4nLCBsZXZlbDogJ2FjZXB0YWJsZScsIGxhYmVsOiAn8J+foSBBQ0VQVEFCTEUnLCBkZXRhaWwgfTsKICAgIH0KICAgIGNvbnN0IG1vbnRoS2V5ID0gdG9Nb250aEtleShyb3cuZmVjaGEpOwogICAgY29uc3Qgc3RyZWFrTW9udGhzID0gcmVzb2x2ZUZjaVNpZ25hbFN0cmVhayh0eXBlLCBub3JtYWxpemVGY2lGb25kb0tleShyb3cuZm9uZG8pLCBzaWduYWwubGV2ZWwsIG1vbnRoS2V5KTsKICAgIHJldHVybiB7IC4uLnNpZ25hbCwgc3RyZWFrTW9udGhzIH07CiAgfQogIGZ1bmN0aW9uIHJlbmRlckZjaUJlbmNobWFya0luZm8oKSB7CiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktYmVuY2gtaW5mbycpOwogICAgaWYgKCFlbCkgcmV0dXJuOwogICAgY29uc3QgcGYgPSB0b051bWJlcihzdGF0ZS5iZW5jaG1hcmsucGxhem9GaWpvTW9udGhseVBjdCk7CiAgICBjb25zdCBpbmYgPSB0b051bWJlcihzdGF0ZS5iZW5jaG1hcmsuaW5mbGFjaW9uTW9udGhseVBjdCk7CiAgICBjb25zdCBpbmZEYXRlID0gc3RhdGUuYmVuY2htYXJrLmluZmxhY2lvbkRhdGUgfHwgJ+KAlCc7CiAgICBjb25zdCBiYXNlRGF0ZSA9IHN0YXRlLmZjaUJhc2VEYXRlQnlUeXBlW3N0YXRlLmZjaVR5cGVdIHx8ICfigJQnOwogICAgY29uc3QgYmFzZVRhcmdldERhdGUgPSBzdGF0ZS5mY2lCYXNlVGFyZ2V0RGF0ZUJ5VHlwZVtzdGF0ZS5mY2lUeXBlXSB8fCAn4oCUJzsKICAgIGlmIChwZiA9PT0gbnVsbCAmJiBpbmYgPT09IG51bGwpIHsKICAgICAgZWwuaW5uZXJIVE1MID0gJ0JlbmNobWFyazogc2luIGRhdG9zIGRlIHJlZmVyZW5jaWEgcG9yIGFob3JhLic7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IHVwZGF0ZWQgPSBzdGF0ZS5iZW5jaG1hcmsudXBkYXRlZEF0SHVtYW5BcnQgPyBgIMK3IEFjdHVhbGl6YWRvOiAke2VzY2FwZUh0bWwoc3RhdGUuYmVuY2htYXJrLnVwZGF0ZWRBdEh1bWFuQXJ0KX1gIDogJyc7CiAgICBlbC5pbm5lckhUTUwgPSBgPHN0cm9uZz5CZW5jaG1hcms6PC9zdHJvbmc+IFBGIG1lbnN1YWwgKFRFTSkgJHtmb3JtYXRQY3RWYWwocGYpfSDCtyBJbmZsYWNpw7NuIG1lbnN1YWwgKCR7ZXNjYXBlSHRtbChpbmZEYXRlKX0pICR7Zm9ybWF0UGN0VmFsKGluZil9IMK3IEJhc2UgRkNJICR7ZXNjYXBlSHRtbChiYXNlRGF0ZSl9IChvYmpldGl2byAke2VzY2FwZUh0bWwoYmFzZVRhcmdldERhdGUpfSkke3VwZGF0ZWR9YDsKICB9CiAgZnVuY3Rpb24gZ2V0SGlzdG9yeUNvbEVsZW1lbnRzKCkgewogICAgY29uc3QgY29sZ3JvdXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGlzdG9yeS1jb2xncm91cCcpOwogICAgcmV0dXJuIGNvbGdyb3VwID8gQXJyYXkuZnJvbShjb2xncm91cC5xdWVyeVNlbGVjdG9yQWxsKCdjb2wnKSkgOiBbXTsKICB9CiAgZnVuY3Rpb24gY2xhbXBIaXN0b3J5V2lkdGhzKHdpZHRocykgewogICAgcmV0dXJuIEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTLm1hcCgoZmFsbGJhY2ssIGkpID0+IHsKICAgICAgY29uc3QgcmF3ID0gTnVtYmVyKHdpZHRocz8uW2ldKTsKICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUocmF3KSkgcmV0dXJuIGZhbGxiYWNrOwogICAgICBjb25zdCBtaW4gPSBISVNUT1JZX01JTl9DT0xfV0lEVEhTW2ldID8/IDgwOwogICAgICByZXR1cm4gTWF0aC5tYXgobWluLCBNYXRoLnJvdW5kKHJhdykpOwogICAgfSk7CiAgfQogIGZ1bmN0aW9uIHNhdmVIaXN0b3J5Q29sdW1uV2lkdGhzKHdpZHRocykgewogICAgdHJ5IHsKICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oSElTVE9SWV9DT0xTX0tFWSwgSlNPTi5zdHJpbmdpZnkoY2xhbXBIaXN0b3J5V2lkdGhzKHdpZHRocykpKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgY29uc29sZS5lcnJvcignW1JhZGFyTUVQXSBubyBzZSBwdWRvIGd1YXJkYXIgYW5jaG9zIGRlIGNvbHVtbmFzJywgZSk7CiAgICB9CiAgfQogIGZ1bmN0aW9uIGxvYWRIaXN0b3J5Q29sdW1uV2lkdGhzKCkgewogICAgdHJ5IHsKICAgICAgY29uc3QgcmF3ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oSElTVE9SWV9DT0xTX0tFWSk7CiAgICAgIGlmICghcmF3KSByZXR1cm4gbnVsbDsKICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpOwogICAgICBpZiAoIUFycmF5LmlzQXJyYXkocGFyc2VkKSB8fCBwYXJzZWQubGVuZ3RoICE9PSBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIUy5sZW5ndGgpIHJldHVybiBudWxsOwogICAgICByZXR1cm4gY2xhbXBIaXN0b3J5V2lkdGhzKHBhcnNlZCk7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tSYWRhck1FUF0gYW5jaG9zIGRlIGNvbHVtbmFzIGludsOhbGlkb3MnLCBlKTsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQogIGZ1bmN0aW9uIGFwcGx5SGlzdG9yeUNvbHVtbldpZHRocyh3aWR0aHMsIHBlcnNpc3QgPSBmYWxzZSkgewogICAgY29uc3QgY29scyA9IGdldEhpc3RvcnlDb2xFbGVtZW50cygpOwogICAgaWYgKGNvbHMubGVuZ3RoICE9PSBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIUy5sZW5ndGgpIHJldHVybjsKICAgIGNvbnN0IG5leHQgPSBjbGFtcEhpc3RvcnlXaWR0aHMod2lkdGhzKTsKICAgIGNvbHMuZm9yRWFjaCgoY29sLCBpKSA9PiB7CiAgICAgIGNvbC5zdHlsZS53aWR0aCA9IGAke25leHRbaV19cHhgOwogICAgfSk7CiAgICBzdGF0ZS5oaXN0b3J5Q29sV2lkdGhzID0gbmV4dDsKICAgIGlmIChwZXJzaXN0KSBzYXZlSGlzdG9yeUNvbHVtbldpZHRocyhuZXh0KTsKICB9CiAgZnVuY3Rpb24gaW5pdEhpc3RvcnlDb2x1bW5XaWR0aHMoKSB7CiAgICBjb25zdCBzYXZlZCA9IGxvYWRIaXN0b3J5Q29sdW1uV2lkdGhzKCk7CiAgICBhcHBseUhpc3RvcnlDb2x1bW5XaWR0aHMoc2F2ZWQgfHwgSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFMsIGZhbHNlKTsKICB9CiAgZnVuY3Rpb24gYmluZEhpc3RvcnlDb2x1bW5SZXNpemUoKSB7CiAgICBpZiAoc3RhdGUuaGlzdG9yeVJlc2l6ZUJvdW5kKSByZXR1cm47CiAgICBjb25zdCB0YWJsZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoaXN0b3J5LXRhYmxlJyk7CiAgICBpZiAoIXRhYmxlKSByZXR1cm47CiAgICBjb25zdCBoYW5kbGVzID0gQXJyYXkuZnJvbSh0YWJsZS5xdWVyeVNlbGVjdG9yQWxsKCcuY29sLXJlc2l6ZXInKSk7CiAgICBpZiAoIWhhbmRsZXMubGVuZ3RoKSByZXR1cm47CiAgICBzdGF0ZS5oaXN0b3J5UmVzaXplQm91bmQgPSB0cnVlOwoKICAgIGhhbmRsZXMuZm9yRWFjaCgoaGFuZGxlKSA9PiB7CiAgICAgIGhhbmRsZS5hZGRFdmVudExpc3RlbmVyKCdkYmxjbGljaycsIChldmVudCkgPT4gewogICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgY29uc3QgaWR4ID0gTnVtYmVyKGhhbmRsZS5kYXRhc2V0LmNvbEluZGV4KTsKICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShpZHgpKSByZXR1cm47CiAgICAgICAgY29uc3QgbmV4dCA9IHN0YXRlLmhpc3RvcnlDb2xXaWR0aHMuc2xpY2UoKTsKICAgICAgICBuZXh0W2lkeF0gPSBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIU1tpZHhdOwogICAgICAgIGFwcGx5SGlzdG9yeUNvbHVtbldpZHRocyhuZXh0LCB0cnVlKTsKICAgICAgfSk7CiAgICAgIGhhbmRsZS5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVyZG93bicsIChldmVudCkgPT4gewogICAgICAgIGlmIChldmVudC5idXR0b24gIT09IDApIHJldHVybjsKICAgICAgICBjb25zdCBpZHggPSBOdW1iZXIoaGFuZGxlLmRhdGFzZXQuY29sSW5kZXgpOwogICAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGlkeCkpIHJldHVybjsKICAgICAgICBjb25zdCBzdGFydFggPSBldmVudC5jbGllbnRYOwogICAgICAgIGNvbnN0IHN0YXJ0V2lkdGggPSBzdGF0ZS5oaXN0b3J5Q29sV2lkdGhzW2lkeF0gPz8gSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFNbaWR4XTsKICAgICAgICBoYW5kbGUuY2xhc3NMaXN0LmFkZCgnYWN0aXZlJyk7CiAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKCiAgICAgICAgY29uc3Qgb25Nb3ZlID0gKG1vdmVFdmVudCkgPT4gewogICAgICAgICAgY29uc3QgZGVsdGEgPSBtb3ZlRXZlbnQuY2xpZW50WCAtIHN0YXJ0WDsKICAgICAgICAgIGNvbnN0IG1pbiA9IEhJU1RPUllfTUlOX0NPTF9XSURUSFNbaWR4XSA/PyA4MDsKICAgICAgICAgIGNvbnN0IG5leHRXaWR0aCA9IE1hdGgubWF4KG1pbiwgTWF0aC5yb3VuZChzdGFydFdpZHRoICsgZGVsdGEpKTsKICAgICAgICAgIGNvbnN0IG5leHQgPSBzdGF0ZS5oaXN0b3J5Q29sV2lkdGhzLnNsaWNlKCk7CiAgICAgICAgICBuZXh0W2lkeF0gPSBuZXh0V2lkdGg7CiAgICAgICAgICBhcHBseUhpc3RvcnlDb2x1bW5XaWR0aHMobmV4dCwgZmFsc2UpOwogICAgICAgIH07CiAgICAgICAgY29uc3Qgb25VcCA9ICgpID0+IHsKICAgICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdwb2ludGVybW92ZScsIG9uTW92ZSk7CiAgICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcnVwJywgb25VcCk7CiAgICAgICAgICBoYW5kbGUuY2xhc3NMaXN0LnJlbW92ZSgnYWN0aXZlJyk7CiAgICAgICAgICBzYXZlSGlzdG9yeUNvbHVtbldpZHRocyhzdGF0ZS5oaXN0b3J5Q29sV2lkdGhzKTsKICAgICAgICB9OwogICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVybW92ZScsIG9uTW92ZSk7CiAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJ1cCcsIG9uVXApOwogICAgICB9KTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gZ2V0RmNpQ29sRWxlbWVudHMoKSB7CiAgICBjb25zdCBjb2xncm91cCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktY29sZ3JvdXAnKTsKICAgIHJldHVybiBjb2xncm91cCA/IEFycmF5LmZyb20oY29sZ3JvdXAucXVlcnlTZWxlY3RvckFsbCgnY29sJykpIDogW107CiAgfQogIGZ1bmN0aW9uIGNsYW1wRmNpV2lkdGhzKHdpZHRocykgewogICAgcmV0dXJuIEZDSV9ERUZBVUxUX0NPTF9XSURUSFMubWFwKChmYWxsYmFjaywgaSkgPT4gewogICAgICBjb25zdCByYXcgPSBOdW1iZXIod2lkdGhzPy5baV0pOwogICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShyYXcpKSByZXR1cm4gZmFsbGJhY2s7CiAgICAgIGNvbnN0IG1pbiA9IEZDSV9NSU5fQ09MX1dJRFRIU1tpXSA/PyA4MDsKICAgICAgcmV0dXJuIE1hdGgubWF4KG1pbiwgTWF0aC5yb3VuZChyYXcpKTsKICAgIH0pOwogIH0KICBmdW5jdGlvbiBzYXZlRmNpQ29sdW1uV2lkdGhzKHdpZHRocykgewogICAgdHJ5IHsKICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oRkNJX0NPTFNfS0VZLCBKU09OLnN0cmluZ2lmeShjbGFtcEZjaVdpZHRocyh3aWR0aHMpKSk7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tSYWRhck1FUF0gbm8gc2UgcHVkbyBndWFyZGFyIGFuY2hvcyBkZSBjb2x1bW5hcyBGQ0knLCBlKTsKICAgIH0KICB9CiAgZnVuY3Rpb24gbG9hZEZjaUNvbHVtbldpZHRocygpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJhdyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKEZDSV9DT0xTX0tFWSk7CiAgICAgIGlmICghcmF3KSByZXR1cm4gbnVsbDsKICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpOwogICAgICBpZiAoIUFycmF5LmlzQXJyYXkocGFyc2VkKSB8fCBwYXJzZWQubGVuZ3RoICE9PSBGQ0lfREVGQVVMVF9DT0xfV0lEVEhTLmxlbmd0aCkgcmV0dXJuIG51bGw7CiAgICAgIHJldHVybiBjbGFtcEZjaVdpZHRocyhwYXJzZWQpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBjb25zb2xlLmVycm9yKCdbUmFkYXJNRVBdIGFuY2hvcyBkZSBjb2x1bW5hcyBGQ0kgaW52w6FsaWRvcycsIGUpOwogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CiAgZnVuY3Rpb24gYXBwbHlGY2lDb2x1bW5XaWR0aHMod2lkdGhzLCBwZXJzaXN0ID0gZmFsc2UpIHsKICAgIGNvbnN0IGNvbHMgPSBnZXRGY2lDb2xFbGVtZW50cygpOwogICAgaWYgKGNvbHMubGVuZ3RoICE9PSBGQ0lfREVGQVVMVF9DT0xfV0lEVEhTLmxlbmd0aCkgcmV0dXJuOwogICAgY29uc3QgbmV4dCA9IGNsYW1wRmNpV2lkdGhzKHdpZHRocyk7CiAgICBjb2xzLmZvckVhY2goKGNvbCwgaSkgPT4gewogICAgICBjb2wuc3R5bGUud2lkdGggPSBgJHtuZXh0W2ldfXB4YDsKICAgIH0pOwogICAgc3RhdGUuZmNpQ29sV2lkdGhzID0gbmV4dDsKICAgIGlmIChwZXJzaXN0KSBzYXZlRmNpQ29sdW1uV2lkdGhzKG5leHQpOwogIH0KICBmdW5jdGlvbiBpbml0RmNpQ29sdW1uV2lkdGhzKCkgewogICAgY29uc3Qgc2F2ZWQgPSBsb2FkRmNpQ29sdW1uV2lkdGhzKCk7CiAgICBhcHBseUZjaUNvbHVtbldpZHRocyhzYXZlZCB8fCBGQ0lfREVGQVVMVF9DT0xfV0lEVEhTLCBmYWxzZSk7CiAgfQogIGZ1bmN0aW9uIGJpbmRGY2lDb2x1bW5SZXNpemUoKSB7CiAgICBpZiAoc3RhdGUuZmNpUmVzaXplQm91bmQpIHJldHVybjsKICAgIGNvbnN0IHRhYmxlID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmZjaS10YWJsZScpOwogICAgaWYgKCF0YWJsZSkgcmV0dXJuOwogICAgY29uc3QgaGFuZGxlcyA9IEFycmF5LmZyb20odGFibGUucXVlcnlTZWxlY3RvckFsbCgnLmZjaS1jb2wtcmVzaXplcicpKTsKICAgIGlmICghaGFuZGxlcy5sZW5ndGgpIHJldHVybjsKICAgIHN0YXRlLmZjaVJlc2l6ZUJvdW5kID0gdHJ1ZTsKCiAgICBoYW5kbGVzLmZvckVhY2goKGhhbmRsZSkgPT4gewogICAgICBoYW5kbGUuYWRkRXZlbnRMaXN0ZW5lcignZGJsY2xpY2snLCAoZXZlbnQpID0+IHsKICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGNvbnN0IGlkeCA9IE51bWJlcihoYW5kbGUuZGF0YXNldC5mY2lDb2xJbmRleCk7CiAgICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoaWR4KSkgcmV0dXJuOwogICAgICAgIGNvbnN0IG5leHQgPSBzdGF0ZS5mY2lDb2xXaWR0aHMuc2xpY2UoKTsKICAgICAgICBuZXh0W2lkeF0gPSBGQ0lfREVGQVVMVF9DT0xfV0lEVEhTW2lkeF07CiAgICAgICAgYXBwbHlGY2lDb2x1bW5XaWR0aHMobmV4dCwgdHJ1ZSk7CiAgICAgIH0pOwogICAgICBoYW5kbGUuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcmRvd24nLCAoZXZlbnQpID0+IHsKICAgICAgICBpZiAoZXZlbnQuYnV0dG9uICE9PSAwKSByZXR1cm47CiAgICAgICAgY29uc3QgaWR4ID0gTnVtYmVyKGhhbmRsZS5kYXRhc2V0LmZjaUNvbEluZGV4KTsKICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShpZHgpKSByZXR1cm47CiAgICAgICAgY29uc3Qgc3RhcnRYID0gZXZlbnQuY2xpZW50WDsKICAgICAgICBjb25zdCBzdGFydFdpZHRoID0gc3RhdGUuZmNpQ29sV2lkdGhzW2lkeF0gPz8gRkNJX0RFRkFVTFRfQ09MX1dJRFRIU1tpZHhdOwogICAgICAgIGhhbmRsZS5jbGFzc0xpc3QuYWRkKCdhY3RpdmUnKTsKICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpOwoKICAgICAgICBjb25zdCBvbk1vdmUgPSAobW92ZUV2ZW50KSA9PiB7CiAgICAgICAgICBjb25zdCBkZWx0YSA9IG1vdmVFdmVudC5jbGllbnRYIC0gc3RhcnRYOwogICAgICAgICAgY29uc3QgbWluID0gRkNJX01JTl9DT0xfV0lEVEhTW2lkeF0gPz8gODA7CiAgICAgICAgICBjb25zdCBuZXh0V2lkdGggPSBNYXRoLm1heChtaW4sIE1hdGgucm91bmQoc3RhcnRXaWR0aCArIGRlbHRhKSk7CiAgICAgICAgICBjb25zdCBuZXh0ID0gc3RhdGUuZmNpQ29sV2lkdGhzLnNsaWNlKCk7CiAgICAgICAgICBuZXh0W2lkeF0gPSBuZXh0V2lkdGg7CiAgICAgICAgICBhcHBseUZjaUNvbHVtbldpZHRocyhuZXh0LCBmYWxzZSk7CiAgICAgICAgfTsKICAgICAgICBjb25zdCBvblVwID0gKCkgPT4gewogICAgICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJtb3ZlJywgb25Nb3ZlKTsKICAgICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdwb2ludGVydXAnLCBvblVwKTsKICAgICAgICAgIGhhbmRsZS5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKTsKICAgICAgICAgIHNhdmVGY2lDb2x1bW5XaWR0aHMoc3RhdGUuZmNpQ29sV2lkdGhzKTsKICAgICAgICB9OwogICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVybW92ZScsIG9uTW92ZSk7CiAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJ1cCcsIG9uVXApOwogICAgICB9KTsKICAgIH0pOwogIH0KCiAgLy8gMykgRnVuY2lvbmVzIGRlIHJlbmRlcgogIGZ1bmN0aW9uIHJlbmRlck1lcENjbChwYXlsb2FkKSB7CiAgICBpZiAoIXBheWxvYWQpIHsKICAgICAgc2V0RGFzaChbJ21lcC12YWwnLCAnY2NsLXZhbCcsICdicmVjaGEtYWJzJywgJ2JyZWNoYS1wY3QnXSk7CiAgICAgIHNldFRleHQoJ3N0YXR1cy1sYWJlbCcsICdEYXRvcyBpbmNvbXBsZXRvcycpOwogICAgICBzZXRUZXh0KCdzdGF0dXMtYmFkZ2UnLCAnU2luIGRhdG8nKTsKICAgICAgc3RhdGUuZGF0YUNvbmZpZGVuY2UgPSAnTk9fREFUQSc7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGRhdGEgPSBleHRyYWN0Um9vdChwYXlsb2FkKTsKICAgIGNvbnN0IGN1cnJlbnQgPSBkYXRhICYmIHR5cGVvZiBkYXRhLmN1cnJlbnQgPT09ICdvYmplY3QnID8gZGF0YS5jdXJyZW50IDogbnVsbDsKICAgIGNvbnN0IG1lcCA9IGN1cnJlbnQgPyB0b051bWJlcihjdXJyZW50Lm1lcCkgOiAocGlja051bWJlcihkYXRhLCBbWydtZXAnLCAndmVudGEnXSwgWydtZXAnLCAnc2VsbCddLCBbJ21lcCddLCBbJ21lcF92ZW50YSddLCBbJ2RvbGFyX21lcCddXSkgPz8gcGlja0J5S2V5SGludChkYXRhLCAnbWVwJykpOwogICAgY29uc3QgY2NsID0gY3VycmVudCA/IHRvTnVtYmVyKGN1cnJlbnQuY2NsKSA6IChwaWNrTnVtYmVyKGRhdGEsIFtbJ2NjbCcsICd2ZW50YSddLCBbJ2NjbCcsICdzZWxsJ10sIFsnY2NsJ10sIFsnY2NsX3ZlbnRhJ10sIFsnZG9sYXJfY2NsJ11dKSA/PyBwaWNrQnlLZXlIaW50KGRhdGEsICdjY2wnKSk7CiAgICBjb25zdCBhYnMgPSBjdXJyZW50CiAgICAgID8gdG9OdW1iZXIoY3VycmVudC5zcHJlYWRBYnNBcnMpID8/IHRvTnVtYmVyKGN1cnJlbnQuYWJzRGlmZikgPz8gKG1lcCAhPT0gbnVsbCAmJiBjY2wgIT09IG51bGwgPyBNYXRoLmFicyhtZXAgLSBjY2wpIDogbnVsbCkKICAgICAgOiAobWVwICE9PSBudWxsICYmIGNjbCAhPT0gbnVsbCA/IE1hdGguYWJzKG1lcCAtIGNjbCkgOiBudWxsKTsKICAgIGNvbnN0IHBjdCA9IGN1cnJlbnQKICAgICAgPyB0b051bWJlcihjdXJyZW50LnNwcmVhZFBjdFBlcmNlbnQpID8/IHRvTnVtYmVyKGN1cnJlbnQucGN0RGlmZikgPz8gYnJlY2hhUGVyY2VudChtZXAsIGNjbCkKICAgICAgOiBicmVjaGFQZXJjZW50KG1lcCwgY2NsKTsKICAgIGNvbnN0IGlzU2ltaWxhciA9IGN1cnJlbnQgJiYgdHlwZW9mIGN1cnJlbnQuc2ltaWxhciA9PT0gJ2Jvb2xlYW4nCiAgICAgID8gY3VycmVudC5zaW1pbGFyCiAgICAgIDogKHBjdCAhPT0gbnVsbCAmJiBhYnMgIT09IG51bGwgJiYgKHBjdCA8PSBTSU1JTEFSX1BDVF9USFJFU0hPTEQgfHwgYWJzIDw9IFNJTUlMQVJfQVJTX1RIUkVTSE9MRCkpOwoKICAgIHNldFRleHQoJ21lcC12YWwnLCBmb3JtYXRNb25leShtZXAsIDIpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnY2NsLXZhbCcsIGZvcm1hdE1vbmV5KGNjbCwgMiksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdicmVjaGEtYWJzJywgYWJzID09PSBudWxsID8gJ+KAlCcgOiBmb3JtYXRNb25leShhYnMsIDIpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnYnJlY2hhLXBjdCcsIGZvcm1hdFBlcmNlbnQocGN0LCAyKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ3N0YXR1cy1sYWJlbCcsIGlzU2ltaWxhciA/ICdNRVAg4omIIENDTCcgOiAnTUVQIOKJoCBDQ0wnKTsKICAgIHNldFRleHQoJ3N0YXR1cy1iYWRnZScsIGlzU2ltaWxhciA/ICdTaW1pbGFyJyA6ICdObyBzaW1pbGFyJyk7CiAgICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdGF0dXMtYmFkZ2UnKTsKICAgIGlmIChiYWRnZSkgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZSgnbm9zaW0nLCAhaXNTaW1pbGFyKTsKCiAgICBjb25zdCBiYW5uZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RhdHVzLWJhbm5lcicpOwogICAgaWYgKGJhbm5lcikgewogICAgICBiYW5uZXIuY2xhc3NMaXN0LnRvZ2dsZSgnc2ltaWxhcicsICEhaXNTaW1pbGFyKTsKICAgICAgYmFubmVyLmNsYXNzTGlzdC50b2dnbGUoJ25vLXNpbWlsYXInLCAhaXNTaW1pbGFyKTsKICAgIH0KICAgIGNvbnN0IHN1YiA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJyNzdGF0dXMtYmFubmVyIC5zLXN1YicpOwogICAgaWYgKHN1YikgewogICAgICBzdWIudGV4dENvbnRlbnQgPSBpc1NpbWlsYXIKICAgICAgICA/ICdMYSBicmVjaGEgZXN0w6EgZGVudHJvIGRlbCB1bWJyYWwg4oCUIGxvcyBwcmVjaW9zIHNvbiBjb21wYXJhYmxlcycKICAgICAgICA6ICdMYSBicmVjaGEgc3VwZXJhIGVsIHVtYnJhbCDigJQgbG9zIHByZWNpb3Mgbm8gc29uIGNvbXBhcmFibGVzJzsKICAgIH0KICAgIGNvbnN0IGlzT3BlbiA9IGRhdGE/Lm1hcmtldCAmJiB0eXBlb2YgZGF0YS5tYXJrZXQuaXNPcGVuID09PSAnYm9vbGVhbicgPyBkYXRhLm1hcmtldC5pc09wZW4gOiBudWxsOwogICAgaWYgKGlzT3BlbiAhPT0gbnVsbCkgc2V0TWFya2V0VGFnKGlzT3Blbik7CiAgICBzdGF0ZS5sYXRlc3QubWVwID0gbWVwOwogICAgc3RhdGUubGF0ZXN0LmNjbCA9IGNjbDsKICAgIHN0YXRlLmxhdGVzdC5icmVjaGFBYnMgPSBhYnM7CiAgICBzdGF0ZS5sYXRlc3QuYnJlY2hhUGN0ID0gcGN0OwogIH0KCiAgZnVuY3Rpb24gaXNTaW1pbGFyUm93KHJvdykgewogICAgY29uc3QgYWJzID0gcm93LmFic19kaWZmICE9IG51bGwgPyByb3cuYWJzX2RpZmYgOiBNYXRoLmFicyhyb3cubWVwIC0gcm93LmNjbCk7CiAgICBjb25zdCBwY3QgPSByb3cuc3ByZWFkX3BjdF9wZXJjZW50ICE9IG51bGwKICAgICAgPyByb3cuc3ByZWFkX3BjdF9wZXJjZW50CiAgICAgIDogKHJvdy5wY3RfZGlmZiAhPSBudWxsID8gcm93LnBjdF9kaWZmIDogY2FsY0JyZWNoYVBjdChyb3cubWVwLCByb3cuY2NsKSk7CiAgICByZXR1cm4gKE51bWJlci5pc0Zpbml0ZShwY3QpICYmIHBjdCA8PSBTSU1JTEFSX1BDVF9USFJFU0hPTEQpIHx8IChOdW1iZXIuaXNGaW5pdGUoYWJzKSAmJiBhYnMgPD0gU0lNSUxBUl9BUlNfVEhSRVNIT0xEKTsKICB9CgogIGZ1bmN0aW9uIGZpbHRlckRlc2NyaXB0b3IobW9kZSA9IHN0YXRlLmZpbHRlck1vZGUpIHsKICAgIGlmIChtb2RlID09PSAnMW0nKSByZXR1cm4gJzEgTWVzJzsKICAgIGlmIChtb2RlID09PSAnMXcnKSByZXR1cm4gJzEgU2VtYW5hJzsKICAgIHJldHVybiAnMSBEw61hJzsKICB9CgogIGZ1bmN0aW9uIHJlbmRlck1ldHJpY3MyNGgocGF5bG9hZCkgewogICAgY29uc3QgZmlsdGVyZWQgPSBmaWx0ZXJIaXN0b3J5Um93cyhleHRyYWN0SGlzdG9yeVJvd3MocGF5bG9hZCksIHN0YXRlLmZpbHRlck1vZGUpOwogICAgY29uc3QgcGN0VmFsdWVzID0gZmlsdGVyZWQKICAgICAgLm1hcCgocikgPT4gKHIuc3ByZWFkX3BjdF9wZXJjZW50ICE9IG51bGwgPyByLnNwcmVhZF9wY3RfcGVyY2VudCA6IChyLnBjdF9kaWZmICE9IG51bGwgPyByLnBjdF9kaWZmIDogY2FsY0JyZWNoYVBjdChyLm1lcCwgci5jY2wpKSkpCiAgICAgIC5maWx0ZXIoKHYpID0+IE51bWJlci5pc0Zpbml0ZSh2KSk7CiAgICBjb25zdCBzaW1pbGFyQ291bnQgPSBmaWx0ZXJlZC5maWx0ZXIoKHIpID0+IGlzU2ltaWxhclJvdyhyKSkubGVuZ3RoOwogICAgY29uc3QgZGVzY3JpcHRvciA9IGZpbHRlckRlc2NyaXB0b3IoKTsKCiAgICBzZXRUZXh0KCdtZXRyaWMtY291bnQtbGFiZWwnLCBgTXVlc3RyYXMgJHtkZXNjcmlwdG9yfWApOwogICAgc2V0VGV4dCgnbWV0cmljLWNvdW50LTI0aCcsIFN0cmluZyhmaWx0ZXJlZC5sZW5ndGgpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnbWV0cmljLWNvdW50LXN1YicsICdyZWdpc3Ryb3MgZGVsIHBlcsOtb2RvIGZpbHRyYWRvJyk7CiAgICBzZXRUZXh0KCdtZXRyaWMtc2ltaWxhci1sYWJlbCcsIGBWZWNlcyBzaW1pbGFyICgke2Rlc2NyaXB0b3J9KWApOwogICAgc2V0VGV4dCgnbWV0cmljLXNpbWlsYXItMjRoJywgU3RyaW5nKHNpbWlsYXJDb3VudCksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtc2ltaWxhci1zdWInLCAnbW9tZW50b3MgZW4gem9uYSDiiaQxJSBvIOKJpCQxMCcpOwogICAgc2V0VGV4dCgnbWV0cmljLW1pbi1sYWJlbCcsIGBCcmVjaGEgbcOtbi4gKCR7ZGVzY3JpcHRvcn0pYCk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWluLTI0aCcsIHBjdFZhbHVlcy5sZW5ndGggPyBmb3JtYXRQZXJjZW50KE1hdGgubWluKC4uLnBjdFZhbHVlcyksIDIpIDogJ+KAlCcsIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWluLXN1YicsICdtw61uaW1hIGRlbCBwZXLDrW9kbyBmaWx0cmFkbycpOwogICAgc2V0VGV4dCgnbWV0cmljLW1heC1sYWJlbCcsIGBCcmVjaGEgbcOheC4gKCR7ZGVzY3JpcHRvcn0pYCk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWF4LTI0aCcsIHBjdFZhbHVlcy5sZW5ndGggPyBmb3JtYXRQZXJjZW50KE1hdGgubWF4KC4uLnBjdFZhbHVlcyksIDIpIDogJ+KAlCcsIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWF4LXN1YicsICdtw6F4aW1hIGRlbCBwZXLDrW9kbyBmaWx0cmFkbycpOwogICAgc2V0VGV4dCgndHJlbmQtdGl0bGUnLCBgVGVuZGVuY2lhIE1FUC9DQ0wg4oCUICR7ZGVzY3JpcHRvcn1gKTsKICB9CgogIGZ1bmN0aW9uIHJvd0hvdXJMYWJlbChlcG9jaCkgewogICAgY29uc3QgbiA9IHRvTnVtYmVyKGVwb2NoKTsKICAgIGlmIChuID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gZm10QXJnSG91ci5mb3JtYXQobmV3IERhdGUobiAqIDEwMDApKTsKICB9CiAgZnVuY3Rpb24gcm93RGF5SG91ckxhYmVsKGVwb2NoKSB7CiAgICBjb25zdCBuID0gdG9OdW1iZXIoZXBvY2gpOwogICAgaWYgKG4gPT09IG51bGwpIHJldHVybiAn4oCUJzsKICAgIGNvbnN0IGRhdGUgPSBuZXcgRGF0ZShuICogMTAwMCk7CiAgICByZXR1cm4gYCR7Zm10QXJnRGF5TW9udGguZm9ybWF0KGRhdGUpfSAke2ZtdEFyZ0hvdXIuZm9ybWF0KGRhdGUpfWA7CiAgfQogIGZ1bmN0aW9uIGFydERhdGVLZXkoZXBvY2gpIHsKICAgIGNvbnN0IG4gPSB0b051bWJlcihlcG9jaCk7CiAgICBpZiAobiA9PT0gbnVsbCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gZm10QXJnRGF0ZS5mb3JtYXQobmV3IERhdGUobiAqIDEwMDApKTsKICB9CiAgZnVuY3Rpb24gYXJ0V2Vla2RheShlcG9jaCkgewogICAgY29uc3QgbiA9IHRvTnVtYmVyKGVwb2NoKTsKICAgIGlmIChuID09PSBudWxsKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiBmbXRBcmdXZWVrZGF5LmZvcm1hdChuZXcgRGF0ZShuICogMTAwMCkpOwogIH0KICBmdW5jdGlvbiBleHRyYWN0SGlzdG9yeVJvd3MocGF5bG9hZCkgewogICAgY29uc3QgZGF0YSA9IGV4dHJhY3RSb290KHBheWxvYWQpOwogICAgY29uc3Qgcm93cyA9IEFycmF5LmlzQXJyYXkoZGF0YS5oaXN0b3J5KSA/IGRhdGEuaGlzdG9yeS5zbGljZSgpIDogW107CiAgICByZXR1cm4gcm93cwogICAgICAubWFwKChyKSA9PiAoewogICAgICAgIGVwb2NoOiB0b051bWJlcihyLmVwb2NoKSwKICAgICAgICBtZXA6IHRvTnVtYmVyKHIubWVwKSwKICAgICAgICBjY2w6IHRvTnVtYmVyKHIuY2NsKSwKICAgICAgICBhYnNfZGlmZjogdG9OdW1iZXIoci5hYnNfZGlmZiksCiAgICAgICAgc3ByZWFkX3BjdF9wZXJjZW50OiB0b051bWJlcihyLnNwcmVhZF9wY3RfcGVyY2VudCksCiAgICAgICAgcGN0X2RpZmY6IHRvTnVtYmVyKHIucGN0X2RpZmYpLAogICAgICAgIHNpbWlsYXI6IEJvb2xlYW4oci5zaW1pbGFyKQogICAgICB9KSkKICAgICAgLmZpbHRlcigocikgPT4gci5lcG9jaCAhPSBudWxsICYmIHIubWVwICE9IG51bGwgJiYgci5jY2wgIT0gbnVsbCkKICAgICAgLnNvcnQoKGEsIGIpID0+IGEuZXBvY2ggLSBiLmVwb2NoKTsKICB9CiAgZnVuY3Rpb24gZmlsdGVySGlzdG9yeVJvd3Mocm93cywgbW9kZSkgewogICAgaWYgKCFyb3dzLmxlbmd0aCkgcmV0dXJuIFtdOwogICAgY29uc3QgbGF0ZXN0RXBvY2ggPSByb3dzW3Jvd3MubGVuZ3RoIC0gMV0uZXBvY2g7CiAgICBpZiAobW9kZSA9PT0gJzFtJykgewogICAgICBjb25zdCBjdXRvZmYgPSBsYXRlc3RFcG9jaCAtICgzMCAqIDI0ICogMzYwMCk7CiAgICAgIHJldHVybiByb3dzLmZpbHRlcigocikgPT4gci5lcG9jaCA+PSBjdXRvZmYpOwogICAgfQogICAgaWYgKG1vZGUgPT09ICcxdycpIHsKICAgICAgY29uc3QgYWxsb3dlZERheXMgPSBuZXcgU2V0KCk7CiAgICAgIGZvciAobGV0IGkgPSByb3dzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7CiAgICAgICAgY29uc3QgZGF5ID0gYXJ0RGF0ZUtleShyb3dzW2ldLmVwb2NoKTsKICAgICAgICBjb25zdCB3ZCA9IGFydFdlZWtkYXkocm93c1tpXS5lcG9jaCk7CiAgICAgICAgaWYgKCFkYXkgfHwgd2QgPT09ICdTYXQnIHx8IHdkID09PSAnU3VuJykgY29udGludWU7CiAgICAgICAgYWxsb3dlZERheXMuYWRkKGRheSk7CiAgICAgICAgaWYgKGFsbG93ZWREYXlzLnNpemUgPj0gNSkgYnJlYWs7CiAgICAgIH0KICAgICAgcmV0dXJuIHJvd3MuZmlsdGVyKChyKSA9PiB7CiAgICAgICAgY29uc3QgZGF5ID0gYXJ0RGF0ZUtleShyLmVwb2NoKTsKICAgICAgICByZXR1cm4gZGF5ICYmIGFsbG93ZWREYXlzLmhhcyhkYXkpOwogICAgICB9KTsKICAgIH0KICAgIGNvbnN0IGN1dG9mZiA9IGxhdGVzdEVwb2NoIC0gKDI0ICogMzYwMCk7CiAgICByZXR1cm4gcm93cy5maWx0ZXIoKHIpID0+IHIuZXBvY2ggPj0gY3V0b2ZmKTsKICB9CiAgZnVuY3Rpb24gZG93bnNhbXBsZVJvd3Mocm93cywgbWF4UG9pbnRzKSB7CiAgICBpZiAocm93cy5sZW5ndGggPD0gbWF4UG9pbnRzKSByZXR1cm4gcm93czsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgY29uc3Qgc3RlcCA9IChyb3dzLmxlbmd0aCAtIDEpIC8gKG1heFBvaW50cyAtIDEpOwogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBtYXhQb2ludHM7IGkrKykgewogICAgICBvdXQucHVzaChyb3dzW01hdGgucm91bmQoaSAqIHN0ZXApXSk7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KICBmdW5jdGlvbiBjdXJyZW50RmlsdGVyTGFiZWwoKSB7CiAgICBpZiAoc3RhdGUuZmlsdGVyTW9kZSA9PT0gJzFtJykgcmV0dXJuICcxIE1lcyc7CiAgICBpZiAoc3RhdGUuZmlsdGVyTW9kZSA9PT0gJzF3JykgcmV0dXJuICcxIFNlbWFuYSc7CiAgICByZXR1cm4gJzEgRMOtYSc7CiAgfQogIGZ1bmN0aW9uIGdldEZpbHRlcmVkSGlzdG9yeVJvd3MocGF5bG9hZCA9IHN0YXRlLmxhc3RNZXBQYXlsb2FkKSB7CiAgICBpZiAoIXBheWxvYWQpIHJldHVybiBbXTsKICAgIHJldHVybiBmaWx0ZXJIaXN0b3J5Um93cyhleHRyYWN0SGlzdG9yeVJvd3MocGF5bG9hZCksIHN0YXRlLmZpbHRlck1vZGUpOwogIH0KICBmdW5jdGlvbiBjc3ZFc2NhcGUodmFsdWUpIHsKICAgIGNvbnN0IHYgPSBTdHJpbmcodmFsdWUgPz8gJycpOwogICAgcmV0dXJuIGAiJHt2LnJlcGxhY2UoLyIvZywgJyIiJyl9ImA7CiAgfQogIGZ1bmN0aW9uIGNzdk51bWJlcih2YWx1ZSwgZGlnaXRzID0gMikgewogICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gdmFsdWUudG9GaXhlZChkaWdpdHMpLnJlcGxhY2UoJy4nLCAnLCcpOwogIH0KICBmdW5jdGlvbiBmaWx0ZXJDb2RlKCkgewogICAgaWYgKHN0YXRlLmZpbHRlck1vZGUgPT09ICcxbScpIHJldHVybiAnMW0nOwogICAgaWYgKHN0YXRlLmZpbHRlck1vZGUgPT09ICcxdycpIHJldHVybiAnMXcnOwogICAgcmV0dXJuICcxZCc7CiAgfQogIGZ1bmN0aW9uIGRvd25sb2FkSGlzdG9yeUNzdigpIHsKICAgIGNvbnN0IGZpbHRlcmVkID0gZ2V0RmlsdGVyZWRIaXN0b3J5Um93cygpOwogICAgaWYgKCFmaWx0ZXJlZC5sZW5ndGgpIHsKICAgICAgc2V0RnJlc2hCYWRnZSgnU2luIGRhdG9zIHBhcmEgZXhwb3J0YXIgZW4gZWwgZmlsdHJvIGFjdGl2bycsICdpZGxlJyk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGhlYWRlciA9IFsnZmVjaGEnLCAnaG9yYScsICdtZXAnLCAnY2NsJywgJ2RpZl9hYnMnLCAnZGlmX3BjdCcsICdlc3RhZG8nXTsKICAgIGNvbnN0IHJvd3MgPSBmaWx0ZXJlZC5tYXAoKHIpID0+IHsKICAgICAgY29uc3QgZGF0ZSA9IG5ldyBEYXRlKHIuZXBvY2ggKiAxMDAwKTsKICAgICAgY29uc3QgbWVwID0gdG9OdW1iZXIoci5tZXApOwogICAgICBjb25zdCBjY2wgPSB0b051bWJlcihyLmNjbCk7CiAgICAgIGNvbnN0IGFicyA9IHRvTnVtYmVyKHIuYWJzX2RpZmYpOwogICAgICBjb25zdCBwY3QgPSB0b051bWJlcihyLnNwcmVhZF9wY3RfcGVyY2VudCkgPz8gdG9OdW1iZXIoci5wY3RfZGlmZik7CiAgICAgIGNvbnN0IGVzdGFkbyA9IEJvb2xlYW4oci5zaW1pbGFyKSA/ICdTSU1JTEFSJyA6ICdOTyBTSU1JTEFSJzsKICAgICAgcmV0dXJuIFsKICAgICAgICBmbXRBcmdEYXlNb250aC5mb3JtYXQoZGF0ZSksCiAgICAgICAgZm10QXJnSG91ci5mb3JtYXQoZGF0ZSksCiAgICAgICAgY3N2TnVtYmVyKG1lcCwgMiksCiAgICAgICAgY3N2TnVtYmVyKGNjbCwgMiksCiAgICAgICAgY3N2TnVtYmVyKGFicywgMiksCiAgICAgICAgY3N2TnVtYmVyKHBjdCwgMiksCiAgICAgICAgZXN0YWRvCiAgICAgIF0ubWFwKGNzdkVzY2FwZSkuam9pbignOycpOwogICAgfSk7CiAgICBjb25zdCBhcnREYXRlID0gZm10QXJnRGF0ZS5mb3JtYXQobmV3IERhdGUoKSk7CiAgICBjb25zdCBmaWxlbmFtZSA9IGBoaXN0b3JpYWwtbWVwLWNjbC0ke2ZpbHRlckNvZGUoKX0tJHthcnREYXRlfS5jc3ZgOwogICAgY29uc3QgY3N2ID0gJ1x1RkVGRicgKyBbaGVhZGVyLmpvaW4oJzsnKSwgLi4ucm93c10uam9pbignXG4nKTsKICAgIGNvbnN0IGJsb2IgPSBuZXcgQmxvYihbY3N2XSwgeyB0eXBlOiAndGV4dC9jc3Y7Y2hhcnNldD11dGYtODsnIH0pOwogICAgY29uc3QgdXJsID0gVVJMLmNyZWF0ZU9iamVjdFVSTChibG9iKTsKICAgIGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdhJyk7CiAgICBhLmhyZWYgPSB1cmw7CiAgICBhLmRvd25sb2FkID0gZmlsZW5hbWU7CiAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGEpOwogICAgYS5jbGljaygpOwogICAgYS5yZW1vdmUoKTsKICAgIFVSTC5yZXZva2VPYmplY3RVUkwodXJsKTsKICB9CiAgZnVuY3Rpb24gYXBwbHlGaWx0ZXIobW9kZSkgewogICAgc3RhdGUuZmlsdGVyTW9kZSA9IG1vZGU7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucGlsbFtkYXRhLWZpbHRlcl0nKS5mb3JFYWNoKChidG4pID0+IHsKICAgICAgYnRuLmNsYXNzTGlzdC50b2dnbGUoJ29uJywgYnRuLmRhdGFzZXQuZmlsdGVyID09PSBtb2RlKTsKICAgIH0pOwogICAgaWYgKHN0YXRlLmxhc3RNZXBQYXlsb2FkKSB7CiAgICAgIHJlbmRlclRyZW5kKHN0YXRlLmxhc3RNZXBQYXlsb2FkKTsKICAgICAgcmVuZGVySGlzdG9yeShzdGF0ZS5sYXN0TWVwUGF5bG9hZCk7CiAgICAgIHJlbmRlck1ldHJpY3MyNGgoc3RhdGUubGFzdE1lcFBheWxvYWQpOwogICAgfQogIH0KCiAgZnVuY3Rpb24gcmVuZGVySGlzdG9yeShwYXlsb2FkKSB7CiAgICBjb25zdCB0Ym9keSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoaXN0b3J5LXJvd3MnKTsKICAgIGNvbnN0IGNhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoaXN0b3J5LWNhcCcpOwogICAgaWYgKCF0Ym9keSkgcmV0dXJuOwogICAgY29uc3QgZmlsdGVyZWQgPSBnZXRGaWx0ZXJlZEhpc3RvcnlSb3dzKHBheWxvYWQpOwogICAgY29uc3Qgcm93cyA9IGZpbHRlcmVkLnNsaWNlKCkucmV2ZXJzZSgpOwogICAgaWYgKGNhcCkgY2FwLnRleHRDb250ZW50ID0gYCR7Y3VycmVudEZpbHRlckxhYmVsKCl9IMK3ICR7cm93cy5sZW5ndGh9IHJlZ2lzdHJvc2A7CiAgICBpZiAoIXJvd3MubGVuZ3RoKSB7CiAgICAgIHRib2R5LmlubmVySFRNTCA9ICc8dHI+PHRkIGNsYXNzPSJkaW0iIGNvbHNwYW49IjYiPlNpbiByZWdpc3Ryb3MgdG9kYXbDrWE8L3RkPjwvdHI+JzsKICAgICAgcmV0dXJuOwogICAgfQogICAgdGJvZHkuaW5uZXJIVE1MID0gcm93cy5tYXAoKHIpID0+IHsKICAgICAgY29uc3QgbWVwID0gdG9OdW1iZXIoci5tZXApOwogICAgICBjb25zdCBjY2wgPSB0b051bWJlcihyLmNjbCk7CiAgICAgIGNvbnN0IGFicyA9IHRvTnVtYmVyKHIuYWJzX2RpZmYpOwogICAgICBjb25zdCBwY3QgPSB0b051bWJlcihyLnNwcmVhZF9wY3RfcGVyY2VudCkgPz8gdG9OdW1iZXIoci5wY3RfZGlmZik7CiAgICAgIGNvbnN0IHNpbSA9IEJvb2xlYW4oci5zaW1pbGFyKTsKICAgICAgcmV0dXJuIGA8dHI+CiAgICAgICAgPHRkIGNsYXNzPSJkaW0iPjxkaXYgY2xhc3M9InRzLWRheSI+JHtmbXRBcmdEYXlNb250aC5mb3JtYXQobmV3IERhdGUoci5lcG9jaCAqIDEwMDApKX08L2Rpdj48ZGl2IGNsYXNzPSJ0cy1ob3VyIj4ke3Jvd0hvdXJMYWJlbChyLmVwb2NoKX08L2Rpdj48L3RkPgogICAgICAgIDx0ZCBzdHlsZT0iY29sb3I6dmFyKC0tbWVwKSI+JHtmb3JtYXRNb25leShtZXAsIDIpfTwvdGQ+CiAgICAgICAgPHRkIHN0eWxlPSJjb2xvcjp2YXIoLS1jY2wpIj4ke2Zvcm1hdE1vbmV5KGNjbCwgMil9PC90ZD4KICAgICAgICA8dGQ+JHtmb3JtYXRNb25leShhYnMsIDIpfTwvdGQ+CiAgICAgICAgPHRkPiR7Zm9ybWF0UGVyY2VudChwY3QsIDIpfTwvdGQ+CiAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJzYmFkZ2UgJHtzaW0gPyAnc2ltJyA6ICdub3NpbSd9Ij4ke3NpbSA/ICdTaW1pbGFyJyA6ICdObyBzaW1pbGFyJ308L3NwYW4+PC90ZD4KICAgICAgPC90cj5gOwogICAgfSkuam9pbignJyk7CiAgfQoKICBmdW5jdGlvbiBsaW5lUG9pbnRzKHZhbHVlcywgeDAsIHgxLCB5MCwgeTEsIG1pblZhbHVlLCBtYXhWYWx1ZSkgewogICAgaWYgKCF2YWx1ZXMubGVuZ3RoKSByZXR1cm4gJyc7CiAgICBjb25zdCBtaW4gPSBOdW1iZXIuaXNGaW5pdGUobWluVmFsdWUpID8gbWluVmFsdWUgOiBNYXRoLm1pbiguLi52YWx1ZXMpOwogICAgY29uc3QgbWF4ID0gTnVtYmVyLmlzRmluaXRlKG1heFZhbHVlKSA/IG1heFZhbHVlIDogTWF0aC5tYXgoLi4udmFsdWVzKTsKICAgIGNvbnN0IHNwYW4gPSBNYXRoLm1heCgwLjAwMDAwMSwgbWF4IC0gbWluKTsKICAgIHJldHVybiB2YWx1ZXMubWFwKCh2LCBpKSA9PiB7CiAgICAgIGNvbnN0IHggPSB4MCArICgoeDEgLSB4MCkgKiBpIC8gTWF0aC5tYXgoMSwgdmFsdWVzLmxlbmd0aCAtIDEpKTsKICAgICAgY29uc3QgeSA9IHkxIC0gKCh2IC0gbWluKSAvIHNwYW4pICogKHkxIC0geTApOwogICAgICByZXR1cm4gYCR7eC50b0ZpeGVkKDIpfSwke3kudG9GaXhlZCgyKX1gOwogICAgfSkuam9pbignICcpOwogIH0KICBmdW5jdGlvbiB2YWx1ZVRvWSh2YWx1ZSwgeTAsIHkxLCBtaW5WYWx1ZSwgbWF4VmFsdWUpIHsKICAgIGNvbnN0IHNwYW4gPSBNYXRoLm1heCgwLjAwMDAwMSwgbWF4VmFsdWUgLSBtaW5WYWx1ZSk7CiAgICByZXR1cm4geTEgLSAoKHZhbHVlIC0gbWluVmFsdWUpIC8gc3BhbikgKiAoeTEgLSB5MCk7CiAgfQogIGZ1bmN0aW9uIGNhbGNCcmVjaGFQY3QobWVwLCBjY2wpIHsKICAgIGlmICghTnVtYmVyLmlzRmluaXRlKG1lcCkgfHwgIU51bWJlci5pc0Zpbml0ZShjY2wpKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGF2ZyA9IChtZXAgKyBjY2wpIC8gMjsKICAgIGlmICghYXZnKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiAoTWF0aC5hYnMobWVwIC0gY2NsKSAvIGF2ZykgKiAxMDA7CiAgfQogIGZ1bmN0aW9uIGNhbGNCcmVjaGFBYnMobWVwLCBjY2wpIHsKICAgIGlmICghTnVtYmVyLmlzRmluaXRlKG1lcCkgfHwgIU51bWJlci5pc0Zpbml0ZShjY2wpKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiBNYXRoLmFicyhtZXAgLSBjY2wpOwogIH0KICBmdW5jdGlvbiBzZXRCcmVjaGFIb3VybHlEZWx0YShkZWx0YVBjdCkgewogICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYnJlY2hhLWhvdXJseS1kZWx0YScpOwogICAgaWYgKCFlbCkgcmV0dXJuOwogICAgZWwuY2xhc3NMaXN0LnJlbW92ZSgndXAnLCAnZG93bicpOwogICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoZGVsdGFQY3QpKSB7CiAgICAgIHNldFRleHQoJ2JyZWNoYS1ob3VybHktZGVsdGEnLCAndnMgaGFjZSAxaCDigJQnKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc3QgYWJzRGVsdGEgPSBNYXRoLmFicyhkZWx0YVBjdCkudG9GaXhlZCgyKTsKICAgIGlmIChkZWx0YVBjdCA+IDAuMDAwMSkgewogICAgICBlbC5jbGFzc0xpc3QuYWRkKCd1cCcpOwogICAgICBzZXRUZXh0KCdicmVjaGEtaG91cmx5LWRlbHRhJywgYOKWsiAke2Fic0RlbHRhfSUgdnMgaGFjZSAxaGApOwogICAgICByZXR1cm47CiAgICB9CiAgICBpZiAoZGVsdGFQY3QgPCAtMC4wMDAxKSB7CiAgICAgIGVsLmNsYXNzTGlzdC5hZGQoJ2Rvd24nKTsKICAgICAgc2V0VGV4dCgnYnJlY2hhLWhvdXJseS1kZWx0YScsIGDilrwgJHthYnNEZWx0YX0lIHZzIGhhY2UgMWhgKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgc2V0VGV4dCgnYnJlY2hhLWhvdXJseS1kZWx0YScsIGDigKIgJHthYnNEZWx0YX0lIHZzIGhhY2UgMWhgKTsKICB9CiAgZnVuY3Rpb24gaGlkZVRyZW5kSG92ZXIoKSB7CiAgICBjb25zdCB0aXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtdG9vbHRpcCcpOwogICAgY29uc3QgbGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1saW5lJyk7CiAgICBjb25zdCBtZXBEb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItbWVwJyk7CiAgICBjb25zdCBjY2xEb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItY2NsJyk7CiAgICBpZiAodGlwKSB0aXAuc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzAnKTsKICAgIGlmIChsaW5lKSBsaW5lLnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcwJyk7CiAgICBpZiAobWVwRG90KSBtZXBEb3Quc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzAnKTsKICAgIGlmIChjY2xEb3QpIGNjbERvdC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMCcpOwogIH0KICBmdW5jdGlvbiByZW5kZXJUcmVuZEhvdmVyKHBvaW50KSB7CiAgICBjb25zdCB0aXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtdG9vbHRpcCcpOwogICAgY29uc3QgYmcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtdG9vbHRpcC1iZycpOwogICAgY29uc3QgbGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1saW5lJyk7CiAgICBjb25zdCBtZXBEb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItbWVwJyk7CiAgICBjb25zdCBjY2xEb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItY2NsJyk7CiAgICBpZiAoIXRpcCB8fCAhYmcgfHwgIWxpbmUgfHwgIW1lcERvdCB8fCAhY2NsRG90IHx8ICFwb2ludCkgcmV0dXJuOwoKICAgIGxpbmUuc2V0QXR0cmlidXRlKCd4MScsIHBvaW50LngudG9GaXhlZCgyKSk7CiAgICBsaW5lLnNldEF0dHJpYnV0ZSgneDInLCBwb2ludC54LnRvRml4ZWQoMikpOwogICAgbGluZS5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMScpOwogICAgbWVwRG90LnNldEF0dHJpYnV0ZSgnY3gnLCBwb2ludC54LnRvRml4ZWQoMikpOwogICAgbWVwRG90LnNldEF0dHJpYnV0ZSgnY3knLCBwb2ludC5tZXBZLnRvRml4ZWQoMikpOwogICAgbWVwRG90LnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcxJyk7CiAgICBjY2xEb3Quc2V0QXR0cmlidXRlKCdjeCcsIHBvaW50LngudG9GaXhlZCgyKSk7CiAgICBjY2xEb3Quc2V0QXR0cmlidXRlKCdjeScsIHBvaW50LmNjbFkudG9GaXhlZCgyKSk7CiAgICBjY2xEb3Quc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzEnKTsKCiAgICBzZXRUZXh0KCd0cmVuZC10aXAtdGltZScsIHJvd0RheUhvdXJMYWJlbChwb2ludC5lcG9jaCkpOwogICAgc2V0VGV4dCgndHJlbmQtdGlwLW1lcCcsIGBNRVAgJHtmb3JtYXRNb25leShwb2ludC5tZXAsIDIpfWApOwogICAgc2V0VGV4dCgndHJlbmQtdGlwLWNjbCcsIGBDQ0wgJHtmb3JtYXRNb25leShwb2ludC5jY2wsIDIpfWApOwogICAgY29uc3QgYWJzR2FwID0gY2FsY0JyZWNoYUFicyhwb2ludC5tZXAsIHBvaW50LmNjbCk7CiAgICBzZXRUZXh0KCd0cmVuZC10aXAtZ2FwJywgYEJyZWNoYSAke2Zvcm1hdFBlcmNlbnQocG9pbnQucGN0LCAyKX0gwrcgJHtmb3JtYXRNb25leShhYnNHYXAsIDIpfWApOwoKICAgIGNvbnN0IHRpcFcgPSAxODg7CiAgICBjb25zdCB0aXBIID0gNTY7CiAgICBjb25zdCB0aXBYID0gTWF0aC5taW4oODQwIC0gdGlwVywgTWF0aC5tYXgoMzAsIHBvaW50LnggKyAxMCkpOwogICAgY29uc3QgdGlwWSA9IE1hdGgubWluKDEwMCwgTWF0aC5tYXgoMTgsIE1hdGgubWluKHBvaW50Lm1lcFksIHBvaW50LmNjbFkpIC0gdGlwSCAtIDQpKTsKICAgIHRpcC5zZXRBdHRyaWJ1dGUoJ3RyYW5zZm9ybScsIGB0cmFuc2xhdGUoJHt0aXBYLnRvRml4ZWQoMil9ICR7dGlwWS50b0ZpeGVkKDIpfSlgKTsKICAgIGJnLnNldEF0dHJpYnV0ZSgnd2lkdGgnLCBTdHJpbmcodGlwVykpOwogICAgYmcuc2V0QXR0cmlidXRlKCdoZWlnaHQnLCBTdHJpbmcodGlwSCkpOwogICAgdGlwLnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcxJyk7CiAgfQogIGZ1bmN0aW9uIGJpbmRUcmVuZEhvdmVyKCkgewogICAgaWYgKHN0YXRlLnRyZW5kSG92ZXJCb3VuZCkgcmV0dXJuOwogICAgY29uc3QgY2hhcnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtY2hhcnQnKTsKICAgIGlmICghY2hhcnQpIHJldHVybjsKICAgIHN0YXRlLnRyZW5kSG92ZXJCb3VuZCA9IHRydWU7CgogICAgY2hhcnQuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VsZWF2ZScsICgpID0+IGhpZGVUcmVuZEhvdmVyKCkpOwogICAgY2hhcnQuYWRkRXZlbnRMaXN0ZW5lcignbW91c2Vtb3ZlJywgKGV2ZW50KSA9PiB7CiAgICAgIGlmICghc3RhdGUudHJlbmRSb3dzLmxlbmd0aCkgcmV0dXJuOwogICAgICBjb25zdCBjdG0gPSBjaGFydC5nZXRTY3JlZW5DVE0oKTsKICAgICAgaWYgKCFjdG0pIHJldHVybjsKICAgICAgY29uc3QgcHQgPSBjaGFydC5jcmVhdGVTVkdQb2ludCgpOwogICAgICBwdC54ID0gZXZlbnQuY2xpZW50WDsKICAgICAgcHQueSA9IGV2ZW50LmNsaWVudFk7CiAgICAgIGNvbnN0IGxvY2FsID0gcHQubWF0cml4VHJhbnNmb3JtKGN0bS5pbnZlcnNlKCkpOwogICAgICBjb25zdCB4ID0gTWF0aC5tYXgoMzAsIE1hdGgubWluKDg0MCwgbG9jYWwueCkpOwogICAgICBsZXQgbmVhcmVzdCA9IHN0YXRlLnRyZW5kUm93c1swXTsKICAgICAgbGV0IGJlc3QgPSBNYXRoLmFicyhuZWFyZXN0LnggLSB4KTsKICAgICAgZm9yIChsZXQgaSA9IDE7IGkgPCBzdGF0ZS50cmVuZFJvd3MubGVuZ3RoOyBpKyspIHsKICAgICAgICBjb25zdCBkID0gTWF0aC5hYnMoc3RhdGUudHJlbmRSb3dzW2ldLnggLSB4KTsKICAgICAgICBpZiAoZCA8IGJlc3QpIHsKICAgICAgICAgIGJlc3QgPSBkOwogICAgICAgICAgbmVhcmVzdCA9IHN0YXRlLnRyZW5kUm93c1tpXTsKICAgICAgICB9CiAgICAgIH0KICAgICAgcmVuZGVyVHJlbmRIb3ZlcihuZWFyZXN0KTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyVHJlbmQocGF5bG9hZCkgewogICAgY29uc3QgaGlzdG9yeSA9IGRvd25zYW1wbGVSb3dzKGZpbHRlckhpc3RvcnlSb3dzKGV4dHJhY3RIaXN0b3J5Um93cyhwYXlsb2FkKSwgc3RhdGUuZmlsdGVyTW9kZSksIFRSRU5EX01BWF9QT0lOVFMpOwogICAgY29uc3QgbWVwTGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1tZXAtbGluZScpOwogICAgY29uc3QgY2NsTGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1jY2wtbGluZScpOwogICAgaWYgKCFtZXBMaW5lIHx8ICFjY2xMaW5lKSByZXR1cm47CiAgICBiaW5kVHJlbmRIb3ZlcigpOwogICAgaWYgKCFoaXN0b3J5Lmxlbmd0aCkgewogICAgICBtZXBMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgJycpOwogICAgICBjY2xMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgJycpOwogICAgICBzdGF0ZS50cmVuZFJvd3MgPSBbXTsKICAgICAgaGlkZVRyZW5kSG92ZXIoKTsKICAgICAgWyd0cmVuZC15LXRvcCcsICd0cmVuZC15LW1pZCcsICd0cmVuZC15LWxvdycsICd0cmVuZC14LTEnLCAndHJlbmQteC0yJywgJ3RyZW5kLXgtMycsICd0cmVuZC14LTQnLCAndHJlbmQteC01J10uZm9yRWFjaCgoaWQpID0+IHNldFRleHQoaWQsICfigJQnKSk7CiAgICAgIHNldEJyZWNoYUhvdXJseURlbHRhKG51bGwpOwogICAgICByZXR1cm47CiAgICB9CgogICAgY29uc3Qgcm93cyA9IGhpc3RvcnkKICAgICAgLm1hcCgocikgPT4gKHsKICAgICAgICBlcG9jaDogci5lcG9jaCwKICAgICAgICBtZXA6IHRvTnVtYmVyKHIubWVwKSwKICAgICAgICBjY2w6IHRvTnVtYmVyKHIuY2NsKSwKICAgICAgICBwY3Q6IHRvTnVtYmVyKHIuc3ByZWFkX3BjdF9wZXJjZW50KSA/PyB0b051bWJlcihyLnBjdF9kaWZmKQogICAgICB9KSkKICAgICAgLmZpbHRlcigocikgPT4gci5tZXAgIT0gbnVsbCAmJiByLmNjbCAhPSBudWxsKTsKICAgIGlmICghcm93cy5sZW5ndGgpIHJldHVybjsKCiAgICBjb25zdCBtZXBWYWxzID0gcm93cy5tYXAoKHIpID0+IHIubWVwKTsKICAgIGNvbnN0IGNjbFZhbHMgPSByb3dzLm1hcCgocikgPT4gci5jY2wpOwogICAgY29uc3QgY3VycmVudCA9IHJvd3Nbcm93cy5sZW5ndGggLSAxXTsKICAgIGNvbnN0IGN1cnJlbnRQY3QgPSBjYWxjQnJlY2hhUGN0KGN1cnJlbnQubWVwLCBjdXJyZW50LmNjbCk7CiAgICBjb25zdCB0YXJnZXRFcG9jaCA9IGN1cnJlbnQuZXBvY2ggLSAzNjAwOwogICAgbGV0IHJlZiA9IHJvd3NbMF07CiAgICBsZXQgYmVzdCA9IE1hdGguYWJzKChyZWY/LmVwb2NoID8/IHRhcmdldEVwb2NoKSAtIHRhcmdldEVwb2NoKTsKICAgIGZvciAobGV0IGkgPSAxOyBpIDwgcm93cy5sZW5ndGg7IGkrKykgewogICAgICBjb25zdCBkID0gTWF0aC5hYnMocm93c1tpXS5lcG9jaCAtIHRhcmdldEVwb2NoKTsKICAgICAgaWYgKGQgPCBiZXN0KSB7CiAgICAgICAgYmVzdCA9IGQ7CiAgICAgICAgcmVmID0gcm93c1tpXTsKICAgICAgfQogICAgfQogICAgY29uc3QgcmVmUGN0ID0gY2FsY0JyZWNoYVBjdChyZWY/Lm1lcCwgcmVmPy5jY2wpOwogICAgY29uc3QgZGVsdGEgPSBOdW1iZXIuaXNGaW5pdGUoY3VycmVudFBjdCkgJiYgTnVtYmVyLmlzRmluaXRlKHJlZlBjdCkgPyBjdXJyZW50UGN0IC0gcmVmUGN0IDogbnVsbDsKICAgIHNldEJyZWNoYUhvdXJseURlbHRhKGRlbHRhKTsKCiAgICAvLyBFc2NhbGEgY29tcGFydGlkYSBwYXJhIE1FUCB5IENDTDogY29tcGFyYWNpw7NuIHZpc3VhbCBmaWVsLgogICAgY29uc3QgYWxsUHJpY2VWYWxzID0gbWVwVmFscy5jb25jYXQoY2NsVmFscyk7CiAgICBjb25zdCByYXdNaW4gPSBNYXRoLm1pbiguLi5hbGxQcmljZVZhbHMpOwogICAgY29uc3QgcmF3TWF4ID0gTWF0aC5tYXgoLi4uYWxsUHJpY2VWYWxzKTsKICAgIGNvbnN0IHByaWNlUGFkID0gTWF0aC5tYXgoMSwgKHJhd01heCAtIHJhd01pbikgKiAwLjA4KTsKICAgIGNvbnN0IHByaWNlTWluID0gcmF3TWluIC0gcHJpY2VQYWQ7CiAgICBjb25zdCBwcmljZU1heCA9IHJhd01heCArIHByaWNlUGFkOwoKICAgIG1lcExpbmUuc2V0QXR0cmlidXRlKCdwb2ludHMnLCBsaW5lUG9pbnRzKG1lcFZhbHMsIDMwLCA4NDAsIDI1LCAxMzAsIHByaWNlTWluLCBwcmljZU1heCkpOwogICAgY2NsTGluZS5zZXRBdHRyaWJ1dGUoJ3BvaW50cycsIGxpbmVQb2ludHMoY2NsVmFscywgMzAsIDg0MCwgMjUsIDEzMCwgcHJpY2VNaW4sIHByaWNlTWF4KSk7CiAgICBzdGF0ZS50cmVuZFJvd3MgPSByb3dzLm1hcCgociwgaSkgPT4gewogICAgICBjb25zdCB4ID0gMzAgKyAoKDg0MCAtIDMwKSAqIGkgLyBNYXRoLm1heCgxLCByb3dzLmxlbmd0aCAtIDEpKTsKICAgICAgcmV0dXJuIHsKICAgICAgICBlcG9jaDogci5lcG9jaCwKICAgICAgICBtZXA6IHIubWVwLAogICAgICAgIGNjbDogci5jY2wsCiAgICAgICAgcGN0OiBjYWxjQnJlY2hhUGN0KHIubWVwLCByLmNjbCksCiAgICAgICAgeCwKICAgICAgICBtZXBZOiB2YWx1ZVRvWShyLm1lcCwgMjUsIDEzMCwgcHJpY2VNaW4sIHByaWNlTWF4KSwKICAgICAgICBjY2xZOiB2YWx1ZVRvWShyLmNjbCwgMjUsIDEzMCwgcHJpY2VNaW4sIHByaWNlTWF4KQogICAgICB9OwogICAgfSk7CiAgICBoaWRlVHJlbmRIb3ZlcigpOwoKICAgIGNvbnN0IG1pZCA9IChwcmljZU1pbiArIHByaWNlTWF4KSAvIDI7CiAgICBzZXRUZXh0KCd0cmVuZC15LXRvcCcsIChwcmljZU1heCAvIDEwMDApLnRvRml4ZWQoMykpOwogICAgc2V0VGV4dCgndHJlbmQteS1taWQnLCAobWlkIC8gMTAwMCkudG9GaXhlZCgzKSk7CiAgICBzZXRUZXh0KCd0cmVuZC15LWxvdycsIChwcmljZU1pbiAvIDEwMDApLnRvRml4ZWQoMykpOwoKICAgIGNvbnN0IGlkeCA9IFswLCAwLjI1LCAwLjUsIDAuNzUsIDFdLm1hcCgocCkgPT4gTWF0aC5taW4ocm93cy5sZW5ndGggLSAxLCBNYXRoLmZsb29yKChyb3dzLmxlbmd0aCAtIDEpICogcCkpKTsKICAgIGNvbnN0IGxhYnMgPSBpZHgubWFwKChpKSA9PiByb3dEYXlIb3VyTGFiZWwocm93c1tpXT8uZXBvY2gpKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtMScsIGxhYnNbMF0gfHwgJ+KAlCcpOwogICAgc2V0VGV4dCgndHJlbmQteC0yJywgbGFic1sxXSB8fCAn4oCUJyk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTMnLCBsYWJzWzJdIHx8ICfigJQnKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtNCcsIGxhYnNbM10gfHwgJ+KAlCcpOwogICAgc2V0VGV4dCgndHJlbmQteC01JywgbGFic1s0XSB8fCAn4oCUJyk7CiAgfQoKICBmdW5jdGlvbiBnZXRGY2lUeXBlTGFiZWwodHlwZSkgewogICAgcmV0dXJuIHR5cGUgPT09ICd2YXJpYWJsZScgPyAnUmVudGEgdmFyaWFibGUgKEZDSSBBcmdlbnRpbmEpJyA6ICdSZW50YSBmaWphIChGQ0kgQXJnZW50aW5hKSc7CiAgfQoKICBmdW5jdGlvbiBzZXRGY2lUeXBlKHR5cGUpIHsKICAgIGNvbnN0IG5leHQgPSB0eXBlID09PSAndmFyaWFibGUnID8gJ3ZhcmlhYmxlJyA6ICdmaWphJzsKICAgIGlmIChzdGF0ZS5mY2lUeXBlID09PSBuZXh0KSByZXR1cm47CiAgICBzdGF0ZS5mY2lUeXBlID0gbmV4dDsKICAgIHN0YXRlLmZjaVBhZ2UgPSAxOwogICAgcmVuZGVyRmNpUmVudGFGaWphKCk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJGY2lSZW50YUZpamEocGF5bG9hZCwgcHJldmlvdXNQYXlsb2FkLCB0eXBlID0gc3RhdGUuZmNpVHlwZSwgYmFzZVBheWxvYWQpIHsKICAgIGNvbnN0IG5vcm1hbGl6ZWRUeXBlID0gdHlwZSA9PT0gJ3ZhcmlhYmxlJyA/ICd2YXJpYWJsZScgOiAnZmlqYSc7CiAgICBjb25zdCByb3dzRWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLXJvd3MnKTsKICAgIGNvbnN0IGVtcHR5RWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLWVtcHR5Jyk7CiAgICBpZiAoIXJvd3NFbCB8fCAhZW1wdHlFbCkgcmV0dXJuOwoKICAgIGNvbnN0IHRpdGxlRWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLXRpdGxlJyk7CiAgICBpZiAodGl0bGVFbCkgdGl0bGVFbC50ZXh0Q29udGVudCA9IGdldEZjaVR5cGVMYWJlbChzdGF0ZS5mY2lUeXBlKTsKICAgIGNvbnN0IHRhYkZpamEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLXRhYi1maWphJyk7CiAgICBjb25zdCB0YWJWYXJpYWJsZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktdGFiLXZhcmlhYmxlJyk7CiAgICBpZiAodGFiRmlqYSkgdGFiRmlqYS5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCBzdGF0ZS5mY2lUeXBlID09PSAnZmlqYScpOwogICAgaWYgKHRhYlZhcmlhYmxlKSB0YWJWYXJpYWJsZS5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCBzdGF0ZS5mY2lUeXBlID09PSAndmFyaWFibGUnKTsKCiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+IDEpIHsKICAgICAgY29uc3QgcHJldmlvdXNSb3dzID0gbm9ybWFsaXplRmNpUm93cyhwcmV2aW91c1BheWxvYWQpCiAgICAgICAgLm1hcCgoaXRlbSkgPT4gewogICAgICAgICAgY29uc3QgZm9uZG8gPSBTdHJpbmcoaXRlbT8uZm9uZG8gfHwgaXRlbT8ubm9tYnJlIHx8IGl0ZW0/LmZjaSB8fCAnJykudHJpbSgpOwogICAgICAgICAgcmV0dXJuIHsKICAgICAgICAgICAgZm9uZG8sCiAgICAgICAgICAgIHZjcDogdG9OdW1iZXIoaXRlbT8udmNwKSwKICAgICAgICAgICAgY2NwOiB0b051bWJlcihpdGVtPy5jY3ApLAogICAgICAgICAgICBwYXRyaW1vbmlvOiB0b051bWJlcihpdGVtPy5wYXRyaW1vbmlvKSwKICAgICAgICAgIH07CiAgICAgICAgfSkKICAgICAgICAuZmlsdGVyKChpdGVtKSA9PiBpdGVtLmZvbmRvKTsKICAgICAgY29uc3QgcHJldmlvdXNCeUZvbmRvID0gbmV3IE1hcCgpOwogICAgICBwcmV2aW91c1Jvd3MuZm9yRWFjaCgoaXRlbSkgPT4gewogICAgICAgIHByZXZpb3VzQnlGb25kby5zZXQobm9ybWFsaXplRmNpRm9uZG9LZXkoaXRlbS5mb25kbyksIGl0ZW0pOwogICAgICB9KTsKICAgICAgc3RhdGUuZmNpUHJldmlvdXNCeUZvbmRvQnlUeXBlW25vcm1hbGl6ZWRUeXBlXSA9IHByZXZpb3VzQnlGb25kbzsKICAgIH0KICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID4gMykgewogICAgICBjb25zdCBiYXNlUm93cyA9IG5vcm1hbGl6ZUZjaVJvd3MoYmFzZVBheWxvYWQpCiAgICAgICAgLm1hcCgoaXRlbSkgPT4gewogICAgICAgICAgY29uc3QgZm9uZG8gPSBTdHJpbmcoaXRlbT8uZm9uZG8gfHwgaXRlbT8ubm9tYnJlIHx8IGl0ZW0/LmZjaSB8fCAnJykudHJpbSgpOwogICAgICAgICAgcmV0dXJuIHsKICAgICAgICAgICAgZm9uZG8sCiAgICAgICAgICAgIHZjcDogdG9OdW1iZXIoaXRlbT8udmNwKQogICAgICAgICAgfTsKICAgICAgICB9KQogICAgICAgIC5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uZm9uZG8gJiYgaXRlbS52Y3AgIT09IG51bGwpOwogICAgICBjb25zdCBiYXNlQnlGb25kbyA9IG5ldyBNYXAoKTsKICAgICAgYmFzZVJvd3MuZm9yRWFjaCgoaXRlbSkgPT4gewogICAgICAgIGJhc2VCeUZvbmRvLnNldChub3JtYWxpemVGY2lGb25kb0tleShpdGVtLmZvbmRvKSwgaXRlbSk7CiAgICAgIH0pOwogICAgICBzdGF0ZS5mY2lCYXNlQnlGb25kb0J5VHlwZVtub3JtYWxpemVkVHlwZV0gPSBiYXNlQnlGb25kbzsKICAgICAgc3RhdGUuZmNpQmFzZURhdGVCeVR5cGVbbm9ybWFsaXplZFR5cGVdID0gdHlwZW9mIGJhc2VQYXlsb2FkPy5iYXNlRGF0ZSA9PT0gJ3N0cmluZycgPyBiYXNlUGF5bG9hZC5iYXNlRGF0ZSA6IG51bGw7CiAgICAgIHN0YXRlLmZjaUJhc2VUYXJnZXREYXRlQnlUeXBlW25vcm1hbGl6ZWRUeXBlXSA9IHR5cGVvZiBiYXNlUGF5bG9hZD8uYmFzZVRhcmdldERhdGUgPT09ICdzdHJpbmcnID8gYmFzZVBheWxvYWQuYmFzZVRhcmdldERhdGUgOiBudWxsOwogICAgfQogICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPiAwKSB7CiAgICAgIGNvbnN0IHJvd3MgPSBub3JtYWxpemVGY2lSb3dzKHBheWxvYWQpCiAgICAgICAgLm1hcCgoaXRlbSkgPT4gewogICAgICAgICAgY29uc3QgZm9uZG8gPSBTdHJpbmcoaXRlbT8uZm9uZG8gfHwgaXRlbT8ubm9tYnJlIHx8IGl0ZW0/LmZjaSB8fCAnJykudHJpbSgpOwogICAgICAgICAgY29uc3QgZmVjaGEgPSBTdHJpbmcoaXRlbT8uZmVjaGEgfHwgJycpLnRyaW0oKTsKICAgICAgICAgIGNvbnN0IHZjcCA9IHRvTnVtYmVyKGl0ZW0/LnZjcCk7CiAgICAgICAgICBjb25zdCBjY3AgPSB0b051bWJlcihpdGVtPy5jY3ApOwogICAgICAgICAgY29uc3QgcGF0cmltb25pbyA9IHRvTnVtYmVyKGl0ZW0/LnBhdHJpbW9uaW8pOwogICAgICAgICAgY29uc3QgaG9yaXpvbnRlID0gU3RyaW5nKGl0ZW0/Lmhvcml6b250ZSB8fCAnJykudHJpbSgpOwogICAgICAgICAgY29uc3QgZm9uZG9LZXkgPSBub3JtYWxpemVGY2lGb25kb0tleShmb25kbyk7CiAgICAgICAgICBjb25zdCBwcmV2aW91cyA9IHN0YXRlLmZjaVByZXZpb3VzQnlGb25kb0J5VHlwZVtub3JtYWxpemVkVHlwZV0uZ2V0KGZvbmRvS2V5KTsKICAgICAgICAgIGNvbnN0IGJhc2UgPSBzdGF0ZS5mY2lCYXNlQnlGb25kb0J5VHlwZVtub3JtYWxpemVkVHlwZV0uZ2V0KGZvbmRvS2V5KTsKICAgICAgICAgIGNvbnN0IG1vbnRobHlQY3QgPSBjb21wdXRlTW9udGhseVBjdCh2Y3AsIGJhc2U/LnZjcCk7CiAgICAgICAgICByZXR1cm4gewogICAgICAgICAgICBmb25kbywKICAgICAgICAgICAgZmVjaGEsCiAgICAgICAgICAgIHZjcCwKICAgICAgICAgICAgY2NwLAogICAgICAgICAgICBwYXRyaW1vbmlvLAogICAgICAgICAgICBob3Jpem9udGUsCiAgICAgICAgICAgIG1vbnRobHlQY3QsCiAgICAgICAgICAgIHByZXZpb3VzVmNwOiBwcmV2aW91cz8udmNwID8/IG51bGwsCiAgICAgICAgICAgIHZjcFRyZW5kOiBmY2lUcmVuZERpcih2Y3AsIHByZXZpb3VzPy52Y3ApLAogICAgICAgICAgICBjY3BUcmVuZDogZmNpVHJlbmREaXIoY2NwLCBwcmV2aW91cz8uY2NwKSwKICAgICAgICAgICAgcGF0cmltb25pb1RyZW5kOiBmY2lUcmVuZERpcihwYXRyaW1vbmlvLCBwcmV2aW91cz8ucGF0cmltb25pbyksCiAgICAgICAgICB9OwogICAgICAgIH0pCiAgICAgICAgLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5mb25kbyAmJiAoaXRlbS52Y3AgIT09IG51bGwgfHwgaXRlbS5mZWNoYSkpOwogICAgICBjb25zdCBzb3J0ZWRSb3dzID0gcm93cy5zbGljZSgpLnNvcnQoKGEsIGIpID0+IChiLnBhdHJpbW9uaW8gPz8gLUluZmluaXR5KSAtIChhLnBhdHJpbW9uaW8gPz8gLUluZmluaXR5KSk7CiAgICAgIHN0YXRlLmZjaVJvd3NCeVR5cGVbbm9ybWFsaXplZFR5cGVdID0gc29ydGVkUm93czsKICAgICAgc3RhdGUuZmNpRGF0ZUJ5VHlwZVtub3JtYWxpemVkVHlwZV0gPSBzb3J0ZWRSb3dzLmZpbmQoKHJvdykgPT4gcm93LmZlY2hhKT8uZmVjaGEgfHwgJ+KAlCc7CiAgICAgIGlmIChub3JtYWxpemVkVHlwZSA9PT0gc3RhdGUuZmNpVHlwZSkgc3RhdGUuZmNpUGFnZSA9IDE7CiAgICB9CgogICAgY29uc3QgYWN0aXZlUm93cyA9IHN0YXRlLmZjaVJvd3NCeVR5cGVbc3RhdGUuZmNpVHlwZV0gfHwgW107CiAgICBjb25zdCBxdWVyeSA9IHN0YXRlLmZjaVF1ZXJ5LnRyaW0oKS50b0xvd2VyQ2FzZSgpOwogICAgY29uc3QgZmlsdGVyZWQgPSBxdWVyeQogICAgICA/IGFjdGl2ZVJvd3MuZmlsdGVyKChyb3cpID0+IHJvdy5mb25kby50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHF1ZXJ5KSkKICAgICAgOiBhY3RpdmVSb3dzLnNsaWNlKCk7CgogICAgY29uc3QgdG90YWxQYWdlcyA9IE1hdGgubWF4KDEsIE1hdGguY2VpbChmaWx0ZXJlZC5sZW5ndGggLyBGQ0lfUEFHRV9TSVpFKSk7CiAgICBzdGF0ZS5mY2lQYWdlID0gTWF0aC5taW4oTWF0aC5tYXgoMSwgc3RhdGUuZmNpUGFnZSksIHRvdGFsUGFnZXMpOwogICAgY29uc3QgZnJvbSA9IChzdGF0ZS5mY2lQYWdlIC0gMSkgKiBGQ0lfUEFHRV9TSVpFOwogICAgY29uc3QgcGFnZVJvd3MgPSBmaWx0ZXJlZC5zbGljZShmcm9tLCBmcm9tICsgRkNJX1BBR0VfU0laRSk7CgogICAgY29uc3QgZGF0ZUVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1sYXN0LWRhdGUnKTsKICAgIGNvbnN0IGZpcnN0RGF0ZSA9IGZpbHRlcmVkLmZpbmQoKHJvdykgPT4gcm93LmZlY2hhKT8uZmVjaGEgfHwgc3RhdGUuZmNpRGF0ZUJ5VHlwZVtzdGF0ZS5mY2lUeXBlXSB8fCAn4oCUJzsKICAgIGlmIChkYXRlRWwpIGRhdGVFbC50ZXh0Q29udGVudCA9IGBGZWNoYTogJHtmaXJzdERhdGV9YDsKICAgIHNldFRleHQoJ2ZjaS1wYWdlLWluZm8nLCBgJHtzdGF0ZS5mY2lQYWdlfSAvICR7dG90YWxQYWdlc31gKTsKICAgIGNvbnN0IHByZXZCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLXByZXYnKTsKICAgIGNvbnN0IG5leHRCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLW5leHQnKTsKICAgIGlmIChwcmV2QnRuKSBwcmV2QnRuLmRpc2FibGVkID0gc3RhdGUuZmNpUGFnZSA8PSAxOwogICAgaWYgKG5leHRCdG4pIG5leHRCdG4uZGlzYWJsZWQgPSBzdGF0ZS5mY2lQYWdlID49IHRvdGFsUGFnZXM7CgogICAgaWYgKCFwYWdlUm93cy5sZW5ndGgpIHsKICAgICAgcm93c0VsLmlubmVySFRNTCA9ICcnOwogICAgICBpZiAocXVlcnkpIGVtcHR5RWwudGV4dENvbnRlbnQgPSAnTm8gaGF5IHJlc3VsdGFkb3MgcGFyYSBsYSBiw7pzcXVlZGEgaW5kaWNhZGEuJzsKICAgICAgZWxzZSBlbXB0eUVsLnRleHRDb250ZW50ID0gYE5vIGhheSBkYXRvcyBkZSAke3N0YXRlLmZjaVR5cGUgPT09ICd2YXJpYWJsZScgPyAncmVudGEgdmFyaWFibGUnIDogJ3JlbnRhIGZpamEnfSBkaXNwb25pYmxlcyBlbiBlc3RlIG1vbWVudG8uYDsKICAgICAgZW1wdHlFbC5zdHlsZS5kaXNwbGF5ID0gJ2Jsb2NrJzsKICAgICAgcmVuZGVyRmNpQmVuY2htYXJrSW5mbygpOwogICAgICByZXR1cm47CiAgICB9CgogICAgZW1wdHlFbC5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwogICAgcm93c0VsLmlubmVySFRNTCA9IHBhZ2VSb3dzLm1hcCgocm93KSA9PiBgCiAgICAgIDx0cj4KICAgICAgICA8dGQgdGl0bGU9IiR7ZXNjYXBlSHRtbChyb3cuZm9uZG8pfSI+JHtlc2NhcGVIdG1sKHJvdy5mb25kbyl9PC90ZD4KICAgICAgICA8dGQ+JHtyZW5kZXJGY2lUcmVuZFZhbHVlKHJvdy52Y3AsIHJvdy52Y3BUcmVuZCl9PC90ZD4KICAgICAgICA8dGQ+JHtyZW5kZXJGY2lUcmVuZFZhbHVlKHJvdy5jY3AsIHJvdy5jY3BUcmVuZCl9PC90ZD4KICAgICAgICA8dGQ+JHtyZW5kZXJGY2lUcmVuZFZhbHVlKHJvdy5wYXRyaW1vbmlvLCByb3cucGF0cmltb25pb1RyZW5kKX08L3RkPgogICAgICAgIDx0ZD4ke2VzY2FwZUh0bWwocm93Lmhvcml6b250ZSB8fCAn4oCUJyl9PC90ZD4KICAgICAgICA8dGQgY2xhc3M9ImZjaS1zaWduYWwtY2VsbCI+JHtyZW5kZXJGY2lTaWduYWxCYWRnZShjb21wdXRlRmNpU2lnbmFsKHJvdywgc3RhdGUuZmNpVHlwZSkpfTwvdGQ+CiAgICAgIDwvdHI+CiAgICBgKS5qb2luKCcnKTsKICAgIHNhdmVGY2lTaWduYWxTdHJlYWtzKCk7CiAgICByZW5kZXJGY2lCZW5jaG1hcmtJbmZvKCk7CiAgfQoKICAvLyA0KSBGdW5jacOzbiBjZW50cmFsIGZldGNoQWxsKCkKICBhc3luYyBmdW5jdGlvbiBmZXRjaEpzb24odXJsKSB7CiAgICBjb25zdCBjdHJsID0gbmV3IEFib3J0Q29udHJvbGxlcigpOwogICAgY29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4gY3RybC5hYm9ydCgpLCAxMjAwMCk7CiAgICB0cnkgewogICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6ICduby1zdG9yZScsIHNpZ25hbDogY3RybC5zaWduYWwgfSk7CiAgICAgIGlmICghcmVzLm9rKSB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXMuc3RhdHVzfWApOwogICAgICByZXR1cm4gYXdhaXQgcmVzLmpzb24oKTsKICAgIH0gZmluYWxseSB7CiAgICAgIGNsZWFyVGltZW91dCh0aW1lb3V0KTsKICAgIH0KICB9CgogIGFzeW5jIGZ1bmN0aW9uIGZldGNoQWxsKG9wdGlvbnMgPSB7fSkgewogICAgaWYgKHN0YXRlLmlzRmV0Y2hpbmcpIHJldHVybjsKICAgIHN0YXRlLmlzRmV0Y2hpbmcgPSB0cnVlOwogICAgc2V0TG9hZGluZyhOVU1FUklDX0lEUywgdHJ1ZSk7CiAgICBzZXRGcmVzaEJhZGdlKCdBY3R1YWxpemFuZG/igKYnLCAnZmV0Y2hpbmcnKTsKICAgIHNldEVycm9yQmFubmVyKGZhbHNlKTsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHRhc2tzID0gW1snYnVuZGxlJywgRU5EUE9JTlRTLmJ1bmRsZV1dOwoKICAgICAgY29uc3Qgc2V0dGxlZCA9IGF3YWl0IFByb21pc2UuYWxsU2V0dGxlZCh0YXNrcy5tYXAoYXN5bmMgKFtuYW1lLCB1cmxdKSA9PiB7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIGNvbnN0IGRhdGEgPSBhd2FpdCBmZXRjaEpzb24odXJsKTsKICAgICAgICAgIHJldHVybiB7IG5hbWUsIGRhdGEgfTsKICAgICAgICB9IGNhdGNoIChlcnJvcikgewogICAgICAgICAgY29uc29sZS5lcnJvcihgW1JhZGFyTUVQXSBlcnJvciBlbiAke25hbWV9YCwgZXJyb3IpOwogICAgICAgICAgdGhyb3cgeyBuYW1lLCBlcnJvciB9OwogICAgICAgIH0KICAgICAgfSkpOwoKICAgICAgY29uc3QgYmFnID0gewogICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSwKICAgICAgICBtZXBDY2w6IG51bGwsCiAgICAgICAgZmNpUmVudGFGaWphOiBudWxsLAogICAgICAgIGZjaVJlbnRhRmlqYVBlbnVsdGltbzogbnVsbCwKICAgICAgICBmY2lSZW50YUZpamFNZXNCYXNlOiBudWxsLAogICAgICAgIGZjaVJlbnRhVmFyaWFibGU6IG51bGwsCiAgICAgICAgZmNpUmVudGFWYXJpYWJsZVBlbnVsdGltbzogbnVsbCwKICAgICAgICBmY2lSZW50YVZhcmlhYmxlTWVzQmFzZTogbnVsbCwKICAgICAgICBiZW5jaG1hcmtQbGF6b0Zpam86IG51bGwsCiAgICAgICAgYmVuY2htYXJrSW5mbGFjaW9uOiBudWxsCiAgICAgIH07CiAgICAgIGNvbnN0IGZhaWxlZCA9IFtdOwogICAgICBjb25zdCBidW5kbGVSZXN1bHQgPSBzZXR0bGVkWzBdOwogICAgICBpZiAoYnVuZGxlUmVzdWx0LnN0YXR1cyA9PT0gJ2Z1bGZpbGxlZCcgJiYgYnVuZGxlUmVzdWx0LnZhbHVlPy5kYXRhICYmIHR5cGVvZiBidW5kbGVSZXN1bHQudmFsdWUuZGF0YSA9PT0gJ29iamVjdCcpIHsKICAgICAgICBPYmplY3QuYXNzaWduKGJhZywgYnVuZGxlUmVzdWx0LnZhbHVlLmRhdGEpOwogICAgICB9IGVsc2UgewogICAgICAgIGZhaWxlZC5wdXNoKCdidW5kbGUnKTsKICAgICAgfQoKICAgICAgY29uc3QgcGZEYXRhID0gYmFnLmJlbmNobWFya1BsYXpvRmlqbz8uZGF0YSB8fCB7fTsKICAgICAgY29uc3QgaW5mRGF0YSA9IGJhZy5iZW5jaG1hcmtJbmZsYWNpb24/LmRhdGEgfHwge307CiAgICAgIHN0YXRlLmJlbmNobWFyayA9IHsKICAgICAgICBwbGF6b0Zpam9Nb250aGx5UGN0OiB0b051bWJlcihwZkRhdGE/Lm1vbnRobHlQY3QpLAogICAgICAgIGluZmxhY2lvbk1vbnRobHlQY3Q6IHRvTnVtYmVyKGluZkRhdGE/Lm1vbnRobHlQY3QpLAogICAgICAgIGluZmxhY2lvbkRhdGU6IHR5cGVvZiBpbmZEYXRhPy5kYXRlID09PSAnc3RyaW5nJyA/IGluZkRhdGEuZGF0ZSA6IG51bGwsCiAgICAgICAgdXBkYXRlZEF0SHVtYW5BcnQ6IGJhZy5iZW5jaG1hcmtQbGF6b0Zpam8/LmZldGNoZWRBdEh1bWFuQXJ0IHx8IGJhZy5iZW5jaG1hcmtJbmZsYWNpb24/LmZldGNoZWRBdEh1bWFuQXJ0IHx8IG51bGwKICAgICAgfTsKCiAgICAgIHJlbmRlck1lcENjbChiYWcubWVwQ2NsKTsKICAgICAgaWYgKGJhZy5mY2lSZW50YUZpamEgfHwgYmFnLmZjaVJlbnRhRmlqYVBlbnVsdGltbykgewogICAgICAgIHJlbmRlckZjaVJlbnRhRmlqYShiYWcuZmNpUmVudGFGaWphLCBiYWcuZmNpUmVudGFGaWphUGVudWx0aW1vLCAnZmlqYScsIGJhZy5mY2lSZW50YUZpamFNZXNCYXNlKTsKICAgICAgfQogICAgICBpZiAoYmFnLmZjaVJlbnRhVmFyaWFibGUgfHwgYmFnLmZjaVJlbnRhVmFyaWFibGVQZW51bHRpbW8pIHsKICAgICAgICByZW5kZXJGY2lSZW50YUZpamEoYmFnLmZjaVJlbnRhVmFyaWFibGUsIGJhZy5mY2lSZW50YVZhcmlhYmxlUGVudWx0aW1vLCAndmFyaWFibGUnLCBiYWcuZmNpUmVudGFWYXJpYWJsZU1lc0Jhc2UpOwogICAgICB9CiAgICAgIHJlbmRlckZjaVJlbnRhRmlqYSgpOwogICAgICBzdGF0ZS5sYXN0TWVwUGF5bG9hZCA9IGJhZy5tZXBDY2w7CiAgICAgIHJlbmRlck1ldHJpY3MyNGgoYmFnLm1lcENjbCk7CiAgICAgIHJlbmRlclRyZW5kKGJhZy5tZXBDY2wpOwogICAgICByZW5kZXJIaXN0b3J5KGJhZy5tZXBDY2wpOwogICAgICBjb25zdCBtZXBSb290ID0gZXh0cmFjdFJvb3QoYmFnLm1lcENjbCk7CiAgICAgIGNvbnN0IHVwZGF0ZWRBcnQgPSB0eXBlb2YgbWVwUm9vdD8udXBkYXRlZEF0SHVtYW5BcnQgPT09ICdzdHJpbmcnID8gbWVwUm9vdC51cGRhdGVkQXRIdW1hbkFydCA6IG51bGw7CiAgICAgIGNvbnN0IHNvdXJjZVRzTXMgPSB0b051bWJlcihtZXBSb290Py5zb3VyY2VTdGF0dXM/LmxhdGVzdFNvdXJjZVRzTXMpCiAgICAgICAgPz8gdG9OdW1iZXIobWVwUm9vdD8uY3VycmVudD8ubWVwVHNNcykKICAgICAgICA/PyB0b051bWJlcihtZXBSb290Py5jdXJyZW50Py5jY2xUc01zKQogICAgICAgID8/IG51bGw7CiAgICAgIHN0YXRlLnNvdXJjZVRzTXMgPSBzb3VyY2VUc01zOwogICAgICBzZXRUZXh0KCdsYXN0LXJ1bi10aW1lJywgdXBkYXRlZEFydCB8fCBmbXRBcmdUaW1lU2VjLmZvcm1hdChuZXcgRGF0ZSgpKSk7CiAgICAgIGFwcGx5RGF0YUNvbmZpZGVuY2VTdGF0ZShtZXBSb290KTsKCiAgICAgIGNvbnN0IHN1Y2Nlc3NDb3VudCA9IHRhc2tzLmxlbmd0aCAtIGZhaWxlZC5sZW5ndGg7CiAgICAgIGlmIChzdWNjZXNzQ291bnQgPiAwKSB7CiAgICAgICAgc3RhdGUubGFzdFN1Y2Nlc3NBdCA9IERhdGUubm93KCk7CiAgICAgICAgc3RhdGUucmV0cnlJbmRleCA9IDA7CiAgICAgICAgaWYgKHN0YXRlLnJldHJ5VGltZXIpIGNsZWFyVGltZW91dChzdGF0ZS5yZXRyeVRpbWVyKTsKICAgICAgICBzYXZlQ2FjaGUoYmFnKTsKICAgICAgICBjb25zdCBhZ2VMYWJlbCA9IHNvdXJjZVRzTXMgIT0gbnVsbCA/IGZvcm1hdFNvdXJjZUFnZUxhYmVsKHNvdXJjZVRzTXMpIDogbnVsbDsKICAgICAgICBjb25zdCBiYWRnZUJhc2UgPSBhZ2VMYWJlbCA/IGDDmmx0aW1hIGFjdHVhbGl6YWNpw7NuIGhhY2U6ICR7YWdlTGFiZWx9YCA6ICdNb3N0cmFuZG8gw7psdGltbyBzbmFwc2hvdCB2w6FsaWRvJzsKICAgICAgICBpZiAoZmFpbGVkLmxlbmd0aCkgc2V0RnJlc2hCYWRnZShgQWN0dWFsaXphY2nDs24gcGFyY2lhbCDCtyAke2JhZGdlQmFzZX1gLCAnaWRsZScpOwogICAgICAgIGVsc2UgYXBwbHlEYXRhQ29uZmlkZW5jZVN0YXRlKG1lcFJvb3QsIHsgZm9yY2VCYWRnZTogdHJ1ZSB9KTsKICAgICAgICByZWZyZXNoRnJlc2hCYWRnZUZyb21Tb3VyY2UoKTsKICAgICAgfSBlbHNlIHsKICAgICAgICBjb25zdCBhdHRlbXB0ID0gc3RhdGUucmV0cnlJbmRleCArIDE7CiAgICAgICAgaWYgKHN0YXRlLnJldHJ5SW5kZXggPCBSRVRSWV9ERUxBWVMubGVuZ3RoKSB7CiAgICAgICAgICBjb25zdCBkZWxheSA9IFJFVFJZX0RFTEFZU1tzdGF0ZS5yZXRyeUluZGV4XTsKICAgICAgICAgIHN0YXRlLnJldHJ5SW5kZXggKz0gMTsKICAgICAgICAgIHNldEZyZXNoQmFkZ2UoYEVycm9yIMK3IFJlaW50ZW50byBlbiAke01hdGgucm91bmQoZGVsYXkgLyAxMDAwKX1zYCwgJ2Vycm9yJyk7CiAgICAgICAgICBpZiAoc3RhdGUucmV0cnlUaW1lcikgY2xlYXJUaW1lb3V0KHN0YXRlLnJldHJ5VGltZXIpOwogICAgICAgICAgc3RhdGUucmV0cnlUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gZmV0Y2hBbGwoeyBtYW51YWw6IHRydWUgfSksIGRlbGF5KTsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgc2V0RnJlc2hCYWRnZSgnRXJyb3IgwrcgUmVpbnRlbnRhcicsICdlcnJvcicpOwogICAgICAgICAgc2V0RXJyb3JCYW5uZXIodHJ1ZSwgJ0Vycm9yIGFsIGFjdHVhbGl6YXIgwrcgUmVpbnRlbnRhcicpOwogICAgICAgICAgY29uc29sZS5lcnJvcihgW1JhZGFyTUVQXSBzZSBhZ290YXJvbiByZXRyaWVzICgke2F0dGVtcHR9IGludGVudG9zKWApOwogICAgICAgICAgaWYgKHdpbmRvdy5zY2hlZHVsZXIpIHdpbmRvdy5zY2hlZHVsZXIuc3RvcCgpOwogICAgICAgIH0KICAgICAgfQogICAgfSBmaW5hbGx5IHsKICAgICAgc2V0TG9hZGluZyhOVU1FUklDX0lEUywgZmFsc2UpOwogICAgICBzdGF0ZS5pc0ZldGNoaW5nID0gZmFsc2U7CiAgICB9CiAgfQoKICAvLyA1KSBDbGFzZSBNYXJrZXRTY2hlZHVsZXIKICBjbGFzcyBNYXJrZXRTY2hlZHVsZXIgewogICAgY29uc3RydWN0b3IoZmV0Y2hGbiwgaW50ZXJ2YWxNcyA9IDMwMDAwMCkgewogICAgICB0aGlzLmZldGNoRm4gPSBmZXRjaEZuOwogICAgICB0aGlzLmludGVydmFsTXMgPSBpbnRlcnZhbE1zOwogICAgICB0aGlzLnRpbWVyID0gbnVsbDsKICAgICAgdGhpcy53YWl0VGltZXIgPSBudWxsOwogICAgICB0aGlzLmNvdW50ZG93blRpbWVyID0gbnVsbDsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBudWxsOwogICAgICB0aGlzLnJ1bm5pbmcgPSBmYWxzZTsKICAgICAgdGhpcy5wYXVzZWQgPSBmYWxzZTsKICAgIH0KCiAgICBzdGFydCgpIHsKICAgICAgaWYgKHRoaXMucnVubmluZykgcmV0dXJuOwogICAgICB0aGlzLnJ1bm5pbmcgPSB0cnVlOwogICAgICB0aGlzLnBhdXNlZCA9IGZhbHNlOwogICAgICBpZiAodGhpcy5pc01hcmtldE9wZW4oKSkgewogICAgICAgIHNldE1hcmtldFRhZyh0cnVlKTsKICAgICAgICB0aGlzLl9zY2hlZHVsZSh0aGlzLmludGVydmFsTXMpOwogICAgICB9IGVsc2UgewogICAgICAgIHNldE1hcmtldFRhZyhmYWxzZSk7CiAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgfQogICAgICB0aGlzLl9zdGFydENvdW50ZG93bigpOwogICAgfQoKICAgIHBhdXNlKCkgewogICAgICB0aGlzLnBhdXNlZCA9IHRydWU7CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLnRpbWVyKTsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMud2FpdFRpbWVyKTsKICAgICAgdGhpcy50aW1lciA9IG51bGw7CiAgICAgIHRoaXMud2FpdFRpbWVyID0gbnVsbDsKICAgICAgdGhpcy5fc3RvcENvdW50ZG93bigpOwogICAgICBjb25zdCBjb3VudGRvd24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY291bnRkb3duLXRleHQnKTsKICAgICAgaWYgKGNvdW50ZG93bikgY291bnRkb3duLnRleHRDb250ZW50ID0gJ0FjdHVhbGl6YWNpw7NuIHBhdXNhZGEnOwogICAgfQoKICAgIHJlc3VtZSgpIHsKICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcpIHRoaXMucnVubmluZyA9IHRydWU7CiAgICAgIHRoaXMucGF1c2VkID0gZmFsc2U7CiAgICAgIGNvbnN0IGNvbnRpbnVlUmVzdW1lID0gKCkgPT4gewogICAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcodHJ1ZSk7CiAgICAgICAgICB0aGlzLl9zY2hlZHVsZSh0aGlzLmludGVydmFsTXMpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcoZmFsc2UpOwogICAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgICB9CiAgICAgICAgdGhpcy5fc3RhcnRDb3VudGRvd24oKTsKICAgICAgfTsKICAgICAgaWYgKERhdGUubm93KCkgLSBzdGF0ZS5sYXN0U3VjY2Vzc0F0ID4gdGhpcy5pbnRlcnZhbE1zKSB7CiAgICAgICAgUHJvbWlzZS5yZXNvbHZlKHRoaXMuZmV0Y2hGbih7IG1hbnVhbDogdHJ1ZSB9KSkuZmluYWxseShjb250aW51ZVJlc3VtZSk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgY29udGludWVSZXN1bWUoKTsKICAgICAgfQogICAgfQoKICAgIHN0b3AoKSB7CiAgICAgIHRoaXMucnVubmluZyA9IGZhbHNlOwogICAgICB0aGlzLnBhdXNlZCA9IGZhbHNlOwogICAgICBjbGVhclRpbWVvdXQodGhpcy50aW1lcik7CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLndhaXRUaW1lcik7CiAgICAgIHRoaXMudGltZXIgPSBudWxsOwogICAgICB0aGlzLndhaXRUaW1lciA9IG51bGw7CiAgICAgIHRoaXMubmV4dFJ1bkF0ID0gbnVsbDsKICAgICAgdGhpcy5fc3RvcENvdW50ZG93bigpOwogICAgfQoKICAgIGlzTWFya2V0T3BlbigpIHsKICAgICAgY29uc3QgcCA9IGdldEFyZ05vd1BhcnRzKCk7CiAgICAgIGNvbnN0IGJ1c2luZXNzRGF5ID0gcC53ZWVrZGF5ID49IDEgJiYgcC53ZWVrZGF5IDw9IDU7CiAgICAgIGNvbnN0IHNlY29uZHMgPSBwLmhvdXIgKiAzNjAwICsgcC5taW51dGUgKiA2MCArIHAuc2Vjb25kOwogICAgICBjb25zdCBmcm9tID0gMTAgKiAzNjAwICsgMzAgKiA2MDsKICAgICAgY29uc3QgdG8gPSAxOCAqIDM2MDA7CiAgICAgIHJldHVybiBidXNpbmVzc0RheSAmJiBzZWNvbmRzID49IGZyb20gJiYgc2Vjb25kcyA8IHRvOwogICAgfQoKICAgIGdldE5leHRSdW5UaW1lKCkgewogICAgICByZXR1cm4gdGhpcy5uZXh0UnVuQXQgPyBuZXcgRGF0ZSh0aGlzLm5leHRSdW5BdCkgOiBudWxsOwogICAgfQoKICAgIF9zY2hlZHVsZShkZWxheU1zKSB7CiAgICAgIGlmICghdGhpcy5ydW5uaW5nIHx8IHRoaXMucGF1c2VkKSByZXR1cm47CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLnRpbWVyKTsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBEYXRlLm5vdygpICsgZGVsYXlNczsKICAgICAgdGhpcy50aW1lciA9IHNldFRpbWVvdXQoYXN5bmMgKCkgPT4gewogICAgICAgIGlmICghdGhpcy5ydW5uaW5nIHx8IHRoaXMucGF1c2VkKSByZXR1cm47CiAgICAgICAgaWYgKCF0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcoZmFsc2UpOwogICAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgc2V0TWFya2V0VGFnKHRydWUpOwogICAgICAgIGF3YWl0IHRoaXMuZmV0Y2hGbigpOwogICAgICAgIHRoaXMuX3NjaGVkdWxlKHRoaXMuaW50ZXJ2YWxNcyk7CiAgICAgIH0sIGRlbGF5TXMpOwogICAgfQoKICAgIF93YWl0Rm9yT3BlbigpIHsKICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMud2FpdFRpbWVyKTsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBEYXRlLm5vdygpICsgNjAwMDA7CiAgICAgIHRoaXMud2FpdFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7CiAgICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgICBpZiAodGhpcy5pc01hcmtldE9wZW4oKSkgewogICAgICAgICAgc2V0TWFya2V0VGFnKHRydWUpOwogICAgICAgICAgdGhpcy5mZXRjaEZuKHsgbWFudWFsOiB0cnVlIH0pOwogICAgICAgICAgdGhpcy5fc2NoZWR1bGUodGhpcy5pbnRlcnZhbE1zKTsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgc2V0TWFya2V0VGFnKGZhbHNlKTsKICAgICAgICAgIHRoaXMuX3dhaXRGb3JPcGVuKCk7CiAgICAgICAgfQogICAgICB9LCA2MDAwMCk7CiAgICB9CgogICAgX3N0YXJ0Q291bnRkb3duKCkgewogICAgICB0aGlzLl9zdG9wQ291bnRkb3duKCk7CiAgICAgIHRoaXMuY291bnRkb3duVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7CiAgICAgICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY291bnRkb3duLXRleHQnKTsKICAgICAgICBpZiAoIWVsIHx8IHRoaXMucGF1c2VkKSByZXR1cm47CiAgICAgICAgY29uc3QgbmV4dCA9IHRoaXMuZ2V0TmV4dFJ1blRpbWUoKTsKICAgICAgICBpZiAoIW5leHQpIHsKICAgICAgICAgIGVsLnRleHRDb250ZW50ID0gdGhpcy5pc01hcmtldE9wZW4oKSA/ICdQcsOzeGltYSBhY3R1YWxpemFjacOzbiBlbiDigJQnIDogJ01lcmNhZG8gY2VycmFkbyc7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIGNvbnN0IGRpZmYgPSBNYXRoLm1heCgwLCBuZXh0LmdldFRpbWUoKSAtIERhdGUubm93KCkpOwogICAgICAgIGNvbnN0IG0gPSBNYXRoLmZsb29yKGRpZmYgLyA2MDAwMCk7CiAgICAgICAgY29uc3QgcyA9IE1hdGguZmxvb3IoKGRpZmYgJSA2MDAwMCkgLyAxMDAwKTsKICAgICAgICBpZiAodGhpcy5pc01hcmtldE9wZW4oKSkgZWwudGV4dENvbnRlbnQgPSBgUHLDs3hpbWEgYWN0dWFsaXphY2nDs24gZW4gJHttfToke1N0cmluZyhzKS5wYWRTdGFydCgyLCAnMCcpfWA7CiAgICAgICAgZWxzZSBlbC50ZXh0Q29udGVudCA9ICdNZXJjYWRvIGNlcnJhZG8nOwogICAgICB9LCAxMDAwKTsKICAgIH0KCiAgICBfc3RvcENvdW50ZG93bigpIHsKICAgICAgY2xlYXJJbnRlcnZhbCh0aGlzLmNvdW50ZG93blRpbWVyKTsKICAgICAgdGhpcy5jb3VudGRvd25UaW1lciA9IG51bGw7CiAgICB9CiAgfQoKICAvLyA2KSBMw7NnaWNhIGRlIGNhY2jDqQogIGZ1bmN0aW9uIHNhdmVDYWNoZShkYXRhKSB7CiAgICB0cnkgewogICAgICBzZXNzaW9uU3RvcmFnZS5zZXRJdGVtKENBQ0hFX0tFWSwgSlNPTi5zdHJpbmdpZnkoewogICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSwKICAgICAgICBtZXBDY2w6IGRhdGEubWVwQ2NsLAogICAgICAgIGZjaVJlbnRhRmlqYTogZGF0YS5mY2lSZW50YUZpamEsCiAgICAgICAgZmNpUmVudGFGaWphUGVudWx0aW1vOiBkYXRhLmZjaVJlbnRhRmlqYVBlbnVsdGltbywKICAgICAgICBmY2lSZW50YUZpamFNZXNCYXNlOiBkYXRhLmZjaVJlbnRhRmlqYU1lc0Jhc2UsCiAgICAgICAgZmNpUmVudGFWYXJpYWJsZTogZGF0YS5mY2lSZW50YVZhcmlhYmxlLAogICAgICAgIGZjaVJlbnRhVmFyaWFibGVQZW51bHRpbW86IGRhdGEuZmNpUmVudGFWYXJpYWJsZVBlbnVsdGltbywKICAgICAgICBmY2lSZW50YVZhcmlhYmxlTWVzQmFzZTogZGF0YS5mY2lSZW50YVZhcmlhYmxlTWVzQmFzZSwKICAgICAgICBiZW5jaG1hcmtQbGF6b0Zpam86IGRhdGEuYmVuY2htYXJrUGxhem9GaWpvLAogICAgICAgIGJlbmNobWFya0luZmxhY2lvbjogZGF0YS5iZW5jaG1hcmtJbmZsYWNpb24KICAgICAgfSkpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBjb25zb2xlLmVycm9yKCdbUmFkYXJNRVBdIG5vIHNlIHB1ZG8gZ3VhcmRhciBjYWNoZScsIGUpOwogICAgfQogIH0KCiAgZnVuY3Rpb24gbG9hZENhY2hlKCkgewogICAgdHJ5IHsKICAgICAgY29uc3QgcmF3ID0gc2Vzc2lvblN0b3JhZ2UuZ2V0SXRlbShDQUNIRV9LRVkpOwogICAgICBpZiAoIXJhdykgcmV0dXJuIG51bGw7CiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTsKICAgICAgaWYgKCFwYXJzZWQudGltZXN0YW1wIHx8IERhdGUubm93KCkgLSBwYXJzZWQudGltZXN0YW1wID4gQ0FDSEVfVFRMX01TKSByZXR1cm4gbnVsbDsKICAgICAgcmV0dXJuIHBhcnNlZDsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgY29uc29sZS5lcnJvcignW1JhZGFyTUVQXSBjYWNoZSBpbnbDoWxpZGEnLCBlKTsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBjbGFtcERyYXdlcldpZHRoKHB4KSB7CiAgICByZXR1cm4gTWF0aC5tYXgoRFJBV0VSX01JTl9XLCBNYXRoLm1pbihEUkFXRVJfTUFYX1csIE1hdGgucm91bmQocHgpKSk7CiAgfQogIGZ1bmN0aW9uIHNhdmVEcmF3ZXJXaWR0aChweCkgewogICAgdHJ5IHsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oRFJBV0VSX1dJRFRIX0tFWSwgU3RyaW5nKGNsYW1wRHJhd2VyV2lkdGgocHgpKSk7IH0gY2F0Y2gge30KICB9CiAgZnVuY3Rpb24gbG9hZERyYXdlcldpZHRoKCkgewogICAgdHJ5IHsKICAgICAgY29uc3QgcmF3ID0gTnVtYmVyKGxvY2FsU3RvcmFnZS5nZXRJdGVtKERSQVdFUl9XSURUSF9LRVkpKTsKICAgICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShyYXcpID8gY2xhbXBEcmF3ZXJXaWR0aChyYXcpIDogbnVsbDsKICAgIH0gY2F0Y2ggewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CiAgZnVuY3Rpb24gYXBwbHlEcmF3ZXJXaWR0aChweCwgcGVyc2lzdCA9IGZhbHNlKSB7CiAgICBpZiAod2luZG93LmlubmVyV2lkdGggPD0gOTAwKSByZXR1cm47CiAgICBjb25zdCBuZXh0ID0gY2xhbXBEcmF3ZXJXaWR0aChweCk7CiAgICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuc3R5bGUuc2V0UHJvcGVydHkoJy0tZHJhd2VyLXcnLCBgJHtuZXh0fXB4YCk7CiAgICBpZiAocGVyc2lzdCkgc2F2ZURyYXdlcldpZHRoKG5leHQpOwogIH0KICBmdW5jdGlvbiBpbml0RHJhd2VyV2lkdGgoKSB7CiAgICBjb25zdCBzYXZlZCA9IGxvYWREcmF3ZXJXaWR0aCgpOwogICAgaWYgKHNhdmVkICE9PSBudWxsKSBhcHBseURyYXdlcldpZHRoKHNhdmVkLCBmYWxzZSk7CiAgfQogIGZ1bmN0aW9uIGJpbmREcmF3ZXJSZXNpemUoKSB7CiAgICBpZiAoc3RhdGUuZHJhd2VyUmVzaXplQm91bmQpIHJldHVybjsKICAgIGNvbnN0IGhhbmRsZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdkcmF3ZXItcmVzaXplcicpOwogICAgY29uc3QgZHJhd2VyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2RyYXdlcicpOwogICAgaWYgKCFoYW5kbGUgfHwgIWRyYXdlcikgcmV0dXJuOwogICAgc3RhdGUuZHJhd2VyUmVzaXplQm91bmQgPSB0cnVlOwogICAgaGFuZGxlLmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJkb3duJywgKGV2ZW50KSA9PiB7CiAgICAgIGlmICh3aW5kb3cuaW5uZXJXaWR0aCA8PSA5MDAgfHwgZXZlbnQuYnV0dG9uICE9PSAwKSByZXR1cm47CiAgICAgIGNvbnN0IHN0YXJ0WCA9IGV2ZW50LmNsaWVudFg7CiAgICAgIGNvbnN0IHN0YXJ0V2lkdGggPSBkcmF3ZXIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkud2lkdGg7CiAgICAgIGhhbmRsZS5jbGFzc0xpc3QuYWRkKCdhY3RpdmUnKTsKICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKICAgICAgY29uc3Qgb25Nb3ZlID0gKG1vdmVFdmVudCkgPT4gewogICAgICAgIGNvbnN0IGRlbHRhID0gbW92ZUV2ZW50LmNsaWVudFggLSBzdGFydFg7CiAgICAgICAgYXBwbHlEcmF3ZXJXaWR0aChzdGFydFdpZHRoIC0gZGVsdGEsIGZhbHNlKTsKICAgICAgfTsKICAgICAgY29uc3Qgb25VcCA9ICgpID0+IHsKICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcm1vdmUnLCBvbk1vdmUpOwogICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdwb2ludGVydXAnLCBvblVwKTsKICAgICAgICBoYW5kbGUuY2xhc3NMaXN0LnJlbW92ZSgnYWN0aXZlJyk7CiAgICAgICAgY29uc3Qgd2lkdGggPSBkcmF3ZXIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkud2lkdGg7CiAgICAgICAgYXBwbHlEcmF3ZXJXaWR0aCh3aWR0aCwgdHJ1ZSk7CiAgICAgIH07CiAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVybW92ZScsIG9uTW92ZSk7CiAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVydXAnLCBvblVwKTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gaGlkZVNtYXJ0VGlwKCkgewogICAgY29uc3QgdGlwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NtYXJ0LXRpcCcpOwogICAgaWYgKCF0aXApIHJldHVybjsKICAgIHRpcC5jbGFzc0xpc3QucmVtb3ZlKCdzaG93Jyk7CiAgICB0aXAuc2V0QXR0cmlidXRlKCdhcmlhLWhpZGRlbicsICd0cnVlJyk7CiAgfQogIGZ1bmN0aW9uIHNob3dTbWFydFRpcChhbmNob3IpIHsKICAgIGNvbnN0IHRpcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzbWFydC10aXAnKTsKICAgIGlmICghdGlwIHx8ICFhbmNob3IpIHJldHVybjsKICAgIGNvbnN0IHRleHQgPSBhbmNob3IuZ2V0QXR0cmlidXRlKCdkYXRhLXQnKTsKICAgIGlmICghdGV4dCkgcmV0dXJuOwogICAgdGlwLnRleHRDb250ZW50ID0gdGV4dDsKICAgIHRpcC5jbGFzc0xpc3QuYWRkKCdzaG93Jyk7CiAgICB0aXAuc2V0QXR0cmlidXRlKCdhcmlhLWhpZGRlbicsICdmYWxzZScpOwoKICAgIGNvbnN0IG1hcmdpbiA9IDg7CiAgICBjb25zdCByZWN0ID0gYW5jaG9yLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgY29uc3QgdGlwUmVjdCA9IHRpcC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICAgIGxldCBsZWZ0ID0gcmVjdC5sZWZ0OwogICAgaWYgKGxlZnQgKyB0aXBSZWN0LndpZHRoICsgbWFyZ2luID4gd2luZG93LmlubmVyV2lkdGgpIGxlZnQgPSB3aW5kb3cuaW5uZXJXaWR0aCAtIHRpcFJlY3Qud2lkdGggLSBtYXJnaW47CiAgICBpZiAobGVmdCA8IG1hcmdpbikgbGVmdCA9IG1hcmdpbjsKICAgIGxldCB0b3AgPSByZWN0LmJvdHRvbSArIDg7CiAgICBpZiAodG9wICsgdGlwUmVjdC5oZWlnaHQgKyBtYXJnaW4gPiB3aW5kb3cuaW5uZXJIZWlnaHQpIHRvcCA9IE1hdGgubWF4KG1hcmdpbiwgcmVjdC50b3AgLSB0aXBSZWN0LmhlaWdodCAtIDgpOwogICAgdGlwLnN0eWxlLmxlZnQgPSBgJHtNYXRoLnJvdW5kKGxlZnQpfXB4YDsKICAgIHRpcC5zdHlsZS50b3AgPSBgJHtNYXRoLnJvdW5kKHRvcCl9cHhgOwogIH0KICBmdW5jdGlvbiBpbml0U21hcnRUaXBzKCkgewogICAgaWYgKHN0YXRlLnNtYXJ0VGlwQm91bmQpIHJldHVybjsKICAgIHN0YXRlLnNtYXJ0VGlwQm91bmQgPSB0cnVlOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRpcC50aXAtZG93bicpLmZvckVhY2goKGVsKSA9PiB7CiAgICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlZW50ZXInLCAoKSA9PiBzaG93U21hcnRUaXAoZWwpKTsKICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignZm9jdXMnLCAoKSA9PiBzaG93U21hcnRUaXAoZWwpKTsKICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZXZlbnQpID0+IHsKICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIHNob3dTbWFydFRpcChlbCk7CiAgICAgIH0pOwogICAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWxlYXZlJywgaGlkZVNtYXJ0VGlwKTsKICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignYmx1cicsIGhpZGVTbWFydFRpcCk7CiAgICB9KTsKICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdzY3JvbGwnLCBoaWRlU21hcnRUaXAsIHRydWUpOwogICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3Jlc2l6ZScsICgpID0+IHsKICAgICAgaGlkZVNtYXJ0VGlwKCk7CiAgICAgIGluaXREcmF3ZXJXaWR0aCgpOwogICAgfSk7CiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChldmVudCkgPT4gewogICAgICBpZiAoIShldmVudC50YXJnZXQgaW5zdGFuY2VvZiBFbGVtZW50KSkgcmV0dXJuOwogICAgICBpZiAoIWV2ZW50LnRhcmdldC5jbG9zZXN0KCcudGlwLnRpcC1kb3duJykgJiYgIWV2ZW50LnRhcmdldC5jbG9zZXN0KCcjc21hcnQtdGlwJykpIGhpZGVTbWFydFRpcCgpOwogICAgfSk7CiAgfQoKICAvLyA3KSBJbmljaWFsaXphY2nDs24KICBzdGFydEZyZXNoVGlja2VyKCk7CiAgaW5pdERyYXdlcldpZHRoKCk7CiAgYmluZERyYXdlclJlc2l6ZSgpOwogIGluaXRTbWFydFRpcHMoKTsKICBmdW5jdGlvbiB0b2dnbGVEcmF3ZXIoKSB7CiAgICBjb25zdCBkcmF3ZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZHJhd2VyJyk7CiAgICBjb25zdCB3cmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2JvZHlXcmFwJyk7CiAgICBjb25zdCBidG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYnRuVGFzYXMnKTsKICAgIGNvbnN0IG92bCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdvdmVybGF5Jyk7CiAgICBjb25zdCBpc09wZW4gPSBkcmF3ZXIuY2xhc3NMaXN0LmNvbnRhaW5zKCdvcGVuJyk7CiAgICBkcmF3ZXIuY2xhc3NMaXN0LnRvZ2dsZSgnb3BlbicsICFpc09wZW4pOwogICAgd3JhcC5jbGFzc0xpc3QudG9nZ2xlKCdkcmF3ZXItb3BlbicsICFpc09wZW4pOwogICAgYnRuLmNsYXNzTGlzdC50b2dnbGUoJ2FjdGl2ZScsICFpc09wZW4pOwogICAgb3ZsLmNsYXNzTGlzdC50b2dnbGUoJ3Nob3cnLCAhaXNPcGVuKTsKICB9CgogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5waWxsW2RhdGEtZmlsdGVyXScpLmZvckVhY2goKHApID0+IHsKICAgIHAuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBhcHBseUZpbHRlcihwLmRhdGFzZXQuZmlsdGVyKSk7CiAgfSk7CiAgY29uc3QgY3N2QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2J0bi1kb3dubG9hZC1jc3YnKTsKICBpZiAoY3N2QnRuKSBjc3ZCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBkb3dubG9hZEhpc3RvcnlDc3YpOwogIGNvbnN0IGZjaVRhYkZpamEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLXRhYi1maWphJyk7CiAgaWYgKGZjaVRhYkZpamEpIHsKICAgIGZjaVRhYkZpamEuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBzZXRGY2lUeXBlKCdmaWphJykpOwogIH0KICBjb25zdCBmY2lUYWJWYXJpYWJsZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktdGFiLXZhcmlhYmxlJyk7CiAgaWYgKGZjaVRhYlZhcmlhYmxlKSB7CiAgICBmY2lUYWJWYXJpYWJsZS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHNldEZjaVR5cGUoJ3ZhcmlhYmxlJykpOwogIH0KICBjb25zdCBmY2lTZWFyY2ggPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLXNlYXJjaCcpOwogIGlmIChmY2lTZWFyY2gpIHsKICAgIGZjaVNlYXJjaC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IHsKICAgICAgc3RhdGUuZmNpUXVlcnkgPSBmY2lTZWFyY2gudmFsdWUgfHwgJyc7CiAgICAgIHN0YXRlLmZjaVBhZ2UgPSAxOwogICAgICByZW5kZXJGY2lSZW50YUZpamEoKTsKICAgIH0pOwogIH0KICBjb25zdCBmY2lQcmV2ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1wcmV2Jyk7CiAgaWYgKGZjaVByZXYpIHsKICAgIGZjaVByZXYuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIHN0YXRlLmZjaVBhZ2UgPSBNYXRoLm1heCgxLCBzdGF0ZS5mY2lQYWdlIC0gMSk7CiAgICAgIHJlbmRlckZjaVJlbnRhRmlqYSgpOwogICAgfSk7CiAgfQogIGNvbnN0IGZjaU5leHQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLW5leHQnKTsKICBpZiAoZmNpTmV4dCkgewogICAgZmNpTmV4dC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgc3RhdGUuZmNpUGFnZSArPSAxOwogICAgICByZW5kZXJGY2lSZW50YUZpamEoKTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gdG9nZ2xlR2xvcygpIHsKICAgIGNvbnN0IGdyaWQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZ2xvc0dyaWQnKTsKICAgIGNvbnN0IGFycm93ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2dsb3NBcnJvdycpOwogICAgY29uc3Qgb3BlbiA9IGdyaWQuY2xhc3NMaXN0LnRvZ2dsZSgnb3BlbicpOwogICAgYXJyb3cudGV4dENvbnRlbnQgPSBvcGVuID8gJ+KWtCcgOiAn4pa+JzsKICB9CgogIGNvbnN0IHJldHJ5QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Vycm9yLXJldHJ5LWJ0bicpOwogIGlmIChyZXRyeUJ0bikgewogICAgcmV0cnlCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIGlmICh3aW5kb3cuc2NoZWR1bGVyKSB3aW5kb3cuc2NoZWR1bGVyLnJlc3VtZSgpOwogICAgICBmZXRjaEFsbCh7IG1hbnVhbDogdHJ1ZSB9KTsKICAgIH0pOwogIH0KCiAgY29uc3QgY2FjaGVkID0gbG9hZENhY2hlKCk7CiAgaW5pdEhpc3RvcnlDb2x1bW5XaWR0aHMoKTsKICBiaW5kSGlzdG9yeUNvbHVtblJlc2l6ZSgpOwogIGluaXRGY2lDb2x1bW5XaWR0aHMoKTsKICBiaW5kRmNpQ29sdW1uUmVzaXplKCk7CiAgc3RhdGUuZmNpU2lnbmFsU3RyZWFrcyA9IGxvYWRGY2lTaWduYWxTdHJlYWtzKCk7CiAgaWYgKGNhY2hlZCkgewogICAgc3RhdGUubGFzdE1lcFBheWxvYWQgPSBjYWNoZWQubWVwQ2NsOwogICAgY29uc3QgcGZEYXRhID0gY2FjaGVkLmJlbmNobWFya1BsYXpvRmlqbz8uZGF0YSB8fCB7fTsKICAgIGNvbnN0IGluZkRhdGEgPSBjYWNoZWQuYmVuY2htYXJrSW5mbGFjaW9uPy5kYXRhIHx8IHt9OwogICAgc3RhdGUuYmVuY2htYXJrID0gewogICAgICBwbGF6b0Zpam9Nb250aGx5UGN0OiB0b051bWJlcihwZkRhdGE/Lm1vbnRobHlQY3QpLAogICAgICBpbmZsYWNpb25Nb250aGx5UGN0OiB0b051bWJlcihpbmZEYXRhPy5tb250aGx5UGN0KSwKICAgICAgaW5mbGFjaW9uRGF0ZTogdHlwZW9mIGluZkRhdGE/LmRhdGUgPT09ICdzdHJpbmcnID8gaW5mRGF0YS5kYXRlIDogbnVsbCwKICAgICAgdXBkYXRlZEF0SHVtYW5BcnQ6IGNhY2hlZC5iZW5jaG1hcmtQbGF6b0Zpam8/LmZldGNoZWRBdEh1bWFuQXJ0IHx8IGNhY2hlZC5iZW5jaG1hcmtJbmZsYWNpb24/LmZldGNoZWRBdEh1bWFuQXJ0IHx8IG51bGwKICAgIH07CiAgICBpZiAoY2FjaGVkLmZjaVJlbnRhRmlqYSB8fCBjYWNoZWQuZmNpUmVudGFGaWphUGVudWx0aW1vIHx8IGNhY2hlZC5mY2lSZW50YUZpamFNZXNCYXNlKSB7CiAgICAgIHJlbmRlckZjaVJlbnRhRmlqYShjYWNoZWQuZmNpUmVudGFGaWphLCBjYWNoZWQuZmNpUmVudGFGaWphUGVudWx0aW1vLCAnZmlqYScsIGNhY2hlZC5mY2lSZW50YUZpamFNZXNCYXNlKTsKICAgIH0KICAgIGlmIChjYWNoZWQuZmNpUmVudGFWYXJpYWJsZSB8fCBjYWNoZWQuZmNpUmVudGFWYXJpYWJsZVBlbnVsdGltbyB8fCBjYWNoZWQuZmNpUmVudGFWYXJpYWJsZU1lc0Jhc2UpIHsKICAgICAgcmVuZGVyRmNpUmVudGFGaWphKGNhY2hlZC5mY2lSZW50YVZhcmlhYmxlLCBjYWNoZWQuZmNpUmVudGFWYXJpYWJsZVBlbnVsdGltbywgJ3ZhcmlhYmxlJywgY2FjaGVkLmZjaVJlbnRhVmFyaWFibGVNZXNCYXNlKTsKICAgIH0KICAgIHJlbmRlckZjaVJlbnRhRmlqYSgpOwogICAgcmVuZGVyTWVwQ2NsKGNhY2hlZC5tZXBDY2wpOwogICAgcmVuZGVyTWV0cmljczI0aChjYWNoZWQubWVwQ2NsKTsKICAgIHJlbmRlclRyZW5kKGNhY2hlZC5tZXBDY2wpOwogICAgcmVuZGVySGlzdG9yeShjYWNoZWQubWVwQ2NsKTsKICAgIGNvbnN0IGNhY2hlZFJvb3QgPSBleHRyYWN0Um9vdChjYWNoZWQubWVwQ2NsKTsKICAgIHN0YXRlLnNvdXJjZVRzTXMgPSB0b051bWJlcihjYWNoZWRSb290Py5zb3VyY2VTdGF0dXM/LmxhdGVzdFNvdXJjZVRzTXMpCiAgICAgID8/IHRvTnVtYmVyKGNhY2hlZFJvb3Q/LmN1cnJlbnQ/Lm1lcFRzTXMpCiAgICAgID8/IHRvTnVtYmVyKGNhY2hlZFJvb3Q/LmN1cnJlbnQ/LmNjbFRzTXMpCiAgICAgID8/IG51bGw7CiAgICBhcHBseURhdGFDb25maWRlbmNlU3RhdGUoY2FjaGVkUm9vdCwgeyBmb3JjZUJhZGdlOiB0cnVlIH0pOwogICAgcmVmcmVzaEZyZXNoQmFkZ2VGcm9tU291cmNlKCk7CiAgfQoKICBhcHBseUZpbHRlcihzdGF0ZS5maWx0ZXJNb2RlKTsKCiAgd2luZG93LnNjaGVkdWxlciA9IG5ldyBNYXJrZXRTY2hlZHVsZXIoZmV0Y2hBbGwsIEZFVENIX0lOVEVSVkFMX01TKTsKICB3aW5kb3cuc2NoZWR1bGVyLnN0YXJ0KCk7CiAgZmV0Y2hBbGwoeyBtYW51YWw6IHRydWUgfSk7CgogIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3Zpc2liaWxpdHljaGFuZ2UnLCAoKSA9PiB7CiAgICBpZiAoZG9jdW1lbnQuaGlkZGVuKSB3aW5kb3cuc2NoZWR1bGVyLnBhdXNlKCk7CiAgICBlbHNlIHdpbmRvdy5zY2hlZHVsZXIucmVzdW1lKCk7CiAgfSk7Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K`;

function decodeBase64Utf8(b64) {
  const compact = b64.replace(/\s+/g, "");
  const binary = atob(compact);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function renderDashboardHtml() {
  return decodeBase64Utf8(DASHBOARD_HTML_B64);
}
