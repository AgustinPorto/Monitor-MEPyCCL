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
const UX_REDESIGN_DATE = "2026-02-26";
const MAX_HISTORY_ITEMS = 4000;
const THRESHOLDS = {
  maxAbsDiffArs: 12,
  maxPctDiff: 1.0,
};
const DEFAULT_ALERT_COOLDOWN_MINUTES = 120;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "/dashboard.html") {
      return htmlResponse(renderDashboardHtml());
    }

    if (path === "/api/data") {
      let state = normalizeState(await loadState(env));
      if (!state || !isUsableState(state)) {
        state = await runUpdate(env);
      }
      if (!state.history?.length) {
        const recoveredHistory = await loadHistory(env);
        if (recoveredHistory.length) {
          state.history = recoveredHistory;
          state.metrics24h = computeMetrics24h(recoveredHistory, Math.floor(Date.now() / 1000));
        }
      }
      return jsonResponse(decorateOperationalState(state), false);
    }

    if (path === "/api/health") {
      const state = await loadState(env);
      return jsonResponse(
        {
          ok: Boolean(state),
          updatedAtHumanArt: state?.updatedAtHumanArt || null,
          sourceStatus: state?.sourceStatus || null,
        },
        false,
      );
    }

    if (path === "/api/fci/renta-fija/ultimo") {
      let payload = await loadFciPayload(env, FCI_LAST_KEY);
      if (!payload) {
        await refreshFciRentaFijaData(env);
        payload = await loadFciPayload(env, FCI_LAST_KEY);
      }
      return jsonResponse(payload || buildEmptyFciPayload("ultimo"), false);
    }

    if (path === "/api/fci/renta-fija/penultimo") {
      let payload = await loadFciPayload(env, FCI_PREV_KEY);
      if (!payload) {
        await refreshFciRentaFijaData(env);
        payload = await loadFciPayload(env, FCI_PREV_KEY);
      }
      return jsonResponse(payload || buildEmptyFciPayload("penultimo"), false);
    }

    if (path === "/api/fci/renta-fija/mes-base") {
      let payload = await loadFciPayload(env, FCI_BASE30_KEY);
      if (!payload) {
        await refreshFciRentaFijaData(env);
        payload = await loadFciPayload(env, FCI_BASE30_KEY);
      }
      return jsonResponse(payload || buildEmptyFciPayload("base30"), false);
    }

    if (path === "/api/fci/status") {
      const status = await loadFciStatus(env);
      return jsonResponse(status || buildEmptyFciStatus(), false);
    }

    if (path === "/api/fci/renta-variable/ultimo") {
      let payload = await loadFciPayload(env, FCI_RV_LAST_KEY);
      if (!payload) {
        await refreshFciRentaVariableData(env);
        payload = await loadFciPayload(env, FCI_RV_LAST_KEY);
      }
      return jsonResponse(payload || buildEmptyFciPayload("ultimo"), false);
    }

    if (path === "/api/fci/renta-variable/penultimo") {
      let payload = await loadFciPayload(env, FCI_RV_PREV_KEY);
      if (!payload) {
        await refreshFciRentaVariableData(env);
        payload = await loadFciPayload(env, FCI_RV_PREV_KEY);
      }
      return jsonResponse(payload || buildEmptyFciPayload("penultimo"), false);
    }

    if (path === "/api/fci/renta-variable/mes-base") {
      let payload = await loadFciPayload(env, FCI_RV_BASE30_KEY);
      if (!payload) {
        await refreshFciRentaVariableData(env);
        payload = await loadFciPayload(env, FCI_RV_BASE30_KEY);
      }
      return jsonResponse(payload || buildEmptyFciPayload("base30"), false);
    }

    if (path === "/api/fci/renta-variable/status") {
      const status = await loadFciStatus(env, FCI_RV_STATE_KEY);
      return jsonResponse(status || buildEmptyFciStatus(), false);
    }

    if (path === "/api/benchmark/plazo-fijo") {
      let payload = await loadFciPayload(env, PLAZO_FIJO_BENCH_KEY);
      if (!payload) {
        await refreshBenchmarkData(env);
        payload = await loadFciPayload(env, PLAZO_FIJO_BENCH_KEY);
      }
      return jsonResponse(payload || buildEmptyBenchmarkPayload("plazo_fijo"), false);
    }

    if (path === "/api/benchmark/inflacion") {
      let payload = await loadFciPayload(env, INFLACION_BENCH_KEY);
      if (!payload) {
        await refreshBenchmarkData(env);
        payload = await loadFciPayload(env, INFLACION_BENCH_KEY);
      }
      return jsonResponse(payload || buildEmptyBenchmarkPayload("inflacion"), false);
    }

    if (path === "/api/benchmark/status") {
      const status = await loadFciPayload(env, BENCHMARK_STATE_KEY);
      return jsonResponse(status || buildEmptyBenchmarkStatus(), false);
    }

    if (path === "/api/snapshots") {
      const snapshots = await listSnapshots(env, 60);
      return jsonResponse({ count: snapshots.length, snapshots }, false);
    }

    if (path === "/api/recovery-check") {
      const state = normalizeState(await loadState(env));
      const history = state?.history?.length ? state.history : await loadHistory(env);
      const snapshots = await listSnapshots(env, 365);
      return jsonResponse(buildRecoveryCheck(history, snapshots), false);
    }

    if (path === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.allSettled([
      runUpdate(env),
      refreshFciRentaFijaData(env),
      refreshFciRentaVariableData(env),
      refreshBenchmarkData(env),
    ]));
  },
};

async function runUpdate(env) {
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
    const html = await fetchSourceHtml(SOURCE_URL);
    const mep = extractNumber(html, "mep", "sell");
    const ccl = extractNumber(html, "ccl", "sell");
    const mepTs = extractInt(html, "mep", "timestamp");
    const cclTs = extractInt(html, "ccl", "timestamp");

    if (!Number.isFinite(mep) || !Number.isFinite(ccl)) {
      throw new Error("No se pudo parsear MEP/CCL en la fuente");
    }

    const absDiff = round2(Math.abs(mep - ccl));
    const avg = (mep + ccl) / 2;
    const pctDiff = round2(avg > 0 ? (absDiff / avg) * 100 : 0);
    const similar = absDiff <= THRESHOLDS.maxAbsDiffArs || pctDiff <= THRESHOLDS.maxPctDiff;

    const history = Array.isArray(previous.history) ? previous.history.slice() : [];
    history.push({
      epoch: nowEpoch,
      label: formatArtDate(now),
      mep: round2(mep),
      ccl: round2(ccl),
      abs_diff: absDiff,
      pct_diff: pctDiff,
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
      absDiff,
      pctDiff,
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
    };
    next.status = deriveStatus(true, similar);
    next.operational = {
      ...(previous.operational || {}),
      lastSuccessAtHumanArt: formatArtDate(now),
      lastSuccessAtIso: now.toISOString(),
      nextRunAtHumanArt: formatArtDate(computeNextScheduledRun(new Date(now.getTime() + 60 * 1000))),
    };
    next.alerting = await maybeSendSimilarEmailAlert(env, previous, next, now, nowEpoch);
    next.lastError = null;
    next.lastErrorAtIso = null;
  } catch (error) {
    const trimmedHistory = Array.isArray(previous.history) ? previous.history.slice(-MAX_HISTORY_ITEMS) : [];
    const metrics24h = computeMetrics24h(trimmedHistory, nowEpoch);
    const freshness = computeFreshness(previous?.current?.mepTsMs, previous?.current?.cclTsMs, nowEpoch);

    next.history = trimmedHistory;
    next.metrics24h = metrics24h;
    next.current = previous.current || null;
    next.sourceStatus = {
      ok: false,
      text: "ERROR DE FUENTE",
      error: sanitizeError(error),
      freshLabel: freshness.label,
      freshWarn: freshness.warn,
      sourceAgeMinutes: freshness.ageMinutes,
      latestSourceTsMs: freshness.latestTsMs,
    };
    next.status = deriveStatus(false, Boolean(previous?.current?.similar));
    next.operational = {
      ...(previous.operational || {}),
      nextRunAtHumanArt: formatArtDate(computeNextScheduledRun(new Date(now.getTime() + 60 * 1000))),
    };
    next.alerting = {
      ...(previous.alerting || {}),
      enabled: isAlertsEnabled(env),
      lastRunAtHumanArt: formatArtDate(now),
      lastDecision: "skip_source_error",
    };
    next.lastError = sanitizeError(error);
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

function normalizeFciRows(payload) {
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

function normalizeFciPayload(kind, sourcePayload, now) {
  const rows = normalizeFciRows(sourcePayload);
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

async function fetchJsonSource(url, timeoutMs = 25000) {
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
      throw new Error(`Fuente FCI respondió ${response.status}`);
    }
    return await response.json();
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
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) <= 1.5) return n * 100;
  return n;
}

function computePlazoFijoBenchmark(sourcePayload, now) {
  const rows = normalizeFciRows(sourcePayload)
    .map((item) => {
      const banco = String(item?.entidad || item?.banco || item?.nombre || "").trim();
      const tnaClientesPct = normalizePercentValue(item?.tnaClientes);
      return { banco, tnaClientesPct };
    })
    .filter((row) => row.banco && row.tnaClientesPct !== null);
  const avgTnaPct = rows.length
    ? rows.reduce((acc, row) => acc + row.tnaClientesPct, 0) / rows.length
    : null;
  const monthlyPct = avgTnaPct !== null ? (avgTnaPct * 30) / 365 : null;
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
  const rows = normalizeFciRows(sourcePayload)
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

async function refreshBenchmarkData(env) {
  const now = new Date();
  const [pfRes, infRes] = await Promise.allSettled([
    fetchJsonSource(PLAZO_FIJO_API_URL),
    fetchJsonSource(INFLACION_API_URL),
  ]);

  let pfPayload = await loadFciPayload(env, PLAZO_FIJO_BENCH_KEY);
  let infPayload = await loadFciPayload(env, INFLACION_BENCH_KEY);
  let lastError = null;
  let okCount = 0;

  if (pfRes.status === "fulfilled") {
    pfPayload = computePlazoFijoBenchmark(pfRes.value, now);
    await env.MONITOR_KV.put(PLAZO_FIJO_BENCH_KEY, JSON.stringify(pfPayload));
    okCount += 1;
  } else {
    lastError = sanitizeError(pfRes.reason);
  }

  if (infRes.status === "fulfilled") {
    infPayload = computeInflacionBenchmark(infRes.value, now);
    await env.MONITOR_KV.put(INFLACION_BENCH_KEY, JSON.stringify(infPayload));
    okCount += 1;
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

async function refreshFciSeriesData(env, config) {
  const now = new Date();
  const baseTarget = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const baseCandidates = Array.from({ length: 8 }, (_, i) => {
    const d = new Date(baseTarget.getTime() - i * 24 * 60 * 60 * 1000);
    return artDateStringFromDate(d);
  });
  const urls = {
    ultimo: `${config.apiBase}/ultimo`,
    penultimo: `${config.apiBase}/penultimo`,
  };

  let ultimoPayload = null;
  let penultimoPayload = null;
  let errorCount = 0;
  let lastError = null;

  const [ultimoRes, penultimoRes] = await Promise.allSettled([
    fetchJsonSource(urls.ultimo),
    fetchJsonSource(urls.penultimo),
  ]);

  if (ultimoRes.status === "fulfilled") {
    ultimoPayload = normalizeFciPayload("ultimo", ultimoRes.value, now);
    await env.MONITOR_KV.put(config.lastKey, JSON.stringify(ultimoPayload));
  } else {
    errorCount += 1;
    lastError = sanitizeError(ultimoRes.reason);
  }

  if (penultimoRes.status === "fulfilled") {
    penultimoPayload = normalizeFciPayload("penultimo", penultimoRes.value, now);
    await env.MONITOR_KV.put(config.prevKey, JSON.stringify(penultimoPayload));
  } else {
    errorCount += 1;
    lastError = sanitizeError(penultimoRes.reason);
  }

  let base30Payload = null;
  let baseDateUsed = null;
  for (const candidate of baseCandidates) {
    try {
      const data = await fetchJsonSource(`${config.apiBase}/${candidate}`);
      base30Payload = normalizeFciPayload("base30", data, now);
      base30Payload.baseDate = candidate;
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
    baseRows: Number(base30Payload?.rowsCount || 0),
    snapshotKey: null,
  };

  if (ultimoPayload || penultimoPayload) {
    status.snapshotKey = await saveFciDailySnapshot(env, config.snapshotPrefix, ultimoPayload, penultimoPayload, now);
  }
  await env.MONITOR_KV.put(config.stateKey, JSON.stringify(status));
  return { ultimo: ultimoPayload, penultimo: penultimoPayload, base30: base30Payload, status };
}

async function refreshFciRentaFijaData(env) {
  return refreshFciSeriesData(env, {
    apiBase: FCI_RF_API_BASE,
    lastKey: FCI_LAST_KEY,
    prevKey: FCI_PREV_KEY,
    base30Key: FCI_BASE30_KEY,
    stateKey: FCI_STATE_KEY,
    snapshotPrefix: FCI_SNAPSHOT_PREFIX,
  });
}

async function refreshFciRentaVariableData(env) {
  return refreshFciSeriesData(env, {
    apiBase: FCI_RV_API_BASE,
    lastKey: FCI_RV_LAST_KEY,
    prevKey: FCI_RV_PREV_KEY,
    base30Key: FCI_RV_BASE30_KEY,
    stateKey: FCI_RV_STATE_KEY,
    snapshotPrefix: FCI_RV_SNAPSHOT_PREFIX,
  });
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
  return {
    ...state,
    operational: {
      ...(state.operational || {}),
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

async function fetchSourceHtml(url) {
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
      throw new Error(`Fuente respondió ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractNumber(html, key, field) {
  const re = new RegExp(
    String.raw`\\?"${key}\\?":\\?\{[\s\S]*?\\?"${field}\\?":([0-9]+(?:\.[0-9]+)?)`,
    "i",
  );
  const match = html.match(re);
  return match ? Number(match[1]) : Number.NaN;
}

function extractInt(html, key, field) {
  const re = new RegExp(
    String.raw`\\?"${key}\\?":\\?\{[\s\S]*?\\?"${field}\\?":([0-9]{10,})`,
    "i",
  );
  const match = html.match(re);
  return match ? Number(match[1]) : null;
}

function getMarketStatus(date) {
  const parts = getArtParts(date);
  const hhmm = parts.hour * 100 + parts.minute;
  const isWeekday = parts.weekday >= 1 && parts.weekday <= 5;
  const isOpen = isWeekday && hhmm >= 1030 && hhmm < 1800;
  return {
    status: isOpen ? "ABIERTO" : "CERRADO",
    isOpen,
    windowLabel: "Lun-Vie 10:30-17:59 GMT-3 (Buenos Aires)",
  };
}

function computeFreshness(mepTsMs, cclTsMs, nowEpoch) {
  const candidates = [mepTsMs, cclTsMs].filter((v) => Number.isFinite(v));
  if (!candidates.length) {
    return { label: "N/D", warn: false, ageMinutes: null, latestTsMs: null };
  }

  const latestTsMs = Math.max(...candidates);
  const ageMinutes = Math.max(0, Math.floor((nowEpoch - latestTsMs / 1000) / 60));
  const label = ageMinutes < 60 ? `${ageMinutes} min` : `${(ageMinutes / 60).toFixed(1)} h`;
  return {
    label,
    warn: ageMinutes > 60,
    ageMinutes,
    latestTsMs,
  };
}

function computeMetrics24h(history, nowEpoch) {
  const cutoff = nowEpoch - 86400;
  const rows = history.filter((item) => Number(item.epoch) >= cutoff);
  if (!rows.length) {
    return { count: 0, similarCount: 0, minPct: null, maxPct: null, avgPct: null };
  }

  const pctValues = rows.map((r) => Number(r.pct_diff)).filter((v) => Number.isFinite(v));
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

const DASHBOARD_HTML_B64 = `PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVzIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+UmFkYXIgTUVQL0NDTCDCtyBNZXJjYWRvIEFSRzwvdGl0bGU+CjxsaW5rIHJlbD0icHJlY29ubmVjdCIgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbSI+CjxsaW5rIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20vY3NzMj9mYW1pbHk9U3BhY2UrTW9ubzp3Z2h0QDQwMDs3MDAmZmFtaWx5PVN5bmU6d2dodEA0MDA7NjAwOzcwMDs4MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c3R5bGU+Ci8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBUT0tFTlMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCjpyb290IHsKICAtLWJnOiAgICAgICAjMDgwYjBlOwogIC0tc3VyZjogICAgICMwZjEzMTg7CiAgLS1zdXJmMjogICAgIzE2MWIyMjsKICAtLXN1cmYzOiAgICAjMWMyMzMwOwogIC0tYm9yZGVyOiAgICMxZTI1MzA7CiAgLS1ib3JkZXJCOiAgIzJhMzQ0NDsKCiAgLS1ncmVlbjogICAgIzAwZTY3NjsKICAtLWdyZWVuLWQ6ICByZ2JhKDAsMjMwLDExOCwuMDkpOwogIC0tZ3JlZW4tZzogIHJnYmEoMCwyMzAsMTE4LC4yMik7CiAgLS1yZWQ6ICAgICAgI2ZmNDc1NzsKICAtLXJlZC1kOiAgICByZ2JhKDI1NSw3MSw4NywuMDkpOwogIC0teWVsbG93OiAgICNmZmMgYzAwOwogIC0teWVsbG93OiAgICNmZmNjMDA7CiAgLS15ZWxsb3ctZDogcmdiYSgyNTUsMjA0LDAsLjA5KTsKCiAgLS1tZXA6ICAgICAgIzI5YjZmNjsKICAtLWNjbDogICAgICAjYjM5ZGRiOwogIC0tdGV4dDogICAgICNkZGU0ZWU7CiAgLS1tdXRlZDogICAgIzU1NjA3MDsKICAtLW11dGVkMjogICAjN2E4ZmE4OwoKICAtLW1vbm86ICdTcGFjZSBNb25vJywgbW9ub3NwYWNlOwogIC0tc2FuczogJ1N5bmUnLCBzYW5zLXNlcmlmOwoKICAtLWRyYXdlci13OiA0MDBweDsKICAtLWhlYWRlci1oOiA1NHB4Owp9CgoqLCAqOjpiZWZvcmUsICo6OmFmdGVyIHsgYm94LXNpemluZzogYm9yZGVyLWJveDsgbWFyZ2luOiAwOyBwYWRkaW5nOiAwOyB9CgpodG1sIHsgc2Nyb2xsLWJlaGF2aW9yOiBzbW9vdGg7IH0KCmJvZHkgewogIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgZm9udC1mYW1pbHk6IHZhcigtLW1vbm8pOwogIG1pbi1oZWlnaHQ6IDEwMHZoOwogIG92ZXJmbG93LXg6IGhpZGRlbjsKfQoKYm9keTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogZml4ZWQ7IGluc2V0OiAwOwogIGJhY2tncm91bmQtaW1hZ2U6CiAgICBsaW5lYXItZ3JhZGllbnQocmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KSwKICAgIGxpbmVhci1ncmFkaWVudCg5MGRlZywgcmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KTsKICBiYWNrZ3JvdW5kLXNpemU6IDQ0cHggNDRweDsKICBwb2ludGVyLWV2ZW50czogbm9uZTsgei1pbmRleDogMDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIExBWU9VVCBTSEVMTArilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmFwcCB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBtaW4taGVpZ2h0OiAxMDB2aDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEhFQURFUgrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KaGVhZGVyIHsKICBwb3NpdGlvbjogc3RpY2t5OyB0b3A6IDA7IHotaW5kZXg6IDIwMDsKICBoZWlnaHQ6IHZhcigtLWhlYWRlci1oKTsKICBiYWNrZ3JvdW5kOiByZ2JhKDgsMTEsMTQsLjkzKTsKICBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMThweCk7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogMCAyMnB4OwogIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKfQoKLmxvZ28gewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6IDgwMDsgZm9udC1zaXplOiAxNXB4OwogIGxldHRlci1zcGFjaW5nOiAuMDVlbTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA5cHg7Cn0KCi5saXZlLWRvdCB7CiAgd2lkdGg6IDdweDsgaGVpZ2h0OiA3cHg7IGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbik7CiAgYm94LXNoYWRvdzogMCAwIDhweCB2YXIoLS1ncmVlbik7CiAgYW5pbWF0aW9uOiBibGluayAyLjJzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9CkBrZXlmcmFtZXMgYmxpbmsgewogIDAlLDEwMCV7b3BhY2l0eToxO2JveC1zaGFkb3c6MCAwIDhweCB2YXIoLS1ncmVlbik7fQogIDUwJXtvcGFjaXR5Oi4zNTtib3gtc2hhZG93OjAgMCAzcHggdmFyKC0tZ3JlZW4pO30KfQoKLmhlYWRlci1yaWdodCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTJweDsgfQoKLmZyZXNoLWJhZGdlIHsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDVweDsKICBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAyMHB4OyBwYWRkaW5nOiAzcHggMTFweDsKfQouZnJlc2gtZG90IHsgd2lkdGg6NXB4O2hlaWdodDo1cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDp2YXIoLS1ncmVlbik7YW5pbWF0aW9uOmJsaW5rIDIuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmZldGNoaW5nIHsgYW5pbWF0aW9uOiBiYWRnZVB1bHNlIDEuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmVycm9yIHsgY29sb3I6I2ZmZDBkMDsgYm9yZGVyLWNvbG9yOnJnYmEoMjU1LDgyLDgyLC40NSk7IGJhY2tncm91bmQ6cmdiYSgyNTUsODIsODIsLjEyKTsgY3Vyc29yOnBvaW50ZXI7IH0KQGtleWZyYW1lcyBiYWRnZVB1bHNlIHsKICAwJSwxMDAlIHsgb3BhY2l0eToxOyB9CiAgNTAlIHsgb3BhY2l0eTouNjU7IH0KfQoKLnRhZy1tZXJjYWRvIHsKICBmb250LWZhbWlseTogdmFyKC0tc2Fucyk7IGZvbnQtc2l6ZToxMHB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsKICBwYWRkaW5nOjNweCA5cHg7IGJvcmRlci1yYWRpdXM6NHB4Owp9Ci50YWctbWVyY2Fkby5jbG9zZWQgeyBiYWNrZ3JvdW5kOnZhcigtLW11dGVkKTsgY29sb3I6IzBhMGMwZjsgfQoKLmJ0biB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOyBmb250LXNpemU6MTFweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4wN2VtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgYm9yZGVyLXJhZGl1czo2cHg7IHBhZGRpbmc6NnB4IDE0cHg7IGN1cnNvcjpwb2ludGVyOwogIGJvcmRlcjpub25lOyB0cmFuc2l0aW9uOiBhbGwgLjE4czsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo2cHg7Cn0KLmJ0bi1hbGVydCB7IGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4pOyBjb2xvcjojMDAwOyB9Ci5idG4tYWxlcnQ6aG92ZXIgeyBiYWNrZ3JvdW5kOiMwMGZmODg7IHRyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpOyB9CgouYnRuLXRhc2FzIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMik7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6IHZhcigtLXRleHQpOwp9Ci5idG4tdGFzYXM6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMyk7IGJvcmRlci1jb2xvcjogdmFyKC0tbXV0ZWQyKTsgfQouYnRuLXRhc2FzLmFjdGl2ZSB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZjMpOwogIGJvcmRlci1jb2xvcjogdmFyKC0teWVsbG93KTsKICBjb2xvcjogdmFyKC0teWVsbG93KTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIE1BSU4gKyBEUkFXRVIgTEFZT1VUCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouYm9keS13cmFwIHsKICBmbGV4OiAxOwogIGRpc3BsYXk6IGZsZXg7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIHotaW5kZXg6IDE7CiAgdHJhbnNpdGlvbjogbm9uZTsKfQoKLm1haW4tY29udGVudCB7CiAgZmxleDogMTsKICBtYXgtd2lkdGg6IDEwMCU7CiAgcGFkZGluZzogMjJweCAyMnB4IDYwcHg7CiAgdHJhbnNpdGlvbjogbWFyZ2luLXJpZ2h0IC4zNXMgY3ViaWMtYmV6aWVyKC40LDAsLjIsMSk7Cn0KCi5ib2R5LXdyYXAuZHJhd2VyLW9wZW4gLm1haW4tY29udGVudCB7CiAgbWFyZ2luLXJpZ2h0OiB2YXIoLS1kcmF3ZXItdyk7Cn0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBEUkFXRVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5kcmF3ZXIgewogIHBvc2l0aW9uOiBmaXhlZDsKICB0b3A6IHZhcigtLWhlYWRlci1oKTsKICByaWdodDogMDsKICB3aWR0aDogdmFyKC0tZHJhd2VyLXcpOwogIGhlaWdodDogY2FsYygxMDB2aCAtIHZhcigtLWhlYWRlci1oKSk7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZik7CiAgYm9yZGVyLWxlZnQ6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHRyYW5zZm9ybTogdHJhbnNsYXRlWCgxMDAlKTsKICB0cmFuc2l0aW9uOiB0cmFuc2Zvcm0gLjM1cyBjdWJpYy1iZXppZXIoLjQsMCwuMiwxKTsKICBvdmVyZmxvdy15OiBhdXRvOwogIHotaW5kZXg6IDE1MDsKICBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwp9CgouZHJhd2VyLm9wZW4geyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMCk7IH0KCi5kcmF3ZXItcmVzaXplciB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IC00cHg7CiAgdG9wOiAwOwogIHdpZHRoOiA4cHg7CiAgaGVpZ2h0OiAxMDAlOwogIGN1cnNvcjogY29sLXJlc2l6ZTsKICB6LWluZGV4OiAxODA7Cn0KLmRyYXdlci1yZXNpemVyOjpiZWZvcmUgewogIGNvbnRlbnQ6ICcnOwogIHBvc2l0aW9uOiBhYnNvbHV0ZTsKICBsZWZ0OiAzcHg7CiAgdG9wOiAwOwogIHdpZHRoOiAycHg7CiAgaGVpZ2h0OiAxMDAlOwogIGJhY2tncm91bmQ6IHRyYW5zcGFyZW50OwogIHRyYW5zaXRpb246IGJhY2tncm91bmQgLjE1czsKfQouZHJhd2VyLXJlc2l6ZXI6aG92ZXI6OmJlZm9yZSwKLmRyYXdlci1yZXNpemVyLmFjdGl2ZTo6YmVmb3JlIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1tdXRlZDIpOwp9CgouZHJhd2VyLWhlYWRlciB7CiAgcG9zaXRpb246IHN0aWNreTsgdG9wOiAwOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYpOwogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHBhZGRpbmc6IDE2cHggMjBweDsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgei1pbmRleDogMTA7Cn0KCi5kcmF3ZXItdGl0bGUgewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6IDgwMDsgZm9udC1zaXplOiAxM3B4OwogIGxldHRlci1zcGFjaW5nOi4wNGVtOyBjb2xvcjogdmFyKC0tdGV4dCk7CiAgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6OHB4Owp9CgouZHJhd2VyLXNvdXJjZSB7CiAgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgZm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7Cn0KCi5idG4tY2xvc2UgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgY29sb3I6dmFyKC0tbXV0ZWQyKTsgYm9yZGVyLXJhZGl1czo2cHg7IHBhZGRpbmc6NXB4IDEwcHg7CiAgY3Vyc29yOnBvaW50ZXI7IGZvbnQtc2l6ZToxM3B4OyB0cmFuc2l0aW9uOiBhbGwgLjE1czsKfQouYnRuLWNsb3NlOmhvdmVyIHsgY29sb3I6dmFyKC0tdGV4dCk7IGJvcmRlci1jb2xvcjp2YXIoLS1tdXRlZDIpOyB9CgouZHJhd2VyLWJvZHkgeyBwYWRkaW5nOiAxNnB4IDIwcHg7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogMjJweDsgfQoKLmNvbnRleHQtYm94IHsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyMDQsMCwuMDYpOwogIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjU1LDIwNCwwLC4yKTsKICBib3JkZXItcmFkaXVzOiA5cHg7CiAgcGFkZGluZzogMTNweCAxNXB4OwogIGZvbnQtc2l6ZTogMTFweDsKICBsaW5lLWhlaWdodDoxLjY1OwogIGNvbG9yOnZhcigtLW11dGVkMik7Cn0KLmNvbnRleHQtYm94IHN0cm9uZyB7IGNvbG9yOnZhcigtLXllbGxvdyk7IH0KCi5mY2ktaGVhZGVyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBiYXNlbGluZTsKICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgZ2FwOiAxMHB4Owp9Ci5mY2ktdGl0bGUgewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsKICBmb250LXNpemU6IDEycHg7CiAgZm9udC13ZWlnaHQ6IDcwMDsKICBsZXR0ZXItc3BhY2luZzogLjA1ZW07CiAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsKICBjb2xvcjogdmFyKC0tdGV4dCk7Cn0KLmZjaS10aXRsZS13cmFwIHsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgZ2FwOiA4cHg7Cn0KLmZjaS10YWJzIHsKICBkaXNwbGF5OiBmbGV4OwogIGdhcDogOHB4OwogIGZsZXgtd3JhcDogd3JhcDsKfQouZmNpLXRhYi1idG4gewogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsKICBjb2xvcjogdmFyKC0tbXV0ZWQyKTsKICBib3JkZXItcmFkaXVzOiA5OTlweDsKICBmb250LXNpemU6IDEwcHg7CiAgZm9udC13ZWlnaHQ6IDcwMDsKICBsZXR0ZXItc3BhY2luZzogLjA1ZW07CiAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsKICBwYWRkaW5nOiA0cHggMTBweDsKICBjdXJzb3I6IHBvaW50ZXI7Cn0KLmZjaS10YWItYnRuLmFjdGl2ZSB7CiAgY29sb3I6IHZhcigtLXllbGxvdyk7CiAgYm9yZGVyLWNvbG9yOiB2YXIoLS15ZWxsb3cpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LCAyMDQsIDAsIC4wOCk7Cn0KLmZjaS1tZXRhIHsKICBmb250LXNpemU6IDEwcHg7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKfQouZmNpLXRhYmxlLXdyYXAgewogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czogMTBweDsKICBvdmVyZmxvdzogYXV0bzsKfQouZmNpLXRhYmxlIHsKICB3aWR0aDogMTAwJTsKICBtaW4td2lkdGg6IDk4MHB4OwogIGJvcmRlci1jb2xsYXBzZTogY29sbGFwc2U7CiAgdGFibGUtbGF5b3V0OiBmaXhlZDsKfQouZmNpLXRhYmxlIHRoZWFkIHRoIHsKICBwb3NpdGlvbjogc3RpY2t5OwogIHRvcDogMDsKICB6LWluZGV4OiA1OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsKICBjb2xvcjogdmFyKC0tbXV0ZWQyKTsKICBmb250LXNpemU6IDEwcHg7CiAgbGV0dGVyLXNwYWNpbmc6IC4wOGVtOwogIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7CiAgdGV4dC1hbGlnbjogbGVmdDsKICBwYWRkaW5nOiA5cHggMTBweDsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouZmNpLXRhYmxlIHRoZWFkIHRoOmhvdmVyIHsKICB6LWluZGV4OiA4MDsKfQouZmNpLXRhYmxlIHRib2R5IHRyIHsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouZmNpLXRhYmxlIHRib2R5IHRyOmxhc3QtY2hpbGQgewogIGJvcmRlci1ib3R0b206IG5vbmU7Cn0KLmZjaS10YWJsZSB0ZCB7CiAgZm9udC1zaXplOiAxMXB4OwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBwYWRkaW5nOiA5cHggMTBweDsKICBvdmVyZmxvdzogaGlkZGVuOwogIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7Cn0KLmZjaS10YWJsZSB0ZC5mY2ktc2lnbmFsLWNlbGwgewogIHdoaXRlLXNwYWNlOiBub3JtYWw7CiAgb3ZlcmZsb3c6IHZpc2libGU7CiAgdGV4dC1vdmVyZmxvdzogY2xpcDsKfQouZmNpLWNvbC1sYWJlbCB7CiAgcGFkZGluZy1yaWdodDogMTBweDsKICBkaXNwbGF5OiBpbmxpbmUtYmxvY2s7Cn0KLmZjaS1jb2wtcmVzaXplciB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIHRvcDogMDsKICByaWdodDogLTRweDsKICB3aWR0aDogOHB4OwogIGhlaWdodDogMTAwJTsKICBjdXJzb3I6IGNvbC1yZXNpemU7CiAgdXNlci1zZWxlY3Q6IG5vbmU7CiAgdG91Y2gtYWN0aW9uOiBub25lOwogIHotaW5kZXg6IDM7Cn0KLmZjaS1jb2wtcmVzaXplcjo6YWZ0ZXIgewogIGNvbnRlbnQ6ICcnOwogIHBvc2l0aW9uOiBhYnNvbHV0ZTsKICB0b3A6IDZweDsKICBib3R0b206IDZweDsKICBsZWZ0OiAzcHg7CiAgd2lkdGg6IDFweDsKICBiYWNrZ3JvdW5kOiByZ2JhKDEyMiwxNDMsMTY4LC4yOCk7Cn0KLmZjaS1jb2wtcmVzaXplcjpob3Zlcjo6YWZ0ZXIsCi5mY2ktY29sLXJlc2l6ZXIuYWN0aXZlOjphZnRlciB7CiAgYmFja2dyb3VuZDogcmdiYSgxMjIsMTQzLDE2OCwuNzUpOwp9Ci5mY2ktZW1wdHkgewogIGZvbnQtc2l6ZTogMTFweDsKICBjb2xvcjogdmFyKC0tbXV0ZWQyKTsKICBwYWRkaW5nOiAxMnB4OwogIGJvcmRlcjogMXB4IGRhc2hlZCB2YXIoLS1ib3JkZXJCKTsKICBib3JkZXItcmFkaXVzOiAxMHB4Owp9Ci5mY2ktY29udHJvbHMgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgZ2FwOiAxMHB4Owp9Ci5mY2ktc2VhcmNoIHsKICB3aWR0aDogMTAwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMik7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6IHZhcigtLXRleHQpOwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBwYWRkaW5nOiA4cHggMTBweDsKICBmb250LXNpemU6IDExcHg7CiAgb3V0bGluZTogbm9uZTsKfQouZmNpLXNlYXJjaDpmb2N1cyB7CiAgYm9yZGVyLWNvbG9yOiB2YXIoLS1tdXRlZDIpOwp9Ci5mY2ktcGFnaW5hdGlvbiB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogOHB4OwogIGZsZXgtc2hyaW5rOiAwOwp9Ci5mY2ktcGFnZS1idG4gewogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgYm9yZGVyLXJhZGl1czogNnB4OwogIGZvbnQtc2l6ZTogMTBweDsKICBmb250LXdlaWdodDogNzAwOwogIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7CiAgbGV0dGVyLXNwYWNpbmc6IC4wNmVtOwogIHBhZGRpbmc6IDVweCA4cHg7CiAgY3Vyc29yOiBwb2ludGVyOwp9Ci5mY2ktcGFnZS1idG46ZGlzYWJsZWQgewogIG9wYWNpdHk6IC40OwogIGN1cnNvcjogZGVmYXVsdDsKfQouZmNpLXBhZ2UtaW5mbyB7CiAgZm9udC1zaXplOiAxMHB4OwogIGNvbG9yOiB2YXIoLS1tdXRlZDIpOwp9Ci5mY2ktYmVuY2ggewogIGZvbnQtc2l6ZTogMTBweDsKICBjb2xvcjogdmFyKC0tbXV0ZWQyKTsKICBwYWRkaW5nOiA2cHggMnB4IDA7Cn0KLmZjaS1iZW5jaCBzdHJvbmcgewogIGNvbG9yOiB2YXIoLS10ZXh0KTsKfQouZmNpLXRyZW5kIHsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNXB4Owp9Ci5mY2ktdHJlbmQtaWNvbiB7CiAgZm9udC1zaXplOiAxMHB4OwogIGZvbnQtd2VpZ2h0OiA3MDA7Cn0KLmZjaS10cmVuZC51cCAuZmNpLXRyZW5kLWljb24geyBjb2xvcjogdmFyKC0tZ3JlZW4pOyB9Ci5mY2ktdHJlbmQuZG93biAuZmNpLXRyZW5kLWljb24geyBjb2xvcjogdmFyKC0tcmVkKTsgfQouZmNpLXRyZW5kLmZsYXQgLmZjaS10cmVuZC1pY29uIHsgY29sb3I6IHZhcigtLW11dGVkMik7IH0KLmZjaS10cmVuZC5uYSAuZmNpLXRyZW5kLWljb24geyBjb2xvcjogdmFyKC0tbXV0ZWQpOyB9Ci5mY2ktc2lnbmFsIHsKICBkaXNwbGF5OiBpbmxpbmUtYmxvY2s7CiAgYm9yZGVyLXJhZGl1czogOTk5cHg7CiAgZm9udC1zaXplOiAxMHB4OwogIGZvbnQtd2VpZ2h0OiA3MDA7CiAgbGV0dGVyLXNwYWNpbmc6IC4wNGVtOwogIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7CiAgcGFkZGluZzogMnB4IDhweDsKfQouZmNpLXNpZ25hbC5nb29kIHsKICBjb2xvcjogdmFyKC0tZ3JlZW4pOwogIGJhY2tncm91bmQ6IHZhcigtLWdyZWVuLWQpOwogIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMCwyMzAsMTE4LC4yNSk7Cn0KLmZjaS1zaWduYWwud2FybiB7CiAgY29sb3I6IHZhcigtLXllbGxvdyk7CiAgYmFja2dyb3VuZDogcmdiYSgyNTUsMjA0LDAsLjEwKTsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwyMDQsMCwuMjUpOwp9Ci5mY2ktc2lnbmFsLm9qbyB7CiAgY29sb3I6ICNmZmI4NmI7CiAgYmFja2dyb3VuZDogcmdiYSgyNTUsIDE0MCwgMCwgLjE0KTsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwgMTYyLCA3OCwgLjMwKTsKfQouZmNpLXNpZ25hbC5pbmZvIHsKICBjb2xvcjogIzdiYzZmZjsKICBiYWNrZ3JvdW5kOiByZ2JhKDQxLDE4MiwyNDYsLjEyKTsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDQxLDE4MiwyNDYsLjMpOwp9Ci5mY2ktc2lnbmFsLmJhZCB7CiAgY29sb3I6ICNmZjdmOGE7CiAgYmFja2dyb3VuZDogdmFyKC0tcmVkLWQpOwogIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjU1LDcxLDg3LC4yNSk7Cn0KLmZjaS1zaWduYWwubmEgewogIGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6IHJnYmEoMTIyLDE0MywxNjgsLjEwKTsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDEyMiwxNDMsMTY4LC4yNSk7Cn0KLmZjaS1zaWduYWwtd3JhcCB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBhbGlnbi1pdGVtczogZmxleC1zdGFydDsKICBnYXA6IDNweDsKfQouZmNpLXNpZ25hbC1zdHJlYWsgewogIGZvbnQtc2l6ZTogOXB4OwogIGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGxldHRlci1zcGFjaW5nOiAuMDJlbTsKICBsaW5lLWhlaWdodDogMS4yNTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIFNUQVRVUyBCQU5ORVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5zdGF0dXMtYmFubmVyIHsKICBib3JkZXItcmFkaXVzOjExcHg7IHBhZGRpbmc6MThweCAyNHB4OyBtYXJnaW4tYm90dG9tOjIwcHg7CiAgYm9yZGVyOjFweCBzb2xpZDsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgYW5pbWF0aW9uOmZhZGVJbiAuNHMgZWFzZTsKICBvdmVyZmxvdzpoaWRkZW47IHBvc2l0aW9uOnJlbGF0aXZlOwp9Ci5zdGF0dXMtYmFubmVyLnNpbWlsYXIgewogIGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4tZCk7IGJvcmRlci1jb2xvcjpyZ2JhKDAsMjMwLDExOCwuMjgpOwp9Ci5zdGF0dXMtYmFubmVyLnNpbWlsYXI6OmFmdGVyIHsKICBjb250ZW50OicnOyBwb3NpdGlvbjphYnNvbHV0ZTsgcmlnaHQ6LTUwcHg7IHRvcDo1MCU7CiAgdHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTUwJSk7IHdpZHRoOjIwMHB4OyBoZWlnaHQ6MjAwcHg7CiAgYm9yZGVyLXJhZGl1czo1MCU7CiAgYmFja2dyb3VuZDpyYWRpYWwtZ3JhZGllbnQoY2lyY2xlLHZhcigtLWdyZWVuLWcpIDAlLHRyYW5zcGFyZW50IDcwJSk7CiAgcG9pbnRlci1ldmVudHM6bm9uZTsKfQouc3RhdHVzLWJhbm5lci5uby1zaW1pbGFyIHsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSw4Miw4MiwuMDgpOwogIGJvcmRlci1jb2xvcjogcmdiYSgyNTUsODIsODIsLjM1KTsKfQouc3RhdHVzLWJhbm5lci5uby1zaW1pbGFyOjphZnRlciB7CiAgY29udGVudDonJzsKICBwb3NpdGlvbjphYnNvbHV0ZTsKICByaWdodDotNTBweDsKICB0b3A6NTAlOwogIHRyYW5zZm9ybTp0cmFuc2xhdGVZKC01MCUpOwogIHdpZHRoOjIwMHB4OwogIGhlaWdodDoyMDBweDsKICBib3JkZXItcmFkaXVzOjUwJTsKICBiYWNrZ3JvdW5kOnJhZGlhbC1ncmFkaWVudChjaXJjbGUscmdiYSgyNTUsODIsODIsLjE4KSAwJSx0cmFuc3BhcmVudCA3MCUpOwogIHBvaW50ZXItZXZlbnRzOm5vbmU7Cn0KCi5zLWxlZnQge30KLnMtdGl0bGUgewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo4MDA7IGZvbnQtc2l6ZToyNnB4OwogIGxldHRlci1zcGFjaW5nOi0uMDJlbTsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDoxMnB4Owp9Ci5zLWJhZGdlIHsKICBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOyBsZXR0ZXItc3BhY2luZzouMWVtOwogIHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgcGFkZGluZzoycHggOXB4OyBib3JkZXItcmFkaXVzOjRweDsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsgYWxpZ24tc2VsZjpjZW50ZXI7Cn0KLnMtYmFkZ2Uubm9zaW0geyBiYWNrZ3JvdW5kOiB2YXIoLS1yZWQpOyBjb2xvcjogI2ZmZjsgfQoucy1zdWIgeyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgbWFyZ2luLXRvcDo0cHg7IH0KCi5lcnJvci1iYW5uZXIgewogIGRpc3BsYXk6bm9uZTsKICBtYXJnaW46IDAgMCAxNHB4IDA7CiAgcGFkZGluZzogMTBweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSw4Miw4MiwuNDUpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDgyLDgyLC4xMik7CiAgY29sb3I6ICNmZmQwZDA7CiAgZm9udC1zaXplOiAxMXB4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOwogIGdhcDogMTBweDsKfQouZXJyb3ItYmFubmVyLnNob3cgeyBkaXNwbGF5OmZsZXg7IH0KLmVycm9yLWJhbm5lciBidXR0b24gewogIGJvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsODIsODIsLjUpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDgyLDgyLC4xNSk7CiAgY29sb3I6I2ZmZGVkZTsKICBib3JkZXItcmFkaXVzOjZweDsKICBwYWRkaW5nOjRweCAxMHB4OwogIGZvbnQtc2l6ZToxMHB4OwogIGZvbnQtd2VpZ2h0OjcwMDsKICB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgbGV0dGVyLXNwYWNpbmc6LjA2ZW07CiAgY3Vyc29yOnBvaW50ZXI7Cn0KCi5za2VsZXRvbiB7CiAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDkwZGVnLCAjMWMyMzMwIDI1JSwgIzJhMzQ0NCA1MCUsICMxYzIzMzAgNzUlKTsKICBiYWNrZ3JvdW5kLXNpemU6IDIwMCUgMTAwJTsKICBhbmltYXRpb246IHNoaW1tZXIgMS40cyBpbmZpbml0ZTsKICBib3JkZXItcmFkaXVzOiA0cHg7CiAgY29sb3I6IHRyYW5zcGFyZW50OwogIHVzZXItc2VsZWN0OiBub25lOwp9CkBrZXlmcmFtZXMgc2hpbW1lciB7CiAgMCUgICB7IGJhY2tncm91bmQtcG9zaXRpb246IDIwMCUgMDsgfQogIDEwMCUgeyBiYWNrZ3JvdW5kLXBvc2l0aW9uOiAtMjAwJSAwOyB9Cn0KCi52YWx1ZS1jaGFuZ2VkIHsKICBhbmltYXRpb246IGZsYXNoVmFsdWUgNjAwbXMgZWFzZTsKfQpAa2V5ZnJhbWVzIGZsYXNoVmFsdWUgewogIDAlICAgeyBjb2xvcjogI2ZmY2MwMDsgfQogIDEwMCUgeyBjb2xvcjogaW5oZXJpdDsgfQp9Cgoucy1yaWdodCB7IHRleHQtYWxpZ246cmlnaHQ7IGZvbnQtc2l6ZToxMXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IGxpbmUtaGVpZ2h0OjEuOTsgfQoucy1yaWdodCBzdHJvbmcgeyBjb2xvcjp2YXIoLS1tdXRlZDIpOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgSEVSTyBDQVJEUwrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmhlcm8tZ3JpZCB7CiAgZGlzcGxheTpncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmciAxZnI7CiAgZ2FwOjE0cHg7IG1hcmdpbi1ib3R0b206MjBweDsKfQoKLmhjYXJkIHsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBwYWRkaW5nOjIwcHggMjJweDsKICBwb3NpdGlvbjpyZWxhdGl2ZTsgb3ZlcmZsb3c6aGlkZGVuOwogIHRyYW5zaXRpb246Ym9yZGVyLWNvbG9yIC4xOHM7CiAgYW5pbWF0aW9uOiBmYWRlVXAgLjVzIGVhc2UgYm90aDsKfQouaGNhcmQ6bnRoLWNoaWxkKDEpe2FuaW1hdGlvbi1kZWxheTouMDhzO30KLmhjYXJkOm50aC1jaGlsZCgyKXthbmltYXRpb24tZGVsYXk6LjE2czt9Ci5oY2FyZDpudGgtY2hpbGQoMyl7YW5pbWF0aW9uLWRlbGF5Oi4yNHM7fQouaGNhcmQ6aG92ZXIgeyBib3JkZXItY29sb3I6dmFyKC0tYm9yZGVyQik7IH0KCi5oY2FyZCAuYmFyIHsgcG9zaXRpb246YWJzb2x1dGU7IHRvcDowO2xlZnQ6MDtyaWdodDowOyBoZWlnaHQ6MnB4OyB9Ci5oY2FyZC5tZXAgLmJhciB7IGJhY2tncm91bmQ6dmFyKC0tbWVwKTsgfQouaGNhcmQuY2NsIC5iYXIgeyBiYWNrZ3JvdW5kOnZhcigtLWNjbCk7IH0KLmhjYXJkLmdhcCAuYmFyIHsgYmFja2dyb3VuZDp2YXIoLS15ZWxsb3cpOyB9CgouaGNhcmQtbGFiZWwgewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4xMmVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IGNvbG9yOnZhcigtLW11dGVkKTsKICBtYXJnaW4tYm90dG9tOjlweDsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo1cHg7Cn0KLmhjYXJkLWxhYmVsIC5kb3QgeyB3aWR0aDo1cHg7aGVpZ2h0OjVweDtib3JkZXItcmFkaXVzOjUwJTsgfQoubWVwIC5kb3R7YmFja2dyb3VuZDp2YXIoLS1tZXApO30KLmNjbCAuZG90e2JhY2tncm91bmQ6dmFyKC0tY2NsKTt9Ci5nYXAgLmRvdHtiYWNrZ3JvdW5kOnZhcigtLXllbGxvdyk7fQoKLmhjYXJkLXZhbCB7CiAgZm9udC1zaXplOjM0cHg7IGZvbnQtd2VpZ2h0OjcwMDsgbGV0dGVyLXNwYWNpbmc6LS4wMmVtOyBsaW5lLWhlaWdodDoxOwp9Ci5tZXAgLmhjYXJkLXZhbHtjb2xvcjp2YXIoLS1tZXApO30KLmNjbCAuaGNhcmQtdmFse2NvbG9yOnZhcigtLWNjbCk7fQoKLmhjYXJkLXBjdCB7IGZvbnQtc2l6ZToyMHB4OyBjb2xvcjp2YXIoLS15ZWxsb3cpOyBmb250LXdlaWdodDo3MDA7IG1hcmdpbi10b3A6M3B4OyB9Ci5oY2FyZC1zdWIgeyBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tdG9wOjdweDsgfQoKLyogdG9vbHRpcCAqLwoudGlwIHsgcG9zaXRpb246cmVsYXRpdmU7IGN1cnNvcjpoZWxwOyB9Ci50aXA6OmFmdGVyIHsKICBjb250ZW50OmF0dHIoZGF0YS10KTsKICBwb3NpdGlvbjphYnNvbHV0ZTsgYm90dG9tOmNhbGMoMTAwJSArIDdweCk7IGxlZnQ6NTAlOwogIHRyYW5zZm9ybTp0cmFuc2xhdGVYKC01MCUpOwogIGJhY2tncm91bmQ6IzFhMjIzMjsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsKICBjb2xvcjp2YXIoLS10ZXh0KTsgZm9udC1zaXplOjEwcHg7IHBhZGRpbmc6NXB4IDlweDsKICBib3JkZXItcmFkaXVzOjZweDsgd2hpdGUtc3BhY2U6bm93cmFwOwogIG9wYWNpdHk6MDsgcG9pbnRlci1ldmVudHM6bm9uZTsgdHJhbnNpdGlvbjpvcGFjaXR5IC4xOHM7IHotaW5kZXg6OTk7Cn0KLnRpcDpob3Zlcjo6YWZ0ZXJ7b3BhY2l0eToxO30KLnRpcC50aXAtZG93bjo6YWZ0ZXIgewogIGRpc3BsYXk6IG5vbmU7Cn0KCi5zbWFydC10aXAgewogIHBvc2l0aW9uOiBmaXhlZDsKICBsZWZ0OiAwOwogIHRvcDogMDsKICBtYXgtd2lkdGg6IG1pbigyODBweCwgY2FsYygxMDB2dyAtIDE2cHgpKTsKICBiYWNrZ3JvdW5kOiAjMWEyMjMyOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlckIpOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBmb250LXNpemU6IDEwcHg7CiAgbGluZS1oZWlnaHQ6IDEuNDU7CiAgcGFkZGluZzogNnB4IDlweDsKICBib3JkZXItcmFkaXVzOiA2cHg7CiAgei1pbmRleDogNDAwOwogIG9wYWNpdHk6IDA7CiAgcG9pbnRlci1ldmVudHM6IG5vbmU7CiAgdHJhbnNpdGlvbjogb3BhY2l0eSAuMTJzOwp9Ci5zbWFydC10aXAuc2hvdyB7CiAgb3BhY2l0eTogMTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIENIQVJUCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouY2hhcnQtY2FyZCB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmKTsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6MTFweDsgcGFkZGluZzoyMnB4OyBtYXJnaW4tYm90dG9tOjIwcHg7CiAgYW5pbWF0aW9uOmZhZGVVcCAuNXMgLjMycyBlYXNlIGJvdGg7Cn0KLmNoYXJ0LXRvcCB7CiAgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGp1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuOwogIG1hcmdpbi1ib3R0b206MTZweDsKfQouY2hhcnQtdHRsIHsgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtd2VpZ2h0OjcwMDsgZm9udC1zaXplOjEzcHg7IH0KCi5waWxscyB7IGRpc3BsYXk6ZmxleDsgZ2FwOjVweDsgfQoucGlsbCB7CiAgZm9udC1zaXplOjEwcHg7IHBhZGRpbmc6M3B4IDExcHg7IGJvcmRlci1yYWRpdXM6MjBweDsKICBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlckIpOyBjb2xvcjp2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6dHJhbnNwYXJlbnQ7IGN1cnNvcjpwb2ludGVyOyBmb250LWZhbWlseTp2YXIoLS1tb25vKTsKICB0cmFuc2l0aW9uOmFsbCAuMTNzOwp9Ci5waWxsLm9uIHsgYmFja2dyb3VuZDp2YXIoLS1tZXApOyBib3JkZXItY29sb3I6dmFyKC0tbWVwKTsgY29sb3I6IzAwMDsgZm9udC13ZWlnaHQ6NzAwOyB9CgoubGVnZW5kcyB7IGRpc3BsYXk6ZmxleDsgZ2FwOjE4cHg7IG1hcmdpbi1ib3R0b206MTRweDsgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkMik7IH0KLmxlZyB7IGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6NXB4OyB9Ci5sZWctbGluZSB7IHdpZHRoOjE4cHg7IGhlaWdodDoycHg7IGJvcmRlci1yYWRpdXM6MnB4OyB9CgpzdmcuY2hhcnQgeyB3aWR0aDoxMDAlOyBoZWlnaHQ6MTcwcHg7IG92ZXJmbG93OnZpc2libGU7IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBNRVRSSUNTCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwoubWV0cmljcy1ncmlkIHsKICBkaXNwbGF5OmdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNCwxZnIpOwogIGdhcDoxMnB4OyBtYXJnaW4tYm90dG9tOjIwcHg7Cn0KLm1jYXJkIHsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYyKTsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6OXB4OyBwYWRkaW5nOjE0cHggMTZweDsKICBhbmltYXRpb246ZmFkZVVwIC41cyBlYXNlIGJvdGg7Cn0KLm1jYXJkOm50aC1jaGlsZCgxKXthbmltYXRpb24tZGVsYXk6LjM4czt9Ci5tY2FyZDpudGgtY2hpbGQoMil7YW5pbWF0aW9uLWRlbGF5Oi40M3M7fQoubWNhcmQ6bnRoLWNoaWxkKDMpe2FuaW1hdGlvbi1kZWxheTouNDhzO30KLm1jYXJkOm50aC1jaGlsZCg0KXthbmltYXRpb24tZGVsYXk6LjUzczt9Ci5tY2FyZC1sYWJlbCB7CiAgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtc2l6ZTo5cHg7IGZvbnQtd2VpZ2h0OjcwMDsKICBsZXR0ZXItc3BhY2luZzouMWVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IGNvbG9yOnZhcigtLW11dGVkKTsgbWFyZ2luLWJvdHRvbTo3cHg7Cn0KLm1jYXJkLXZhbCB7IGZvbnQtc2l6ZToyMHB4OyBmb250LXdlaWdodDo3MDA7IH0KLm1jYXJkLXN1YiB7IGZvbnQtc2l6ZTo5cHg7IGNvbG9yOnZhcigtLW11dGVkKTsgbWFyZ2luLXRvcDozcHg7IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBUQUJMRQrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLnRhYmxlLWNhcmQgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZik7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOjExcHg7IG92ZXJmbG93OmhpZGRlbjsKICBhbmltYXRpb246ZmFkZVVwIC41cyAuNTZzIGVhc2UgYm90aDsKfQoudGFibGUtdG9wIHsKICBwYWRkaW5nOjE0cHggMjJweDsgYm9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Cn0KLnRhYmxlLXR0bCB7IGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo3MDA7IGZvbnQtc2l6ZToxM3B4OyB9Ci50YWJsZS1yaWdodCB7IGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6MTBweDsgfQoudGFibGUtY2FwIHsgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgfQouYnRuLWRvd25sb2FkIHsKICBkaXNwbGF5OmlubGluZS1mbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo2cHg7CiAgaGVpZ2h0OjI2cHg7IHBhZGRpbmc6MCAxMHB4OyBib3JkZXItcmFkaXVzOjdweDsKICBib3JkZXI6MXB4IHNvbGlkICMyZjRmNjg7IGJhY2tncm91bmQ6cmdiYSg0MSwxODIsMjQ2LDAuMDYpOwogIGNvbG9yOiM4ZmQ4ZmY7IGN1cnNvcjpwb2ludGVyOyBmb250LWZhbWlseTp2YXIoLS1tb25vKTsgZm9udC1zaXplOjEwcHg7CiAgbGV0dGVyLXNwYWNpbmc6LjAyZW07CiAgdHJhbnNpdGlvbjpib3JkZXItY29sb3IgLjE1cyBlYXNlLCBiYWNrZ3JvdW5kIC4xNXMgZWFzZSwgY29sb3IgLjE1cyBlYXNlLCBib3gtc2hhZG93IC4xNXMgZWFzZTsKfQouYnRuLWRvd25sb2FkIHN2ZyB7CiAgd2lkdGg6MTJweDsgaGVpZ2h0OjEycHg7IHN0cm9rZTpjdXJyZW50Q29sb3I7IGZpbGw6bm9uZTsgc3Ryb2tlLXdpZHRoOjEuODsKfQouYnRuLWRvd25sb2FkOmhvdmVyIHsKICBib3JkZXItY29sb3I6IzRmYzNmNzsgYmFja2dyb3VuZDpyZ2JhKDQxLDE4MiwyNDYsMC4xNik7CiAgY29sb3I6I2M2ZWNmZjsgYm94LXNoYWRvdzowIDAgMCAxcHggcmdiYSg3OSwxOTUsMjQ3LC4xOCkgaW5zZXQ7Cn0KCi5oaXN0b3J5LXRhYmxlLXdyYXAgeyBvdmVyZmxvdy14OmF1dG87IH0KLmhpc3RvcnktdGFibGUtd3JhcCB0YWJsZSB7CiAgbWluLXdpZHRoOiA4NjBweDsKfQp0YWJsZSB7IHdpZHRoOjEwMCU7IGJvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTsgdGFibGUtbGF5b3V0OmZpeGVkOyB9CnRoZWFkIHRoIHsKICBmb250LXNpemU6OXB4OyBsZXR0ZXItc3BhY2luZzouMWVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgY29sb3I6dmFyKC0tbXV0ZWQpOyBwYWRkaW5nOjlweCAyMnB4OyB0ZXh0LWFsaWduOmxlZnQ7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmMik7IGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo2MDA7CiAgcG9zaXRpb246cmVsYXRpdmU7Cn0KdGJvZHkgdHIgeyBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyB0cmFuc2l0aW9uOmJhY2tncm91bmQgLjEyczsgfQp0Ym9keSB0cjpob3ZlciB7IGJhY2tncm91bmQ6cmdiYSg0MSwxODIsMjQ2LC4wNCk7IH0KdGJvZHkgdHI6bGFzdC1jaGlsZCB7IGJvcmRlci1ib3R0b206bm9uZTsgfQp0Ym9keSB0ZCB7CiAgcGFkZGluZzoxMXB4IDIycHg7IGZvbnQtc2l6ZToxMnB4OwogIG92ZXJmbG93OmhpZGRlbjsgdGV4dC1vdmVyZmxvdzplbGxpcHNpczsgd2hpdGUtc3BhY2U6bm93cmFwOwp9CnRkLmRpbSB7IGNvbG9yOnZhcigtLW11dGVkMik7IGZvbnQtc2l6ZToxMXB4OyB9CnRkLmRpbSAudHMtZGF5IHsgZm9udC1zaXplOjlweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBsaW5lLWhlaWdodDoxLjE7IH0KdGQuZGltIC50cy1ob3VyIHsgZm9udC1zaXplOjExcHg7IGNvbG9yOnZhcigtLW11dGVkMik7IGxpbmUtaGVpZ2h0OjEuMjsgbWFyZ2luLXRvcDoycHg7IH0KLmNvbC1sYWJlbCB7IHBhZGRpbmctcmlnaHQ6MTBweDsgZGlzcGxheTppbmxpbmUtYmxvY2s7IH0KLmNvbC1yZXNpemVyIHsKICBwb3NpdGlvbjphYnNvbHV0ZTsKICB0b3A6MDsKICByaWdodDotNHB4OwogIHdpZHRoOjhweDsKICBoZWlnaHQ6MTAwJTsKICBjdXJzb3I6Y29sLXJlc2l6ZTsKICB1c2VyLXNlbGVjdDpub25lOwogIHRvdWNoLWFjdGlvbjpub25lOwogIHotaW5kZXg6MjsKfQouY29sLXJlc2l6ZXI6OmFmdGVyIHsKICBjb250ZW50OicnOwogIHBvc2l0aW9uOmFic29sdXRlOwogIHRvcDo2cHg7CiAgYm90dG9tOjZweDsKICBsZWZ0OjNweDsKICB3aWR0aDoxcHg7CiAgYmFja2dyb3VuZDpyZ2JhKDEyMiwxNDMsMTY4LC4yOCk7Cn0KLmNvbC1yZXNpemVyOmhvdmVyOjphZnRlciwKLmNvbC1yZXNpemVyLmFjdGl2ZTo6YWZ0ZXIgewogIGJhY2tncm91bmQ6cmdiYSgxMjIsMTQzLDE2OCwuNzUpOwp9Cgouc2JhZGdlIHsKICBkaXNwbGF5OmlubGluZS1ibG9jazsgZm9udC1zaXplOjlweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4wOGVtOyBwYWRkaW5nOjJweCA3cHg7IGJvcmRlci1yYWRpdXM6NHB4OwogIHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKfQouc2JhZGdlLnNpbSB7IGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4tZCk7IGNvbG9yOnZhcigtLWdyZWVuKTsgYm9yZGVyOjFweCBzb2xpZCByZ2JhKDAsMjMwLDExOCwuMik7IH0KLnNiYWRnZS5ub3NpbSB7IGJhY2tncm91bmQ6dmFyKC0tcmVkLWQpOyBjb2xvcjp2YXIoLS1yZWQpOyBib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjU1LDcxLDg3LC4yKTsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEZPT1RFUiAvIEdMT1NBUklPCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouZ2xvc2FyaW8gewogIG1hcmdpbi10b3A6MjBweDsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6MTFweDsgb3ZlcmZsb3c6aGlkZGVuOwogIGFuaW1hdGlvbjpmYWRlVXAgLjVzIC42cyBlYXNlIGJvdGg7Cn0KLmdsb3MtYnRuIHsKICB3aWR0aDoxMDAlOyBiYWNrZ3JvdW5kOnZhcigtLXN1cmYpOyBib3JkZXI6bm9uZTsKICBjb2xvcjp2YXIoLS1tdXRlZDIpOyBmb250LWZhbWlseTp2YXIoLS1tb25vKTsgZm9udC1zaXplOjExcHg7CiAgcGFkZGluZzoxM3B4IDIycHg7IHRleHQtYWxpZ246bGVmdDsgY3Vyc29yOnBvaW50ZXI7CiAgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGp1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuOwogIHRyYW5zaXRpb246Y29sb3IgLjE1czsKfQouZ2xvcy1idG46aG92ZXIgeyBjb2xvcjp2YXIoLS10ZXh0KTsgfQoKLmdsb3MtZ3JpZCB7CiAgZGlzcGxheTpub25lOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYyKTsgYm9yZGVyLXRvcDoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouZ2xvcy1ncmlkLm9wZW4geyBkaXNwbGF5OmdyaWQ7IH0KCi5naSB7CiAgcGFkZGluZzoxNHB4IDIycHg7IGJvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJpZ2h0OjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9Ci5naTpudGgtY2hpbGQoZXZlbil7Ym9yZGVyLXJpZ2h0Om5vbmU7fQouZ2ktdGVybSB7CiAgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtc2l6ZToxMHB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgbWFyZ2luLWJvdHRvbTozcHg7Cn0KLmdpLWRlZiB7IGZvbnQtc2l6ZToxMXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IGxpbmUtaGVpZ2h0OjEuNTsgfQoKZm9vdGVyIHsKICB0ZXh0LWFsaWduOmNlbnRlcjsgcGFkZGluZzoyMnB4OyBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOwogIGJvcmRlci10b3A6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KZm9vdGVyIGEgeyBjb2xvcjp2YXIoLS1tdXRlZDIpOyB0ZXh0LWRlY29yYXRpb246bm9uZTsgfQpmb290ZXIgYTpob3ZlciB7IGNvbG9yOnZhcigtLXRleHQpOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgQU5JTUFUSU9OUwrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KQGtleWZyYW1lcyBmYWRlSW4geyBmcm9te29wYWNpdHk6MDt9dG97b3BhY2l0eToxO30gfQpAa2V5ZnJhbWVzIGZhZGVVcCB7IGZyb217b3BhY2l0eTowO3RyYW5zZm9ybTp0cmFuc2xhdGVZKDEwcHgpO310b3tvcGFjaXR5OjE7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoMCk7fSB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgUkVTUE9OU0lWRQrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KQG1lZGlhKG1heC13aWR0aDo5MDBweCl7CiAgOnJvb3R7IC0tZHJhd2VyLXc6IDEwMHZ3OyB9CiAgLmJvZHktd3JhcC5kcmF3ZXItb3BlbiAubWFpbi1jb250ZW50IHsgbWFyZ2luLXJpZ2h0OjA7IH0KICAuZHJhd2VyIHsgd2lkdGg6MTAwdnc7IH0KICAuZHJhd2VyLXJlc2l6ZXIgeyBkaXNwbGF5Om5vbmU7IH0KfQpAbWVkaWEobWF4LXdpZHRoOjcwMHB4KXsKICAuaGVyby1ncmlkeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjsgfQogIC5oY2FyZC5nYXB7IGdyaWQtY29sdW1uOnNwYW4gMjsgfQogIC5tZXRyaWNzLWdyaWR7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyOyB9CiAgLmhjYXJkLXZhbHsgZm9udC1zaXplOjI2cHg7IH0KICAucGlsbHN7IGZsZXgtd3JhcDp3cmFwOyB9CiAgLnRhYmxlLXJpZ2h0IHsgZ2FwOjhweDsgfQogIC5idG4tZG93bmxvYWQgeyBwYWRkaW5nOjAgOHB4OyB9CiAgdGhlYWQgdGg6bnRoLWNoaWxkKDQpLCB0Ym9keSB0ZDpudGgtY2hpbGQoNCl7IGRpc3BsYXk6bm9uZTsgfQogIC5zLXJpZ2h0IHsgZGlzcGxheTpub25lOyB9CiAgdGQuZGltIC50cy1kYXkgeyBmb250LXNpemU6OHB4OyB9CiAgdGQuZGltIC50cy1ob3VyIHsgZm9udC1zaXplOjEwcHg7IH0KfQpAbWVkaWEobWF4LXdpZHRoOjQ4MHB4KXsKICAuaGVyby1ncmlkeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyOyB9CiAgLmhjYXJkLmdhcHsgZ3JpZC1jb2x1bW46c3BhbiAxOyB9CiAgaGVhZGVyeyBwYWRkaW5nOjAgMTRweDsgfQogIC50YWctbWVyY2Fkb3sgZGlzcGxheTpub25lOyB9CiAgLmJ0bi10YXNhcyBzcGFuLmxhYmVsLWxvbmcgeyBkaXNwbGF5Om5vbmU7IH0KfQoKLyogRFJBV0VSIE9WRVJMQVkgKG1vYmlsZSkgKi8KLm92ZXJsYXkgewogIGRpc3BsYXk6bm9uZTsKICBwb3NpdGlvbjpmaXhlZDsgaW5zZXQ6MDsgei1pbmRleDoxNDA7CiAgYmFja2dyb3VuZDpyZ2JhKDAsMCwwLC41NSk7CiAgYmFja2Ryb3AtZmlsdGVyOmJsdXIoMnB4KTsKfQpAbWVkaWEobWF4LXdpZHRoOjkwMHB4KXsKICAub3ZlcmxheS5zaG93IHsgZGlzcGxheTpibG9jazsgfQp9Cjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+CjxkaXYgY2xhc3M9ImFwcCI+Cgo8IS0tIOKUgOKUgCBIRUFERVIg4pSA4pSAIC0tPgo8aGVhZGVyPgogIDxkaXYgY2xhc3M9ImxvZ28iPgogICAgPHNwYW4gY2xhc3M9ImxpdmUtZG90Ij48L3NwYW4+CiAgICBSQURBUiBNRVAvQ0NMCiAgPC9kaXY+CiAgPGRpdiBjbGFzcz0iaGVhZGVyLXJpZ2h0Ij4KICAgIDxkaXYgY2xhc3M9ImZyZXNoLWJhZGdlIiBpZD0iZnJlc2gtYmFkZ2UiPgogICAgICA8c3BhbiBjbGFzcz0iZnJlc2gtZG90Ij48L3NwYW4+CiAgICAgIDxzcGFuIGlkPSJmcmVzaC1iYWRnZS10ZXh0Ij5BY3R1YWxpemFuZG/igKY8L3NwYW4+CiAgICA8L2Rpdj4KICAgIDxzcGFuIGNsYXNzPSJ0YWctbWVyY2FkbyBjbG9zZWQiIGlkPSJ0YWctbWVyY2FkbyI+TWVyY2FkbyBjZXJyYWRvPC9zcGFuPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi10YXNhcyIgaWQ9ImJ0blRhc2FzIiBvbmNsaWNrPSJ0b2dnbGVEcmF3ZXIoKSI+CiAgICAgIPCfk4ogPHNwYW4gY2xhc3M9ImxhYmVsLWxvbmciPkZvbmRvcyBDb211bmVzIGRlIEludmVyc2nDs248L3NwYW4+CiAgICA8L2J1dHRvbj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tYWxlcnQiPvCflJQgQWxlcnRhczwvYnV0dG9uPgogIDwvZGl2Pgo8L2hlYWRlcj4KCjwhLS0g4pSA4pSAIE9WRVJMQVkgKG1vYmlsZSkg4pSA4pSAIC0tPgo8ZGl2IGNsYXNzPSJvdmVybGF5IiBpZD0ib3ZlcmxheSIgb25jbGljaz0idG9nZ2xlRHJhd2VyKCkiPjwvZGl2PgoKPCEtLSDilIDilIAgQk9EWSBXUkFQIOKUgOKUgCAtLT4KPGRpdiBjbGFzcz0iYm9keS13cmFwIiBpZD0iYm9keVdyYXAiPgoKICA8IS0tIOKVkOKVkOKVkOKVkCBNQUlOIOKVkOKVkOKVkOKVkCAtLT4KICA8ZGl2IGNsYXNzPSJtYWluLWNvbnRlbnQiPgoKICAgIDwhLS0gU1RBVFVTIEJBTk5FUiAtLT4KICAgIDxkaXYgY2xhc3M9InN0YXR1cy1iYW5uZXIgc2ltaWxhciIgaWQ9InN0YXR1cy1iYW5uZXIiPgogICAgICA8ZGl2IGNsYXNzPSJzLWxlZnQiPgogICAgICAgIDxkaXYgY2xhc3M9InMtdGl0bGUiPgogICAgICAgICAgPHNwYW4gaWQ9InN0YXR1cy1sYWJlbCI+TUVQIOKJiCBDQ0w8L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0icy1iYWRnZSIgaWQ9InN0YXR1cy1iYWRnZSI+U2ltaWxhcjwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJzLXN1YiI+TGEgYnJlY2hhIGVzdMOhIGRlbnRybyBkZWwgdW1icmFsIOKAlCBsb3MgcHJlY2lvcyBzb24gY29tcGFyYWJsZXM8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InMtcmlnaHQiPgogICAgICAgIDxkaXY+w5psdGltYSBjb3JyaWRhOiA8c3Ryb25nIGlkPSJsYXN0LXJ1bi10aW1lIj7igJQ8L3N0cm9uZz48L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJjb3VudGRvd24tdGV4dCI+UHLDs3hpbWEgYWN0dWFsaXphY2nDs24gZW4gNTowMDwvZGl2PgogICAgICAgIDxkaXY+Q3JvbiBHTVQtMyDCtyBMdW7igJNWaWUgMTA6MzDigJMxODowMDwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZXJyb3ItYmFubmVyIiBpZD0iZXJyb3ItYmFubmVyIj4KICAgICAgPHNwYW4gaWQ9ImVycm9yLWJhbm5lci10ZXh0Ij5FcnJvciBhbCBhY3R1YWxpemFyIMK3IFJlaW50ZW50YXI8L3NwYW4+CiAgICAgIDxidXR0b24gaWQ9ImVycm9yLXJldHJ5LWJ0biIgdHlwZT0iYnV0dG9uIj5SZWludGVudGFyPC9idXR0b24+CiAgICA8L2Rpdj4KCiAgICA8IS0tIEhFUk8gQ0FSRFMgLS0+CiAgICA8ZGl2IGNsYXNzPSJoZXJvLWdyaWQiPgogICAgICA8ZGl2IGNsYXNzPSJoY2FyZCBtZXAiPgogICAgICAgIDxkaXYgY2xhc3M9ImJhciI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtbGFiZWwiPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImRvdCI+PC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRpcCIgZGF0YS10PSJEw7NsYXIgQm9sc2Eg4oCUIGNvbXByYS92ZW50YSBkZSBib25vcyBlbiAkQVJTIHkgVVNEIj5NRVAgdmVudGEg4pOYPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXZhbCIgaWQ9Im1lcC12YWwiPiQxLjI2NDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXN1YiI+ZG9sYXJpdG8uYXIgwrcgdmVudGE8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImhjYXJkIGNjbCI+CiAgICAgICAgPGRpdiBjbGFzcz0iYmFyIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1sYWJlbCI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0iZG90Ij48L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGlwIiBkYXRhLXQ9IkNvbnRhZG8gY29uIExpcXVpZGFjacOzbiDigJQgc2ltaWxhciBhbCBNRVAgY29uIGdpcm8gYWwgZXh0ZXJpb3IiPkNDTCB2ZW50YSDik5g8L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtdmFsIiBpZD0iY2NsLXZhbCI+JDEuMjcxPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtc3ViIj5kb2xhcml0by5hciDCtyB2ZW50YTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGNhcmQgZ2FwIj4KICAgICAgICA8ZGl2IGNsYXNzPSJiYXIiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLWxhYmVsIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJkb3QiPjwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0aXAiIGRhdGEtdD0iQnJlY2hhIHJlbGF0aXZhIGNvbnRyYSBlbCBwcm9tZWRpbyBlbnRyZSBNRVAgeSBDQ0wiPkJyZWNoYSDik5g8L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtdmFsIiBpZD0iYnJlY2hhLWFicyI+JDc8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1wY3QiIGlkPSJicmVjaGEtcGN0Ij4wLjU1JTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXN1YiI+ZGlmZXJlbmNpYSBhYnNvbHV0YSDCtyBwb3JjZW50dWFsPC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPCEtLSBDSEFSVCAtLT4KICAgIDxkaXYgY2xhc3M9ImNoYXJ0LWNhcmQiPgogICAgICA8ZGl2IGNsYXNzPSJjaGFydC10b3AiPgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXR0bCIgaWQ9InRyZW5kLXRpdGxlIj5UZW5kZW5jaWEgTUVQL0NDTCDigJQgMSBkw61hPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icGlsbHMiPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0icGlsbCBvbiIgZGF0YS1maWx0ZXI9IjFkIj4xIETDrWE8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9InBpbGwiIGRhdGEtZmlsdGVyPSIxdyI+MSBTZW1hbmE8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9InBpbGwiIGRhdGEtZmlsdGVyPSIxbSI+MSBNZXM8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImxlZ2VuZHMiPgogICAgICAgIDxkaXYgY2xhc3M9ImxlZyI+PGRpdiBjbGFzcz0ibGVnLWxpbmUiIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLW1lcCkiPjwvZGl2Pk1FUDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImxlZyI+PGRpdiBjbGFzcz0ibGVnLWxpbmUiIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLWNjbCkiPjwvZGl2PkNDTDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPHN2ZyBjbGFzcz0iY2hhcnQiIGlkPSJ0cmVuZC1jaGFydCIgdmlld0JveD0iMCAwIDg2MCAxNjAiIHByZXNlcnZlQXNwZWN0UmF0aW89Im5vbmUiPgogICAgICAgIDxsaW5lIHgxPSIwIiB5MT0iNDAiIHgyPSI4NjAiIHkyPSI0MCIgc3Ryb2tlPSIjMWUyNTMwIiBzdHJva2Utd2lkdGg9IjEiLz4KICAgICAgICA8bGluZSB4MT0iMCIgeTE9IjgwIiB4Mj0iODYwIiB5Mj0iODAiIHN0cm9rZT0iIzFlMjUzMCIgc3Ryb2tlLXdpZHRoPSIxIi8+CiAgICAgICAgPGxpbmUgeDE9IjAiIHkxPSIxMjAiIHgyPSI4NjAiIHkyPSIxMjAiIHN0cm9rZT0iIzFlMjUzMCIgc3Ryb2tlLXdpZHRoPSIxIi8+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXktdG9wIiB4PSIyIiB5PSIzNyIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI4IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC15LW1pZCIgeD0iMiIgeT0iNzciIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iOCIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteS1sb3ciIHg9IjIiIHk9IjExNyIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI4IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDxwb2x5bGluZSBpZD0idHJlbmQtbWVwLWxpbmUiIHBvaW50cz0iIiBmaWxsPSJub25lIiBzdHJva2U9IiMyOWI2ZjYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogICAgICAgIDxwb2x5bGluZSBpZD0idHJlbmQtY2NsLWxpbmUiIHBvaW50cz0iIiBmaWxsPSJub25lIiBzdHJva2U9IiNiMzlkZGIiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogICAgICAgIDxsaW5lIGlkPSJ0cmVuZC1ob3Zlci1saW5lIiB4MT0iMCIgeTE9IjE4IiB4Mj0iMCIgeTI9IjEzMiIgc3Ryb2tlPSIjMmEzNDQ0IiBzdHJva2Utd2lkdGg9IjEiIG9wYWNpdHk9IjAiLz4KICAgICAgICA8Y2lyY2xlIGlkPSJ0cmVuZC1ob3Zlci1tZXAiIGN4PSIwIiBjeT0iMCIgcj0iMy41IiBmaWxsPSIjMjliNmY2IiBvcGFjaXR5PSIwIi8+CiAgICAgICAgPGNpcmNsZSBpZD0idHJlbmQtaG92ZXItY2NsIiBjeD0iMCIgY3k9IjAiIHI9IjMuNSIgZmlsbD0iI2IzOWRkYiIgb3BhY2l0eT0iMCIvPgogICAgICAgIDxnIGlkPSJ0cmVuZC10b29sdGlwIiBvcGFjaXR5PSIwIj4KICAgICAgICAgIDxyZWN0IGlkPSJ0cmVuZC10b29sdGlwLWJnIiB4PSIwIiB5PSIwIiB3aWR0aD0iMTQ4IiBoZWlnaHQ9IjU2IiByeD0iNiIgZmlsbD0iIzE2MWIyMiIgc3Ryb2tlPSIjMmEzNDQ0Ii8+CiAgICAgICAgICA8dGV4dCBpZD0idHJlbmQtdGlwLXRpbWUiIHg9IjEwIiB5PSIxNCIgZmlsbD0iIzU1NjA3MCIgZm9udC1zaXplPSI4IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgICAgPHRleHQgaWQ9InRyZW5kLXRpcC1tZXAiIHg9IjEwIiB5PSIyOCIgZmlsbD0iIzI5YjZmNiIgZm9udC1zaXplPSI5IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+TUVQIOKAlDwvdGV4dD4KICAgICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC10aXAtY2NsIiB4PSIxMCIgeT0iNDAiIGZpbGw9IiNiMzlkZGIiIGZvbnQtc2l6ZT0iOSIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPkNDTCDigJQ8L3RleHQ+CiAgICAgICAgICA8dGV4dCBpZD0idHJlbmQtdGlwLWdhcCIgeD0iMTAiIHk9IjUyIiBmaWxsPSIjZmZjYzAwIiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj5CcmVjaGEg4oCUPC90ZXh0PgogICAgICAgIDwvZz4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC0xIiB4PSIyOCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtMiIgeD0iMjE4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC0zIiB4PSI0MTgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTQiIHg9IjYwOCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtNSIgeD0iNzk4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgPC9zdmc+CiAgICA8L2Rpdj4KCiAgICA8IS0tIE1FVFJJQ1MgLS0+CiAgICA8ZGl2IGNsYXNzPSJtZXRyaWNzLWdyaWQiPgogICAgICA8ZGl2IGNsYXNzPSJtY2FyZCI+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtbGFiZWwiIGlkPSJtZXRyaWMtY291bnQtbGFiZWwiPk11ZXN0cmFzIDEgZMOtYTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXZhbCIgaWQ9Im1ldHJpYy1jb3VudC0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiIgaWQ9Im1ldHJpYy1jb3VudC1zdWIiPnJlZ2lzdHJvcyBkZWwgcGVyw61vZG8gZmlsdHJhZG88L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im1jYXJkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1sYWJlbCIgaWQ9Im1ldHJpYy1zaW1pbGFyLWxhYmVsIj5WZWNlcyBzaW1pbGFyPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtdmFsIiBzdHlsZT0iY29sb3I6dmFyKC0tZ3JlZW4pIiBpZD0ibWV0cmljLXNpbWlsYXItMjRoIj7igJQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1zdWIiIGlkPSJtZXRyaWMtc2ltaWxhci1zdWIiPm1vbWVudG9zIGVuIHpvbmEg4omkMSUgbyDiiaQkMTA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im1jYXJkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1sYWJlbCIgaWQ9Im1ldHJpYy1taW4tbGFiZWwiPkJyZWNoYSBtw61uLjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXZhbCIgaWQ9Im1ldHJpYy1taW4tMjRoIj7igJQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1zdWIiIGlkPSJtZXRyaWMtbWluLXN1YiI+bcOtbmltYSBkZWwgcGVyw61vZG8gZmlsdHJhZG88L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im1jYXJkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1sYWJlbCIgaWQ9Im1ldHJpYy1tYXgtbGFiZWwiPkJyZWNoYSBtw6F4LjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXZhbCIgc3R5bGU9ImNvbG9yOnZhcigtLXllbGxvdykiIGlkPSJtZXRyaWMtbWF4LTI0aCI+4oCUPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtc3ViIiBpZD0ibWV0cmljLW1heC1zdWIiPm3DoXhpbWEgZGVsIHBlcsOtb2RvIGZpbHRyYWRvPC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPCEtLSBUQUJMRSAtLT4KICAgIDxkaXYgY2xhc3M9InRhYmxlLWNhcmQiPgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS10b3AiPgogICAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXR0bCI+SGlzdG9yaWFsIGRlIHJlZ2lzdHJvczwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXJpZ2h0Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9InRhYmxlLWNhcCIgaWQ9Imhpc3RvcnktY2FwIj7Dmmx0aW1hcyDigJQgbXVlc3RyYXM8L2Rpdj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0bi1kb3dubG9hZCIgaWQ9ImJ0bi1kb3dubG9hZC1jc3YiIHR5cGU9ImJ1dHRvbiIgYXJpYS1sYWJlbD0iRGVzY2FyZ2FyIENTViI+CiAgICAgICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBhcmlhLWhpZGRlbj0idHJ1ZSI+CiAgICAgICAgICAgICAgPHBhdGggZD0iTTEyIDR2MTAiPjwvcGF0aD4KICAgICAgICAgICAgICA8cGF0aCBkPSJNOCAxMGw0IDQgNC00Ij48L3BhdGg+CiAgICAgICAgICAgICAgPHBhdGggZD0iTTUgMTloMTQiPjwvcGF0aD4KICAgICAgICAgICAgPC9zdmc+CiAgICAgICAgICAgIERlc2NhcmdhciBDU1YKICAgICAgICAgIDwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGlzdG9yeS10YWJsZS13cmFwIj4KICAgICAgPHRhYmxlIGlkPSJoaXN0b3J5LXRhYmxlIj4KICAgICAgICA8Y29sZ3JvdXAgaWQ9Imhpc3RvcnktY29sZ3JvdXAiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iMCI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSIxIj4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjIiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iMyI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSI0Ij4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjUiPgogICAgICAgIDwvY29sZ3JvdXA+CiAgICAgICAgPHRoZWFkPgogICAgICAgICAgPHRyPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+RMOtYSAvIEhvcmE8L3NwYW4+PHNwYW4gY2xhc3M9ImNvbC1yZXNpemVyIiBkYXRhLWNvbC1pbmRleD0iMCIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIETDrWEgLyBIb3JhIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPk1FUDwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSIxIiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgTUVQIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPkNDTDwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSIyIiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgQ0NMIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPkRpZiAkPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjMiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBEaWYgJCI+PC9zcGFuPjwvdGg+CiAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iY29sLWxhYmVsIj5EaWYgJTwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSI0IiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgRGlmICUiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+RXN0YWRvPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjUiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBFc3RhZG8iPjwvc3Bhbj48L3RoPgogICAgICAgICAgPC90cj4KICAgICAgICA8L3RoZWFkPgogICAgICAgIDx0Ym9keSBpZD0iaGlzdG9yeS1yb3dzIj48L3Rib2R5PgogICAgICA8L3RhYmxlPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDwhLS0gR0xPU0FSSU8gLS0+CiAgICA8ZGl2IGNsYXNzPSJnbG9zYXJpbyI+CiAgICAgIDxidXR0b24gY2xhc3M9Imdsb3MtYnRuIiBvbmNsaWNrPSJ0b2dnbGVHbG9zKHRoaXMpIj4KICAgICAgICA8c3Bhbj7wn5OWIEdsb3NhcmlvIGRlIHTDqXJtaW5vczwvc3Bhbj4KICAgICAgICA8c3BhbiBpZD0iZ2xvc0Fycm93Ij7ilr48L3NwYW4+CiAgICAgIDwvYnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJnbG9zLWdyaWQiIGlkPSJnbG9zR3JpZCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPk1FUCB2ZW50YTwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+UHJlY2lvIGRlIHZlbnRhIGRlbCBkw7NsYXIgTUVQIChNZXJjYWRvIEVsZWN0csOzbmljbyBkZSBQYWdvcykgdsOtYSBjb21wcmEvdmVudGEgZGUgYm9ub3MgZW4gJEFSUyB5IFVTRC48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+Q0NMIHZlbnRhPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5Db250YWRvIGNvbiBMaXF1aWRhY2nDs24g4oCUIHNpbWlsYXIgYWwgTUVQIHBlcm8gcGVybWl0ZSB0cmFuc2ZlcmlyIGZvbmRvcyBhbCBleHRlcmlvci4gU3VlbGUgY290aXphciBsZXZlbWVudGUgcG9yIGVuY2ltYS48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+RGlmZXJlbmNpYSAlPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5CcmVjaGEgcmVsYXRpdmEgY2FsY3VsYWRhIGNvbnRyYSBlbCBwcm9tZWRpbyBlbnRyZSBNRVAgeSBDQ0wuIFVtYnJhbCBTSU1JTEFSOiDiiaQgMSUgbyDiiaQgJDEwIEFSUy48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+RnJlc2N1cmEgZGVsIGRhdG88L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPlRpZW1wbyBkZXNkZSBlbCDDumx0aW1vIHRpbWVzdGFtcCBkZSBkb2xhcml0by5hci4gRWwgY3JvbiBjb3JyZSBjYWRhIDUgbWluIGVuIGTDrWFzIGjDoWJpbGVzLjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5Fc3RhZG8gU0lNSUxBUjwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+Q3VhbmRvIE1FUCB5IENDTCBlc3TDoW4gZGVudHJvIGRlbCB1bWJyYWwg4oCUIG1vbWVudG8gaWRlYWwgcGFyYSBvcGVyYXIgYnVzY2FuZG8gcGFyaWRhZCBlbnRyZSBhbWJvcyB0aXBvcy48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+TWVyY2FkbyBBUkc8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPlZlbnRhbmEgb3BlcmF0aXZhOiBsdW5lcyBhIHZpZXJuZXMgZGUgMTA6MzAgYSAxNzo1OSAoR01ULTMsIEJ1ZW5vcyBBaXJlcykuPC9kaXY+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPGZvb3Rlcj4KICAgICAgRnVlbnRlOiA8YSBocmVmPSIjIj5kb2xhcml0by5hcjwvYT4gwrcgPGEgaHJlZj0iIyI+YXJnZW50aW5hZGF0b3MuY29tPC9hPiDCtyBEYXRvcyBjYWRhIDUgbWluIGVuIGTDrWFzIGjDoWJpbGVzIMK3IDxhIGhyZWY9IiMiPlJlcG9ydGFyIHByb2JsZW1hPC9hPgogICAgPC9mb290ZXI+CgogIDwvZGl2PjwhLS0gL21haW4tY29udGVudCAtLT4KCiAgPCEtLSDilZDilZDilZDilZAgRFJBV0VSIOKVkOKVkOKVkOKVkCAtLT4KICA8ZGl2IGNsYXNzPSJkcmF3ZXIiIGlkPSJkcmF3ZXIiPgogICAgPGRpdiBjbGFzcz0iZHJhd2VyLXJlc2l6ZXIiIGlkPSJkcmF3ZXItcmVzaXplciIgYXJpYS1oaWRkZW49InRydWUiPjwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImRyYXdlci1oZWFkZXIiPgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImRyYXdlci10aXRsZSI+8J+TiiBGb25kb3MgQ29tdW5lcyBkZSBJbnZlcnNpw7NuPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZHJhd2VyLXNvdXJjZSI+RnVlbnRlczogYXJnZW50aW5hZGF0b3MuY29tPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4tY2xvc2UiIG9uY2xpY2s9InRvZ2dsZURyYXdlcigpIj7inJU8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImRyYXdlci1ib2R5Ij4KICAgICAgPGRpdiBjbGFzcz0iZmNpLWhlYWRlciI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmNpLXRpdGxlLXdyYXAiPgogICAgICAgICAgPGRpdiBjbGFzcz0iZmNpLXRpdGxlIiBpZD0iZmNpLXRpdGxlIj5SZW50YSBmaWphIChGQ0kgQXJnZW50aW5hKTwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZmNpLXRhYnMiPgogICAgICAgICAgICA8YnV0dG9uIGlkPSJmY2ktdGFiLWZpamEiIGNsYXNzPSJmY2ktdGFiLWJ0biBhY3RpdmUiIHR5cGU9ImJ1dHRvbiI+UmVudGEgZmlqYTwvYnV0dG9uPgogICAgICAgICAgICA8YnV0dG9uIGlkPSJmY2ktdGFiLXZhcmlhYmxlIiBjbGFzcz0iZmNpLXRhYi1idG4iIHR5cGU9ImJ1dHRvbiI+UmVudGEgdmFyaWFibGU8L2J1dHRvbj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZjaS1tZXRhIiBpZD0iZmNpLWxhc3QtZGF0ZSI+RmVjaGE6IOKAlDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmNpLWNvbnRyb2xzIj4KICAgICAgICA8aW5wdXQgaWQ9ImZjaS1zZWFyY2giIGNsYXNzPSJmY2ktc2VhcmNoIiB0eXBlPSJ0ZXh0IiBwbGFjZWhvbGRlcj0iQnVzY2FyIGZvbmRvLi4uIiAvPgogICAgICAgIDxkaXYgY2xhc3M9ImZjaS1wYWdpbmF0aW9uIj4KICAgICAgICAgIDxidXR0b24gaWQ9ImZjaS1wcmV2IiBjbGFzcz0iZmNpLXBhZ2UtYnRuIiB0eXBlPSJidXR0b24iPuKXgDwvYnV0dG9uPgogICAgICAgICAgPGRpdiBpZD0iZmNpLXBhZ2UtaW5mbyIgY2xhc3M9ImZjaS1wYWdlLWluZm8iPjEgLyAxPC9kaXY+CiAgICAgICAgICA8YnV0dG9uIGlkPSJmY2ktbmV4dCIgY2xhc3M9ImZjaS1wYWdlLWJ0biIgdHlwZT0iYnV0dG9uIj7ilrY8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZjaS10YWJsZS13cmFwIj4KICAgICAgICA8dGFibGUgY2xhc3M9ImZjaS10YWJsZSI+CiAgICAgICAgICA8Y29sZ3JvdXAgaWQ9ImZjaS1jb2xncm91cCI+CiAgICAgICAgICAgIDxjb2wgc3R5bGU9IndpZHRoOjI4MHB4Ij4KICAgICAgICAgICAgPGNvbCBzdHlsZT0id2lkdGg6MTUwcHgiPgogICAgICAgICAgICA8Y29sIHN0eWxlPSJ3aWR0aDoxOTBweCI+CiAgICAgICAgICAgIDxjb2wgc3R5bGU9IndpZHRoOjE5MHB4Ij4KICAgICAgICAgICAgPGNvbCBzdHlsZT0id2lkdGg6MTIwcHgiPgogICAgICAgICAgICA8Y29sIHN0eWxlPSJ3aWR0aDoxNjBweCI+CiAgICAgICAgICA8L2NvbGdyb3VwPgogICAgICAgICAgPHRoZWFkPgogICAgICAgICAgICA8dHI+CiAgICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJmY2ktY29sLWxhYmVsIj48c3BhbiBjbGFzcz0idGlwIHRpcC1kb3duIiBkYXRhLXQ9Ik5vbWJyZSBkZWwgRm9uZG8gQ29tw7puIGRlIEludmVyc2nDs24uIj5Gb25kbyDik5g8L3NwYW4+PC9zcGFuPjxzcGFuIGNsYXNzPSJmY2ktY29sLXJlc2l6ZXIiIGRhdGEtZmNpLWNvbC1pbmRleD0iMCIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIEZvbmRvIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImZjaS1jb2wtbGFiZWwiPjxzcGFuIGNsYXNzPSJ0aXAgdGlwLWRvd24iIGRhdGEtdD0iVkNQIOKAlCBWYWxvciBDdW90YXBhcnRlLiBQcmVjaW8gdW5pdGFyaW8gZGUgY2FkYSBjdW90YXBhcnRlLiBVc2FsbyBwYXJhIGNvbXBhcmFyIHJlbmRpbWllbnRvIGVudHJlIGZlY2hhcy4iPlZDUCDik5g8L3NwYW4+PC9zcGFuPjxzcGFuIGNsYXNzPSJmY2ktY29sLXJlc2l6ZXIiIGRhdGEtZmNpLWNvbC1pbmRleD0iMSIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIFZDUCI+PC9zcGFuPjwvdGg+CiAgICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJmY2ktY29sLWxhYmVsIj48c3BhbiBjbGFzcz0idGlwIHRpcC1kb3duIiBkYXRhLXQ9IkNDUCDigJQgQ2FudGlkYWQgZGUgQ3VvdGFwYXJ0ZXMuIFRvdGFsIGRlIGN1b3RhcGFydGVzIGVtaXRpZGFzLiBTdWJlIGN1YW5kbyBlbnRyYW4gaW52ZXJzb3JlcywgYmFqYSBjdWFuZG8gcmVzY2F0YW4uIj5DQ1Ag4pOYPC9zcGFuPjwvc3Bhbj48c3BhbiBjbGFzcz0iZmNpLWNvbC1yZXNpemVyIiBkYXRhLWZjaS1jb2wtaW5kZXg9IjIiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBDQ1AiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iZmNpLWNvbC1sYWJlbCI+PHNwYW4gY2xhc3M9InRpcCB0aXAtZG93biIgZGF0YS10PSJQYXRyaW1vbmlvIOKAlCBWQ1Agw5cgQ0NQLiBWYWxvciB0b3RhbCBhZG1pbmlzdHJhZG8gcG9yIGVsIGZvbmRvIGVuIHBlc29zIGEgZXNhIGZlY2hhLiI+UGF0cmltb25pbyDik5g8L3NwYW4+PC9zcGFuPjxzcGFuIGNsYXNzPSJmY2ktY29sLXJlc2l6ZXIiIGRhdGEtZmNpLWNvbC1pbmRleD0iMyIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIFBhdHJpbW9uaW8iPjwvc3Bhbj48L3RoPgogICAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iZmNpLWNvbC1sYWJlbCI+PHNwYW4gY2xhc3M9InRpcCB0aXAtZG93biIgZGF0YS10PSJIb3Jpem9udGUgZGUgaW52ZXJzacOzbiBzdWdlcmlkbyAoY29ydG8sIG1lZGlvIG8gbGFyZ28pLiI+SG9yaXpvbnRlIOKTmDwvc3Bhbj48L3NwYW4+PHNwYW4gY2xhc3M9ImZjaS1jb2wtcmVzaXplciIgZGF0YS1mY2ktY29sLWluZGV4PSI0IiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgSG9yaXpvbnRlIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImZjaS1jb2wtbGFiZWwiPjxzcGFuIGNsYXNzPSJ0aXAgdGlwLWRvd24iIGRhdGEtdD0iU2XDsWFsIHLDoXBpZGEgdXNhbmRvIHJlbmRpbWllbnRvIG1lbnN1YWwgZXN0aW1hZG8gcG9yIFZDUCB2cyBiZW5jaG1hcmsgZGUgcGxhem8gZmlqbyBlIGluZmxhY2nDs24uIj5TZcOxYWwg4pOYPC9zcGFuPjwvc3Bhbj48c3BhbiBjbGFzcz0iZmNpLWNvbC1yZXNpemVyIiBkYXRhLWZjaS1jb2wtaW5kZXg9IjUiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBTZcOxYWwiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8L3RyPgogICAgICAgICAgPC90aGVhZD4KICAgICAgICAgIDx0Ym9keSBpZD0iZmNpLXJvd3MiPgogICAgICAgICAgICA8dHI+PHRkIGNvbHNwYW49IjYiIGNsYXNzPSJkaW0iPkNhcmdhbmRv4oCmPC90ZD48L3RyPgogICAgICAgICAgPC90Ym9keT4KICAgICAgICA8L3RhYmxlPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmNpLWJlbmNoIiBpZD0iZmNpLWJlbmNoLWluZm8iPkJlbmNobWFyazogY2FyZ2FuZG/igKY8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmNpLWVtcHR5IiBpZD0iZmNpLWVtcHR5IiBzdHlsZT0iZGlzcGxheTpub25lIj4KICAgICAgICBObyBoYXkgZGF0b3MgZGUgRkNJIGRpc3BvbmlibGVzIGVuIGVzdGUgbW9tZW50by4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImNvbnRleHQtYm94Ij4KICAgICAgICA8c3Ryb25nPlRpcDo8L3N0cm9uZz48YnI+CiAgICAgICAgU2UgbGlzdGFuIGxvcyBmb25kb3MgZGUgbGEgc2VyaWUgc2VsZWNjaW9uYWRhIG9yZGVuYWRvcyBwb3IgcGF0cmltb25pbyAoZGUgbWF5b3IgYSBtZW5vcikuPGJyPgogICAgICAgIOKWsiBzdWJlIMK3IOKWvCBiYWphIMK3ID0gc2luIGNhbWJpb3MgKHZzIGTDrWEgYW50ZXJpb3IpLgogICAgICA8L2Rpdj4KICAgIDwvZGl2PjwhLS0gL2RyYXdlci1ib2R5IC0tPgogIDwvZGl2PjwhLS0gL2RyYXdlciAtLT4KCjwvZGl2PjwhLS0gL2JvZHktd3JhcCAtLT4KPC9kaXY+PCEtLSAvYXBwIC0tPgo8ZGl2IGNsYXNzPSJzbWFydC10aXAiIGlkPSJzbWFydC10aXAiIHJvbGU9InRvb2x0aXAiIGFyaWEtaGlkZGVuPSJ0cnVlIj48L2Rpdj4KCjxzY3JpcHQ+CiAgLy8gMSkgQ29uc3RhbnRlcyB5IGNvbmZpZ3VyYWNpw7NuCiAgY29uc3QgRU5EUE9JTlRTID0gewogICAgbWVwQ2NsOiAnL2FwaS9kYXRhJywKICAgIGZjaVJlbnRhRmlqYTogJy9hcGkvZmNpL3JlbnRhLWZpamEvdWx0aW1vJywKICAgIGZjaVJlbnRhRmlqYVBlbnVsdGltbzogJy9hcGkvZmNpL3JlbnRhLWZpamEvcGVudWx0aW1vJywKICAgIGZjaVJlbnRhRmlqYU1lc0Jhc2U6ICcvYXBpL2ZjaS9yZW50YS1maWphL21lcy1iYXNlJywKICAgIGZjaVJlbnRhVmFyaWFibGU6ICcvYXBpL2ZjaS9yZW50YS12YXJpYWJsZS91bHRpbW8nLAogICAgZmNpUmVudGFWYXJpYWJsZVBlbnVsdGltbzogJy9hcGkvZmNpL3JlbnRhLXZhcmlhYmxlL3BlbnVsdGltbycsCiAgICBmY2lSZW50YVZhcmlhYmxlTWVzQmFzZTogJy9hcGkvZmNpL3JlbnRhLXZhcmlhYmxlL21lcy1iYXNlJywKICAgIGJlbmNobWFya1BsYXpvRmlqbzogJy9hcGkvYmVuY2htYXJrL3BsYXpvLWZpam8nLAogICAgYmVuY2htYXJrSW5mbGFjaW9uOiAnL2FwaS9iZW5jaG1hcmsvaW5mbGFjaW9uJwogIH07CiAgY29uc3QgQVJHX1RaID0gJ0FtZXJpY2EvQXJnZW50aW5hL0J1ZW5vc19BaXJlcyc7CiAgY29uc3QgRkVUQ0hfSU5URVJWQUxfTVMgPSAzMDAwMDA7CiAgY29uc3QgQ0FDSEVfS0VZID0gJ3JhZGFyX2NhY2hlJzsKICBjb25zdCBISVNUT1JZX0NPTFNfS0VZID0gJ3JhZGFyX2hpc3RvcnlfY29sX3dpZHRoc192MSc7CiAgY29uc3QgRkNJX0NPTFNfS0VZID0gJ3JhZGFyX2ZjaV9jb2xfd2lkdGhzX3YxJzsKICBjb25zdCBEUkFXRVJfV0lEVEhfS0VZID0gJ3JhZGFyX2RyYXdlcl93aWR0aF92MSc7CiAgY29uc3QgRkNJX1NJR05BTF9TVFJFQUtfS0VZID0gJ3JhZGFyX2ZjaV9zaWduYWxfc3RyZWFrc192MSc7CiAgY29uc3QgQ0FDSEVfVFRMX01TID0gMTUgKiA2MCAqIDEwMDA7CiAgY29uc3QgUkVUUllfREVMQVlTID0gWzEwMDAwLCAzMDAwMCwgNjAwMDBdOwogIGNvbnN0IFNJTUlMQVJfUENUX1RIUkVTSE9MRCA9IDE7CiAgY29uc3QgU0lNSUxBUl9BUlNfVEhSRVNIT0xEID0gMTA7CiAgY29uc3QgVFJFTkRfTUFYX1BPSU5UUyA9IDI0MDsKICBjb25zdCBGQ0lfUEFHRV9TSVpFID0gMTA7CiAgY29uc3QgRFJBV0VSX01JTl9XID0gMzQwOwogIGNvbnN0IERSQVdFUl9NQVhfVyA9IDc2MDsKICBjb25zdCBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIUyA9IFsxNzAsIDE2MCwgMTYwLCAxMjAsIDEyMCwgMTcwXTsKICBjb25zdCBISVNUT1JZX01JTl9DT0xfV0lEVEhTID0gWzEyMCwgMTEwLCAxMTAsIDkwLCA5MCwgMTIwXTsKICBjb25zdCBGQ0lfREVGQVVMVF9DT0xfV0lEVEhTID0gWzI4MCwgMTUwLCAxOTAsIDE5MCwgMTIwLCAxNjBdOwogIGNvbnN0IEZDSV9NSU5fQ09MX1dJRFRIUyA9IFsyMjAsIDEyMCwgMTUwLCAxNTAsIDEwMCwgMTMwXTsKICBjb25zdCBOVU1FUklDX0lEUyA9IFsKICAgICdtZXAtdmFsJywgJ2NjbC12YWwnLCAnYnJlY2hhLWFicycsICdicmVjaGEtcGN0JwogIF07CiAgY29uc3Qgc3RhdGUgPSB7CiAgICByZXRyeUluZGV4OiAwLAogICAgcmV0cnlUaW1lcjogbnVsbCwKICAgIGxhc3RTdWNjZXNzQXQ6IDAsCiAgICBpc0ZldGNoaW5nOiBmYWxzZSwKICAgIGZpbHRlck1vZGU6ICcxZCcsCiAgICBsYXN0TWVwUGF5bG9hZDogbnVsbCwKICAgIHRyZW5kUm93czogW10sCiAgICB0cmVuZEhvdmVyQm91bmQ6IGZhbHNlLAogICAgaGlzdG9yeVJlc2l6ZUJvdW5kOiBmYWxzZSwKICAgIGZjaVJlc2l6ZUJvdW5kOiBmYWxzZSwKICAgIGhpc3RvcnlDb2xXaWR0aHM6IFtdLAogICAgZmNpQ29sV2lkdGhzOiBbXSwKICAgIHNvdXJjZVRzTXM6IG51bGwsCiAgICBmcmVzaEJhZGdlTW9kZTogJ2lkbGUnLAogICAgZnJlc2hUaWNrZXI6IG51bGwsCiAgICBmY2lUeXBlOiAnZmlqYScsCiAgICBmY2lSb3dzQnlUeXBlOiB7IGZpamE6IFtdLCB2YXJpYWJsZTogW10gfSwKICAgIGZjaVByZXZpb3VzQnlGb25kb0J5VHlwZTogeyBmaWphOiBuZXcgTWFwKCksIHZhcmlhYmxlOiBuZXcgTWFwKCkgfSwKICAgIGZjaUJhc2VCeUZvbmRvQnlUeXBlOiB7IGZpamE6IG5ldyBNYXAoKSwgdmFyaWFibGU6IG5ldyBNYXAoKSB9LAogICAgZmNpRGF0ZUJ5VHlwZTogeyBmaWphOiAn4oCUJywgdmFyaWFibGU6ICfigJQnIH0sCiAgICBmY2lTaWduYWxTdHJlYWtzOiB7IGZpamE6IHt9LCB2YXJpYWJsZToge30gfSwKICAgIGZjaVNpZ25hbFN0cmVha3NEaXJ0eTogZmFsc2UsCiAgICBiZW5jaG1hcms6IHsKICAgICAgcGxhem9GaWpvTW9udGhseVBjdDogbnVsbCwKICAgICAgaW5mbGFjaW9uTW9udGhseVBjdDogbnVsbCwKICAgICAgaW5mbGFjaW9uRGF0ZTogbnVsbCwKICAgICAgdXBkYXRlZEF0SHVtYW5BcnQ6IG51bGwKICAgIH0sCiAgICBmY2lRdWVyeTogJycsCiAgICBmY2lQYWdlOiAxLAogICAgc21hcnRUaXBCb3VuZDogZmFsc2UsCiAgICBkcmF3ZXJSZXNpemVCb3VuZDogZmFsc2UsCiAgICBsYXRlc3Q6IHsKICAgICAgbWVwOiBudWxsLAogICAgICBjY2w6IG51bGwsCiAgICAgIGJyZWNoYUFiczogbnVsbCwKICAgICAgYnJlY2hhUGN0OiBudWxsCiAgICB9CiAgfTsKCiAgLy8gMikgSGVscGVycwogIGNvbnN0IGZtdEFyZ1RpbWUgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZXMtQVInLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgaG91cjogJzItZGlnaXQnLAogICAgbWludXRlOiAnMi1kaWdpdCcKICB9KTsKICBjb25zdCBmbXRBcmdUaW1lU2VjID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VzLUFSJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIGhvdXI6ICcyLWRpZ2l0JywKICAgIG1pbnV0ZTogJzItZGlnaXQnLAogICAgc2Vjb25kOiAnMi1kaWdpdCcKICB9KTsKICBjb25zdCBmbXRBcmdIb3VyID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VzLUFSJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIGhvdXI6ICcyLWRpZ2l0JywKICAgIG1pbnV0ZTogJzItZGlnaXQnLAogICAgaG91cjEyOiBmYWxzZQogIH0pOwogIGNvbnN0IGZtdEFyZ0RheU1vbnRoID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VzLUFSJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIGRheTogJzItZGlnaXQnLAogICAgbW9udGg6ICcyLWRpZ2l0JwogIH0pOwogIGNvbnN0IGZtdEFyZ0RhdGUgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tQ0EnLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgeWVhcjogJ251bWVyaWMnLAogICAgbW9udGg6ICcyLWRpZ2l0JywKICAgIGRheTogJzItZGlnaXQnCiAgfSk7CiAgY29uc3QgZm10QXJnV2Vla2RheSA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1VUycsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICB3ZWVrZGF5OiAnc2hvcnQnCiAgfSk7CiAgY29uc3QgZm10QXJnUGFydHMgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tVVMnLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgd2Vla2RheTogJ3Nob3J0JywKICAgIGhvdXI6ICcyLWRpZ2l0JywKICAgIG1pbnV0ZTogJzItZGlnaXQnLAogICAgc2Vjb25kOiAnMi1kaWdpdCcsCiAgICBob3VyMTI6IGZhbHNlCiAgfSk7CiAgY29uc3QgV0VFS0RBWSA9IHsgTW9uOiAxLCBUdWU6IDIsIFdlZDogMywgVGh1OiA0LCBGcmk6IDUsIFNhdDogNiwgU3VuOiA3IH07CgogIGZ1bmN0aW9uIHRvTnVtYmVyKHZhbHVlKSB7CiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSByZXR1cm4gdmFsdWU7CiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykgewogICAgICBjb25zdCBub3JtYWxpemVkID0gdmFsdWUucmVwbGFjZSgvXHMvZywgJycpLnJlcGxhY2UoJywnLCAnLicpLnJlcGxhY2UoL1teXGQuLV0vZywgJycpOwogICAgICBjb25zdCBwYXJzZWQgPSBOdW1iZXIobm9ybWFsaXplZCk7CiAgICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkKSA/IHBhcnNlZCA6IG51bGw7CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CiAgZnVuY3Rpb24gZ2V0UGF0aChvYmosIHBhdGgpIHsKICAgIHJldHVybiBwYXRoLnJlZHVjZSgoYWNjLCBrZXkpID0+IChhY2MgJiYgYWNjW2tleV0gIT09IHVuZGVmaW5lZCA/IGFjY1trZXldIDogdW5kZWZpbmVkKSwgb2JqKTsKICB9CiAgZnVuY3Rpb24gcGlja051bWJlcihvYmosIHBhdGhzKSB7CiAgICBmb3IgKGNvbnN0IHBhdGggb2YgcGF0aHMpIHsKICAgICAgY29uc3QgdiA9IGdldFBhdGgob2JqLCBwYXRoKTsKICAgICAgY29uc3QgbiA9IHRvTnVtYmVyKHYpOwogICAgICBpZiAobiAhPT0gbnVsbCkgcmV0dXJuIG47CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CiAgZnVuY3Rpb24gcGlja0J5S2V5SGludChvYmosIGhpbnQpIHsKICAgIGlmICghb2JqIHx8IHR5cGVvZiBvYmogIT09ICdvYmplY3QnKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGxvd2VyID0gaGludC50b0xvd2VyQ2FzZSgpOwogICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMob2JqKSkgewogICAgICBpZiAoay50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGxvd2VyKSkgewogICAgICAgIGNvbnN0IG4gPSB0b051bWJlcih2KTsKICAgICAgICBpZiAobiAhPT0gbnVsbCkgcmV0dXJuIG47CiAgICAgICAgaWYgKHYgJiYgdHlwZW9mIHYgPT09ICdvYmplY3QnKSB7CiAgICAgICAgICBjb25zdCBkZWVwID0gcGlja0J5S2V5SGludCh2LCBoaW50KTsKICAgICAgICAgIGlmIChkZWVwICE9PSBudWxsKSByZXR1cm4gZGVlcDsKICAgICAgICB9CiAgICAgIH0KICAgICAgaWYgKHYgJiYgdHlwZW9mIHYgPT09ICdvYmplY3QnKSB7CiAgICAgICAgY29uc3QgZGVlcCA9IHBpY2tCeUtleUhpbnQodiwgaGludCk7CiAgICAgICAgaWYgKGRlZXAgIT09IG51bGwpIHJldHVybiBkZWVwOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CiAgZnVuY3Rpb24gZ2V0QXJnTm93UGFydHMoZGF0ZSA9IG5ldyBEYXRlKCkpIHsKICAgIGNvbnN0IHBhcnRzID0gZm10QXJnUGFydHMuZm9ybWF0VG9QYXJ0cyhkYXRlKS5yZWR1Y2UoKGFjYywgcCkgPT4gewogICAgICBhY2NbcC50eXBlXSA9IHAudmFsdWU7CiAgICAgIHJldHVybiBhY2M7CiAgICB9LCB7fSk7CiAgICByZXR1cm4gewogICAgICB3ZWVrZGF5OiBXRUVLREFZW3BhcnRzLndlZWtkYXldIHx8IDAsCiAgICAgIGhvdXI6IE51bWJlcihwYXJ0cy5ob3VyIHx8ICcwJyksCiAgICAgIG1pbnV0ZTogTnVtYmVyKHBhcnRzLm1pbnV0ZSB8fCAnMCcpLAogICAgICBzZWNvbmQ6IE51bWJlcihwYXJ0cy5zZWNvbmQgfHwgJzAnKQogICAgfTsKICB9CiAgZnVuY3Rpb24gYnJlY2hhUGVyY2VudChtZXAsIGNjbCkgewogICAgaWYgKG1lcCA9PT0gbnVsbCB8fCBjY2wgPT09IG51bGwpIHJldHVybiBudWxsOwogICAgY29uc3QgYXZnID0gKG1lcCArIGNjbCkgLyAyOwogICAgaWYgKCFhdmcpIHJldHVybiBudWxsOwogICAgcmV0dXJuIChNYXRoLmFicyhtZXAgLSBjY2wpIC8gYXZnKSAqIDEwMDsKICB9CiAgZnVuY3Rpb24gZm9ybWF0TW9uZXkodmFsdWUsIGRpZ2l0cyA9IDApIHsKICAgIGlmICh2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuICfigJQnOwogICAgcmV0dXJuICckJyArIHZhbHVlLnRvTG9jYWxlU3RyaW5nKCdlcy1BUicsIHsKICAgICAgbWluaW11bUZyYWN0aW9uRGlnaXRzOiBkaWdpdHMsCiAgICAgIG1heGltdW1GcmFjdGlvbkRpZ2l0czogZGlnaXRzCiAgICB9KTsKICB9CiAgZnVuY3Rpb24gZm9ybWF0UGVyY2VudCh2YWx1ZSwgZGlnaXRzID0gMikgewogICAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gdmFsdWUudG9GaXhlZChkaWdpdHMpICsgJyUnOwogIH0KICBmdW5jdGlvbiBmb3JtYXRDb21wYWN0TW9uZXkodmFsdWUsIGRpZ2l0cyA9IDIpIHsKICAgIGlmICh2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuICfigJQnOwogICAgcmV0dXJuIHZhbHVlLnRvTG9jYWxlU3RyaW5nKCdlcy1BUicsIHsKICAgICAgbWluaW11bUZyYWN0aW9uRGlnaXRzOiBkaWdpdHMsCiAgICAgIG1heGltdW1GcmFjdGlvbkRpZ2l0czogZGlnaXRzCiAgICB9KTsKICB9CiAgZnVuY3Rpb24gZXNjYXBlSHRtbCh2YWx1ZSkgewogICAgcmV0dXJuIFN0cmluZyh2YWx1ZSA/PyAnJykucmVwbGFjZSgvWyY8PiInXS9nLCAoY2hhcikgPT4gKAogICAgICB7ICcmJzogJyZhbXA7JywgJzwnOiAnJmx0OycsICc+JzogJyZndDsnLCAnIic6ICcmcXVvdDsnLCAiJyI6ICcmIzM5OycgfVtjaGFyXQogICAgKSk7CiAgfQogIGZ1bmN0aW9uIHNldFRleHQoaWQsIHRleHQsIG9wdGlvbnMgPSB7fSkgewogICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CiAgICBpZiAoIWVsKSByZXR1cm47CiAgICBjb25zdCBuZXh0ID0gU3RyaW5nKHRleHQpOwogICAgY29uc3QgcHJldiA9IGVsLnRleHRDb250ZW50OwogICAgZWwudGV4dENvbnRlbnQgPSBuZXh0OwogICAgZWwuY2xhc3NMaXN0LnJlbW92ZSgnc2tlbGV0b24nKTsKICAgIGlmIChvcHRpb25zLmNoYW5nZUNsYXNzICYmIHByZXYgIT09IG5leHQpIHsKICAgICAgZWwuY2xhc3NMaXN0LmFkZCgndmFsdWUtY2hhbmdlZCcpOwogICAgICBzZXRUaW1lb3V0KCgpID0+IGVsLmNsYXNzTGlzdC5yZW1vdmUoJ3ZhbHVlLWNoYW5nZWQnKSwgNjAwKTsKICAgIH0KICB9CiAgZnVuY3Rpb24gc2V0RGFzaChpZHMpIHsKICAgIGlkcy5mb3JFYWNoKChpZCkgPT4gc2V0VGV4dChpZCwgJ+KAlCcpKTsKICB9CiAgZnVuY3Rpb24gc2V0TG9hZGluZyhpZHMsIGlzTG9hZGluZykgewogICAgaWRzLmZvckVhY2goKGlkKSA9PiB7CiAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwogICAgICBpZiAoIWVsKSByZXR1cm47CiAgICAgIGVsLmNsYXNzTGlzdC50b2dnbGUoJ3NrZWxldG9uJywgaXNMb2FkaW5nKTsKICAgIH0pOwogIH0KICBmdW5jdGlvbiBzZXRGcmVzaEJhZGdlKHRleHQsIG1vZGUpIHsKICAgIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZyZXNoLWJhZGdlJyk7CiAgICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmcmVzaC1iYWRnZS10ZXh0Jyk7CiAgICBpZiAoIWJhZGdlIHx8ICFsYWJlbCkgcmV0dXJuOwogICAgbGFiZWwudGV4dENvbnRlbnQgPSB0ZXh0OwogICAgc3RhdGUuZnJlc2hCYWRnZU1vZGUgPSBtb2RlIHx8ICdpZGxlJzsKICAgIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoJ2ZldGNoaW5nJywgbW9kZSA9PT0gJ2ZldGNoaW5nJyk7CiAgICBiYWRnZS5jbGFzc0xpc3QudG9nZ2xlKCdlcnJvcicsIG1vZGUgPT09ICdlcnJvcicpOwogICAgYmFkZ2Uub25jbGljayA9IG1vZGUgPT09ICdlcnJvcicgPyAoKSA9PiBmZXRjaEFsbCh7IG1hbnVhbDogdHJ1ZSB9KSA6IG51bGw7CiAgfQogIGZ1bmN0aW9uIGZvcm1hdFNvdXJjZUFnZUxhYmVsKHRzTXMpIHsKICAgIGxldCBuID0gdG9OdW1iZXIodHNNcyk7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShuKSkgcmV0dXJuIG51bGw7CiAgICBpZiAobiA8IDFlMTIpIG4gKj0gMTAwMDsKICAgIGNvbnN0IGFnZU1pbiA9IE1hdGgubWF4KDAsIE1hdGguZmxvb3IoKERhdGUubm93KCkgLSBuKSAvIDYwMDAwKSk7CiAgICBpZiAoYWdlTWluIDwgNjApIHJldHVybiBgJHthZ2VNaW59IG1pbmA7CiAgICBjb25zdCBoID0gTWF0aC5mbG9vcihhZ2VNaW4gLyA2MCk7CiAgICBjb25zdCBtID0gYWdlTWluICUgNjA7CiAgICByZXR1cm4gbSA9PT0gMCA/IGAke2h9IGhgIDogYCR7aH0gaCAke219IG1pbmA7CiAgfQogIGZ1bmN0aW9uIHJlZnJlc2hGcmVzaEJhZGdlRnJvbVNvdXJjZSgpIHsKICAgIGlmIChzdGF0ZS5mcmVzaEJhZGdlTW9kZSA9PT0gJ2ZldGNoaW5nJyB8fCBzdGF0ZS5mcmVzaEJhZGdlTW9kZSA9PT0gJ2Vycm9yJykgcmV0dXJuOwogICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoc3RhdGUuc291cmNlVHNNcykpIHJldHVybjsKICAgIGNvbnN0IGFnZUxhYmVsID0gZm9ybWF0U291cmNlQWdlTGFiZWwoc3RhdGUuc291cmNlVHNNcyk7CiAgICBpZiAoIWFnZUxhYmVsKSByZXR1cm47CiAgICBzZXRGcmVzaEJhZGdlKGDDmmx0aW1hIGFjdHVhbGl6YWNpw7NuIGhhY2U6ICR7YWdlTGFiZWx9YCwgJ2lkbGUnKTsKICB9CiAgZnVuY3Rpb24gc3RhcnRGcmVzaFRpY2tlcigpIHsKICAgIGlmIChzdGF0ZS5mcmVzaFRpY2tlcikgcmV0dXJuOwogICAgc3RhdGUuZnJlc2hUaWNrZXIgPSBzZXRJbnRlcnZhbChyZWZyZXNoRnJlc2hCYWRnZUZyb21Tb3VyY2UsIDMwMDAwKTsKICB9CiAgZnVuY3Rpb24gc2V0TWFya2V0VGFnKGlzT3BlbikgewogICAgY29uc3QgdGFnID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RhZy1tZXJjYWRvJyk7CiAgICBpZiAoIXRhZykgcmV0dXJuOwogICAgdGFnLnRleHRDb250ZW50ID0gaXNPcGVuID8gJ01lcmNhZG8gYWJpZXJ0bycgOiAnTWVyY2FkbyBjZXJyYWRvJzsKICAgIHRhZy5jbGFzc0xpc3QudG9nZ2xlKCdjbG9zZWQnLCAhaXNPcGVuKTsKICB9CiAgZnVuY3Rpb24gc2V0RXJyb3JCYW5uZXIoc2hvdywgdGV4dCkgewogICAgY29uc3QgYmFubmVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Vycm9yLWJhbm5lcicpOwogICAgY29uc3QgbGFiZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXJyb3ItYmFubmVyLXRleHQnKTsKICAgIGlmICghYmFubmVyKSByZXR1cm47CiAgICBpZiAodGV4dCAmJiBsYWJlbCkgbGFiZWwudGV4dENvbnRlbnQgPSB0ZXh0OwogICAgYmFubmVyLmNsYXNzTGlzdC50b2dnbGUoJ3Nob3cnLCAhIXNob3cpOwogIH0KICBmdW5jdGlvbiBleHRyYWN0Um9vdChqc29uKSB7CiAgICByZXR1cm4ganNvbiAmJiB0eXBlb2YganNvbiA9PT0gJ29iamVjdCcgPyAoanNvbi5kYXRhIHx8IGpzb24ucmVzdWx0IHx8IGpzb24pIDoge307CiAgfQogIGZ1bmN0aW9uIG5vcm1hbGl6ZUZjaVJvd3MocGF5bG9hZCkgewogICAgY29uc3Qgcm9vdCA9IGV4dHJhY3RSb290KHBheWxvYWQpOwogICAgaWYgKEFycmF5LmlzQXJyYXkocm9vdCkpIHJldHVybiByb290OwogICAgaWYgKEFycmF5LmlzQXJyYXkocm9vdD8uaXRlbXMpKSByZXR1cm4gcm9vdC5pdGVtczsKICAgIGlmIChBcnJheS5pc0FycmF5KHJvb3Q/LnJvd3MpKSByZXR1cm4gcm9vdC5yb3dzOwogICAgcmV0dXJuIFtdOwogIH0KICBmdW5jdGlvbiBub3JtYWxpemVGY2lGb25kb0tleSh2YWx1ZSkgewogICAgcmV0dXJuIFN0cmluZyh2YWx1ZSB8fCAnJykKICAgICAgLnRvTG93ZXJDYXNlKCkKICAgICAgLm5vcm1hbGl6ZSgnTkZEJykKICAgICAgLnJlcGxhY2UoL1tcdTAzMDAtXHUwMzZmXS9nLCAnJykKICAgICAgLnJlcGxhY2UoL1xzKy9nLCAnICcpCiAgICAgIC50cmltKCk7CiAgfQogIGZ1bmN0aW9uIGZjaVRyZW5kRGlyKGN1cnJlbnQsIHByZXZpb3VzKSB7CiAgICBjb25zdCBjdXJyID0gdG9OdW1iZXIoY3VycmVudCk7CiAgICBjb25zdCBwcmV2ID0gdG9OdW1iZXIocHJldmlvdXMpOwogICAgaWYgKGN1cnIgPT09IG51bGwgfHwgcHJldiA9PT0gbnVsbCkgcmV0dXJuICduYSc7CiAgICBpZiAoTWF0aC5hYnMoY3VyciAtIHByZXYpIDwgMWUtOSkgcmV0dXJuICdmbGF0JzsKICAgIHJldHVybiBjdXJyID4gcHJldiA/ICd1cCcgOiAnZG93bic7CiAgfQogIGZ1bmN0aW9uIGZjaVRyZW5kTGFiZWwoZGlyKSB7CiAgICBpZiAoZGlyID09PSAndXAnKSByZXR1cm4gJ1N1YmnDsyB2cyBkw61hIGFudGVyaW9yJzsKICAgIGlmIChkaXIgPT09ICdkb3duJykgcmV0dXJuICdCYWrDsyB2cyBkw61hIGFudGVyaW9yJzsKICAgIGlmIChkaXIgPT09ICdmbGF0JykgcmV0dXJuICdTaW4gY2FtYmlvcyB2cyBkw61hIGFudGVyaW9yJzsKICAgIHJldHVybiAnU2luIGRhdG8gZGVsIGTDrWEgYW50ZXJpb3InOwogIH0KICBmdW5jdGlvbiByZW5kZXJGY2lUcmVuZFZhbHVlKHZhbHVlLCBkaXIpIHsKICAgIGNvbnN0IGRpcmVjdGlvbiA9IGRpciB8fCAnbmEnOwogICAgY29uc3QgaWNvbiA9IGRpcmVjdGlvbiA9PT0gJ3VwJyA/ICfilrInIDogZGlyZWN0aW9uID09PSAnZG93bicgPyAn4pa8JyA6IGRpcmVjdGlvbiA9PT0gJ2ZsYXQnID8gJz0nIDogJ8K3JzsKICAgIHJldHVybiBgPHNwYW4gY2xhc3M9ImZjaS10cmVuZCAke2RpcmVjdGlvbn0iIHRpdGxlPSIke2VzY2FwZUh0bWwoZmNpVHJlbmRMYWJlbChkaXJlY3Rpb24pKX0iPjxzcGFuIGNsYXNzPSJmY2ktdHJlbmQtaWNvbiI+JHtpY29ufTwvc3Bhbj48c3Bhbj4ke2Zvcm1hdENvbXBhY3RNb25leSh2YWx1ZSwgMil9PC9zcGFuPjwvc3Bhbj5gOwogIH0KICBmdW5jdGlvbiByb3VuZDJuKHZhbHVlKSB7CiAgICBjb25zdCBuID0gTnVtYmVyKHZhbHVlKTsKICAgIGlmICghTnVtYmVyLmlzRmluaXRlKG4pKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiBNYXRoLnJvdW5kKG4gKiAxMDApIC8gMTAwOwogIH0KICBmdW5jdGlvbiBjb21wdXRlTW9udGhseVBjdCh2Y3AsIGJhc2VWY3ApIHsKICAgIGNvbnN0IGN1cnIgPSB0b051bWJlcih2Y3ApOwogICAgY29uc3QgcHJldiA9IHRvTnVtYmVyKGJhc2VWY3ApOwogICAgaWYgKGN1cnIgPT09IG51bGwgfHwgcHJldiA9PT0gbnVsbCB8fCBwcmV2IDw9IDApIHJldHVybiBudWxsOwogICAgcmV0dXJuIHJvdW5kMm4oKChjdXJyIC0gcHJldikgLyBwcmV2KSAqIDEwMCk7CiAgfQogIGZ1bmN0aW9uIGZvcm1hdFBjdFZhbCh2YWx1ZSkgewogICAgcmV0dXJuIHZhbHVlID09PSBudWxsID8gJ+KAlCcgOiBgJHt2YWx1ZS50b0ZpeGVkKDIpfSVgOwogIH0KICBmdW5jdGlvbiB0b01vbnRoS2V5KGRhdGVTdHIpIHsKICAgIGlmICh0eXBlb2YgZGF0ZVN0ciAhPT0gJ3N0cmluZycpIHJldHVybiBudWxsOwogICAgY29uc3QgY2xlYW4gPSBkYXRlU3RyLnRyaW0oKTsKICAgIGlmICgvXlxkezR9LVxkezJ9LVxkezJ9JC8udGVzdChjbGVhbikpIHJldHVybiBjbGVhbi5zbGljZSgwLCA3KTsKICAgIHJldHVybiBudWxsOwogIH0KICBmdW5jdGlvbiBsb2FkRmNpU2lnbmFsU3RyZWFrcygpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJhdyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKEZDSV9TSUdOQUxfU1RSRUFLX0tFWSk7CiAgICAgIGlmICghcmF3KSByZXR1cm4geyBmaWphOiB7fSwgdmFyaWFibGU6IHt9IH07CiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTsKICAgICAgcmV0dXJuIHsKICAgICAgICBmaWphOiBwYXJzZWQ/LmZpamEgJiYgdHlwZW9mIHBhcnNlZC5maWphID09PSAnb2JqZWN0JyA/IHBhcnNlZC5maWphIDoge30sCiAgICAgICAgdmFyaWFibGU6IHBhcnNlZD8udmFyaWFibGUgJiYgdHlwZW9mIHBhcnNlZC52YXJpYWJsZSA9PT0gJ29iamVjdCcgPyBwYXJzZWQudmFyaWFibGUgOiB7fQogICAgICB9OwogICAgfSBjYXRjaCB7CiAgICAgIHJldHVybiB7IGZpamE6IHt9LCB2YXJpYWJsZToge30gfTsKICAgIH0KICB9CiAgZnVuY3Rpb24gc2F2ZUZjaVNpZ25hbFN0cmVha3MoKSB7CiAgICBpZiAoIXN0YXRlLmZjaVNpZ25hbFN0cmVha3NEaXJ0eSkgcmV0dXJuOwogICAgdHJ5IHsKICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oRkNJX1NJR05BTF9TVFJFQUtfS0VZLCBKU09OLnN0cmluZ2lmeShzdGF0ZS5mY2lTaWduYWxTdHJlYWtzKSk7CiAgICAgIHN0YXRlLmZjaVNpZ25hbFN0cmVha3NEaXJ0eSA9IGZhbHNlOwogICAgfSBjYXRjaCB7fQogIH0KICBmdW5jdGlvbiByZXNvbHZlRmNpU2lnbmFsU3RyZWFrKHR5cGUsIGZvbmRvS2V5LCBsZXZlbCwgbW9udGhLZXkpIHsKICAgIGlmICghdHlwZSB8fCAhZm9uZG9LZXkgfHwgIW1vbnRoS2V5IHx8ICFsZXZlbCB8fCBsZXZlbCA9PT0gJ25hJykgcmV0dXJuIG51bGw7CiAgICBjb25zdCBieVR5cGUgPSBzdGF0ZS5mY2lTaWduYWxTdHJlYWtzW3R5cGVdIHx8IChzdGF0ZS5mY2lTaWduYWxTdHJlYWtzW3R5cGVdID0ge30pOwogICAgY29uc3QgY3VycmVudCA9IGJ5VHlwZVtmb25kb0tleV07CiAgICBpZiAoIWN1cnJlbnQpIHsKICAgICAgYnlUeXBlW2ZvbmRvS2V5XSA9IHsgbGV2ZWwsIG1vbnRoS2V5LCBtb250aHM6IDEgfTsKICAgICAgc3RhdGUuZmNpU2lnbmFsU3RyZWFrc0RpcnR5ID0gdHJ1ZTsKICAgICAgcmV0dXJuIDE7CiAgICB9CiAgICBjb25zdCBwcmV2TW9udGhzID0gTnVtYmVyLmlzRmluaXRlKE51bWJlcihjdXJyZW50Lm1vbnRocykpID8gTnVtYmVyKGN1cnJlbnQubW9udGhzKSA6IDE7CiAgICBpZiAoY3VycmVudC5tb250aEtleSA9PT0gbW9udGhLZXkpIHsKICAgICAgaWYgKGN1cnJlbnQubGV2ZWwgIT09IGxldmVsKSB7CiAgICAgICAgY3VycmVudC5sZXZlbCA9IGxldmVsOwogICAgICAgIGN1cnJlbnQubW9udGhzID0gMTsKICAgICAgICBzdGF0ZS5mY2lTaWduYWxTdHJlYWtzRGlydHkgPSB0cnVlOwogICAgICAgIHJldHVybiAxOwogICAgICB9CiAgICAgIHJldHVybiBwcmV2TW9udGhzOwogICAgfQogICAgY3VycmVudC5tb250aHMgPSBjdXJyZW50LmxldmVsID09PSBsZXZlbCA/IHByZXZNb250aHMgKyAxIDogMTsKICAgIGN1cnJlbnQubGV2ZWwgPSBsZXZlbDsKICAgIGN1cnJlbnQubW9udGhLZXkgPSBtb250aEtleTsKICAgIHN0YXRlLmZjaVNpZ25hbFN0cmVha3NEaXJ0eSA9IHRydWU7CiAgICByZXR1cm4gY3VycmVudC5tb250aHM7CiAgfQogIGZ1bmN0aW9uIHJlbmRlckZjaVNpZ25hbEJhZGdlKHNpZ25hbCkgewogICAgY29uc3QgcyA9IHNpZ25hbCB8fCB7IGtpbmQ6ICduYScsIGxhYmVsOiAncy9kYXRvJywgZGV0YWlsOiAnJywgc3RyZWFrTW9udGhzOiBudWxsIH07CiAgICBjb25zdCBzdHJlYWsgPSBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHMuc3RyZWFrTW9udGhzKSkKICAgICAgPyBgPHNwYW4gY2xhc3M9ImZjaS1zaWduYWwtc3RyZWFrIj5MbGV2YSAke3Muc3RyZWFrTW9udGhzfSAke051bWJlcihzLnN0cmVha01vbnRocykgPT09IDEgPyAnbWVzJyA6ICdtZXNlcyd9IGVuIGVzdGUgZXN0YWRvLjwvc3Bhbj5gCiAgICAgIDogJyc7CiAgICByZXR1cm4gYDxzcGFuIGNsYXNzPSJmY2ktc2lnbmFsLXdyYXAiPjxzcGFuIGNsYXNzPSJmY2ktc2lnbmFsICR7cy5raW5kfSIgdGl0bGU9IiR7ZXNjYXBlSHRtbChzLmRldGFpbCB8fCBzLmxhYmVsKX0iPiR7ZXNjYXBlSHRtbChzLmxhYmVsKX08L3NwYW4+JHtzdHJlYWt9PC9zcGFuPmA7CiAgfQogIGZ1bmN0aW9uIGNvbXB1dGVGY2lTaWduYWwocm93LCB0eXBlKSB7CiAgICBjb25zdCBtb250aGx5UGN0ID0gdG9OdW1iZXIocm93Lm1vbnRobHlQY3QpOwogICAgY29uc3QgcGYgPSB0b051bWJlcihzdGF0ZS5iZW5jaG1hcmsucGxhem9GaWpvTW9udGhseVBjdCk7CiAgICBjb25zdCBpbmYgPSB0b051bWJlcihzdGF0ZS5iZW5jaG1hcmsuaW5mbGFjaW9uTW9udGhseVBjdCk7CiAgICBpZiAobW9udGhseVBjdCA9PT0gbnVsbCB8fCBwZiA9PT0gbnVsbCB8fCBpbmYgPT09IG51bGwpIHsKICAgICAgcmV0dXJuIHsga2luZDogJ25hJywgbGV2ZWw6ICduYScsIGxhYmVsOiAncy9kYXRvJywgZGV0YWlsOiAnU2luIGRhdG8gc3VmaWNpZW50ZSBwYXJhIGNhbGN1bGFyIHNlw7FhbCBtZW5zdWFsIGNvbnRyYSBwbGF6byBmaWpvIGUgaW5mbGFjacOzbi4nLCBzdHJlYWtNb250aHM6IG51bGwgfTsKICAgIH0KICAgIGNvbnN0IG1hcmdpblZzSW5mID0gcm91bmQybihtb250aGx5UGN0IC0gaW5mKTsKICAgIGNvbnN0IGRldGFpbCA9IGBSZW5kLiBtZW5zdWFsIEZDSTogJHtmb3JtYXRQY3RWYWwobW9udGhseVBjdCl9IMK3IFBGIG1lbnN1YWw6ICR7Zm9ybWF0UGN0VmFsKHBmKX0gwrcgSW5mbGFjacOzbiBtZW5zdWFsOiAke2Zvcm1hdFBjdFZhbChpbmYpfWA7CiAgICBsZXQgc2lnbmFsID0gbnVsbDsKICAgIGlmIChtb250aGx5UGN0IDwgcGYgJiYgbW9udGhseVBjdCA8IGluZikgewogICAgICBzaWduYWwgPSB7IGtpbmQ6ICdiYWQnLCBsZXZlbDogJ3BlcmRpZW5kbycsIGxhYmVsOiAn8J+UtCBQRVJESUVORE8nLCBkZXRhaWwgfTsKICAgIH0gZWxzZSBpZiAobW9udGhseVBjdCA+PSBwZiAmJiBtb250aGx5UGN0IDwgaW5mKSB7CiAgICAgIHNpZ25hbCA9IHsga2luZDogJ29qbycsIGxldmVsOiAnb2pvJywgbGFiZWw6ICfwn5+gIE9KTycsIGRldGFpbCB9OwogICAgfSBlbHNlIGlmIChtb250aGx5UGN0ID49IGluZiAmJiBtYXJnaW5Wc0luZiA8PSAwLjUpIHsKICAgICAgc2lnbmFsID0geyBraW5kOiAnd2FybicsIGxldmVsOiAnYWNlcHRhYmxlJywgbGFiZWw6ICfwn5+hIEFDRVBUQUJMRScsIGRldGFpbCB9OwogICAgfSBlbHNlIGlmIChtb250aGx5UGN0ID4gcGYgJiYgbWFyZ2luVnNJbmYgPiAwLjUpIHsKICAgICAgc2lnbmFsID0geyBraW5kOiAnZ29vZCcsIGxldmVsOiAnZ2FuYW5kbycsIGxhYmVsOiAn8J+foiBHQU5BTkRPJywgZGV0YWlsIH07CiAgICB9IGVsc2UgewogICAgICBzaWduYWwgPSB7IGtpbmQ6ICd3YXJuJywgbGV2ZWw6ICdhY2VwdGFibGUnLCBsYWJlbDogJ/Cfn6EgQUNFUFRBQkxFJywgZGV0YWlsIH07CiAgICB9CiAgICBjb25zdCBtb250aEtleSA9IHRvTW9udGhLZXkocm93LmZlY2hhKTsKICAgIGNvbnN0IHN0cmVha01vbnRocyA9IHJlc29sdmVGY2lTaWduYWxTdHJlYWsodHlwZSwgbm9ybWFsaXplRmNpRm9uZG9LZXkocm93LmZvbmRvKSwgc2lnbmFsLmxldmVsLCBtb250aEtleSk7CiAgICByZXR1cm4geyAuLi5zaWduYWwsIHN0cmVha01vbnRocyB9OwogIH0KICBmdW5jdGlvbiByZW5kZXJGY2lCZW5jaG1hcmtJbmZvKCkgewogICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLWJlbmNoLWluZm8nKTsKICAgIGlmICghZWwpIHJldHVybjsKICAgIGNvbnN0IHBmID0gdG9OdW1iZXIoc3RhdGUuYmVuY2htYXJrLnBsYXpvRmlqb01vbnRobHlQY3QpOwogICAgY29uc3QgaW5mID0gdG9OdW1iZXIoc3RhdGUuYmVuY2htYXJrLmluZmxhY2lvbk1vbnRobHlQY3QpOwogICAgY29uc3QgaW5mRGF0ZSA9IHN0YXRlLmJlbmNobWFyay5pbmZsYWNpb25EYXRlIHx8ICfigJQnOwogICAgaWYgKHBmID09PSBudWxsICYmIGluZiA9PT0gbnVsbCkgewogICAgICBlbC5pbm5lckhUTUwgPSAnQmVuY2htYXJrOiBzaW4gZGF0b3MgZGUgcmVmZXJlbmNpYSBwb3IgYWhvcmEuJzsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc3QgdXBkYXRlZCA9IHN0YXRlLmJlbmNobWFyay51cGRhdGVkQXRIdW1hbkFydCA/IGAgwrcgQWN0dWFsaXphZG86ICR7ZXNjYXBlSHRtbChzdGF0ZS5iZW5jaG1hcmsudXBkYXRlZEF0SHVtYW5BcnQpfWAgOiAnJzsKICAgIGVsLmlubmVySFRNTCA9IGA8c3Ryb25nPkJlbmNobWFyazo8L3N0cm9uZz4gUEYgcmVmIG1lbnN1YWwgJHtmb3JtYXRQY3RWYWwocGYpfSDCtyBJbmZsYWNpw7NuIG1lbnN1YWwgKCR7ZXNjYXBlSHRtbChpbmZEYXRlKX0pICR7Zm9ybWF0UGN0VmFsKGluZil9JHt1cGRhdGVkfWA7CiAgfQogIGZ1bmN0aW9uIGdldEhpc3RvcnlDb2xFbGVtZW50cygpIHsKICAgIGNvbnN0IGNvbGdyb3VwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hpc3RvcnktY29sZ3JvdXAnKTsKICAgIHJldHVybiBjb2xncm91cCA/IEFycmF5LmZyb20oY29sZ3JvdXAucXVlcnlTZWxlY3RvckFsbCgnY29sJykpIDogW107CiAgfQogIGZ1bmN0aW9uIGNsYW1wSGlzdG9yeVdpZHRocyh3aWR0aHMpIHsKICAgIHJldHVybiBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIUy5tYXAoKGZhbGxiYWNrLCBpKSA9PiB7CiAgICAgIGNvbnN0IHJhdyA9IE51bWJlcih3aWR0aHM/LltpXSk7CiAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHJhdykpIHJldHVybiBmYWxsYmFjazsKICAgICAgY29uc3QgbWluID0gSElTVE9SWV9NSU5fQ09MX1dJRFRIU1tpXSA/PyA4MDsKICAgICAgcmV0dXJuIE1hdGgubWF4KG1pbiwgTWF0aC5yb3VuZChyYXcpKTsKICAgIH0pOwogIH0KICBmdW5jdGlvbiBzYXZlSGlzdG9yeUNvbHVtbldpZHRocyh3aWR0aHMpIHsKICAgIHRyeSB7CiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEhJU1RPUllfQ09MU19LRVksIEpTT04uc3RyaW5naWZ5KGNsYW1wSGlzdG9yeVdpZHRocyh3aWR0aHMpKSk7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tSYWRhck1FUF0gbm8gc2UgcHVkbyBndWFyZGFyIGFuY2hvcyBkZSBjb2x1bW5hcycsIGUpOwogICAgfQogIH0KICBmdW5jdGlvbiBsb2FkSGlzdG9yeUNvbHVtbldpZHRocygpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJhdyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKEhJU1RPUllfQ09MU19LRVkpOwogICAgICBpZiAoIXJhdykgcmV0dXJuIG51bGw7CiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTsKICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHBhcnNlZCkgfHwgcGFyc2VkLmxlbmd0aCAhPT0gSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFMubGVuZ3RoKSByZXR1cm4gbnVsbDsKICAgICAgcmV0dXJuIGNsYW1wSGlzdG9yeVdpZHRocyhwYXJzZWQpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBjb25zb2xlLmVycm9yKCdbUmFkYXJNRVBdIGFuY2hvcyBkZSBjb2x1bW5hcyBpbnbDoWxpZG9zJywgZSk7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogIH0KICBmdW5jdGlvbiBhcHBseUhpc3RvcnlDb2x1bW5XaWR0aHMod2lkdGhzLCBwZXJzaXN0ID0gZmFsc2UpIHsKICAgIGNvbnN0IGNvbHMgPSBnZXRIaXN0b3J5Q29sRWxlbWVudHMoKTsKICAgIGlmIChjb2xzLmxlbmd0aCAhPT0gSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFMubGVuZ3RoKSByZXR1cm47CiAgICBjb25zdCBuZXh0ID0gY2xhbXBIaXN0b3J5V2lkdGhzKHdpZHRocyk7CiAgICBjb2xzLmZvckVhY2goKGNvbCwgaSkgPT4gewogICAgICBjb2wuc3R5bGUud2lkdGggPSBgJHtuZXh0W2ldfXB4YDsKICAgIH0pOwogICAgc3RhdGUuaGlzdG9yeUNvbFdpZHRocyA9IG5leHQ7CiAgICBpZiAocGVyc2lzdCkgc2F2ZUhpc3RvcnlDb2x1bW5XaWR0aHMobmV4dCk7CiAgfQogIGZ1bmN0aW9uIGluaXRIaXN0b3J5Q29sdW1uV2lkdGhzKCkgewogICAgY29uc3Qgc2F2ZWQgPSBsb2FkSGlzdG9yeUNvbHVtbldpZHRocygpOwogICAgYXBwbHlIaXN0b3J5Q29sdW1uV2lkdGhzKHNhdmVkIHx8IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTLCBmYWxzZSk7CiAgfQogIGZ1bmN0aW9uIGJpbmRIaXN0b3J5Q29sdW1uUmVzaXplKCkgewogICAgaWYgKHN0YXRlLmhpc3RvcnlSZXNpemVCb3VuZCkgcmV0dXJuOwogICAgY29uc3QgdGFibGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGlzdG9yeS10YWJsZScpOwogICAgaWYgKCF0YWJsZSkgcmV0dXJuOwogICAgY29uc3QgaGFuZGxlcyA9IEFycmF5LmZyb20odGFibGUucXVlcnlTZWxlY3RvckFsbCgnLmNvbC1yZXNpemVyJykpOwogICAgaWYgKCFoYW5kbGVzLmxlbmd0aCkgcmV0dXJuOwogICAgc3RhdGUuaGlzdG9yeVJlc2l6ZUJvdW5kID0gdHJ1ZTsKCiAgICBoYW5kbGVzLmZvckVhY2goKGhhbmRsZSkgPT4gewogICAgICBoYW5kbGUuYWRkRXZlbnRMaXN0ZW5lcignZGJsY2xpY2snLCAoZXZlbnQpID0+IHsKICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGNvbnN0IGlkeCA9IE51bWJlcihoYW5kbGUuZGF0YXNldC5jb2xJbmRleCk7CiAgICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoaWR4KSkgcmV0dXJuOwogICAgICAgIGNvbnN0IG5leHQgPSBzdGF0ZS5oaXN0b3J5Q29sV2lkdGhzLnNsaWNlKCk7CiAgICAgICAgbmV4dFtpZHhdID0gSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFNbaWR4XTsKICAgICAgICBhcHBseUhpc3RvcnlDb2x1bW5XaWR0aHMobmV4dCwgdHJ1ZSk7CiAgICAgIH0pOwogICAgICBoYW5kbGUuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcmRvd24nLCAoZXZlbnQpID0+IHsKICAgICAgICBpZiAoZXZlbnQuYnV0dG9uICE9PSAwKSByZXR1cm47CiAgICAgICAgY29uc3QgaWR4ID0gTnVtYmVyKGhhbmRsZS5kYXRhc2V0LmNvbEluZGV4KTsKICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShpZHgpKSByZXR1cm47CiAgICAgICAgY29uc3Qgc3RhcnRYID0gZXZlbnQuY2xpZW50WDsKICAgICAgICBjb25zdCBzdGFydFdpZHRoID0gc3RhdGUuaGlzdG9yeUNvbFdpZHRoc1tpZHhdID8/IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTW2lkeF07CiAgICAgICAgaGFuZGxlLmNsYXNzTGlzdC5hZGQoJ2FjdGl2ZScpOwogICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7CgogICAgICAgIGNvbnN0IG9uTW92ZSA9IChtb3ZlRXZlbnQpID0+IHsKICAgICAgICAgIGNvbnN0IGRlbHRhID0gbW92ZUV2ZW50LmNsaWVudFggLSBzdGFydFg7CiAgICAgICAgICBjb25zdCBtaW4gPSBISVNUT1JZX01JTl9DT0xfV0lEVEhTW2lkeF0gPz8gODA7CiAgICAgICAgICBjb25zdCBuZXh0V2lkdGggPSBNYXRoLm1heChtaW4sIE1hdGgucm91bmQoc3RhcnRXaWR0aCArIGRlbHRhKSk7CiAgICAgICAgICBjb25zdCBuZXh0ID0gc3RhdGUuaGlzdG9yeUNvbFdpZHRocy5zbGljZSgpOwogICAgICAgICAgbmV4dFtpZHhdID0gbmV4dFdpZHRoOwogICAgICAgICAgYXBwbHlIaXN0b3J5Q29sdW1uV2lkdGhzKG5leHQsIGZhbHNlKTsKICAgICAgICB9OwogICAgICAgIGNvbnN0IG9uVXAgPSAoKSA9PiB7CiAgICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcm1vdmUnLCBvbk1vdmUpOwogICAgICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJ1cCcsIG9uVXApOwogICAgICAgICAgaGFuZGxlLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpOwogICAgICAgICAgc2F2ZUhpc3RvcnlDb2x1bW5XaWR0aHMoc3RhdGUuaGlzdG9yeUNvbFdpZHRocyk7CiAgICAgICAgfTsKICAgICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcm1vdmUnLCBvbk1vdmUpOwogICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVydXAnLCBvblVwKTsKICAgICAgfSk7CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIGdldEZjaUNvbEVsZW1lbnRzKCkgewogICAgY29uc3QgY29sZ3JvdXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLWNvbGdyb3VwJyk7CiAgICByZXR1cm4gY29sZ3JvdXAgPyBBcnJheS5mcm9tKGNvbGdyb3VwLnF1ZXJ5U2VsZWN0b3JBbGwoJ2NvbCcpKSA6IFtdOwogIH0KICBmdW5jdGlvbiBjbGFtcEZjaVdpZHRocyh3aWR0aHMpIHsKICAgIHJldHVybiBGQ0lfREVGQVVMVF9DT0xfV0lEVEhTLm1hcCgoZmFsbGJhY2ssIGkpID0+IHsKICAgICAgY29uc3QgcmF3ID0gTnVtYmVyKHdpZHRocz8uW2ldKTsKICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUocmF3KSkgcmV0dXJuIGZhbGxiYWNrOwogICAgICBjb25zdCBtaW4gPSBGQ0lfTUlOX0NPTF9XSURUSFNbaV0gPz8gODA7CiAgICAgIHJldHVybiBNYXRoLm1heChtaW4sIE1hdGgucm91bmQocmF3KSk7CiAgICB9KTsKICB9CiAgZnVuY3Rpb24gc2F2ZUZjaUNvbHVtbldpZHRocyh3aWR0aHMpIHsKICAgIHRyeSB7CiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEZDSV9DT0xTX0tFWSwgSlNPTi5zdHJpbmdpZnkoY2xhbXBGY2lXaWR0aHMod2lkdGhzKSkpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBjb25zb2xlLmVycm9yKCdbUmFkYXJNRVBdIG5vIHNlIHB1ZG8gZ3VhcmRhciBhbmNob3MgZGUgY29sdW1uYXMgRkNJJywgZSk7CiAgICB9CiAgfQogIGZ1bmN0aW9uIGxvYWRGY2lDb2x1bW5XaWR0aHMoKSB7CiAgICB0cnkgewogICAgICBjb25zdCByYXcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShGQ0lfQ09MU19LRVkpOwogICAgICBpZiAoIXJhdykgcmV0dXJuIG51bGw7CiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTsKICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHBhcnNlZCkgfHwgcGFyc2VkLmxlbmd0aCAhPT0gRkNJX0RFRkFVTFRfQ09MX1dJRFRIUy5sZW5ndGgpIHJldHVybiBudWxsOwogICAgICByZXR1cm4gY2xhbXBGY2lXaWR0aHMocGFyc2VkKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgY29uc29sZS5lcnJvcignW1JhZGFyTUVQXSBhbmNob3MgZGUgY29sdW1uYXMgRkNJIGludsOhbGlkb3MnLCBlKTsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQogIGZ1bmN0aW9uIGFwcGx5RmNpQ29sdW1uV2lkdGhzKHdpZHRocywgcGVyc2lzdCA9IGZhbHNlKSB7CiAgICBjb25zdCBjb2xzID0gZ2V0RmNpQ29sRWxlbWVudHMoKTsKICAgIGlmIChjb2xzLmxlbmd0aCAhPT0gRkNJX0RFRkFVTFRfQ09MX1dJRFRIUy5sZW5ndGgpIHJldHVybjsKICAgIGNvbnN0IG5leHQgPSBjbGFtcEZjaVdpZHRocyh3aWR0aHMpOwogICAgY29scy5mb3JFYWNoKChjb2wsIGkpID0+IHsKICAgICAgY29sLnN0eWxlLndpZHRoID0gYCR7bmV4dFtpXX1weGA7CiAgICB9KTsKICAgIHN0YXRlLmZjaUNvbFdpZHRocyA9IG5leHQ7CiAgICBpZiAocGVyc2lzdCkgc2F2ZUZjaUNvbHVtbldpZHRocyhuZXh0KTsKICB9CiAgZnVuY3Rpb24gaW5pdEZjaUNvbHVtbldpZHRocygpIHsKICAgIGNvbnN0IHNhdmVkID0gbG9hZEZjaUNvbHVtbldpZHRocygpOwogICAgYXBwbHlGY2lDb2x1bW5XaWR0aHMoc2F2ZWQgfHwgRkNJX0RFRkFVTFRfQ09MX1dJRFRIUywgZmFsc2UpOwogIH0KICBmdW5jdGlvbiBiaW5kRmNpQ29sdW1uUmVzaXplKCkgewogICAgaWYgKHN0YXRlLmZjaVJlc2l6ZUJvdW5kKSByZXR1cm47CiAgICBjb25zdCB0YWJsZSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5mY2ktdGFibGUnKTsKICAgIGlmICghdGFibGUpIHJldHVybjsKICAgIGNvbnN0IGhhbmRsZXMgPSBBcnJheS5mcm9tKHRhYmxlLnF1ZXJ5U2VsZWN0b3JBbGwoJy5mY2ktY29sLXJlc2l6ZXInKSk7CiAgICBpZiAoIWhhbmRsZXMubGVuZ3RoKSByZXR1cm47CiAgICBzdGF0ZS5mY2lSZXNpemVCb3VuZCA9IHRydWU7CgogICAgaGFuZGxlcy5mb3JFYWNoKChoYW5kbGUpID0+IHsKICAgICAgaGFuZGxlLmFkZEV2ZW50TGlzdGVuZXIoJ2RibGNsaWNrJywgKGV2ZW50KSA9PiB7CiAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKICAgICAgICBjb25zdCBpZHggPSBOdW1iZXIoaGFuZGxlLmRhdGFzZXQuZmNpQ29sSW5kZXgpOwogICAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGlkeCkpIHJldHVybjsKICAgICAgICBjb25zdCBuZXh0ID0gc3RhdGUuZmNpQ29sV2lkdGhzLnNsaWNlKCk7CiAgICAgICAgbmV4dFtpZHhdID0gRkNJX0RFRkFVTFRfQ09MX1dJRFRIU1tpZHhdOwogICAgICAgIGFwcGx5RmNpQ29sdW1uV2lkdGhzKG5leHQsIHRydWUpOwogICAgICB9KTsKICAgICAgaGFuZGxlLmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJkb3duJywgKGV2ZW50KSA9PiB7CiAgICAgICAgaWYgKGV2ZW50LmJ1dHRvbiAhPT0gMCkgcmV0dXJuOwogICAgICAgIGNvbnN0IGlkeCA9IE51bWJlcihoYW5kbGUuZGF0YXNldC5mY2lDb2xJbmRleCk7CiAgICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoaWR4KSkgcmV0dXJuOwogICAgICAgIGNvbnN0IHN0YXJ0WCA9IGV2ZW50LmNsaWVudFg7CiAgICAgICAgY29uc3Qgc3RhcnRXaWR0aCA9IHN0YXRlLmZjaUNvbFdpZHRoc1tpZHhdID8/IEZDSV9ERUZBVUxUX0NPTF9XSURUSFNbaWR4XTsKICAgICAgICBoYW5kbGUuY2xhc3NMaXN0LmFkZCgnYWN0aXZlJyk7CiAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKCiAgICAgICAgY29uc3Qgb25Nb3ZlID0gKG1vdmVFdmVudCkgPT4gewogICAgICAgICAgY29uc3QgZGVsdGEgPSBtb3ZlRXZlbnQuY2xpZW50WCAtIHN0YXJ0WDsKICAgICAgICAgIGNvbnN0IG1pbiA9IEZDSV9NSU5fQ09MX1dJRFRIU1tpZHhdID8/IDgwOwogICAgICAgICAgY29uc3QgbmV4dFdpZHRoID0gTWF0aC5tYXgobWluLCBNYXRoLnJvdW5kKHN0YXJ0V2lkdGggKyBkZWx0YSkpOwogICAgICAgICAgY29uc3QgbmV4dCA9IHN0YXRlLmZjaUNvbFdpZHRocy5zbGljZSgpOwogICAgICAgICAgbmV4dFtpZHhdID0gbmV4dFdpZHRoOwogICAgICAgICAgYXBwbHlGY2lDb2x1bW5XaWR0aHMobmV4dCwgZmFsc2UpOwogICAgICAgIH07CiAgICAgICAgY29uc3Qgb25VcCA9ICgpID0+IHsKICAgICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdwb2ludGVybW92ZScsIG9uTW92ZSk7CiAgICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcnVwJywgb25VcCk7CiAgICAgICAgICBoYW5kbGUuY2xhc3NMaXN0LnJlbW92ZSgnYWN0aXZlJyk7CiAgICAgICAgICBzYXZlRmNpQ29sdW1uV2lkdGhzKHN0YXRlLmZjaUNvbFdpZHRocyk7CiAgICAgICAgfTsKICAgICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcm1vdmUnLCBvbk1vdmUpOwogICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVydXAnLCBvblVwKTsKICAgICAgfSk7CiAgICB9KTsKICB9CgogIC8vIDMpIEZ1bmNpb25lcyBkZSByZW5kZXIKICBmdW5jdGlvbiByZW5kZXJNZXBDY2wocGF5bG9hZCkgewogICAgaWYgKCFwYXlsb2FkKSB7CiAgICAgIHNldERhc2goWydtZXAtdmFsJywgJ2NjbC12YWwnLCAnYnJlY2hhLWFicycsICdicmVjaGEtcGN0J10pOwogICAgICBzZXRUZXh0KCdzdGF0dXMtbGFiZWwnLCAnRGF0b3MgaW5jb21wbGV0b3MnKTsKICAgICAgc2V0VGV4dCgnc3RhdHVzLWJhZGdlJywgJ1NpbiBkYXRvJyk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGRhdGEgPSBleHRyYWN0Um9vdChwYXlsb2FkKTsKICAgIGNvbnN0IGN1cnJlbnQgPSBkYXRhICYmIHR5cGVvZiBkYXRhLmN1cnJlbnQgPT09ICdvYmplY3QnID8gZGF0YS5jdXJyZW50IDogbnVsbDsKICAgIGNvbnN0IG1lcCA9IGN1cnJlbnQgPyB0b051bWJlcihjdXJyZW50Lm1lcCkgOiAocGlja051bWJlcihkYXRhLCBbWydtZXAnLCAndmVudGEnXSwgWydtZXAnLCAnc2VsbCddLCBbJ21lcCddLCBbJ21lcF92ZW50YSddLCBbJ2RvbGFyX21lcCddXSkgPz8gcGlja0J5S2V5SGludChkYXRhLCAnbWVwJykpOwogICAgY29uc3QgY2NsID0gY3VycmVudCA/IHRvTnVtYmVyKGN1cnJlbnQuY2NsKSA6IChwaWNrTnVtYmVyKGRhdGEsIFtbJ2NjbCcsICd2ZW50YSddLCBbJ2NjbCcsICdzZWxsJ10sIFsnY2NsJ10sIFsnY2NsX3ZlbnRhJ10sIFsnZG9sYXJfY2NsJ11dKSA/PyBwaWNrQnlLZXlIaW50KGRhdGEsICdjY2wnKSk7CiAgICBjb25zdCBhYnMgPSBjdXJyZW50ID8gdG9OdW1iZXIoY3VycmVudC5hYnNEaWZmKSA/PyAobWVwICE9PSBudWxsICYmIGNjbCAhPT0gbnVsbCA/IE1hdGguYWJzKG1lcCAtIGNjbCkgOiBudWxsKSA6IChtZXAgIT09IG51bGwgJiYgY2NsICE9PSBudWxsID8gTWF0aC5hYnMobWVwIC0gY2NsKSA6IG51bGwpOwogICAgY29uc3QgcGN0ID0gY3VycmVudCA/IHRvTnVtYmVyKGN1cnJlbnQucGN0RGlmZikgPz8gYnJlY2hhUGVyY2VudChtZXAsIGNjbCkgOiBicmVjaGFQZXJjZW50KG1lcCwgY2NsKTsKICAgIGNvbnN0IGlzU2ltaWxhciA9IGN1cnJlbnQgJiYgdHlwZW9mIGN1cnJlbnQuc2ltaWxhciA9PT0gJ2Jvb2xlYW4nCiAgICAgID8gY3VycmVudC5zaW1pbGFyCiAgICAgIDogKHBjdCAhPT0gbnVsbCAmJiBhYnMgIT09IG51bGwgJiYgKHBjdCA8PSBTSU1JTEFSX1BDVF9USFJFU0hPTEQgfHwgYWJzIDw9IFNJTUlMQVJfQVJTX1RIUkVTSE9MRCkpOwoKICAgIHNldFRleHQoJ21lcC12YWwnLCBmb3JtYXRNb25leShtZXAsIDIpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnY2NsLXZhbCcsIGZvcm1hdE1vbmV5KGNjbCwgMiksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdicmVjaGEtYWJzJywgYWJzID09PSBudWxsID8gJ+KAlCcgOiBmb3JtYXRNb25leShhYnMsIDIpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnYnJlY2hhLXBjdCcsIGZvcm1hdFBlcmNlbnQocGN0LCAyKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ3N0YXR1cy1sYWJlbCcsIGlzU2ltaWxhciA/ICdNRVAg4omIIENDTCcgOiAnTUVQIOKJoCBDQ0wnKTsKICAgIHNldFRleHQoJ3N0YXR1cy1iYWRnZScsIGlzU2ltaWxhciA/ICdTaW1pbGFyJyA6ICdObyBzaW1pbGFyJyk7CiAgICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdGF0dXMtYmFkZ2UnKTsKICAgIGlmIChiYWRnZSkgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZSgnbm9zaW0nLCAhaXNTaW1pbGFyKTsKCiAgICBjb25zdCBiYW5uZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RhdHVzLWJhbm5lcicpOwogICAgaWYgKGJhbm5lcikgewogICAgICBiYW5uZXIuY2xhc3NMaXN0LnRvZ2dsZSgnc2ltaWxhcicsICEhaXNTaW1pbGFyKTsKICAgICAgYmFubmVyLmNsYXNzTGlzdC50b2dnbGUoJ25vLXNpbWlsYXInLCAhaXNTaW1pbGFyKTsKICAgIH0KICAgIGNvbnN0IHN1YiA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJyNzdGF0dXMtYmFubmVyIC5zLXN1YicpOwogICAgaWYgKHN1YikgewogICAgICBzdWIudGV4dENvbnRlbnQgPSBpc1NpbWlsYXIKICAgICAgICA/ICdMYSBicmVjaGEgZXN0w6EgZGVudHJvIGRlbCB1bWJyYWwg4oCUIGxvcyBwcmVjaW9zIHNvbiBjb21wYXJhYmxlcycKICAgICAgICA6ICdMYSBicmVjaGEgc3VwZXJhIGVsIHVtYnJhbCDigJQgbG9zIHByZWNpb3Mgbm8gc29uIGNvbXBhcmFibGVzJzsKICAgIH0KICAgIGNvbnN0IGlzT3BlbiA9IGRhdGE/Lm1hcmtldCAmJiB0eXBlb2YgZGF0YS5tYXJrZXQuaXNPcGVuID09PSAnYm9vbGVhbicgPyBkYXRhLm1hcmtldC5pc09wZW4gOiBudWxsOwogICAgaWYgKGlzT3BlbiAhPT0gbnVsbCkgc2V0TWFya2V0VGFnKGlzT3Blbik7CiAgICBzdGF0ZS5sYXRlc3QubWVwID0gbWVwOwogICAgc3RhdGUubGF0ZXN0LmNjbCA9IGNjbDsKICAgIHN0YXRlLmxhdGVzdC5icmVjaGFBYnMgPSBhYnM7CiAgICBzdGF0ZS5sYXRlc3QuYnJlY2hhUGN0ID0gcGN0OwogIH0KCiAgZnVuY3Rpb24gaXNTaW1pbGFyUm93KHJvdykgewogICAgY29uc3QgYWJzID0gcm93LmFic19kaWZmICE9IG51bGwgPyByb3cuYWJzX2RpZmYgOiBNYXRoLmFicyhyb3cubWVwIC0gcm93LmNjbCk7CiAgICBjb25zdCBwY3QgPSByb3cucGN0X2RpZmYgIT0gbnVsbCA/IHJvdy5wY3RfZGlmZiA6IGNhbGNCcmVjaGFQY3Qocm93Lm1lcCwgcm93LmNjbCk7CiAgICByZXR1cm4gKE51bWJlci5pc0Zpbml0ZShwY3QpICYmIHBjdCA8PSBTSU1JTEFSX1BDVF9USFJFU0hPTEQpIHx8IChOdW1iZXIuaXNGaW5pdGUoYWJzKSAmJiBhYnMgPD0gU0lNSUxBUl9BUlNfVEhSRVNIT0xEKTsKICB9CgogIGZ1bmN0aW9uIGZpbHRlckRlc2NyaXB0b3IobW9kZSA9IHN0YXRlLmZpbHRlck1vZGUpIHsKICAgIGlmIChtb2RlID09PSAnMW0nKSByZXR1cm4gJzEgTWVzJzsKICAgIGlmIChtb2RlID09PSAnMXcnKSByZXR1cm4gJzEgU2VtYW5hJzsKICAgIHJldHVybiAnMSBEw61hJzsKICB9CgogIGZ1bmN0aW9uIHJlbmRlck1ldHJpY3MyNGgocGF5bG9hZCkgewogICAgY29uc3QgZmlsdGVyZWQgPSBmaWx0ZXJIaXN0b3J5Um93cyhleHRyYWN0SGlzdG9yeVJvd3MocGF5bG9hZCksIHN0YXRlLmZpbHRlck1vZGUpOwogICAgY29uc3QgcGN0VmFsdWVzID0gZmlsdGVyZWQubWFwKChyKSA9PiAoci5wY3RfZGlmZiAhPSBudWxsID8gci5wY3RfZGlmZiA6IGNhbGNCcmVjaGFQY3Qoci5tZXAsIHIuY2NsKSkpLmZpbHRlcigodikgPT4gTnVtYmVyLmlzRmluaXRlKHYpKTsKICAgIGNvbnN0IHNpbWlsYXJDb3VudCA9IGZpbHRlcmVkLmZpbHRlcigocikgPT4gaXNTaW1pbGFyUm93KHIpKS5sZW5ndGg7CiAgICBjb25zdCBkZXNjcmlwdG9yID0gZmlsdGVyRGVzY3JpcHRvcigpOwoKICAgIHNldFRleHQoJ21ldHJpYy1jb3VudC1sYWJlbCcsIGBNdWVzdHJhcyAke2Rlc2NyaXB0b3J9YCk7CiAgICBzZXRUZXh0KCdtZXRyaWMtY291bnQtMjRoJywgU3RyaW5nKGZpbHRlcmVkLmxlbmd0aCksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtY291bnQtc3ViJywgJ3JlZ2lzdHJvcyBkZWwgcGVyw61vZG8gZmlsdHJhZG8nKTsKICAgIHNldFRleHQoJ21ldHJpYy1zaW1pbGFyLWxhYmVsJywgYFZlY2VzIHNpbWlsYXIgKCR7ZGVzY3JpcHRvcn0pYCk7CiAgICBzZXRUZXh0KCdtZXRyaWMtc2ltaWxhci0yNGgnLCBTdHJpbmcoc2ltaWxhckNvdW50KSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ21ldHJpYy1zaW1pbGFyLXN1YicsICdtb21lbnRvcyBlbiB6b25hIOKJpDElIG8g4omkJDEwJyk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWluLWxhYmVsJywgYEJyZWNoYSBtw61uLiAoJHtkZXNjcmlwdG9yfSlgKTsKICAgIHNldFRleHQoJ21ldHJpYy1taW4tMjRoJywgcGN0VmFsdWVzLmxlbmd0aCA/IGZvcm1hdFBlcmNlbnQoTWF0aC5taW4oLi4ucGN0VmFsdWVzKSwgMikgOiAn4oCUJywgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ21ldHJpYy1taW4tc3ViJywgJ23DrW5pbWEgZGVsIHBlcsOtb2RvIGZpbHRyYWRvJyk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWF4LWxhYmVsJywgYEJyZWNoYSBtw6F4LiAoJHtkZXNjcmlwdG9yfSlgKTsKICAgIHNldFRleHQoJ21ldHJpYy1tYXgtMjRoJywgcGN0VmFsdWVzLmxlbmd0aCA/IGZvcm1hdFBlcmNlbnQoTWF0aC5tYXgoLi4ucGN0VmFsdWVzKSwgMikgOiAn4oCUJywgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ21ldHJpYy1tYXgtc3ViJywgJ23DoXhpbWEgZGVsIHBlcsOtb2RvIGZpbHRyYWRvJyk7CiAgICBzZXRUZXh0KCd0cmVuZC10aXRsZScsIGBUZW5kZW5jaWEgTUVQL0NDTCDigJQgJHtkZXNjcmlwdG9yfWApOwogIH0KCiAgZnVuY3Rpb24gcm93SG91ckxhYmVsKGVwb2NoKSB7CiAgICBjb25zdCBuID0gdG9OdW1iZXIoZXBvY2gpOwogICAgaWYgKG4gPT09IG51bGwpIHJldHVybiAn4oCUJzsKICAgIHJldHVybiBmbXRBcmdIb3VyLmZvcm1hdChuZXcgRGF0ZShuICogMTAwMCkpOwogIH0KICBmdW5jdGlvbiByb3dEYXlIb3VyTGFiZWwoZXBvY2gpIHsKICAgIGNvbnN0IG4gPSB0b051bWJlcihlcG9jaCk7CiAgICBpZiAobiA9PT0gbnVsbCkgcmV0dXJuICfigJQnOwogICAgY29uc3QgZGF0ZSA9IG5ldyBEYXRlKG4gKiAxMDAwKTsKICAgIHJldHVybiBgJHtmbXRBcmdEYXlNb250aC5mb3JtYXQoZGF0ZSl9ICR7Zm10QXJnSG91ci5mb3JtYXQoZGF0ZSl9YDsKICB9CiAgZnVuY3Rpb24gYXJ0RGF0ZUtleShlcG9jaCkgewogICAgY29uc3QgbiA9IHRvTnVtYmVyKGVwb2NoKTsKICAgIGlmIChuID09PSBudWxsKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiBmbXRBcmdEYXRlLmZvcm1hdChuZXcgRGF0ZShuICogMTAwMCkpOwogIH0KICBmdW5jdGlvbiBhcnRXZWVrZGF5KGVwb2NoKSB7CiAgICBjb25zdCBuID0gdG9OdW1iZXIoZXBvY2gpOwogICAgaWYgKG4gPT09IG51bGwpIHJldHVybiBudWxsOwogICAgcmV0dXJuIGZtdEFyZ1dlZWtkYXkuZm9ybWF0KG5ldyBEYXRlKG4gKiAxMDAwKSk7CiAgfQogIGZ1bmN0aW9uIGV4dHJhY3RIaXN0b3J5Um93cyhwYXlsb2FkKSB7CiAgICBjb25zdCBkYXRhID0gZXh0cmFjdFJvb3QocGF5bG9hZCk7CiAgICBjb25zdCByb3dzID0gQXJyYXkuaXNBcnJheShkYXRhLmhpc3RvcnkpID8gZGF0YS5oaXN0b3J5LnNsaWNlKCkgOiBbXTsKICAgIHJldHVybiByb3dzCiAgICAgIC5tYXAoKHIpID0+ICh7CiAgICAgICAgZXBvY2g6IHRvTnVtYmVyKHIuZXBvY2gpLAogICAgICAgIG1lcDogdG9OdW1iZXIoci5tZXApLAogICAgICAgIGNjbDogdG9OdW1iZXIoci5jY2wpLAogICAgICAgIGFic19kaWZmOiB0b051bWJlcihyLmFic19kaWZmKSwKICAgICAgICBwY3RfZGlmZjogdG9OdW1iZXIoci5wY3RfZGlmZiksCiAgICAgICAgc2ltaWxhcjogQm9vbGVhbihyLnNpbWlsYXIpCiAgICAgIH0pKQogICAgICAuZmlsdGVyKChyKSA9PiByLmVwb2NoICE9IG51bGwgJiYgci5tZXAgIT0gbnVsbCAmJiByLmNjbCAhPSBudWxsKQogICAgICAuc29ydCgoYSwgYikgPT4gYS5lcG9jaCAtIGIuZXBvY2gpOwogIH0KICBmdW5jdGlvbiBmaWx0ZXJIaXN0b3J5Um93cyhyb3dzLCBtb2RlKSB7CiAgICBpZiAoIXJvd3MubGVuZ3RoKSByZXR1cm4gW107CiAgICBjb25zdCBsYXRlc3RFcG9jaCA9IHJvd3Nbcm93cy5sZW5ndGggLSAxXS5lcG9jaDsKICAgIGlmIChtb2RlID09PSAnMW0nKSB7CiAgICAgIGNvbnN0IGN1dG9mZiA9IGxhdGVzdEVwb2NoIC0gKDMwICogMjQgKiAzNjAwKTsKICAgICAgcmV0dXJuIHJvd3MuZmlsdGVyKChyKSA9PiByLmVwb2NoID49IGN1dG9mZik7CiAgICB9CiAgICBpZiAobW9kZSA9PT0gJzF3JykgewogICAgICBjb25zdCBhbGxvd2VkRGF5cyA9IG5ldyBTZXQoKTsKICAgICAgZm9yIChsZXQgaSA9IHJvd3MubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHsKICAgICAgICBjb25zdCBkYXkgPSBhcnREYXRlS2V5KHJvd3NbaV0uZXBvY2gpOwogICAgICAgIGNvbnN0IHdkID0gYXJ0V2Vla2RheShyb3dzW2ldLmVwb2NoKTsKICAgICAgICBpZiAoIWRheSB8fCB3ZCA9PT0gJ1NhdCcgfHwgd2QgPT09ICdTdW4nKSBjb250aW51ZTsKICAgICAgICBhbGxvd2VkRGF5cy5hZGQoZGF5KTsKICAgICAgICBpZiAoYWxsb3dlZERheXMuc2l6ZSA+PSA1KSBicmVhazsKICAgICAgfQogICAgICByZXR1cm4gcm93cy5maWx0ZXIoKHIpID0+IHsKICAgICAgICBjb25zdCBkYXkgPSBhcnREYXRlS2V5KHIuZXBvY2gpOwogICAgICAgIHJldHVybiBkYXkgJiYgYWxsb3dlZERheXMuaGFzKGRheSk7CiAgICAgIH0pOwogICAgfQogICAgY29uc3QgY3V0b2ZmID0gbGF0ZXN0RXBvY2ggLSAoMjQgKiAzNjAwKTsKICAgIHJldHVybiByb3dzLmZpbHRlcigocikgPT4gci5lcG9jaCA+PSBjdXRvZmYpOwogIH0KICBmdW5jdGlvbiBkb3duc2FtcGxlUm93cyhyb3dzLCBtYXhQb2ludHMpIHsKICAgIGlmIChyb3dzLmxlbmd0aCA8PSBtYXhQb2ludHMpIHJldHVybiByb3dzOwogICAgY29uc3Qgb3V0ID0gW107CiAgICBjb25zdCBzdGVwID0gKHJvd3MubGVuZ3RoIC0gMSkgLyAobWF4UG9pbnRzIC0gMSk7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1heFBvaW50czsgaSsrKSB7CiAgICAgIG91dC5wdXNoKHJvd3NbTWF0aC5yb3VuZChpICogc3RlcCldKTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQogIGZ1bmN0aW9uIGN1cnJlbnRGaWx0ZXJMYWJlbCgpIHsKICAgIGlmIChzdGF0ZS5maWx0ZXJNb2RlID09PSAnMW0nKSByZXR1cm4gJzEgTWVzJzsKICAgIGlmIChzdGF0ZS5maWx0ZXJNb2RlID09PSAnMXcnKSByZXR1cm4gJzEgU2VtYW5hJzsKICAgIHJldHVybiAnMSBEw61hJzsKICB9CiAgZnVuY3Rpb24gZ2V0RmlsdGVyZWRIaXN0b3J5Um93cyhwYXlsb2FkID0gc3RhdGUubGFzdE1lcFBheWxvYWQpIHsKICAgIGlmICghcGF5bG9hZCkgcmV0dXJuIFtdOwogICAgcmV0dXJuIGZpbHRlckhpc3RvcnlSb3dzKGV4dHJhY3RIaXN0b3J5Um93cyhwYXlsb2FkKSwgc3RhdGUuZmlsdGVyTW9kZSk7CiAgfQogIGZ1bmN0aW9uIGNzdkVzY2FwZSh2YWx1ZSkgewogICAgY29uc3QgdiA9IFN0cmluZyh2YWx1ZSA/PyAnJyk7CiAgICByZXR1cm4gYCIke3YucmVwbGFjZSgvIi9nLCAnIiInKX0iYDsKICB9CiAgZnVuY3Rpb24gY3N2TnVtYmVyKHZhbHVlLCBkaWdpdHMgPSAyKSB7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpIHJldHVybiAn4oCUJzsKICAgIHJldHVybiB2YWx1ZS50b0ZpeGVkKGRpZ2l0cykucmVwbGFjZSgnLicsICcsJyk7CiAgfQogIGZ1bmN0aW9uIGZpbHRlckNvZGUoKSB7CiAgICBpZiAoc3RhdGUuZmlsdGVyTW9kZSA9PT0gJzFtJykgcmV0dXJuICcxbSc7CiAgICBpZiAoc3RhdGUuZmlsdGVyTW9kZSA9PT0gJzF3JykgcmV0dXJuICcxdyc7CiAgICByZXR1cm4gJzFkJzsKICB9CiAgZnVuY3Rpb24gZG93bmxvYWRIaXN0b3J5Q3N2KCkgewogICAgY29uc3QgZmlsdGVyZWQgPSBnZXRGaWx0ZXJlZEhpc3RvcnlSb3dzKCk7CiAgICBpZiAoIWZpbHRlcmVkLmxlbmd0aCkgewogICAgICBzZXRGcmVzaEJhZGdlKCdTaW4gZGF0b3MgcGFyYSBleHBvcnRhciBlbiBlbCBmaWx0cm8gYWN0aXZvJywgJ2lkbGUnKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc3QgaGVhZGVyID0gWydmZWNoYScsICdob3JhJywgJ21lcCcsICdjY2wnLCAnZGlmX2FicycsICdkaWZfcGN0JywgJ2VzdGFkbyddOwogICAgY29uc3Qgcm93cyA9IGZpbHRlcmVkLm1hcCgocikgPT4gewogICAgICBjb25zdCBkYXRlID0gbmV3IERhdGUoci5lcG9jaCAqIDEwMDApOwogICAgICBjb25zdCBtZXAgPSB0b051bWJlcihyLm1lcCk7CiAgICAgIGNvbnN0IGNjbCA9IHRvTnVtYmVyKHIuY2NsKTsKICAgICAgY29uc3QgYWJzID0gdG9OdW1iZXIoci5hYnNfZGlmZik7CiAgICAgIGNvbnN0IHBjdCA9IHRvTnVtYmVyKHIucGN0X2RpZmYpOwogICAgICBjb25zdCBlc3RhZG8gPSBCb29sZWFuKHIuc2ltaWxhcikgPyAnU0lNSUxBUicgOiAnTk8gU0lNSUxBUic7CiAgICAgIHJldHVybiBbCiAgICAgICAgZm10QXJnRGF5TW9udGguZm9ybWF0KGRhdGUpLAogICAgICAgIGZtdEFyZ0hvdXIuZm9ybWF0KGRhdGUpLAogICAgICAgIGNzdk51bWJlcihtZXAsIDIpLAogICAgICAgIGNzdk51bWJlcihjY2wsIDIpLAogICAgICAgIGNzdk51bWJlcihhYnMsIDIpLAogICAgICAgIGNzdk51bWJlcihwY3QsIDIpLAogICAgICAgIGVzdGFkbwogICAgICBdLm1hcChjc3ZFc2NhcGUpLmpvaW4oJzsnKTsKICAgIH0pOwogICAgY29uc3QgYXJ0RGF0ZSA9IGZtdEFyZ0RhdGUuZm9ybWF0KG5ldyBEYXRlKCkpOwogICAgY29uc3QgZmlsZW5hbWUgPSBgaGlzdG9yaWFsLW1lcC1jY2wtJHtmaWx0ZXJDb2RlKCl9LSR7YXJ0RGF0ZX0uY3N2YDsKICAgIGNvbnN0IGNzdiA9ICdcdUZFRkYnICsgW2hlYWRlci5qb2luKCc7JyksIC4uLnJvd3NdLmpvaW4oJ1xuJyk7CiAgICBjb25zdCBibG9iID0gbmV3IEJsb2IoW2Nzdl0sIHsgdHlwZTogJ3RleHQvY3N2O2NoYXJzZXQ9dXRmLTg7JyB9KTsKICAgIGNvbnN0IHVybCA9IFVSTC5jcmVhdGVPYmplY3RVUkwoYmxvYik7CiAgICBjb25zdCBhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYScpOwogICAgYS5ocmVmID0gdXJsOwogICAgYS5kb3dubG9hZCA9IGZpbGVuYW1lOwogICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChhKTsKICAgIGEuY2xpY2soKTsKICAgIGEucmVtb3ZlKCk7CiAgICBVUkwucmV2b2tlT2JqZWN0VVJMKHVybCk7CiAgfQogIGZ1bmN0aW9uIGFwcGx5RmlsdGVyKG1vZGUpIHsKICAgIHN0YXRlLmZpbHRlck1vZGUgPSBtb2RlOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnBpbGxbZGF0YS1maWx0ZXJdJykuZm9yRWFjaCgoYnRuKSA9PiB7CiAgICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKCdvbicsIGJ0bi5kYXRhc2V0LmZpbHRlciA9PT0gbW9kZSk7CiAgICB9KTsKICAgIGlmIChzdGF0ZS5sYXN0TWVwUGF5bG9hZCkgewogICAgICByZW5kZXJUcmVuZChzdGF0ZS5sYXN0TWVwUGF5bG9hZCk7CiAgICAgIHJlbmRlckhpc3Rvcnkoc3RhdGUubGFzdE1lcFBheWxvYWQpOwogICAgICByZW5kZXJNZXRyaWNzMjRoKHN0YXRlLmxhc3RNZXBQYXlsb2FkKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHJlbmRlckhpc3RvcnkocGF5bG9hZCkgewogICAgY29uc3QgdGJvZHkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGlzdG9yeS1yb3dzJyk7CiAgICBjb25zdCBjYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGlzdG9yeS1jYXAnKTsKICAgIGlmICghdGJvZHkpIHJldHVybjsKICAgIGNvbnN0IGZpbHRlcmVkID0gZ2V0RmlsdGVyZWRIaXN0b3J5Um93cyhwYXlsb2FkKTsKICAgIGNvbnN0IHJvd3MgPSBmaWx0ZXJlZC5zbGljZSgpLnJldmVyc2UoKTsKICAgIGlmIChjYXApIGNhcC50ZXh0Q29udGVudCA9IGAke2N1cnJlbnRGaWx0ZXJMYWJlbCgpfSDCtyAke3Jvd3MubGVuZ3RofSByZWdpc3Ryb3NgOwogICAgaWYgKCFyb3dzLmxlbmd0aCkgewogICAgICB0Ym9keS5pbm5lckhUTUwgPSAnPHRyPjx0ZCBjbGFzcz0iZGltIiBjb2xzcGFuPSI2Ij5TaW4gcmVnaXN0cm9zIHRvZGF2w61hPC90ZD48L3RyPic7CiAgICAgIHJldHVybjsKICAgIH0KICAgIHRib2R5LmlubmVySFRNTCA9IHJvd3MubWFwKChyKSA9PiB7CiAgICAgIGNvbnN0IG1lcCA9IHRvTnVtYmVyKHIubWVwKTsKICAgICAgY29uc3QgY2NsID0gdG9OdW1iZXIoci5jY2wpOwogICAgICBjb25zdCBhYnMgPSB0b051bWJlcihyLmFic19kaWZmKTsKICAgICAgY29uc3QgcGN0ID0gdG9OdW1iZXIoci5wY3RfZGlmZik7CiAgICAgIGNvbnN0IHNpbSA9IEJvb2xlYW4oci5zaW1pbGFyKTsKICAgICAgcmV0dXJuIGA8dHI+CiAgICAgICAgPHRkIGNsYXNzPSJkaW0iPjxkaXYgY2xhc3M9InRzLWRheSI+JHtmbXRBcmdEYXlNb250aC5mb3JtYXQobmV3IERhdGUoci5lcG9jaCAqIDEwMDApKX08L2Rpdj48ZGl2IGNsYXNzPSJ0cy1ob3VyIj4ke3Jvd0hvdXJMYWJlbChyLmVwb2NoKX08L2Rpdj48L3RkPgogICAgICAgIDx0ZCBzdHlsZT0iY29sb3I6dmFyKC0tbWVwKSI+JHtmb3JtYXRNb25leShtZXAsIDIpfTwvdGQ+CiAgICAgICAgPHRkIHN0eWxlPSJjb2xvcjp2YXIoLS1jY2wpIj4ke2Zvcm1hdE1vbmV5KGNjbCwgMil9PC90ZD4KICAgICAgICA8dGQ+JHtmb3JtYXRNb25leShhYnMsIDIpfTwvdGQ+CiAgICAgICAgPHRkPiR7Zm9ybWF0UGVyY2VudChwY3QsIDIpfTwvdGQ+CiAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJzYmFkZ2UgJHtzaW0gPyAnc2ltJyA6ICdub3NpbSd9Ij4ke3NpbSA/ICdTaW1pbGFyJyA6ICdObyBzaW1pbGFyJ308L3NwYW4+PC90ZD4KICAgICAgPC90cj5gOwogICAgfSkuam9pbignJyk7CiAgfQoKICBmdW5jdGlvbiBsaW5lUG9pbnRzKHZhbHVlcywgeDAsIHgxLCB5MCwgeTEsIG1pblZhbHVlLCBtYXhWYWx1ZSkgewogICAgaWYgKCF2YWx1ZXMubGVuZ3RoKSByZXR1cm4gJyc7CiAgICBjb25zdCBtaW4gPSBOdW1iZXIuaXNGaW5pdGUobWluVmFsdWUpID8gbWluVmFsdWUgOiBNYXRoLm1pbiguLi52YWx1ZXMpOwogICAgY29uc3QgbWF4ID0gTnVtYmVyLmlzRmluaXRlKG1heFZhbHVlKSA/IG1heFZhbHVlIDogTWF0aC5tYXgoLi4udmFsdWVzKTsKICAgIGNvbnN0IHNwYW4gPSBNYXRoLm1heCgwLjAwMDAwMSwgbWF4IC0gbWluKTsKICAgIHJldHVybiB2YWx1ZXMubWFwKCh2LCBpKSA9PiB7CiAgICAgIGNvbnN0IHggPSB4MCArICgoeDEgLSB4MCkgKiBpIC8gTWF0aC5tYXgoMSwgdmFsdWVzLmxlbmd0aCAtIDEpKTsKICAgICAgY29uc3QgeSA9IHkxIC0gKCh2IC0gbWluKSAvIHNwYW4pICogKHkxIC0geTApOwogICAgICByZXR1cm4gYCR7eC50b0ZpeGVkKDIpfSwke3kudG9GaXhlZCgyKX1gOwogICAgfSkuam9pbignICcpOwogIH0KICBmdW5jdGlvbiB2YWx1ZVRvWSh2YWx1ZSwgeTAsIHkxLCBtaW5WYWx1ZSwgbWF4VmFsdWUpIHsKICAgIGNvbnN0IHNwYW4gPSBNYXRoLm1heCgwLjAwMDAwMSwgbWF4VmFsdWUgLSBtaW5WYWx1ZSk7CiAgICByZXR1cm4geTEgLSAoKHZhbHVlIC0gbWluVmFsdWUpIC8gc3BhbikgKiAoeTEgLSB5MCk7CiAgfQogIGZ1bmN0aW9uIGNhbGNCcmVjaGFQY3QobWVwLCBjY2wpIHsKICAgIGlmICghTnVtYmVyLmlzRmluaXRlKG1lcCkgfHwgIU51bWJlci5pc0Zpbml0ZShjY2wpKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGF2ZyA9IChtZXAgKyBjY2wpIC8gMjsKICAgIGlmICghYXZnKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiAoTWF0aC5hYnMobWVwIC0gY2NsKSAvIGF2ZykgKiAxMDA7CiAgfQogIGZ1bmN0aW9uIGhpZGVUcmVuZEhvdmVyKCkgewogICAgY29uc3QgdGlwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLXRvb2x0aXAnKTsKICAgIGNvbnN0IGxpbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItbGluZScpOwogICAgY29uc3QgbWVwRG90ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLW1lcCcpOwogICAgY29uc3QgY2NsRG90ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLWNjbCcpOwogICAgaWYgKHRpcCkgdGlwLnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcwJyk7CiAgICBpZiAobGluZSkgbGluZS5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMCcpOwogICAgaWYgKG1lcERvdCkgbWVwRG90LnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcwJyk7CiAgICBpZiAoY2NsRG90KSBjY2xEb3Quc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzAnKTsKICB9CiAgZnVuY3Rpb24gcmVuZGVyVHJlbmRIb3Zlcihwb2ludCkgewogICAgY29uc3QgdGlwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLXRvb2x0aXAnKTsKICAgIGNvbnN0IGJnID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLXRvb2x0aXAtYmcnKTsKICAgIGNvbnN0IGxpbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItbGluZScpOwogICAgY29uc3QgbWVwRG90ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLW1lcCcpOwogICAgY29uc3QgY2NsRG90ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLWNjbCcpOwogICAgaWYgKCF0aXAgfHwgIWJnIHx8ICFsaW5lIHx8ICFtZXBEb3QgfHwgIWNjbERvdCB8fCAhcG9pbnQpIHJldHVybjsKCiAgICBsaW5lLnNldEF0dHJpYnV0ZSgneDEnLCBwb2ludC54LnRvRml4ZWQoMikpOwogICAgbGluZS5zZXRBdHRyaWJ1dGUoJ3gyJywgcG9pbnQueC50b0ZpeGVkKDIpKTsKICAgIGxpbmUuc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzEnKTsKICAgIG1lcERvdC5zZXRBdHRyaWJ1dGUoJ2N4JywgcG9pbnQueC50b0ZpeGVkKDIpKTsKICAgIG1lcERvdC5zZXRBdHRyaWJ1dGUoJ2N5JywgcG9pbnQubWVwWS50b0ZpeGVkKDIpKTsKICAgIG1lcERvdC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMScpOwogICAgY2NsRG90LnNldEF0dHJpYnV0ZSgnY3gnLCBwb2ludC54LnRvRml4ZWQoMikpOwogICAgY2NsRG90LnNldEF0dHJpYnV0ZSgnY3knLCBwb2ludC5jY2xZLnRvRml4ZWQoMikpOwogICAgY2NsRG90LnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcxJyk7CgogICAgc2V0VGV4dCgndHJlbmQtdGlwLXRpbWUnLCByb3dEYXlIb3VyTGFiZWwocG9pbnQuZXBvY2gpKTsKICAgIHNldFRleHQoJ3RyZW5kLXRpcC1tZXAnLCBgTUVQICR7Zm9ybWF0TW9uZXkocG9pbnQubWVwLCAyKX1gKTsKICAgIHNldFRleHQoJ3RyZW5kLXRpcC1jY2wnLCBgQ0NMICR7Zm9ybWF0TW9uZXkocG9pbnQuY2NsLCAyKX1gKTsKICAgIHNldFRleHQoJ3RyZW5kLXRpcC1nYXAnLCBgQnJlY2hhICR7Zm9ybWF0UGVyY2VudChwb2ludC5wY3QsIDIpfWApOwoKICAgIGNvbnN0IHRpcFcgPSAxNDg7CiAgICBjb25zdCB0aXBIID0gNTY7CiAgICBjb25zdCB0aXBYID0gTWF0aC5taW4oODQwIC0gdGlwVywgTWF0aC5tYXgoMzAsIHBvaW50LnggKyAxMCkpOwogICAgY29uc3QgdGlwWSA9IE1hdGgubWluKDEwMCwgTWF0aC5tYXgoMTgsIE1hdGgubWluKHBvaW50Lm1lcFksIHBvaW50LmNjbFkpIC0gdGlwSCAtIDQpKTsKICAgIHRpcC5zZXRBdHRyaWJ1dGUoJ3RyYW5zZm9ybScsIGB0cmFuc2xhdGUoJHt0aXBYLnRvRml4ZWQoMil9ICR7dGlwWS50b0ZpeGVkKDIpfSlgKTsKICAgIGJnLnNldEF0dHJpYnV0ZSgnd2lkdGgnLCBTdHJpbmcodGlwVykpOwogICAgYmcuc2V0QXR0cmlidXRlKCdoZWlnaHQnLCBTdHJpbmcodGlwSCkpOwogICAgdGlwLnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcxJyk7CiAgfQogIGZ1bmN0aW9uIGJpbmRUcmVuZEhvdmVyKCkgewogICAgaWYgKHN0YXRlLnRyZW5kSG92ZXJCb3VuZCkgcmV0dXJuOwogICAgY29uc3QgY2hhcnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtY2hhcnQnKTsKICAgIGlmICghY2hhcnQpIHJldHVybjsKICAgIHN0YXRlLnRyZW5kSG92ZXJCb3VuZCA9IHRydWU7CgogICAgY2hhcnQuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VsZWF2ZScsICgpID0+IGhpZGVUcmVuZEhvdmVyKCkpOwogICAgY2hhcnQuYWRkRXZlbnRMaXN0ZW5lcignbW91c2Vtb3ZlJywgKGV2ZW50KSA9PiB7CiAgICAgIGlmICghc3RhdGUudHJlbmRSb3dzLmxlbmd0aCkgcmV0dXJuOwogICAgICBjb25zdCBjdG0gPSBjaGFydC5nZXRTY3JlZW5DVE0oKTsKICAgICAgaWYgKCFjdG0pIHJldHVybjsKICAgICAgY29uc3QgcHQgPSBjaGFydC5jcmVhdGVTVkdQb2ludCgpOwogICAgICBwdC54ID0gZXZlbnQuY2xpZW50WDsKICAgICAgcHQueSA9IGV2ZW50LmNsaWVudFk7CiAgICAgIGNvbnN0IGxvY2FsID0gcHQubWF0cml4VHJhbnNmb3JtKGN0bS5pbnZlcnNlKCkpOwogICAgICBjb25zdCB4ID0gTWF0aC5tYXgoMzAsIE1hdGgubWluKDg0MCwgbG9jYWwueCkpOwogICAgICBsZXQgbmVhcmVzdCA9IHN0YXRlLnRyZW5kUm93c1swXTsKICAgICAgbGV0IGJlc3QgPSBNYXRoLmFicyhuZWFyZXN0LnggLSB4KTsKICAgICAgZm9yIChsZXQgaSA9IDE7IGkgPCBzdGF0ZS50cmVuZFJvd3MubGVuZ3RoOyBpKyspIHsKICAgICAgICBjb25zdCBkID0gTWF0aC5hYnMoc3RhdGUudHJlbmRSb3dzW2ldLnggLSB4KTsKICAgICAgICBpZiAoZCA8IGJlc3QpIHsKICAgICAgICAgIGJlc3QgPSBkOwogICAgICAgICAgbmVhcmVzdCA9IHN0YXRlLnRyZW5kUm93c1tpXTsKICAgICAgICB9CiAgICAgIH0KICAgICAgcmVuZGVyVHJlbmRIb3ZlcihuZWFyZXN0KTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyVHJlbmQocGF5bG9hZCkgewogICAgY29uc3QgaGlzdG9yeSA9IGRvd25zYW1wbGVSb3dzKGZpbHRlckhpc3RvcnlSb3dzKGV4dHJhY3RIaXN0b3J5Um93cyhwYXlsb2FkKSwgc3RhdGUuZmlsdGVyTW9kZSksIFRSRU5EX01BWF9QT0lOVFMpOwogICAgY29uc3QgbWVwTGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1tZXAtbGluZScpOwogICAgY29uc3QgY2NsTGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1jY2wtbGluZScpOwogICAgaWYgKCFtZXBMaW5lIHx8ICFjY2xMaW5lKSByZXR1cm47CiAgICBiaW5kVHJlbmRIb3ZlcigpOwogICAgaWYgKCFoaXN0b3J5Lmxlbmd0aCkgewogICAgICBtZXBMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgJycpOwogICAgICBjY2xMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgJycpOwogICAgICBzdGF0ZS50cmVuZFJvd3MgPSBbXTsKICAgICAgaGlkZVRyZW5kSG92ZXIoKTsKICAgICAgWyd0cmVuZC15LXRvcCcsICd0cmVuZC15LW1pZCcsICd0cmVuZC15LWxvdycsICd0cmVuZC14LTEnLCAndHJlbmQteC0yJywgJ3RyZW5kLXgtMycsICd0cmVuZC14LTQnLCAndHJlbmQteC01J10uZm9yRWFjaCgoaWQpID0+IHNldFRleHQoaWQsICfigJQnKSk7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICBjb25zdCByb3dzID0gaGlzdG9yeQogICAgICAubWFwKChyKSA9PiAoewogICAgICAgIGVwb2NoOiByLmVwb2NoLAogICAgICAgIG1lcDogdG9OdW1iZXIoci5tZXApLAogICAgICAgIGNjbDogdG9OdW1iZXIoci5jY2wpLAogICAgICAgIHBjdDogdG9OdW1iZXIoci5wY3RfZGlmZikKICAgICAgfSkpCiAgICAgIC5maWx0ZXIoKHIpID0+IHIubWVwICE9IG51bGwgJiYgci5jY2wgIT0gbnVsbCk7CiAgICBpZiAoIXJvd3MubGVuZ3RoKSByZXR1cm47CgogICAgY29uc3QgbWVwVmFscyA9IHJvd3MubWFwKChyKSA9PiByLm1lcCk7CiAgICBjb25zdCBjY2xWYWxzID0gcm93cy5tYXAoKHIpID0+IHIuY2NsKTsKCiAgICAvLyBFc2NhbGEgY29tcGFydGlkYSBwYXJhIE1FUCB5IENDTDogY29tcGFyYWNpw7NuIHZpc3VhbCBmaWVsLgogICAgY29uc3QgYWxsUHJpY2VWYWxzID0gbWVwVmFscy5jb25jYXQoY2NsVmFscyk7CiAgICBjb25zdCByYXdNaW4gPSBNYXRoLm1pbiguLi5hbGxQcmljZVZhbHMpOwogICAgY29uc3QgcmF3TWF4ID0gTWF0aC5tYXgoLi4uYWxsUHJpY2VWYWxzKTsKICAgIGNvbnN0IHByaWNlUGFkID0gTWF0aC5tYXgoMSwgKHJhd01heCAtIHJhd01pbikgKiAwLjA4KTsKICAgIGNvbnN0IHByaWNlTWluID0gcmF3TWluIC0gcHJpY2VQYWQ7CiAgICBjb25zdCBwcmljZU1heCA9IHJhd01heCArIHByaWNlUGFkOwoKICAgIG1lcExpbmUuc2V0QXR0cmlidXRlKCdwb2ludHMnLCBsaW5lUG9pbnRzKG1lcFZhbHMsIDMwLCA4NDAsIDI1LCAxMzAsIHByaWNlTWluLCBwcmljZU1heCkpOwogICAgY2NsTGluZS5zZXRBdHRyaWJ1dGUoJ3BvaW50cycsIGxpbmVQb2ludHMoY2NsVmFscywgMzAsIDg0MCwgMjUsIDEzMCwgcHJpY2VNaW4sIHByaWNlTWF4KSk7CiAgICBzdGF0ZS50cmVuZFJvd3MgPSByb3dzLm1hcCgociwgaSkgPT4gewogICAgICBjb25zdCB4ID0gMzAgKyAoKDg0MCAtIDMwKSAqIGkgLyBNYXRoLm1heCgxLCByb3dzLmxlbmd0aCAtIDEpKTsKICAgICAgcmV0dXJuIHsKICAgICAgICBlcG9jaDogci5lcG9jaCwKICAgICAgICBtZXA6IHIubWVwLAogICAgICAgIGNjbDogci5jY2wsCiAgICAgICAgcGN0OiBjYWxjQnJlY2hhUGN0KHIubWVwLCByLmNjbCksCiAgICAgICAgeCwKICAgICAgICBtZXBZOiB2YWx1ZVRvWShyLm1lcCwgMjUsIDEzMCwgcHJpY2VNaW4sIHByaWNlTWF4KSwKICAgICAgICBjY2xZOiB2YWx1ZVRvWShyLmNjbCwgMjUsIDEzMCwgcHJpY2VNaW4sIHByaWNlTWF4KQogICAgICB9OwogICAgfSk7CiAgICBoaWRlVHJlbmRIb3ZlcigpOwoKICAgIGNvbnN0IG1pZCA9IChwcmljZU1pbiArIHByaWNlTWF4KSAvIDI7CiAgICBzZXRUZXh0KCd0cmVuZC15LXRvcCcsIChwcmljZU1heCAvIDEwMDApLnRvRml4ZWQoMykpOwogICAgc2V0VGV4dCgndHJlbmQteS1taWQnLCAobWlkIC8gMTAwMCkudG9GaXhlZCgzKSk7CiAgICBzZXRUZXh0KCd0cmVuZC15LWxvdycsIChwcmljZU1pbiAvIDEwMDApLnRvRml4ZWQoMykpOwoKICAgIGNvbnN0IGlkeCA9IFswLCAwLjI1LCAwLjUsIDAuNzUsIDFdLm1hcCgocCkgPT4gTWF0aC5taW4ocm93cy5sZW5ndGggLSAxLCBNYXRoLmZsb29yKChyb3dzLmxlbmd0aCAtIDEpICogcCkpKTsKICAgIGNvbnN0IGxhYnMgPSBpZHgubWFwKChpKSA9PiByb3dEYXlIb3VyTGFiZWwocm93c1tpXT8uZXBvY2gpKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtMScsIGxhYnNbMF0gfHwgJ+KAlCcpOwogICAgc2V0VGV4dCgndHJlbmQteC0yJywgbGFic1sxXSB8fCAn4oCUJyk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTMnLCBsYWJzWzJdIHx8ICfigJQnKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtNCcsIGxhYnNbM10gfHwgJ+KAlCcpOwogICAgc2V0VGV4dCgndHJlbmQteC01JywgbGFic1s0XSB8fCAn4oCUJyk7CiAgfQoKICBmdW5jdGlvbiBnZXRGY2lUeXBlTGFiZWwodHlwZSkgewogICAgcmV0dXJuIHR5cGUgPT09ICd2YXJpYWJsZScgPyAnUmVudGEgdmFyaWFibGUgKEZDSSBBcmdlbnRpbmEpJyA6ICdSZW50YSBmaWphIChGQ0kgQXJnZW50aW5hKSc7CiAgfQoKICBmdW5jdGlvbiBzZXRGY2lUeXBlKHR5cGUpIHsKICAgIGNvbnN0IG5leHQgPSB0eXBlID09PSAndmFyaWFibGUnID8gJ3ZhcmlhYmxlJyA6ICdmaWphJzsKICAgIGlmIChzdGF0ZS5mY2lUeXBlID09PSBuZXh0KSByZXR1cm47CiAgICBzdGF0ZS5mY2lUeXBlID0gbmV4dDsKICAgIHN0YXRlLmZjaVBhZ2UgPSAxOwogICAgcmVuZGVyRmNpUmVudGFGaWphKCk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJGY2lSZW50YUZpamEocGF5bG9hZCwgcHJldmlvdXNQYXlsb2FkLCB0eXBlID0gc3RhdGUuZmNpVHlwZSwgYmFzZVBheWxvYWQpIHsKICAgIGNvbnN0IG5vcm1hbGl6ZWRUeXBlID0gdHlwZSA9PT0gJ3ZhcmlhYmxlJyA/ICd2YXJpYWJsZScgOiAnZmlqYSc7CiAgICBjb25zdCByb3dzRWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLXJvd3MnKTsKICAgIGNvbnN0IGVtcHR5RWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLWVtcHR5Jyk7CiAgICBpZiAoIXJvd3NFbCB8fCAhZW1wdHlFbCkgcmV0dXJuOwoKICAgIGNvbnN0IHRpdGxlRWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLXRpdGxlJyk7CiAgICBpZiAodGl0bGVFbCkgdGl0bGVFbC50ZXh0Q29udGVudCA9IGdldEZjaVR5cGVMYWJlbChzdGF0ZS5mY2lUeXBlKTsKICAgIGNvbnN0IHRhYkZpamEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLXRhYi1maWphJyk7CiAgICBjb25zdCB0YWJWYXJpYWJsZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktdGFiLXZhcmlhYmxlJyk7CiAgICBpZiAodGFiRmlqYSkgdGFiRmlqYS5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCBzdGF0ZS5mY2lUeXBlID09PSAnZmlqYScpOwogICAgaWYgKHRhYlZhcmlhYmxlKSB0YWJWYXJpYWJsZS5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCBzdGF0ZS5mY2lUeXBlID09PSAndmFyaWFibGUnKTsKCiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+IDEpIHsKICAgICAgY29uc3QgcHJldmlvdXNSb3dzID0gbm9ybWFsaXplRmNpUm93cyhwcmV2aW91c1BheWxvYWQpCiAgICAgICAgLm1hcCgoaXRlbSkgPT4gewogICAgICAgICAgY29uc3QgZm9uZG8gPSBTdHJpbmcoaXRlbT8uZm9uZG8gfHwgaXRlbT8ubm9tYnJlIHx8IGl0ZW0/LmZjaSB8fCAnJykudHJpbSgpOwogICAgICAgICAgcmV0dXJuIHsKICAgICAgICAgICAgZm9uZG8sCiAgICAgICAgICAgIHZjcDogdG9OdW1iZXIoaXRlbT8udmNwKSwKICAgICAgICAgICAgY2NwOiB0b051bWJlcihpdGVtPy5jY3ApLAogICAgICAgICAgICBwYXRyaW1vbmlvOiB0b051bWJlcihpdGVtPy5wYXRyaW1vbmlvKSwKICAgICAgICAgIH07CiAgICAgICAgfSkKICAgICAgICAuZmlsdGVyKChpdGVtKSA9PiBpdGVtLmZvbmRvKTsKICAgICAgY29uc3QgcHJldmlvdXNCeUZvbmRvID0gbmV3IE1hcCgpOwogICAgICBwcmV2aW91c1Jvd3MuZm9yRWFjaCgoaXRlbSkgPT4gewogICAgICAgIHByZXZpb3VzQnlGb25kby5zZXQobm9ybWFsaXplRmNpRm9uZG9LZXkoaXRlbS5mb25kbyksIGl0ZW0pOwogICAgICB9KTsKICAgICAgc3RhdGUuZmNpUHJldmlvdXNCeUZvbmRvQnlUeXBlW25vcm1hbGl6ZWRUeXBlXSA9IHByZXZpb3VzQnlGb25kbzsKICAgIH0KICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID4gMykgewogICAgICBjb25zdCBiYXNlUm93cyA9IG5vcm1hbGl6ZUZjaVJvd3MoYmFzZVBheWxvYWQpCiAgICAgICAgLm1hcCgoaXRlbSkgPT4gewogICAgICAgICAgY29uc3QgZm9uZG8gPSBTdHJpbmcoaXRlbT8uZm9uZG8gfHwgaXRlbT8ubm9tYnJlIHx8IGl0ZW0/LmZjaSB8fCAnJykudHJpbSgpOwogICAgICAgICAgcmV0dXJuIHsKICAgICAgICAgICAgZm9uZG8sCiAgICAgICAgICAgIHZjcDogdG9OdW1iZXIoaXRlbT8udmNwKQogICAgICAgICAgfTsKICAgICAgICB9KQogICAgICAgIC5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uZm9uZG8gJiYgaXRlbS52Y3AgIT09IG51bGwpOwogICAgICBjb25zdCBiYXNlQnlGb25kbyA9IG5ldyBNYXAoKTsKICAgICAgYmFzZVJvd3MuZm9yRWFjaCgoaXRlbSkgPT4gewogICAgICAgIGJhc2VCeUZvbmRvLnNldChub3JtYWxpemVGY2lGb25kb0tleShpdGVtLmZvbmRvKSwgaXRlbSk7CiAgICAgIH0pOwogICAgICBzdGF0ZS5mY2lCYXNlQnlGb25kb0J5VHlwZVtub3JtYWxpemVkVHlwZV0gPSBiYXNlQnlGb25kbzsKICAgIH0KICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID4gMCkgewogICAgICBjb25zdCByb3dzID0gbm9ybWFsaXplRmNpUm93cyhwYXlsb2FkKQogICAgICAgIC5tYXAoKGl0ZW0pID0+IHsKICAgICAgICAgIGNvbnN0IGZvbmRvID0gU3RyaW5nKGl0ZW0/LmZvbmRvIHx8IGl0ZW0/Lm5vbWJyZSB8fCBpdGVtPy5mY2kgfHwgJycpLnRyaW0oKTsKICAgICAgICAgIGNvbnN0IGZlY2hhID0gU3RyaW5nKGl0ZW0/LmZlY2hhIHx8ICcnKS50cmltKCk7CiAgICAgICAgICBjb25zdCB2Y3AgPSB0b051bWJlcihpdGVtPy52Y3ApOwogICAgICAgICAgY29uc3QgY2NwID0gdG9OdW1iZXIoaXRlbT8uY2NwKTsKICAgICAgICAgIGNvbnN0IHBhdHJpbW9uaW8gPSB0b051bWJlcihpdGVtPy5wYXRyaW1vbmlvKTsKICAgICAgICAgIGNvbnN0IGhvcml6b250ZSA9IFN0cmluZyhpdGVtPy5ob3Jpem9udGUgfHwgJycpLnRyaW0oKTsKICAgICAgICAgIGNvbnN0IGZvbmRvS2V5ID0gbm9ybWFsaXplRmNpRm9uZG9LZXkoZm9uZG8pOwogICAgICAgICAgY29uc3QgcHJldmlvdXMgPSBzdGF0ZS5mY2lQcmV2aW91c0J5Rm9uZG9CeVR5cGVbbm9ybWFsaXplZFR5cGVdLmdldChmb25kb0tleSk7CiAgICAgICAgICBjb25zdCBiYXNlID0gc3RhdGUuZmNpQmFzZUJ5Rm9uZG9CeVR5cGVbbm9ybWFsaXplZFR5cGVdLmdldChmb25kb0tleSk7CiAgICAgICAgICBjb25zdCBtb250aGx5UGN0ID0gY29tcHV0ZU1vbnRobHlQY3QodmNwLCBiYXNlPy52Y3ApOwogICAgICAgICAgcmV0dXJuIHsKICAgICAgICAgICAgZm9uZG8sCiAgICAgICAgICAgIGZlY2hhLAogICAgICAgICAgICB2Y3AsCiAgICAgICAgICAgIGNjcCwKICAgICAgICAgICAgcGF0cmltb25pbywKICAgICAgICAgICAgaG9yaXpvbnRlLAogICAgICAgICAgICBtb250aGx5UGN0LAogICAgICAgICAgICBwcmV2aW91c1ZjcDogcHJldmlvdXM/LnZjcCA/PyBudWxsLAogICAgICAgICAgICB2Y3BUcmVuZDogZmNpVHJlbmREaXIodmNwLCBwcmV2aW91cz8udmNwKSwKICAgICAgICAgICAgY2NwVHJlbmQ6IGZjaVRyZW5kRGlyKGNjcCwgcHJldmlvdXM/LmNjcCksCiAgICAgICAgICAgIHBhdHJpbW9uaW9UcmVuZDogZmNpVHJlbmREaXIocGF0cmltb25pbywgcHJldmlvdXM/LnBhdHJpbW9uaW8pLAogICAgICAgICAgfTsKICAgICAgICB9KQogICAgICAgIC5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uZm9uZG8gJiYgKGl0ZW0udmNwICE9PSBudWxsIHx8IGl0ZW0uZmVjaGEpKTsKICAgICAgY29uc3Qgc29ydGVkUm93cyA9IHJvd3Muc2xpY2UoKS5zb3J0KChhLCBiKSA9PiAoYi5wYXRyaW1vbmlvID8/IC1JbmZpbml0eSkgLSAoYS5wYXRyaW1vbmlvID8/IC1JbmZpbml0eSkpOwogICAgICBzdGF0ZS5mY2lSb3dzQnlUeXBlW25vcm1hbGl6ZWRUeXBlXSA9IHNvcnRlZFJvd3M7CiAgICAgIHN0YXRlLmZjaURhdGVCeVR5cGVbbm9ybWFsaXplZFR5cGVdID0gc29ydGVkUm93cy5maW5kKChyb3cpID0+IHJvdy5mZWNoYSk/LmZlY2hhIHx8ICfigJQnOwogICAgICBpZiAobm9ybWFsaXplZFR5cGUgPT09IHN0YXRlLmZjaVR5cGUpIHN0YXRlLmZjaVBhZ2UgPSAxOwogICAgfQoKICAgIGNvbnN0IGFjdGl2ZVJvd3MgPSBzdGF0ZS5mY2lSb3dzQnlUeXBlW3N0YXRlLmZjaVR5cGVdIHx8IFtdOwogICAgY29uc3QgcXVlcnkgPSBzdGF0ZS5mY2lRdWVyeS50cmltKCkudG9Mb3dlckNhc2UoKTsKICAgIGNvbnN0IGZpbHRlcmVkID0gcXVlcnkKICAgICAgPyBhY3RpdmVSb3dzLmZpbHRlcigocm93KSA9PiByb3cuZm9uZG8udG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxdWVyeSkpCiAgICAgIDogYWN0aXZlUm93cy5zbGljZSgpOwoKICAgIGNvbnN0IHRvdGFsUGFnZXMgPSBNYXRoLm1heCgxLCBNYXRoLmNlaWwoZmlsdGVyZWQubGVuZ3RoIC8gRkNJX1BBR0VfU0laRSkpOwogICAgc3RhdGUuZmNpUGFnZSA9IE1hdGgubWluKE1hdGgubWF4KDEsIHN0YXRlLmZjaVBhZ2UpLCB0b3RhbFBhZ2VzKTsKICAgIGNvbnN0IGZyb20gPSAoc3RhdGUuZmNpUGFnZSAtIDEpICogRkNJX1BBR0VfU0laRTsKICAgIGNvbnN0IHBhZ2VSb3dzID0gZmlsdGVyZWQuc2xpY2UoZnJvbSwgZnJvbSArIEZDSV9QQUdFX1NJWkUpOwoKICAgIGNvbnN0IGRhdGVFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktbGFzdC1kYXRlJyk7CiAgICBjb25zdCBmaXJzdERhdGUgPSBmaWx0ZXJlZC5maW5kKChyb3cpID0+IHJvdy5mZWNoYSk/LmZlY2hhIHx8IHN0YXRlLmZjaURhdGVCeVR5cGVbc3RhdGUuZmNpVHlwZV0gfHwgJ+KAlCc7CiAgICBpZiAoZGF0ZUVsKSBkYXRlRWwudGV4dENvbnRlbnQgPSBgRmVjaGE6ICR7Zmlyc3REYXRlfWA7CiAgICBzZXRUZXh0KCdmY2ktcGFnZS1pbmZvJywgYCR7c3RhdGUuZmNpUGFnZX0gLyAke3RvdGFsUGFnZXN9YCk7CiAgICBjb25zdCBwcmV2QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1wcmV2Jyk7CiAgICBjb25zdCBuZXh0QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1uZXh0Jyk7CiAgICBpZiAocHJldkJ0bikgcHJldkJ0bi5kaXNhYmxlZCA9IHN0YXRlLmZjaVBhZ2UgPD0gMTsKICAgIGlmIChuZXh0QnRuKSBuZXh0QnRuLmRpc2FibGVkID0gc3RhdGUuZmNpUGFnZSA+PSB0b3RhbFBhZ2VzOwoKICAgIGlmICghcGFnZVJvd3MubGVuZ3RoKSB7CiAgICAgIHJvd3NFbC5pbm5lckhUTUwgPSAnJzsKICAgICAgaWYgKHF1ZXJ5KSBlbXB0eUVsLnRleHRDb250ZW50ID0gJ05vIGhheSByZXN1bHRhZG9zIHBhcmEgbGEgYsO6c3F1ZWRhIGluZGljYWRhLic7CiAgICAgIGVsc2UgZW1wdHlFbC50ZXh0Q29udGVudCA9IGBObyBoYXkgZGF0b3MgZGUgJHtzdGF0ZS5mY2lUeXBlID09PSAndmFyaWFibGUnID8gJ3JlbnRhIHZhcmlhYmxlJyA6ICdyZW50YSBmaWphJ30gZGlzcG9uaWJsZXMgZW4gZXN0ZSBtb21lbnRvLmA7CiAgICAgIGVtcHR5RWwuc3R5bGUuZGlzcGxheSA9ICdibG9jayc7CiAgICAgIHJlbmRlckZjaUJlbmNobWFya0luZm8oKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGVtcHR5RWwuc3R5bGUuZGlzcGxheSA9ICdub25lJzsKICAgIHJvd3NFbC5pbm5lckhUTUwgPSBwYWdlUm93cy5tYXAoKHJvdykgPT4gYAogICAgICA8dHI+CiAgICAgICAgPHRkIHRpdGxlPSIke2VzY2FwZUh0bWwocm93LmZvbmRvKX0iPiR7ZXNjYXBlSHRtbChyb3cuZm9uZG8pfTwvdGQ+CiAgICAgICAgPHRkPiR7cmVuZGVyRmNpVHJlbmRWYWx1ZShyb3cudmNwLCByb3cudmNwVHJlbmQpfTwvdGQ+CiAgICAgICAgPHRkPiR7cmVuZGVyRmNpVHJlbmRWYWx1ZShyb3cuY2NwLCByb3cuY2NwVHJlbmQpfTwvdGQ+CiAgICAgICAgPHRkPiR7cmVuZGVyRmNpVHJlbmRWYWx1ZShyb3cucGF0cmltb25pbywgcm93LnBhdHJpbW9uaW9UcmVuZCl9PC90ZD4KICAgICAgICA8dGQ+JHtlc2NhcGVIdG1sKHJvdy5ob3Jpem9udGUgfHwgJ+KAlCcpfTwvdGQ+CiAgICAgICAgPHRkIGNsYXNzPSJmY2ktc2lnbmFsLWNlbGwiPiR7cmVuZGVyRmNpU2lnbmFsQmFkZ2UoY29tcHV0ZUZjaVNpZ25hbChyb3csIHN0YXRlLmZjaVR5cGUpKX08L3RkPgogICAgICA8L3RyPgogICAgYCkuam9pbignJyk7CiAgICBzYXZlRmNpU2lnbmFsU3RyZWFrcygpOwogICAgcmVuZGVyRmNpQmVuY2htYXJrSW5mbygpOwogIH0KCiAgLy8gNCkgRnVuY2nDs24gY2VudHJhbCBmZXRjaEFsbCgpCiAgYXN5bmMgZnVuY3Rpb24gZmV0Y2hKc29uKHVybCkgewogICAgY29uc3QgY3RybCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTsKICAgIGNvbnN0IHRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IGN0cmwuYWJvcnQoKSwgMTIwMDApOwogICAgdHJ5IHsKICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IGNhY2hlOiAnbm8tc3RvcmUnLCBzaWduYWw6IGN0cmwuc2lnbmFsIH0pOwogICAgICBpZiAoIXJlcy5vaykgdGhyb3cgbmV3IEVycm9yKGBIVFRQICR7cmVzLnN0YXR1c31gKTsKICAgICAgcmV0dXJuIGF3YWl0IHJlcy5qc29uKCk7CiAgICB9IGZpbmFsbHkgewogICAgICBjbGVhclRpbWVvdXQodGltZW91dCk7CiAgICB9CiAgfQoKICBhc3luYyBmdW5jdGlvbiBmZXRjaEFsbChvcHRpb25zID0ge30pIHsKICAgIGlmIChzdGF0ZS5pc0ZldGNoaW5nKSByZXR1cm47CiAgICBzdGF0ZS5pc0ZldGNoaW5nID0gdHJ1ZTsKICAgIHNldExvYWRpbmcoTlVNRVJJQ19JRFMsIHRydWUpOwogICAgc2V0RnJlc2hCYWRnZSgnQWN0dWFsaXphbmRv4oCmJywgJ2ZldGNoaW5nJyk7CiAgICBzZXRFcnJvckJhbm5lcihmYWxzZSk7CiAgICB0cnkgewogICAgICBjb25zdCB0YXNrcyA9IFsKICAgICAgICBbJ21lcENjbCcsIEVORFBPSU5UUy5tZXBDY2xdLAogICAgICAgIFsnZmNpUmVudGFGaWphJywgRU5EUE9JTlRTLmZjaVJlbnRhRmlqYV0sCiAgICAgICAgWydmY2lSZW50YUZpamFQZW51bHRpbW8nLCBFTkRQT0lOVFMuZmNpUmVudGFGaWphUGVudWx0aW1vXSwKICAgICAgICBbJ2ZjaVJlbnRhRmlqYU1lc0Jhc2UnLCBFTkRQT0lOVFMuZmNpUmVudGFGaWphTWVzQmFzZV0sCiAgICAgICAgWydmY2lSZW50YVZhcmlhYmxlJywgRU5EUE9JTlRTLmZjaVJlbnRhVmFyaWFibGVdLAogICAgICAgIFsnZmNpUmVudGFWYXJpYWJsZVBlbnVsdGltbycsIEVORFBPSU5UUy5mY2lSZW50YVZhcmlhYmxlUGVudWx0aW1vXSwKICAgICAgICBbJ2ZjaVJlbnRhVmFyaWFibGVNZXNCYXNlJywgRU5EUE9JTlRTLmZjaVJlbnRhVmFyaWFibGVNZXNCYXNlXSwKICAgICAgICBbJ2JlbmNobWFya1BsYXpvRmlqbycsIEVORFBPSU5UUy5iZW5jaG1hcmtQbGF6b0Zpam9dLAogICAgICAgIFsnYmVuY2htYXJrSW5mbGFjaW9uJywgRU5EUE9JTlRTLmJlbmNobWFya0luZmxhY2lvbl0KICAgICAgXTsKCiAgICAgIGNvbnN0IHNldHRsZWQgPSBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQodGFza3MubWFwKGFzeW5jIChbbmFtZSwgdXJsXSkgPT4gewogICAgICAgIHRyeSB7CiAgICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgZmV0Y2hKc29uKHVybCk7CiAgICAgICAgICByZXR1cm4geyBuYW1lLCBkYXRhIH07CiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtSYWRhck1FUF0gZXJyb3IgZW4gJHtuYW1lfWAsIGVycm9yKTsKICAgICAgICAgIHRocm93IHsgbmFtZSwgZXJyb3IgfTsKICAgICAgICB9CiAgICAgIH0pKTsKCiAgICAgIGNvbnN0IGJhZyA9IHsKICAgICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksCiAgICAgICAgbWVwQ2NsOiBudWxsLAogICAgICAgIGZjaVJlbnRhRmlqYTogbnVsbCwKICAgICAgICBmY2lSZW50YUZpamFQZW51bHRpbW86IG51bGwsCiAgICAgICAgZmNpUmVudGFGaWphTWVzQmFzZTogbnVsbCwKICAgICAgICBmY2lSZW50YVZhcmlhYmxlOiBudWxsLAogICAgICAgIGZjaVJlbnRhVmFyaWFibGVQZW51bHRpbW86IG51bGwsCiAgICAgICAgZmNpUmVudGFWYXJpYWJsZU1lc0Jhc2U6IG51bGwsCiAgICAgICAgYmVuY2htYXJrUGxhem9GaWpvOiBudWxsLAogICAgICAgIGJlbmNobWFya0luZmxhY2lvbjogbnVsbAogICAgICB9OwogICAgICBjb25zdCBmYWlsZWQgPSBbXTsKICAgICAgc2V0dGxlZC5mb3JFYWNoKChyLCBpZHgpID0+IHsKICAgICAgICBjb25zdCBuYW1lID0gdGFza3NbaWR4XVswXTsKICAgICAgICBpZiAoci5zdGF0dXMgPT09ICdmdWxmaWxsZWQnKSBiYWdbbmFtZV0gPSByLnZhbHVlLmRhdGE7CiAgICAgICAgZWxzZSBmYWlsZWQucHVzaChuYW1lKTsKICAgICAgfSk7CgogICAgICBjb25zdCBwZkRhdGEgPSBiYWcuYmVuY2htYXJrUGxhem9GaWpvPy5kYXRhIHx8IHt9OwogICAgICBjb25zdCBpbmZEYXRhID0gYmFnLmJlbmNobWFya0luZmxhY2lvbj8uZGF0YSB8fCB7fTsKICAgICAgc3RhdGUuYmVuY2htYXJrID0gewogICAgICAgIHBsYXpvRmlqb01vbnRobHlQY3Q6IHRvTnVtYmVyKHBmRGF0YT8ubW9udGhseVBjdCksCiAgICAgICAgaW5mbGFjaW9uTW9udGhseVBjdDogdG9OdW1iZXIoaW5mRGF0YT8ubW9udGhseVBjdCksCiAgICAgICAgaW5mbGFjaW9uRGF0ZTogdHlwZW9mIGluZkRhdGE/LmRhdGUgPT09ICdzdHJpbmcnID8gaW5mRGF0YS5kYXRlIDogbnVsbCwKICAgICAgICB1cGRhdGVkQXRIdW1hbkFydDogYmFnLmJlbmNobWFya1BsYXpvRmlqbz8uZmV0Y2hlZEF0SHVtYW5BcnQgfHwgYmFnLmJlbmNobWFya0luZmxhY2lvbj8uZmV0Y2hlZEF0SHVtYW5BcnQgfHwgbnVsbAogICAgICB9OwoKICAgICAgcmVuZGVyTWVwQ2NsKGJhZy5tZXBDY2wpOwogICAgICBpZiAoYmFnLmZjaVJlbnRhRmlqYSB8fCBiYWcuZmNpUmVudGFGaWphUGVudWx0aW1vKSB7CiAgICAgICAgcmVuZGVyRmNpUmVudGFGaWphKGJhZy5mY2lSZW50YUZpamEsIGJhZy5mY2lSZW50YUZpamFQZW51bHRpbW8sICdmaWphJywgYmFnLmZjaVJlbnRhRmlqYU1lc0Jhc2UpOwogICAgICB9CiAgICAgIGlmIChiYWcuZmNpUmVudGFWYXJpYWJsZSB8fCBiYWcuZmNpUmVudGFWYXJpYWJsZVBlbnVsdGltbykgewogICAgICAgIHJlbmRlckZjaVJlbnRhRmlqYShiYWcuZmNpUmVudGFWYXJpYWJsZSwgYmFnLmZjaVJlbnRhVmFyaWFibGVQZW51bHRpbW8sICd2YXJpYWJsZScsIGJhZy5mY2lSZW50YVZhcmlhYmxlTWVzQmFzZSk7CiAgICAgIH0KICAgICAgcmVuZGVyRmNpUmVudGFGaWphKCk7CiAgICAgIHN0YXRlLmxhc3RNZXBQYXlsb2FkID0gYmFnLm1lcENjbDsKICAgICAgcmVuZGVyTWV0cmljczI0aChiYWcubWVwQ2NsKTsKICAgICAgcmVuZGVyVHJlbmQoYmFnLm1lcENjbCk7CiAgICAgIHJlbmRlckhpc3RvcnkoYmFnLm1lcENjbCk7CiAgICAgIGNvbnN0IG1lcFJvb3QgPSBleHRyYWN0Um9vdChiYWcubWVwQ2NsKTsKICAgICAgY29uc3QgdXBkYXRlZEFydCA9IHR5cGVvZiBtZXBSb290Py51cGRhdGVkQXRIdW1hbkFydCA9PT0gJ3N0cmluZycgPyBtZXBSb290LnVwZGF0ZWRBdEh1bWFuQXJ0IDogbnVsbDsKICAgICAgY29uc3Qgc291cmNlVHNNcyA9IHRvTnVtYmVyKG1lcFJvb3Q/LnNvdXJjZVN0YXR1cz8ubGF0ZXN0U291cmNlVHNNcykKICAgICAgICA/PyB0b051bWJlcihtZXBSb290Py5jdXJyZW50Py5tZXBUc01zKQogICAgICAgID8/IHRvTnVtYmVyKG1lcFJvb3Q/LmN1cnJlbnQ/LmNjbFRzTXMpCiAgICAgICAgPz8gbnVsbDsKICAgICAgc3RhdGUuc291cmNlVHNNcyA9IHNvdXJjZVRzTXM7CiAgICAgIHNldFRleHQoJ2xhc3QtcnVuLXRpbWUnLCB1cGRhdGVkQXJ0IHx8IGZtdEFyZ1RpbWVTZWMuZm9ybWF0KG5ldyBEYXRlKCkpKTsKCiAgICAgIGNvbnN0IHN1Y2Nlc3NDb3VudCA9IHRhc2tzLmxlbmd0aCAtIGZhaWxlZC5sZW5ndGg7CiAgICAgIGlmIChzdWNjZXNzQ291bnQgPiAwKSB7CiAgICAgICAgc3RhdGUubGFzdFN1Y2Nlc3NBdCA9IERhdGUubm93KCk7CiAgICAgICAgc3RhdGUucmV0cnlJbmRleCA9IDA7CiAgICAgICAgaWYgKHN0YXRlLnJldHJ5VGltZXIpIGNsZWFyVGltZW91dChzdGF0ZS5yZXRyeVRpbWVyKTsKICAgICAgICBzYXZlQ2FjaGUoYmFnKTsKICAgICAgICBjb25zdCBhZ2VMYWJlbCA9IHNvdXJjZVRzTXMgIT0gbnVsbCA/IGZvcm1hdFNvdXJjZUFnZUxhYmVsKHNvdXJjZVRzTXMpIDogbnVsbDsKICAgICAgICBjb25zdCBiYWRnZUJhc2UgPSBhZ2VMYWJlbCA/IGDDmmx0aW1hIGFjdHVhbGl6YWNpw7NuIGhhY2U6ICR7YWdlTGFiZWx9YCA6IGBBY3R1YWxpemFkbyDCtyAke2ZtdEFyZ1RpbWUuZm9ybWF0KG5ldyBEYXRlKCkpfWA7CiAgICAgICAgaWYgKGZhaWxlZC5sZW5ndGgpIHNldEZyZXNoQmFkZ2UoYEFjdHVhbGl6YWNpw7NuIHBhcmNpYWwgwrcgJHtiYWRnZUJhc2V9YCwgJ2lkbGUnKTsKICAgICAgICBlbHNlIHNldEZyZXNoQmFkZ2UoYmFkZ2VCYXNlLCAnaWRsZScpOwogICAgICAgIHJlZnJlc2hGcmVzaEJhZGdlRnJvbVNvdXJjZSgpOwogICAgICB9IGVsc2UgewogICAgICAgIGNvbnN0IGF0dGVtcHQgPSBzdGF0ZS5yZXRyeUluZGV4ICsgMTsKICAgICAgICBpZiAoc3RhdGUucmV0cnlJbmRleCA8IFJFVFJZX0RFTEFZUy5sZW5ndGgpIHsKICAgICAgICAgIGNvbnN0IGRlbGF5ID0gUkVUUllfREVMQVlTW3N0YXRlLnJldHJ5SW5kZXhdOwogICAgICAgICAgc3RhdGUucmV0cnlJbmRleCArPSAxOwogICAgICAgICAgc2V0RnJlc2hCYWRnZShgRXJyb3IgwrcgUmVpbnRlbnRvIGVuICR7TWF0aC5yb3VuZChkZWxheSAvIDEwMDApfXNgLCAnZXJyb3InKTsKICAgICAgICAgIGlmIChzdGF0ZS5yZXRyeVRpbWVyKSBjbGVhclRpbWVvdXQoc3RhdGUucmV0cnlUaW1lcik7CiAgICAgICAgICBzdGF0ZS5yZXRyeVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBmZXRjaEFsbCh7IG1hbnVhbDogdHJ1ZSB9KSwgZGVsYXkpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBzZXRGcmVzaEJhZGdlKCdFcnJvciDCtyBSZWludGVudGFyJywgJ2Vycm9yJyk7CiAgICAgICAgICBzZXRFcnJvckJhbm5lcih0cnVlLCAnRXJyb3IgYWwgYWN0dWFsaXphciDCtyBSZWludGVudGFyJyk7CiAgICAgICAgICBjb25zb2xlLmVycm9yKGBbUmFkYXJNRVBdIHNlIGFnb3Rhcm9uIHJldHJpZXMgKCR7YXR0ZW1wdH0gaW50ZW50b3MpYCk7CiAgICAgICAgICBpZiAod2luZG93LnNjaGVkdWxlcikgd2luZG93LnNjaGVkdWxlci5zdG9wKCk7CiAgICAgICAgfQogICAgICB9CiAgICB9IGZpbmFsbHkgewogICAgICBzZXRMb2FkaW5nKE5VTUVSSUNfSURTLCBmYWxzZSk7CiAgICAgIHN0YXRlLmlzRmV0Y2hpbmcgPSBmYWxzZTsKICAgIH0KICB9CgogIC8vIDUpIENsYXNlIE1hcmtldFNjaGVkdWxlcgogIGNsYXNzIE1hcmtldFNjaGVkdWxlciB7CiAgICBjb25zdHJ1Y3RvcihmZXRjaEZuLCBpbnRlcnZhbE1zID0gMzAwMDAwKSB7CiAgICAgIHRoaXMuZmV0Y2hGbiA9IGZldGNoRm47CiAgICAgIHRoaXMuaW50ZXJ2YWxNcyA9IGludGVydmFsTXM7CiAgICAgIHRoaXMudGltZXIgPSBudWxsOwogICAgICB0aGlzLndhaXRUaW1lciA9IG51bGw7CiAgICAgIHRoaXMuY291bnRkb3duVGltZXIgPSBudWxsOwogICAgICB0aGlzLm5leHRSdW5BdCA9IG51bGw7CiAgICAgIHRoaXMucnVubmluZyA9IGZhbHNlOwogICAgICB0aGlzLnBhdXNlZCA9IGZhbHNlOwogICAgfQoKICAgIHN0YXJ0KCkgewogICAgICBpZiAodGhpcy5ydW5uaW5nKSByZXR1cm47CiAgICAgIHRoaXMucnVubmluZyA9IHRydWU7CiAgICAgIHRoaXMucGF1c2VkID0gZmFsc2U7CiAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgc2V0TWFya2V0VGFnKHRydWUpOwogICAgICAgIHRoaXMuX3NjaGVkdWxlKHRoaXMuaW50ZXJ2YWxNcyk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgc2V0TWFya2V0VGFnKGZhbHNlKTsKICAgICAgICB0aGlzLl93YWl0Rm9yT3BlbigpOwogICAgICB9CiAgICAgIHRoaXMuX3N0YXJ0Q291bnRkb3duKCk7CiAgICB9CgogICAgcGF1c2UoKSB7CiAgICAgIHRoaXMucGF1c2VkID0gdHJ1ZTsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMudGltZXIpOwogICAgICBjbGVhclRpbWVvdXQodGhpcy53YWl0VGltZXIpOwogICAgICB0aGlzLnRpbWVyID0gbnVsbDsKICAgICAgdGhpcy53YWl0VGltZXIgPSBudWxsOwogICAgICB0aGlzLl9zdG9wQ291bnRkb3duKCk7CiAgICAgIGNvbnN0IGNvdW50ZG93biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb3VudGRvd24tdGV4dCcpOwogICAgICBpZiAoY291bnRkb3duKSBjb3VudGRvd24udGV4dENvbnRlbnQgPSAnQWN0dWFsaXphY2nDs24gcGF1c2FkYSc7CiAgICB9CgogICAgcmVzdW1lKCkgewogICAgICBpZiAoIXRoaXMucnVubmluZykgdGhpcy5ydW5uaW5nID0gdHJ1ZTsKICAgICAgdGhpcy5wYXVzZWQgPSBmYWxzZTsKICAgICAgY29uc3QgY29udGludWVSZXN1bWUgPSAoKSA9PiB7CiAgICAgICAgaWYgKHRoaXMuaXNNYXJrZXRPcGVuKCkpIHsKICAgICAgICAgIHNldE1hcmtldFRhZyh0cnVlKTsKICAgICAgICAgIHRoaXMuX3NjaGVkdWxlKHRoaXMuaW50ZXJ2YWxNcyk7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIHNldE1hcmtldFRhZyhmYWxzZSk7CiAgICAgICAgICB0aGlzLl93YWl0Rm9yT3BlbigpOwogICAgICAgIH0KICAgICAgICB0aGlzLl9zdGFydENvdW50ZG93bigpOwogICAgICB9OwogICAgICBpZiAoRGF0ZS5ub3coKSAtIHN0YXRlLmxhc3RTdWNjZXNzQXQgPiB0aGlzLmludGVydmFsTXMpIHsKICAgICAgICBQcm9taXNlLnJlc29sdmUodGhpcy5mZXRjaEZuKHsgbWFudWFsOiB0cnVlIH0pKS5maW5hbGx5KGNvbnRpbnVlUmVzdW1lKTsKICAgICAgfSBlbHNlIHsKICAgICAgICBjb250aW51ZVJlc3VtZSgpOwogICAgICB9CiAgICB9CgogICAgc3RvcCgpIHsKICAgICAgdGhpcy5ydW5uaW5nID0gZmFsc2U7CiAgICAgIHRoaXMucGF1c2VkID0gZmFsc2U7CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLnRpbWVyKTsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMud2FpdFRpbWVyKTsKICAgICAgdGhpcy50aW1lciA9IG51bGw7CiAgICAgIHRoaXMud2FpdFRpbWVyID0gbnVsbDsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBudWxsOwogICAgICB0aGlzLl9zdG9wQ291bnRkb3duKCk7CiAgICB9CgogICAgaXNNYXJrZXRPcGVuKCkgewogICAgICBjb25zdCBwID0gZ2V0QXJnTm93UGFydHMoKTsKICAgICAgY29uc3QgYnVzaW5lc3NEYXkgPSBwLndlZWtkYXkgPj0gMSAmJiBwLndlZWtkYXkgPD0gNTsKICAgICAgY29uc3Qgc2Vjb25kcyA9IHAuaG91ciAqIDM2MDAgKyBwLm1pbnV0ZSAqIDYwICsgcC5zZWNvbmQ7CiAgICAgIGNvbnN0IGZyb20gPSAxMCAqIDM2MDAgKyAzMCAqIDYwOwogICAgICBjb25zdCB0byA9IDE4ICogMzYwMDsKICAgICAgcmV0dXJuIGJ1c2luZXNzRGF5ICYmIHNlY29uZHMgPj0gZnJvbSAmJiBzZWNvbmRzIDwgdG87CiAgICB9CgogICAgZ2V0TmV4dFJ1blRpbWUoKSB7CiAgICAgIHJldHVybiB0aGlzLm5leHRSdW5BdCA/IG5ldyBEYXRlKHRoaXMubmV4dFJ1bkF0KSA6IG51bGw7CiAgICB9CgogICAgX3NjaGVkdWxlKGRlbGF5TXMpIHsKICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMudGltZXIpOwogICAgICB0aGlzLm5leHRSdW5BdCA9IERhdGUubm93KCkgKyBkZWxheU1zOwogICAgICB0aGlzLnRpbWVyID0gc2V0VGltZW91dChhc3luYyAoKSA9PiB7CiAgICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgICBpZiAoIXRoaXMuaXNNYXJrZXRPcGVuKCkpIHsKICAgICAgICAgIHNldE1hcmtldFRhZyhmYWxzZSk7CiAgICAgICAgICB0aGlzLl93YWl0Rm9yT3BlbigpOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgICBzZXRNYXJrZXRUYWcodHJ1ZSk7CiAgICAgICAgYXdhaXQgdGhpcy5mZXRjaEZuKCk7CiAgICAgICAgdGhpcy5fc2NoZWR1bGUodGhpcy5pbnRlcnZhbE1zKTsKICAgICAgfSwgZGVsYXlNcyk7CiAgICB9CgogICAgX3dhaXRGb3JPcGVuKCkgewogICAgICBpZiAoIXRoaXMucnVubmluZyB8fCB0aGlzLnBhdXNlZCkgcmV0dXJuOwogICAgICBjbGVhclRpbWVvdXQodGhpcy53YWl0VGltZXIpOwogICAgICB0aGlzLm5leHRSdW5BdCA9IERhdGUubm93KCkgKyA2MDAwMDsKICAgICAgdGhpcy53YWl0VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsKICAgICAgICBpZiAoIXRoaXMucnVubmluZyB8fCB0aGlzLnBhdXNlZCkgcmV0dXJuOwogICAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcodHJ1ZSk7CiAgICAgICAgICB0aGlzLmZldGNoRm4oeyBtYW51YWw6IHRydWUgfSk7CiAgICAgICAgICB0aGlzLl9zY2hlZHVsZSh0aGlzLmludGVydmFsTXMpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcoZmFsc2UpOwogICAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgICB9CiAgICAgIH0sIDYwMDAwKTsKICAgIH0KCiAgICBfc3RhcnRDb3VudGRvd24oKSB7CiAgICAgIHRoaXMuX3N0b3BDb3VudGRvd24oKTsKICAgICAgdGhpcy5jb3VudGRvd25UaW1lciA9IHNldEludGVydmFsKCgpID0+IHsKICAgICAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb3VudGRvd24tdGV4dCcpOwogICAgICAgIGlmICghZWwgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgICBjb25zdCBuZXh0ID0gdGhpcy5nZXROZXh0UnVuVGltZSgpOwogICAgICAgIGlmICghbmV4dCkgewogICAgICAgICAgZWwudGV4dENvbnRlbnQgPSB0aGlzLmlzTWFya2V0T3BlbigpID8gJ1Byw7N4aW1hIGFjdHVhbGl6YWNpw7NuIGVuIOKAlCcgOiAnTWVyY2FkbyBjZXJyYWRvJzsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgY29uc3QgZGlmZiA9IE1hdGgubWF4KDAsIG5leHQuZ2V0VGltZSgpIC0gRGF0ZS5ub3coKSk7CiAgICAgICAgY29uc3QgbSA9IE1hdGguZmxvb3IoZGlmZiAvIDYwMDAwKTsKICAgICAgICBjb25zdCBzID0gTWF0aC5mbG9vcigoZGlmZiAlIDYwMDAwKSAvIDEwMDApOwogICAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSBlbC50ZXh0Q29udGVudCA9IGBQcsOzeGltYSBhY3R1YWxpemFjacOzbiBlbiAke219OiR7U3RyaW5nKHMpLnBhZFN0YXJ0KDIsICcwJyl9YDsKICAgICAgICBlbHNlIGVsLnRleHRDb250ZW50ID0gJ01lcmNhZG8gY2VycmFkbyc7CiAgICAgIH0sIDEwMDApOwogICAgfQoKICAgIF9zdG9wQ291bnRkb3duKCkgewogICAgICBjbGVhckludGVydmFsKHRoaXMuY291bnRkb3duVGltZXIpOwogICAgICB0aGlzLmNvdW50ZG93blRpbWVyID0gbnVsbDsKICAgIH0KICB9CgogIC8vIDYpIEzDs2dpY2EgZGUgY2FjaMOpCiAgZnVuY3Rpb24gc2F2ZUNhY2hlKGRhdGEpIHsKICAgIHRyeSB7CiAgICAgIHNlc3Npb25TdG9yYWdlLnNldEl0ZW0oQ0FDSEVfS0VZLCBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLAogICAgICAgIG1lcENjbDogZGF0YS5tZXBDY2wsCiAgICAgICAgZmNpUmVudGFGaWphOiBkYXRhLmZjaVJlbnRhRmlqYSwKICAgICAgICBmY2lSZW50YUZpamFQZW51bHRpbW86IGRhdGEuZmNpUmVudGFGaWphUGVudWx0aW1vLAogICAgICAgIGZjaVJlbnRhRmlqYU1lc0Jhc2U6IGRhdGEuZmNpUmVudGFGaWphTWVzQmFzZSwKICAgICAgICBmY2lSZW50YVZhcmlhYmxlOiBkYXRhLmZjaVJlbnRhVmFyaWFibGUsCiAgICAgICAgZmNpUmVudGFWYXJpYWJsZVBlbnVsdGltbzogZGF0YS5mY2lSZW50YVZhcmlhYmxlUGVudWx0aW1vLAogICAgICAgIGZjaVJlbnRhVmFyaWFibGVNZXNCYXNlOiBkYXRhLmZjaVJlbnRhVmFyaWFibGVNZXNCYXNlLAogICAgICAgIGJlbmNobWFya1BsYXpvRmlqbzogZGF0YS5iZW5jaG1hcmtQbGF6b0Zpam8sCiAgICAgICAgYmVuY2htYXJrSW5mbGFjaW9uOiBkYXRhLmJlbmNobWFya0luZmxhY2lvbgogICAgICB9KSk7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tSYWRhck1FUF0gbm8gc2UgcHVkbyBndWFyZGFyIGNhY2hlJywgZSk7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBsb2FkQ2FjaGUoKSB7CiAgICB0cnkgewogICAgICBjb25zdCByYXcgPSBzZXNzaW9uU3RvcmFnZS5nZXRJdGVtKENBQ0hFX0tFWSk7CiAgICAgIGlmICghcmF3KSByZXR1cm4gbnVsbDsKICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpOwogICAgICBpZiAoIXBhcnNlZC50aW1lc3RhbXAgfHwgRGF0ZS5ub3coKSAtIHBhcnNlZC50aW1lc3RhbXAgPiBDQUNIRV9UVExfTVMpIHJldHVybiBudWxsOwogICAgICByZXR1cm4gcGFyc2VkOwogICAgfSBjYXRjaCAoZSkgewogICAgICBjb25zb2xlLmVycm9yKCdbUmFkYXJNRVBdIGNhY2hlIGludsOhbGlkYScsIGUpOwogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CgogIGZ1bmN0aW9uIGNsYW1wRHJhd2VyV2lkdGgocHgpIHsKICAgIHJldHVybiBNYXRoLm1heChEUkFXRVJfTUlOX1csIE1hdGgubWluKERSQVdFUl9NQVhfVywgTWF0aC5yb3VuZChweCkpKTsKICB9CiAgZnVuY3Rpb24gc2F2ZURyYXdlcldpZHRoKHB4KSB7CiAgICB0cnkgeyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShEUkFXRVJfV0lEVEhfS0VZLCBTdHJpbmcoY2xhbXBEcmF3ZXJXaWR0aChweCkpKTsgfSBjYXRjaCB7fQogIH0KICBmdW5jdGlvbiBsb2FkRHJhd2VyV2lkdGgoKSB7CiAgICB0cnkgewogICAgICBjb25zdCByYXcgPSBOdW1iZXIobG9jYWxTdG9yYWdlLmdldEl0ZW0oRFJBV0VSX1dJRFRIX0tFWSkpOwogICAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHJhdykgPyBjbGFtcERyYXdlcldpZHRoKHJhdykgOiBudWxsOwogICAgfSBjYXRjaCB7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogIH0KICBmdW5jdGlvbiBhcHBseURyYXdlcldpZHRoKHB4LCBwZXJzaXN0ID0gZmFsc2UpIHsKICAgIGlmICh3aW5kb3cuaW5uZXJXaWR0aCA8PSA5MDApIHJldHVybjsKICAgIGNvbnN0IG5leHQgPSBjbGFtcERyYXdlcldpZHRoKHB4KTsKICAgIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5zdHlsZS5zZXRQcm9wZXJ0eSgnLS1kcmF3ZXItdycsIGAke25leHR9cHhgKTsKICAgIGlmIChwZXJzaXN0KSBzYXZlRHJhd2VyV2lkdGgobmV4dCk7CiAgfQogIGZ1bmN0aW9uIGluaXREcmF3ZXJXaWR0aCgpIHsKICAgIGNvbnN0IHNhdmVkID0gbG9hZERyYXdlcldpZHRoKCk7CiAgICBpZiAoc2F2ZWQgIT09IG51bGwpIGFwcGx5RHJhd2VyV2lkdGgoc2F2ZWQsIGZhbHNlKTsKICB9CiAgZnVuY3Rpb24gYmluZERyYXdlclJlc2l6ZSgpIHsKICAgIGlmIChzdGF0ZS5kcmF3ZXJSZXNpemVCb3VuZCkgcmV0dXJuOwogICAgY29uc3QgaGFuZGxlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2RyYXdlci1yZXNpemVyJyk7CiAgICBjb25zdCBkcmF3ZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZHJhd2VyJyk7CiAgICBpZiAoIWhhbmRsZSB8fCAhZHJhd2VyKSByZXR1cm47CiAgICBzdGF0ZS5kcmF3ZXJSZXNpemVCb3VuZCA9IHRydWU7CiAgICBoYW5kbGUuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcmRvd24nLCAoZXZlbnQpID0+IHsKICAgICAgaWYgKHdpbmRvdy5pbm5lcldpZHRoIDw9IDkwMCB8fCBldmVudC5idXR0b24gIT09IDApIHJldHVybjsKICAgICAgY29uc3Qgc3RhcnRYID0gZXZlbnQuY2xpZW50WDsKICAgICAgY29uc3Qgc3RhcnRXaWR0aCA9IGRyYXdlci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKS53aWR0aDsKICAgICAgaGFuZGxlLmNsYXNzTGlzdC5hZGQoJ2FjdGl2ZScpOwogICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpOwogICAgICBjb25zdCBvbk1vdmUgPSAobW92ZUV2ZW50KSA9PiB7CiAgICAgICAgY29uc3QgZGVsdGEgPSBtb3ZlRXZlbnQuY2xpZW50WCAtIHN0YXJ0WDsKICAgICAgICBhcHBseURyYXdlcldpZHRoKHN0YXJ0V2lkdGggLSBkZWx0YSwgZmFsc2UpOwogICAgICB9OwogICAgICBjb25zdCBvblVwID0gKCkgPT4gewogICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdwb2ludGVybW92ZScsIG9uTW92ZSk7CiAgICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJ1cCcsIG9uVXApOwogICAgICAgIGhhbmRsZS5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKTsKICAgICAgICBjb25zdCB3aWR0aCA9IGRyYXdlci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKS53aWR0aDsKICAgICAgICBhcHBseURyYXdlcldpZHRoKHdpZHRoLCB0cnVlKTsKICAgICAgfTsKICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJtb3ZlJywgb25Nb3ZlKTsKICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJ1cCcsIG9uVXApOwogICAgfSk7CiAgfQoKICBmdW5jdGlvbiBoaWRlU21hcnRUaXAoKSB7CiAgICBjb25zdCB0aXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc21hcnQtdGlwJyk7CiAgICBpZiAoIXRpcCkgcmV0dXJuOwogICAgdGlwLmNsYXNzTGlzdC5yZW1vdmUoJ3Nob3cnKTsKICAgIHRpcC5zZXRBdHRyaWJ1dGUoJ2FyaWEtaGlkZGVuJywgJ3RydWUnKTsKICB9CiAgZnVuY3Rpb24gc2hvd1NtYXJ0VGlwKGFuY2hvcikgewogICAgY29uc3QgdGlwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NtYXJ0LXRpcCcpOwogICAgaWYgKCF0aXAgfHwgIWFuY2hvcikgcmV0dXJuOwogICAgY29uc3QgdGV4dCA9IGFuY2hvci5nZXRBdHRyaWJ1dGUoJ2RhdGEtdCcpOwogICAgaWYgKCF0ZXh0KSByZXR1cm47CiAgICB0aXAudGV4dENvbnRlbnQgPSB0ZXh0OwogICAgdGlwLmNsYXNzTGlzdC5hZGQoJ3Nob3cnKTsKICAgIHRpcC5zZXRBdHRyaWJ1dGUoJ2FyaWEtaGlkZGVuJywgJ2ZhbHNlJyk7CgogICAgY29uc3QgbWFyZ2luID0gODsKICAgIGNvbnN0IHJlY3QgPSBhbmNob3IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgICBjb25zdCB0aXBSZWN0ID0gdGlwLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgbGV0IGxlZnQgPSByZWN0LmxlZnQ7CiAgICBpZiAobGVmdCArIHRpcFJlY3Qud2lkdGggKyBtYXJnaW4gPiB3aW5kb3cuaW5uZXJXaWR0aCkgbGVmdCA9IHdpbmRvdy5pbm5lcldpZHRoIC0gdGlwUmVjdC53aWR0aCAtIG1hcmdpbjsKICAgIGlmIChsZWZ0IDwgbWFyZ2luKSBsZWZ0ID0gbWFyZ2luOwogICAgbGV0IHRvcCA9IHJlY3QuYm90dG9tICsgODsKICAgIGlmICh0b3AgKyB0aXBSZWN0LmhlaWdodCArIG1hcmdpbiA+IHdpbmRvdy5pbm5lckhlaWdodCkgdG9wID0gTWF0aC5tYXgobWFyZ2luLCByZWN0LnRvcCAtIHRpcFJlY3QuaGVpZ2h0IC0gOCk7CiAgICB0aXAuc3R5bGUubGVmdCA9IGAke01hdGgucm91bmQobGVmdCl9cHhgOwogICAgdGlwLnN0eWxlLnRvcCA9IGAke01hdGgucm91bmQodG9wKX1weGA7CiAgfQogIGZ1bmN0aW9uIGluaXRTbWFydFRpcHMoKSB7CiAgICBpZiAoc3RhdGUuc21hcnRUaXBCb3VuZCkgcmV0dXJuOwogICAgc3RhdGUuc21hcnRUaXBCb3VuZCA9IHRydWU7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudGlwLnRpcC1kb3duJykuZm9yRWFjaCgoZWwpID0+IHsKICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VlbnRlcicsICgpID0+IHNob3dTbWFydFRpcChlbCkpOwogICAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdmb2N1cycsICgpID0+IHNob3dTbWFydFRpcChlbCkpOwogICAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChldmVudCkgPT4gewogICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgc2hvd1NtYXJ0VGlwKGVsKTsKICAgICAgfSk7CiAgICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbGVhdmUnLCBoaWRlU21hcnRUaXApOwogICAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdibHVyJywgaGlkZVNtYXJ0VGlwKTsKICAgIH0pOwogICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3Njcm9sbCcsIGhpZGVTbWFydFRpcCwgdHJ1ZSk7CiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncmVzaXplJywgKCkgPT4gewogICAgICBoaWRlU21hcnRUaXAoKTsKICAgICAgaW5pdERyYXdlcldpZHRoKCk7CiAgICB9KTsKICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKGV2ZW50KSA9PiB7CiAgICAgIGlmICghKGV2ZW50LnRhcmdldCBpbnN0YW5jZW9mIEVsZW1lbnQpKSByZXR1cm47CiAgICAgIGlmICghZXZlbnQudGFyZ2V0LmNsb3Nlc3QoJy50aXAudGlwLWRvd24nKSAmJiAhZXZlbnQudGFyZ2V0LmNsb3Nlc3QoJyNzbWFydC10aXAnKSkgaGlkZVNtYXJ0VGlwKCk7CiAgICB9KTsKICB9CgogIC8vIDcpIEluaWNpYWxpemFjacOzbgogIHN0YXJ0RnJlc2hUaWNrZXIoKTsKICBpbml0RHJhd2VyV2lkdGgoKTsKICBiaW5kRHJhd2VyUmVzaXplKCk7CiAgaW5pdFNtYXJ0VGlwcygpOwogIGZ1bmN0aW9uIHRvZ2dsZURyYXdlcigpIHsKICAgIGNvbnN0IGRyYXdlciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdkcmF3ZXInKTsKICAgIGNvbnN0IHdyYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYm9keVdyYXAnKTsKICAgIGNvbnN0IGJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdidG5UYXNhcycpOwogICAgY29uc3Qgb3ZsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ292ZXJsYXknKTsKICAgIGNvbnN0IGlzT3BlbiA9IGRyYXdlci5jbGFzc0xpc3QuY29udGFpbnMoJ29wZW4nKTsKICAgIGRyYXdlci5jbGFzc0xpc3QudG9nZ2xlKCdvcGVuJywgIWlzT3Blbik7CiAgICB3cmFwLmNsYXNzTGlzdC50b2dnbGUoJ2RyYXdlci1vcGVuJywgIWlzT3Blbik7CiAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgIWlzT3Blbik7CiAgICBvdmwuY2xhc3NMaXN0LnRvZ2dsZSgnc2hvdycsICFpc09wZW4pOwogIH0KCiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnBpbGxbZGF0YS1maWx0ZXJdJykuZm9yRWFjaCgocCkgPT4gewogICAgcC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IGFwcGx5RmlsdGVyKHAuZGF0YXNldC5maWx0ZXIpKTsKICB9KTsKICBjb25zdCBjc3ZCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYnRuLWRvd25sb2FkLWNzdicpOwogIGlmIChjc3ZCdG4pIGNzdkJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGRvd25sb2FkSGlzdG9yeUNzdik7CiAgY29uc3QgZmNpVGFiRmlqYSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktdGFiLWZpamEnKTsKICBpZiAoZmNpVGFiRmlqYSkgewogICAgZmNpVGFiRmlqYS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHNldEZjaVR5cGUoJ2ZpamEnKSk7CiAgfQogIGNvbnN0IGZjaVRhYlZhcmlhYmxlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS10YWItdmFyaWFibGUnKTsKICBpZiAoZmNpVGFiVmFyaWFibGUpIHsKICAgIGZjaVRhYlZhcmlhYmxlLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gc2V0RmNpVHlwZSgndmFyaWFibGUnKSk7CiAgfQogIGNvbnN0IGZjaVNlYXJjaCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktc2VhcmNoJyk7CiAgaWYgKGZjaVNlYXJjaCkgewogICAgZmNpU2VhcmNoLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgKCkgPT4gewogICAgICBzdGF0ZS5mY2lRdWVyeSA9IGZjaVNlYXJjaC52YWx1ZSB8fCAnJzsKICAgICAgc3RhdGUuZmNpUGFnZSA9IDE7CiAgICAgIHJlbmRlckZjaVJlbnRhRmlqYSgpOwogICAgfSk7CiAgfQogIGNvbnN0IGZjaVByZXYgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLXByZXYnKTsKICBpZiAoZmNpUHJldikgewogICAgZmNpUHJldi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgc3RhdGUuZmNpUGFnZSA9IE1hdGgubWF4KDEsIHN0YXRlLmZjaVBhZ2UgLSAxKTsKICAgICAgcmVuZGVyRmNpUmVudGFGaWphKCk7CiAgICB9KTsKICB9CiAgY29uc3QgZmNpTmV4dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktbmV4dCcpOwogIGlmIChmY2lOZXh0KSB7CiAgICBmY2lOZXh0LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICBzdGF0ZS5mY2lQYWdlICs9IDE7CiAgICAgIHJlbmRlckZjaVJlbnRhRmlqYSgpOwogICAgfSk7CiAgfQoKICBmdW5jdGlvbiB0b2dnbGVHbG9zKCkgewogICAgY29uc3QgZ3JpZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdnbG9zR3JpZCcpOwogICAgY29uc3QgYXJyb3cgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZ2xvc0Fycm93Jyk7CiAgICBjb25zdCBvcGVuID0gZ3JpZC5jbGFzc0xpc3QudG9nZ2xlKCdvcGVuJyk7CiAgICBhcnJvdy50ZXh0Q29udGVudCA9IG9wZW4gPyAn4pa0JyA6ICfilr4nOwogIH0KCiAgY29uc3QgcmV0cnlCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXJyb3ItcmV0cnktYnRuJyk7CiAgaWYgKHJldHJ5QnRuKSB7CiAgICByZXRyeUJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgaWYgKHdpbmRvdy5zY2hlZHVsZXIpIHdpbmRvdy5zY2hlZHVsZXIucmVzdW1lKCk7CiAgICAgIGZldGNoQWxsKHsgbWFudWFsOiB0cnVlIH0pOwogICAgfSk7CiAgfQoKICBjb25zdCBjYWNoZWQgPSBsb2FkQ2FjaGUoKTsKICBpbml0SGlzdG9yeUNvbHVtbldpZHRocygpOwogIGJpbmRIaXN0b3J5Q29sdW1uUmVzaXplKCk7CiAgaW5pdEZjaUNvbHVtbldpZHRocygpOwogIGJpbmRGY2lDb2x1bW5SZXNpemUoKTsKICBzdGF0ZS5mY2lTaWduYWxTdHJlYWtzID0gbG9hZEZjaVNpZ25hbFN0cmVha3MoKTsKICBpZiAoY2FjaGVkKSB7CiAgICBzdGF0ZS5sYXN0TWVwUGF5bG9hZCA9IGNhY2hlZC5tZXBDY2w7CiAgICBjb25zdCBwZkRhdGEgPSBjYWNoZWQuYmVuY2htYXJrUGxhem9GaWpvPy5kYXRhIHx8IHt9OwogICAgY29uc3QgaW5mRGF0YSA9IGNhY2hlZC5iZW5jaG1hcmtJbmZsYWNpb24/LmRhdGEgfHwge307CiAgICBzdGF0ZS5iZW5jaG1hcmsgPSB7CiAgICAgIHBsYXpvRmlqb01vbnRobHlQY3Q6IHRvTnVtYmVyKHBmRGF0YT8ubW9udGhseVBjdCksCiAgICAgIGluZmxhY2lvbk1vbnRobHlQY3Q6IHRvTnVtYmVyKGluZkRhdGE/Lm1vbnRobHlQY3QpLAogICAgICBpbmZsYWNpb25EYXRlOiB0eXBlb2YgaW5mRGF0YT8uZGF0ZSA9PT0gJ3N0cmluZycgPyBpbmZEYXRhLmRhdGUgOiBudWxsLAogICAgICB1cGRhdGVkQXRIdW1hbkFydDogY2FjaGVkLmJlbmNobWFya1BsYXpvRmlqbz8uZmV0Y2hlZEF0SHVtYW5BcnQgfHwgY2FjaGVkLmJlbmNobWFya0luZmxhY2lvbj8uZmV0Y2hlZEF0SHVtYW5BcnQgfHwgbnVsbAogICAgfTsKICAgIGlmIChjYWNoZWQuZmNpUmVudGFGaWphIHx8IGNhY2hlZC5mY2lSZW50YUZpamFQZW51bHRpbW8gfHwgY2FjaGVkLmZjaVJlbnRhRmlqYU1lc0Jhc2UpIHsKICAgICAgcmVuZGVyRmNpUmVudGFGaWphKGNhY2hlZC5mY2lSZW50YUZpamEsIGNhY2hlZC5mY2lSZW50YUZpamFQZW51bHRpbW8sICdmaWphJywgY2FjaGVkLmZjaVJlbnRhRmlqYU1lc0Jhc2UpOwogICAgfQogICAgaWYgKGNhY2hlZC5mY2lSZW50YVZhcmlhYmxlIHx8IGNhY2hlZC5mY2lSZW50YVZhcmlhYmxlUGVudWx0aW1vIHx8IGNhY2hlZC5mY2lSZW50YVZhcmlhYmxlTWVzQmFzZSkgewogICAgICByZW5kZXJGY2lSZW50YUZpamEoY2FjaGVkLmZjaVJlbnRhVmFyaWFibGUsIGNhY2hlZC5mY2lSZW50YVZhcmlhYmxlUGVudWx0aW1vLCAndmFyaWFibGUnLCBjYWNoZWQuZmNpUmVudGFWYXJpYWJsZU1lc0Jhc2UpOwogICAgfQogICAgcmVuZGVyRmNpUmVudGFGaWphKCk7CiAgICByZW5kZXJNZXBDY2woY2FjaGVkLm1lcENjbCk7CiAgICByZW5kZXJNZXRyaWNzMjRoKGNhY2hlZC5tZXBDY2wpOwogICAgcmVuZGVyVHJlbmQoY2FjaGVkLm1lcENjbCk7CiAgICByZW5kZXJIaXN0b3J5KGNhY2hlZC5tZXBDY2wpOwogICAgY29uc3QgY2FjaGVkUm9vdCA9IGV4dHJhY3RSb290KGNhY2hlZC5tZXBDY2wpOwogICAgc3RhdGUuc291cmNlVHNNcyA9IHRvTnVtYmVyKGNhY2hlZFJvb3Q/LnNvdXJjZVN0YXR1cz8ubGF0ZXN0U291cmNlVHNNcykKICAgICAgPz8gdG9OdW1iZXIoY2FjaGVkUm9vdD8uY3VycmVudD8ubWVwVHNNcykKICAgICAgPz8gdG9OdW1iZXIoY2FjaGVkUm9vdD8uY3VycmVudD8uY2NsVHNNcykKICAgICAgPz8gbnVsbDsKICAgIHJlZnJlc2hGcmVzaEJhZGdlRnJvbVNvdXJjZSgpOwogIH0KCiAgYXBwbHlGaWx0ZXIoc3RhdGUuZmlsdGVyTW9kZSk7CgogIHdpbmRvdy5zY2hlZHVsZXIgPSBuZXcgTWFya2V0U2NoZWR1bGVyKGZldGNoQWxsLCBGRVRDSF9JTlRFUlZBTF9NUyk7CiAgd2luZG93LnNjaGVkdWxlci5zdGFydCgpOwogIGZldGNoQWxsKHsgbWFudWFsOiB0cnVlIH0pOwoKICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCd2aXNpYmlsaXR5Y2hhbmdlJywgKCkgPT4gewogICAgaWYgKGRvY3VtZW50LmhpZGRlbikgd2luZG93LnNjaGVkdWxlci5wYXVzZSgpOwogICAgZWxzZSB3aW5kb3cuc2NoZWR1bGVyLnJlc3VtZSgpOwogIH0pOwo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg==`;

function decodeBase64Utf8(b64) {
  const compact = b64.replace(/\s+/g, "");
  const binary = atob(compact);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function renderDashboardHtml() {
  return decodeBase64Utf8(DASHBOARD_HTML_B64);
}
