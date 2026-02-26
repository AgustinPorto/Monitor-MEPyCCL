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

const DASHBOARD_HTML_B64 = `PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVzIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+UmFkYXIgTUVQL0NDTCDCtyBNZXJjYWRvIEFSRzwvdGl0bGU+CjxsaW5rIHJlbD0icHJlY29ubmVjdCIgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbSI+CjxsaW5rIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20vY3NzMj9mYW1pbHk9U3BhY2UrTW9ubzp3Z2h0QDQwMDs3MDAmZmFtaWx5PVN5bmU6d2dodEA0MDA7NjAwOzcwMDs4MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c3R5bGU+Ci8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBUT0tFTlMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCjpyb290IHsKICAtLWJnOiAgICAgICAjMDgwYjBlOwogIC0tc3VyZjogICAgICMwZjEzMTg7CiAgLS1zdXJmMjogICAgIzE2MWIyMjsKICAtLXN1cmYzOiAgICAjMWMyMzMwOwogIC0tYm9yZGVyOiAgICMxZTI1MzA7CiAgLS1ib3JkZXJCOiAgIzJhMzQ0NDsKCiAgLS1ncmVlbjogICAgIzAwZTY3NjsKICAtLWdyZWVuLWQ6ICByZ2JhKDAsMjMwLDExOCwuMDkpOwogIC0tZ3JlZW4tZzogIHJnYmEoMCwyMzAsMTE4LC4yMik7CiAgLS1yZWQ6ICAgICAgI2ZmNDc1NzsKICAtLXJlZC1kOiAgICByZ2JhKDI1NSw3MSw4NywuMDkpOwogIC0teWVsbG93OiAgICNmZmMgYzAwOwogIC0teWVsbG93OiAgICNmZmNjMDA7CiAgLS15ZWxsb3ctZDogcmdiYSgyNTUsMjA0LDAsLjA5KTsKCiAgLS1tZXA6ICAgICAgIzI5YjZmNjsKICAtLWNjbDogICAgICAjYjM5ZGRiOwogIC0tdGV4dDogICAgICNkZGU0ZWU7CiAgLS1tdXRlZDogICAgIzU1NjA3MDsKICAtLW11dGVkMjogICAjN2E4ZmE4OwoKICAtLW1vbm86ICdTcGFjZSBNb25vJywgbW9ub3NwYWNlOwogIC0tc2FuczogJ1N5bmUnLCBzYW5zLXNlcmlmOwoKICAtLWRyYXdlci13OiA0MDBweDsKICAtLWhlYWRlci1oOiA1NHB4Owp9CgoqLCAqOjpiZWZvcmUsICo6OmFmdGVyIHsgYm94LXNpemluZzogYm9yZGVyLWJveDsgbWFyZ2luOiAwOyBwYWRkaW5nOiAwOyB9CgpodG1sIHsgc2Nyb2xsLWJlaGF2aW9yOiBzbW9vdGg7IH0KCmJvZHkgewogIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgZm9udC1mYW1pbHk6IHZhcigtLW1vbm8pOwogIG1pbi1oZWlnaHQ6IDEwMHZoOwogIG92ZXJmbG93LXg6IGhpZGRlbjsKfQoKYm9keTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogZml4ZWQ7IGluc2V0OiAwOwogIGJhY2tncm91bmQtaW1hZ2U6CiAgICBsaW5lYXItZ3JhZGllbnQocmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KSwKICAgIGxpbmVhci1ncmFkaWVudCg5MGRlZywgcmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KTsKICBiYWNrZ3JvdW5kLXNpemU6IDQ0cHggNDRweDsKICBwb2ludGVyLWV2ZW50czogbm9uZTsgei1pbmRleDogMDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIExBWU9VVCBTSEVMTArilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmFwcCB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBtaW4taGVpZ2h0OiAxMDB2aDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEhFQURFUgrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KaGVhZGVyIHsKICBwb3NpdGlvbjogc3RpY2t5OyB0b3A6IDA7IHotaW5kZXg6IDIwMDsKICBoZWlnaHQ6IHZhcigtLWhlYWRlci1oKTsKICBiYWNrZ3JvdW5kOiByZ2JhKDgsMTEsMTQsLjkzKTsKICBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMThweCk7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogMCAyMnB4OwogIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKfQoKLmxvZ28gewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6IDgwMDsgZm9udC1zaXplOiAxNXB4OwogIGxldHRlci1zcGFjaW5nOiAuMDVlbTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA5cHg7Cn0KCi5saXZlLWRvdCB7CiAgd2lkdGg6IDdweDsgaGVpZ2h0OiA3cHg7IGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbik7CiAgYm94LXNoYWRvdzogMCAwIDhweCB2YXIoLS1ncmVlbik7CiAgYW5pbWF0aW9uOiBibGluayAyLjJzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9CkBrZXlmcmFtZXMgYmxpbmsgewogIDAlLDEwMCV7b3BhY2l0eToxO2JveC1zaGFkb3c6MCAwIDhweCB2YXIoLS1ncmVlbik7fQogIDUwJXtvcGFjaXR5Oi4zNTtib3gtc2hhZG93OjAgMCAzcHggdmFyKC0tZ3JlZW4pO30KfQoKLmhlYWRlci1yaWdodCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTJweDsgfQoKLmZyZXNoLWJhZGdlIHsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDVweDsKICBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAyMHB4OyBwYWRkaW5nOiAzcHggMTFweDsKfQouZnJlc2gtZG90IHsgd2lkdGg6NXB4O2hlaWdodDo1cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDp2YXIoLS1ncmVlbik7YW5pbWF0aW9uOmJsaW5rIDIuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmZldGNoaW5nIHsgYW5pbWF0aW9uOiBiYWRnZVB1bHNlIDEuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmVycm9yIHsgY29sb3I6I2ZmZDBkMDsgYm9yZGVyLWNvbG9yOnJnYmEoMjU1LDgyLDgyLC40NSk7IGJhY2tncm91bmQ6cmdiYSgyNTUsODIsODIsLjEyKTsgY3Vyc29yOnBvaW50ZXI7IH0KQGtleWZyYW1lcyBiYWRnZVB1bHNlIHsKICAwJSwxMDAlIHsgb3BhY2l0eToxOyB9CiAgNTAlIHsgb3BhY2l0eTouNjU7IH0KfQoKLnRhZy1tZXJjYWRvIHsKICBmb250LWZhbWlseTogdmFyKC0tc2Fucyk7IGZvbnQtc2l6ZToxMHB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsKICBwYWRkaW5nOjNweCA5cHg7IGJvcmRlci1yYWRpdXM6NHB4Owp9Ci50YWctbWVyY2Fkby5jbG9zZWQgeyBiYWNrZ3JvdW5kOnZhcigtLW11dGVkKTsgY29sb3I6IzBhMGMwZjsgfQoKLmJ0biB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOyBmb250LXNpemU6MTFweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4wN2VtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgYm9yZGVyLXJhZGl1czo2cHg7IHBhZGRpbmc6NnB4IDE0cHg7IGN1cnNvcjpwb2ludGVyOwogIGJvcmRlcjpub25lOyB0cmFuc2l0aW9uOiBhbGwgLjE4czsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo2cHg7Cn0KLmJ0bi1hbGVydCB7IGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4pOyBjb2xvcjojMDAwOyB9Ci5idG4tYWxlcnQ6aG92ZXIgeyBiYWNrZ3JvdW5kOiMwMGZmODg7IHRyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpOyB9CgouYnRuLXRhc2FzIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMik7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6IHZhcigtLXRleHQpOwp9Ci5idG4tdGFzYXM6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMyk7IGJvcmRlci1jb2xvcjogdmFyKC0tbXV0ZWQyKTsgfQouYnRuLXRhc2FzLmFjdGl2ZSB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZjMpOwogIGJvcmRlci1jb2xvcjogdmFyKC0teWVsbG93KTsKICBjb2xvcjogdmFyKC0teWVsbG93KTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIE1BSU4gKyBEUkFXRVIgTEFZT1VUCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouYm9keS13cmFwIHsKICBmbGV4OiAxOwogIGRpc3BsYXk6IGZsZXg7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIHotaW5kZXg6IDE7CiAgdHJhbnNpdGlvbjogbm9uZTsKfQoKLm1haW4tY29udGVudCB7CiAgZmxleDogMTsKICBtYXgtd2lkdGg6IDEwMCU7CiAgcGFkZGluZzogMjJweCAyMnB4IDYwcHg7CiAgdHJhbnNpdGlvbjogbWFyZ2luLXJpZ2h0IC4zNXMgY3ViaWMtYmV6aWVyKC40LDAsLjIsMSk7Cn0KCi5ib2R5LXdyYXAuZHJhd2VyLW9wZW4gLm1haW4tY29udGVudCB7CiAgbWFyZ2luLXJpZ2h0OiB2YXIoLS1kcmF3ZXItdyk7Cn0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBEUkFXRVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5kcmF3ZXIgewogIHBvc2l0aW9uOiBmaXhlZDsKICB0b3A6IHZhcigtLWhlYWRlci1oKTsKICByaWdodDogMDsKICB3aWR0aDogdmFyKC0tZHJhd2VyLXcpOwogIGhlaWdodDogY2FsYygxMDB2aCAtIHZhcigtLWhlYWRlci1oKSk7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZik7CiAgYm9yZGVyLWxlZnQ6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHRyYW5zZm9ybTogdHJhbnNsYXRlWCgxMDAlKTsKICB0cmFuc2l0aW9uOiB0cmFuc2Zvcm0gLjM1cyBjdWJpYy1iZXppZXIoLjQsMCwuMiwxKTsKICBvdmVyZmxvdy15OiBhdXRvOwogIHotaW5kZXg6IDE1MDsKICBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwp9CgouZHJhd2VyLm9wZW4geyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMCk7IH0KCi5kcmF3ZXItcmVzaXplciB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IC00cHg7CiAgdG9wOiAwOwogIHdpZHRoOiA4cHg7CiAgaGVpZ2h0OiAxMDAlOwogIGN1cnNvcjogY29sLXJlc2l6ZTsKICB6LWluZGV4OiAxODA7Cn0KLmRyYXdlci1yZXNpemVyOjpiZWZvcmUgewogIGNvbnRlbnQ6ICcnOwogIHBvc2l0aW9uOiBhYnNvbHV0ZTsKICBsZWZ0OiAzcHg7CiAgdG9wOiAwOwogIHdpZHRoOiAycHg7CiAgaGVpZ2h0OiAxMDAlOwogIGJhY2tncm91bmQ6IHRyYW5zcGFyZW50OwogIHRyYW5zaXRpb246IGJhY2tncm91bmQgLjE1czsKfQouZHJhd2VyLXJlc2l6ZXI6aG92ZXI6OmJlZm9yZSwKLmRyYXdlci1yZXNpemVyLmFjdGl2ZTo6YmVmb3JlIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1tdXRlZDIpOwp9CgouZHJhd2VyLWhlYWRlciB7CiAgcG9zaXRpb246IHN0aWNreTsgdG9wOiAwOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYpOwogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHBhZGRpbmc6IDE2cHggMjBweDsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgei1pbmRleDogMTA7Cn0KCi5kcmF3ZXItdGl0bGUgewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6IDgwMDsgZm9udC1zaXplOiAxM3B4OwogIGxldHRlci1zcGFjaW5nOi4wNGVtOyBjb2xvcjogdmFyKC0tdGV4dCk7CiAgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6OHB4Owp9CgouZHJhd2VyLXNvdXJjZSB7CiAgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgZm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7Cn0KCi5idG4tY2xvc2UgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgY29sb3I6dmFyKC0tbXV0ZWQyKTsgYm9yZGVyLXJhZGl1czo2cHg7IHBhZGRpbmc6NXB4IDEwcHg7CiAgY3Vyc29yOnBvaW50ZXI7IGZvbnQtc2l6ZToxM3B4OyB0cmFuc2l0aW9uOiBhbGwgLjE1czsKfQouYnRuLWNsb3NlOmhvdmVyIHsgY29sb3I6dmFyKC0tdGV4dCk7IGJvcmRlci1jb2xvcjp2YXIoLS1tdXRlZDIpOyB9CgouZHJhd2VyLWJvZHkgeyBwYWRkaW5nOiAxNnB4IDIwcHg7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogMjJweDsgfQoKLmNvbnRleHQtYm94IHsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyMDQsMCwuMDYpOwogIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjU1LDIwNCwwLC4yKTsKICBib3JkZXItcmFkaXVzOiA5cHg7CiAgcGFkZGluZzogMTNweCAxNXB4OwogIGZvbnQtc2l6ZTogMTFweDsKICBsaW5lLWhlaWdodDoxLjY1OwogIGNvbG9yOnZhcigtLW11dGVkMik7Cn0KLmNvbnRleHQtYm94IHN0cm9uZyB7IGNvbG9yOnZhcigtLXllbGxvdyk7IH0KCi5mY2ktaGVhZGVyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBiYXNlbGluZTsKICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgZ2FwOiAxMHB4Owp9Ci5mY2ktdGl0bGUgewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsKICBmb250LXNpemU6IDEycHg7CiAgZm9udC13ZWlnaHQ6IDcwMDsKICBsZXR0ZXItc3BhY2luZzogLjA1ZW07CiAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsKICBjb2xvcjogdmFyKC0tdGV4dCk7Cn0KLmZjaS10aXRsZS13cmFwIHsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgZ2FwOiA4cHg7Cn0KLmZjaS10YWJzIHsKICBkaXNwbGF5OiBmbGV4OwogIGdhcDogOHB4OwogIGZsZXgtd3JhcDogd3JhcDsKfQouZmNpLXRhYi1idG4gewogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsKICBjb2xvcjogdmFyKC0tbXV0ZWQyKTsKICBib3JkZXItcmFkaXVzOiA5OTlweDsKICBmb250LXNpemU6IDEwcHg7CiAgZm9udC13ZWlnaHQ6IDcwMDsKICBsZXR0ZXItc3BhY2luZzogLjA1ZW07CiAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsKICBwYWRkaW5nOiA0cHggMTBweDsKICBjdXJzb3I6IHBvaW50ZXI7Cn0KLmZjaS10YWItYnRuLmFjdGl2ZSB7CiAgY29sb3I6IHZhcigtLXllbGxvdyk7CiAgYm9yZGVyLWNvbG9yOiB2YXIoLS15ZWxsb3cpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LCAyMDQsIDAsIC4wOCk7Cn0KLmZjaS1tZXRhIHsKICBmb250LXNpemU6IDEwcHg7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKfQouZmNpLXRhYmxlLXdyYXAgewogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czogMTBweDsKICBvdmVyZmxvdzogYXV0bzsKfQouZmNpLXRhYmxlIHsKICB3aWR0aDogMTAwJTsKICBtaW4td2lkdGg6IDk4MHB4OwogIGJvcmRlci1jb2xsYXBzZTogY29sbGFwc2U7CiAgdGFibGUtbGF5b3V0OiBmaXhlZDsKfQouZmNpLXRhYmxlIHRoZWFkIHRoIHsKICBwb3NpdGlvbjogc3RpY2t5OwogIHRvcDogMDsKICB6LWluZGV4OiA1OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsKICBjb2xvcjogdmFyKC0tbXV0ZWQyKTsKICBmb250LXNpemU6IDEwcHg7CiAgbGV0dGVyLXNwYWNpbmc6IC4wOGVtOwogIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7CiAgdGV4dC1hbGlnbjogbGVmdDsKICBwYWRkaW5nOiA5cHggMTBweDsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouZmNpLXRhYmxlIHRoZWFkIHRoOmhvdmVyIHsKICB6LWluZGV4OiA4MDsKfQouZmNpLXRhYmxlIHRib2R5IHRyIHsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouZmNpLXRhYmxlIHRib2R5IHRyOmxhc3QtY2hpbGQgewogIGJvcmRlci1ib3R0b206IG5vbmU7Cn0KLmZjaS10YWJsZSB0ZCB7CiAgZm9udC1zaXplOiAxMXB4OwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBwYWRkaW5nOiA5cHggMTBweDsKICBvdmVyZmxvdzogaGlkZGVuOwogIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7Cn0KLmZjaS10YWJsZSB0ZC5mY2ktc2lnbmFsLWNlbGwgewogIHdoaXRlLXNwYWNlOiBub3JtYWw7CiAgb3ZlcmZsb3c6IHZpc2libGU7CiAgdGV4dC1vdmVyZmxvdzogY2xpcDsKfQouZmNpLWNvbC1sYWJlbCB7CiAgcGFkZGluZy1yaWdodDogMTBweDsKICBkaXNwbGF5OiBpbmxpbmUtYmxvY2s7Cn0KLmZjaS1jb2wtcmVzaXplciB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIHRvcDogMDsKICByaWdodDogLTRweDsKICB3aWR0aDogOHB4OwogIGhlaWdodDogMTAwJTsKICBjdXJzb3I6IGNvbC1yZXNpemU7CiAgdXNlci1zZWxlY3Q6IG5vbmU7CiAgdG91Y2gtYWN0aW9uOiBub25lOwogIHotaW5kZXg6IDM7Cn0KLmZjaS1jb2wtcmVzaXplcjo6YWZ0ZXIgewogIGNvbnRlbnQ6ICcnOwogIHBvc2l0aW9uOiBhYnNvbHV0ZTsKICB0b3A6IDZweDsKICBib3R0b206IDZweDsKICBsZWZ0OiAzcHg7CiAgd2lkdGg6IDFweDsKICBiYWNrZ3JvdW5kOiByZ2JhKDEyMiwxNDMsMTY4LC4yOCk7Cn0KLmZjaS1jb2wtcmVzaXplcjpob3Zlcjo6YWZ0ZXIsCi5mY2ktY29sLXJlc2l6ZXIuYWN0aXZlOjphZnRlciB7CiAgYmFja2dyb3VuZDogcmdiYSgxMjIsMTQzLDE2OCwuNzUpOwp9Ci5mY2ktZW1wdHkgewogIGZvbnQtc2l6ZTogMTFweDsKICBjb2xvcjogdmFyKC0tbXV0ZWQyKTsKICBwYWRkaW5nOiAxMnB4OwogIGJvcmRlcjogMXB4IGRhc2hlZCB2YXIoLS1ib3JkZXJCKTsKICBib3JkZXItcmFkaXVzOiAxMHB4Owp9Ci5mY2ktY29udHJvbHMgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgZ2FwOiAxMHB4Owp9Ci5mY2ktc2VhcmNoIHsKICB3aWR0aDogMTAwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMik7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6IHZhcigtLXRleHQpOwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBwYWRkaW5nOiA4cHggMTBweDsKICBmb250LXNpemU6IDExcHg7CiAgb3V0bGluZTogbm9uZTsKfQouZmNpLXNlYXJjaDpmb2N1cyB7CiAgYm9yZGVyLWNvbG9yOiB2YXIoLS1tdXRlZDIpOwp9Ci5mY2ktcGFnaW5hdGlvbiB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogOHB4OwogIGZsZXgtc2hyaW5rOiAwOwp9Ci5mY2ktcGFnZS1idG4gewogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgYm9yZGVyLXJhZGl1czogNnB4OwogIGZvbnQtc2l6ZTogMTBweDsKICBmb250LXdlaWdodDogNzAwOwogIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7CiAgbGV0dGVyLXNwYWNpbmc6IC4wNmVtOwogIHBhZGRpbmc6IDVweCA4cHg7CiAgY3Vyc29yOiBwb2ludGVyOwp9Ci5mY2ktcGFnZS1idG46ZGlzYWJsZWQgewogIG9wYWNpdHk6IC40OwogIGN1cnNvcjogZGVmYXVsdDsKfQouZmNpLXBhZ2UtaW5mbyB7CiAgZm9udC1zaXplOiAxMHB4OwogIGNvbG9yOiB2YXIoLS1tdXRlZDIpOwp9Ci5mY2ktYmVuY2ggewogIGZvbnQtc2l6ZTogMTBweDsKICBjb2xvcjogdmFyKC0tbXV0ZWQyKTsKICBwYWRkaW5nOiA2cHggMnB4IDA7Cn0KLmZjaS1iZW5jaCBzdHJvbmcgewogIGNvbG9yOiB2YXIoLS10ZXh0KTsKfQouZmNpLXRyZW5kIHsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNXB4Owp9Ci5mY2ktdHJlbmQtaWNvbiB7CiAgZm9udC1zaXplOiAxMHB4OwogIGZvbnQtd2VpZ2h0OiA3MDA7Cn0KLmZjaS10cmVuZC51cCAuZmNpLXRyZW5kLWljb24geyBjb2xvcjogdmFyKC0tZ3JlZW4pOyB9Ci5mY2ktdHJlbmQuZG93biAuZmNpLXRyZW5kLWljb24geyBjb2xvcjogdmFyKC0tcmVkKTsgfQouZmNpLXRyZW5kLmZsYXQgLmZjaS10cmVuZC1pY29uIHsgY29sb3I6IHZhcigtLW11dGVkMik7IH0KLmZjaS10cmVuZC5uYSAuZmNpLXRyZW5kLWljb24geyBjb2xvcjogdmFyKC0tbXV0ZWQpOyB9Ci5mY2ktc2lnbmFsIHsKICBkaXNwbGF5OiBpbmxpbmUtYmxvY2s7CiAgYm9yZGVyLXJhZGl1czogOTk5cHg7CiAgZm9udC1zaXplOiAxMHB4OwogIGZvbnQtd2VpZ2h0OiA3MDA7CiAgbGV0dGVyLXNwYWNpbmc6IC4wNGVtOwogIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7CiAgcGFkZGluZzogMnB4IDhweDsKfQouZmNpLXNpZ25hbC5nb29kIHsKICBjb2xvcjogdmFyKC0tZ3JlZW4pOwogIGJhY2tncm91bmQ6IHZhcigtLWdyZWVuLWQpOwogIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMCwyMzAsMTE4LC4yNSk7Cn0KLmZjaS1zaWduYWwud2FybiB7CiAgY29sb3I6IHZhcigtLXllbGxvdyk7CiAgYmFja2dyb3VuZDogcmdiYSgyNTUsMjA0LDAsLjEwKTsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwyMDQsMCwuMjUpOwp9Ci5mY2ktc2lnbmFsLm9qbyB7CiAgY29sb3I6ICNmZmI4NmI7CiAgYmFja2dyb3VuZDogcmdiYSgyNTUsIDE0MCwgMCwgLjE0KTsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwgMTYyLCA3OCwgLjMwKTsKfQouZmNpLXNpZ25hbC5pbmZvIHsKICBjb2xvcjogIzdiYzZmZjsKICBiYWNrZ3JvdW5kOiByZ2JhKDQxLDE4MiwyNDYsLjEyKTsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDQxLDE4MiwyNDYsLjMpOwp9Ci5mY2ktc2lnbmFsLmJhZCB7CiAgY29sb3I6ICNmZjdmOGE7CiAgYmFja2dyb3VuZDogdmFyKC0tcmVkLWQpOwogIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjU1LDcxLDg3LC4yNSk7Cn0KLmZjaS1zaWduYWwubmEgewogIGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6IHJnYmEoMTIyLDE0MywxNjgsLjEwKTsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDEyMiwxNDMsMTY4LC4yNSk7Cn0KLmZjaS1zaWduYWwtd3JhcCB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBhbGlnbi1pdGVtczogZmxleC1zdGFydDsKICBnYXA6IDNweDsKfQouZmNpLXNpZ25hbC1zdHJlYWsgewogIGZvbnQtc2l6ZTogOXB4OwogIGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGxldHRlci1zcGFjaW5nOiAuMDJlbTsKICBsaW5lLWhlaWdodDogMS4yNTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIFNUQVRVUyBCQU5ORVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5zdGF0dXMtYmFubmVyIHsKICBib3JkZXItcmFkaXVzOjExcHg7IHBhZGRpbmc6MThweCAyNHB4OyBtYXJnaW4tYm90dG9tOjIwcHg7CiAgYm9yZGVyOjFweCBzb2xpZDsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgYW5pbWF0aW9uOmZhZGVJbiAuNHMgZWFzZTsKICBvdmVyZmxvdzpoaWRkZW47IHBvc2l0aW9uOnJlbGF0aXZlOwp9Ci5zdGF0dXMtYmFubmVyLnNpbWlsYXIgewogIGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4tZCk7IGJvcmRlci1jb2xvcjpyZ2JhKDAsMjMwLDExOCwuMjgpOwp9Ci5zdGF0dXMtYmFubmVyLnNpbWlsYXI6OmFmdGVyIHsKICBjb250ZW50OicnOyBwb3NpdGlvbjphYnNvbHV0ZTsgcmlnaHQ6LTUwcHg7IHRvcDo1MCU7CiAgdHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTUwJSk7IHdpZHRoOjIwMHB4OyBoZWlnaHQ6MjAwcHg7CiAgYm9yZGVyLXJhZGl1czo1MCU7CiAgYmFja2dyb3VuZDpyYWRpYWwtZ3JhZGllbnQoY2lyY2xlLHZhcigtLWdyZWVuLWcpIDAlLHRyYW5zcGFyZW50IDcwJSk7CiAgcG9pbnRlci1ldmVudHM6bm9uZTsKfQouc3RhdHVzLWJhbm5lci5uby1zaW1pbGFyIHsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSw4Miw4MiwuMDgpOwogIGJvcmRlci1jb2xvcjogcmdiYSgyNTUsODIsODIsLjM1KTsKfQouc3RhdHVzLWJhbm5lci5uby1zaW1pbGFyOjphZnRlciB7CiAgY29udGVudDonJzsKICBwb3NpdGlvbjphYnNvbHV0ZTsKICByaWdodDotNTBweDsKICB0b3A6NTAlOwogIHRyYW5zZm9ybTp0cmFuc2xhdGVZKC01MCUpOwogIHdpZHRoOjIwMHB4OwogIGhlaWdodDoyMDBweDsKICBib3JkZXItcmFkaXVzOjUwJTsKICBiYWNrZ3JvdW5kOnJhZGlhbC1ncmFkaWVudChjaXJjbGUscmdiYSgyNTUsODIsODIsLjE4KSAwJSx0cmFuc3BhcmVudCA3MCUpOwogIHBvaW50ZXItZXZlbnRzOm5vbmU7Cn0KCi5zLWxlZnQge30KLnMtdGl0bGUgewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo4MDA7IGZvbnQtc2l6ZToyNnB4OwogIGxldHRlci1zcGFjaW5nOi0uMDJlbTsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDoxMnB4Owp9Ci5zLWJhZGdlIHsKICBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOyBsZXR0ZXItc3BhY2luZzouMWVtOwogIHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgcGFkZGluZzoycHggOXB4OyBib3JkZXItcmFkaXVzOjRweDsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsgYWxpZ24tc2VsZjpjZW50ZXI7Cn0KLnMtYmFkZ2Uubm9zaW0geyBiYWNrZ3JvdW5kOiB2YXIoLS1yZWQpOyBjb2xvcjogI2ZmZjsgfQoucy1zdWIgeyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgbWFyZ2luLXRvcDo0cHg7IH0KCi5lcnJvci1iYW5uZXIgewogIGRpc3BsYXk6bm9uZTsKICBtYXJnaW46IDAgMCAxNHB4IDA7CiAgcGFkZGluZzogMTBweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSw4Miw4MiwuNDUpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDgyLDgyLC4xMik7CiAgY29sb3I6ICNmZmQwZDA7CiAgZm9udC1zaXplOiAxMXB4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOwogIGdhcDogMTBweDsKfQouZXJyb3ItYmFubmVyLnNob3cgeyBkaXNwbGF5OmZsZXg7IH0KLmVycm9yLWJhbm5lciBidXR0b24gewogIGJvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsODIsODIsLjUpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDgyLDgyLC4xNSk7CiAgY29sb3I6I2ZmZGVkZTsKICBib3JkZXItcmFkaXVzOjZweDsKICBwYWRkaW5nOjRweCAxMHB4OwogIGZvbnQtc2l6ZToxMHB4OwogIGZvbnQtd2VpZ2h0OjcwMDsKICB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgbGV0dGVyLXNwYWNpbmc6LjA2ZW07CiAgY3Vyc29yOnBvaW50ZXI7Cn0KCi5za2VsZXRvbiB7CiAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDkwZGVnLCAjMWMyMzMwIDI1JSwgIzJhMzQ0NCA1MCUsICMxYzIzMzAgNzUlKTsKICBiYWNrZ3JvdW5kLXNpemU6IDIwMCUgMTAwJTsKICBhbmltYXRpb246IHNoaW1tZXIgMS40cyBpbmZpbml0ZTsKICBib3JkZXItcmFkaXVzOiA0cHg7CiAgY29sb3I6IHRyYW5zcGFyZW50OwogIHVzZXItc2VsZWN0OiBub25lOwp9CkBrZXlmcmFtZXMgc2hpbW1lciB7CiAgMCUgICB7IGJhY2tncm91bmQtcG9zaXRpb246IDIwMCUgMDsgfQogIDEwMCUgeyBiYWNrZ3JvdW5kLXBvc2l0aW9uOiAtMjAwJSAwOyB9Cn0KCi52YWx1ZS1jaGFuZ2VkIHsKICBhbmltYXRpb246IGZsYXNoVmFsdWUgNjAwbXMgZWFzZTsKfQpAa2V5ZnJhbWVzIGZsYXNoVmFsdWUgewogIDAlICAgeyBjb2xvcjogI2ZmY2MwMDsgfQogIDEwMCUgeyBjb2xvcjogaW5oZXJpdDsgfQp9Cgoucy1yaWdodCB7IHRleHQtYWxpZ246cmlnaHQ7IGZvbnQtc2l6ZToxMXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IGxpbmUtaGVpZ2h0OjEuOTsgfQoucy1yaWdodCBzdHJvbmcgeyBjb2xvcjp2YXIoLS1tdXRlZDIpOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgSEVSTyBDQVJEUwrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmhlcm8tZ3JpZCB7CiAgZGlzcGxheTpncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmciAxZnI7CiAgZ2FwOjE0cHg7IG1hcmdpbi1ib3R0b206MjBweDsKfQoKLmhjYXJkIHsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBwYWRkaW5nOjIwcHggMjJweDsKICBwb3NpdGlvbjpyZWxhdGl2ZTsgb3ZlcmZsb3c6aGlkZGVuOwogIHRyYW5zaXRpb246Ym9yZGVyLWNvbG9yIC4xOHM7CiAgYW5pbWF0aW9uOiBmYWRlVXAgLjVzIGVhc2UgYm90aDsKfQouaGNhcmQ6bnRoLWNoaWxkKDEpe2FuaW1hdGlvbi1kZWxheTouMDhzO30KLmhjYXJkOm50aC1jaGlsZCgyKXthbmltYXRpb24tZGVsYXk6LjE2czt9Ci5oY2FyZDpudGgtY2hpbGQoMyl7YW5pbWF0aW9uLWRlbGF5Oi4yNHM7fQouaGNhcmQ6aG92ZXIgeyBib3JkZXItY29sb3I6dmFyKC0tYm9yZGVyQik7IH0KCi5oY2FyZCAuYmFyIHsgcG9zaXRpb246YWJzb2x1dGU7IHRvcDowO2xlZnQ6MDtyaWdodDowOyBoZWlnaHQ6MnB4OyB9Ci5oY2FyZC5tZXAgLmJhciB7IGJhY2tncm91bmQ6dmFyKC0tbWVwKTsgfQouaGNhcmQuY2NsIC5iYXIgeyBiYWNrZ3JvdW5kOnZhcigtLWNjbCk7IH0KLmhjYXJkLmdhcCAuYmFyIHsgYmFja2dyb3VuZDp2YXIoLS15ZWxsb3cpOyB9CgouaGNhcmQtbGFiZWwgewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4xMmVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IGNvbG9yOnZhcigtLW11dGVkKTsKICBtYXJnaW4tYm90dG9tOjlweDsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo1cHg7Cn0KLmhjYXJkLWxhYmVsIC5kb3QgeyB3aWR0aDo1cHg7aGVpZ2h0OjVweDtib3JkZXItcmFkaXVzOjUwJTsgfQoubWVwIC5kb3R7YmFja2dyb3VuZDp2YXIoLS1tZXApO30KLmNjbCAuZG90e2JhY2tncm91bmQ6dmFyKC0tY2NsKTt9Ci5nYXAgLmRvdHtiYWNrZ3JvdW5kOnZhcigtLXllbGxvdyk7fQoKLmhjYXJkLXZhbCB7CiAgZm9udC1zaXplOjM0cHg7IGZvbnQtd2VpZ2h0OjcwMDsgbGV0dGVyLXNwYWNpbmc6LS4wMmVtOyBsaW5lLWhlaWdodDoxOwp9Ci5tZXAgLmhjYXJkLXZhbHtjb2xvcjp2YXIoLS1tZXApO30KLmNjbCAuaGNhcmQtdmFse2NvbG9yOnZhcigtLWNjbCk7fQoKLmhjYXJkLXBjdCB7IGZvbnQtc2l6ZToyMHB4OyBjb2xvcjp2YXIoLS15ZWxsb3cpOyBmb250LXdlaWdodDo3MDA7IG1hcmdpbi10b3A6M3B4OyB9Ci5oY2FyZC1zdWIgeyBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tdG9wOjdweDsgfQoKLyogdG9vbHRpcCAqLwoudGlwIHsgcG9zaXRpb246cmVsYXRpdmU7IGN1cnNvcjpoZWxwOyB9Ci50aXA6OmFmdGVyIHsKICBjb250ZW50OmF0dHIoZGF0YS10KTsKICBwb3NpdGlvbjphYnNvbHV0ZTsgYm90dG9tOmNhbGMoMTAwJSArIDdweCk7IGxlZnQ6NTAlOwogIHRyYW5zZm9ybTp0cmFuc2xhdGVYKC01MCUpOwogIGJhY2tncm91bmQ6IzFhMjIzMjsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsKICBjb2xvcjp2YXIoLS10ZXh0KTsgZm9udC1zaXplOjEwcHg7IHBhZGRpbmc6NXB4IDlweDsKICBib3JkZXItcmFkaXVzOjZweDsgd2hpdGUtc3BhY2U6bm93cmFwOwogIG9wYWNpdHk6MDsgcG9pbnRlci1ldmVudHM6bm9uZTsgdHJhbnNpdGlvbjpvcGFjaXR5IC4xOHM7IHotaW5kZXg6OTk7Cn0KLnRpcDpob3Zlcjo6YWZ0ZXJ7b3BhY2l0eToxO30KLnRpcC50aXAtZG93bjo6YWZ0ZXIgewogIGRpc3BsYXk6IG5vbmU7Cn0KCi5zbWFydC10aXAgewogIHBvc2l0aW9uOiBmaXhlZDsKICBsZWZ0OiAwOwogIHRvcDogMDsKICBtYXgtd2lkdGg6IG1pbigyODBweCwgY2FsYygxMDB2dyAtIDE2cHgpKTsKICBiYWNrZ3JvdW5kOiAjMWEyMjMyOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlckIpOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBmb250LXNpemU6IDEwcHg7CiAgbGluZS1oZWlnaHQ6IDEuNDU7CiAgcGFkZGluZzogNnB4IDlweDsKICBib3JkZXItcmFkaXVzOiA2cHg7CiAgei1pbmRleDogNDAwOwogIG9wYWNpdHk6IDA7CiAgcG9pbnRlci1ldmVudHM6IG5vbmU7CiAgdHJhbnNpdGlvbjogb3BhY2l0eSAuMTJzOwp9Ci5zbWFydC10aXAuc2hvdyB7CiAgb3BhY2l0eTogMTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIENIQVJUCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouY2hhcnQtY2FyZCB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmKTsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6MTFweDsgcGFkZGluZzoyMnB4OyBtYXJnaW4tYm90dG9tOjIwcHg7CiAgYW5pbWF0aW9uOmZhZGVVcCAuNXMgLjMycyBlYXNlIGJvdGg7Cn0KLmNoYXJ0LXRvcCB7CiAgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGp1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuOwogIG1hcmdpbi1ib3R0b206MTZweDsKfQouY2hhcnQtdHRsIHsgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtd2VpZ2h0OjcwMDsgZm9udC1zaXplOjEzcHg7IH0KCi5waWxscyB7IGRpc3BsYXk6ZmxleDsgZ2FwOjVweDsgfQoucGlsbCB7CiAgZm9udC1zaXplOjEwcHg7IHBhZGRpbmc6M3B4IDExcHg7IGJvcmRlci1yYWRpdXM6MjBweDsKICBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlckIpOyBjb2xvcjp2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6dHJhbnNwYXJlbnQ7IGN1cnNvcjpwb2ludGVyOyBmb250LWZhbWlseTp2YXIoLS1tb25vKTsKICB0cmFuc2l0aW9uOmFsbCAuMTNzOwp9Ci5waWxsLm9uIHsgYmFja2dyb3VuZDp2YXIoLS1tZXApOyBib3JkZXItY29sb3I6dmFyKC0tbWVwKTsgY29sb3I6IzAwMDsgZm9udC13ZWlnaHQ6NzAwOyB9CgoubGVnZW5kcyB7IGRpc3BsYXk6ZmxleDsgZ2FwOjE4cHg7IG1hcmdpbi1ib3R0b206MTRweDsgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkMik7IH0KLmxlZyB7IGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6NXB4OyB9Ci5sZWctbGluZSB7IHdpZHRoOjE4cHg7IGhlaWdodDoycHg7IGJvcmRlci1yYWRpdXM6MnB4OyB9CgpzdmcuY2hhcnQgeyB3aWR0aDoxMDAlOyBoZWlnaHQ6MTcwcHg7IG92ZXJmbG93OnZpc2libGU7IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBNRVRSSUNTCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwoubWV0cmljcy1ncmlkIHsKICBkaXNwbGF5OmdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNCwxZnIpOwogIGdhcDoxMnB4OyBtYXJnaW4tYm90dG9tOjIwcHg7Cn0KLm1jYXJkIHsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYyKTsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6OXB4OyBwYWRkaW5nOjE0cHggMTZweDsKICBhbmltYXRpb246ZmFkZVVwIC41cyBlYXNlIGJvdGg7Cn0KLm1jYXJkOm50aC1jaGlsZCgxKXthbmltYXRpb24tZGVsYXk6LjM4czt9Ci5tY2FyZDpudGgtY2hpbGQoMil7YW5pbWF0aW9uLWRlbGF5Oi40M3M7fQoubWNhcmQ6bnRoLWNoaWxkKDMpe2FuaW1hdGlvbi1kZWxheTouNDhzO30KLm1jYXJkOm50aC1jaGlsZCg0KXthbmltYXRpb24tZGVsYXk6LjUzczt9Ci5tY2FyZC1sYWJlbCB7CiAgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtc2l6ZTo5cHg7IGZvbnQtd2VpZ2h0OjcwMDsKICBsZXR0ZXItc3BhY2luZzouMWVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IGNvbG9yOnZhcigtLW11dGVkKTsgbWFyZ2luLWJvdHRvbTo3cHg7Cn0KLm1jYXJkLXZhbCB7IGZvbnQtc2l6ZToyMHB4OyBmb250LXdlaWdodDo3MDA7IH0KLm1jYXJkLXN1YiB7IGZvbnQtc2l6ZTo5cHg7IGNvbG9yOnZhcigtLW11dGVkKTsgbWFyZ2luLXRvcDozcHg7IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBUQUJMRQrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLnRhYmxlLWNhcmQgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZik7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOjExcHg7IG92ZXJmbG93OmhpZGRlbjsKICBhbmltYXRpb246ZmFkZVVwIC41cyAuNTZzIGVhc2UgYm90aDsKfQoudGFibGUtdG9wIHsKICBwYWRkaW5nOjE0cHggMjJweDsgYm9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Cn0KLnRhYmxlLXR0bCB7IGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo3MDA7IGZvbnQtc2l6ZToxM3B4OyB9Ci50YWJsZS1yaWdodCB7IGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6MTBweDsgfQoudGFibGUtY2FwIHsgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgfQouYnRuLWRvd25sb2FkIHsKICBkaXNwbGF5OmlubGluZS1mbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo2cHg7CiAgaGVpZ2h0OjI2cHg7IHBhZGRpbmc6MCAxMHB4OyBib3JkZXItcmFkaXVzOjdweDsKICBib3JkZXI6MXB4IHNvbGlkICMyZjRmNjg7IGJhY2tncm91bmQ6cmdiYSg0MSwxODIsMjQ2LDAuMDYpOwogIGNvbG9yOiM4ZmQ4ZmY7IGN1cnNvcjpwb2ludGVyOyBmb250LWZhbWlseTp2YXIoLS1tb25vKTsgZm9udC1zaXplOjEwcHg7CiAgbGV0dGVyLXNwYWNpbmc6LjAyZW07CiAgdHJhbnNpdGlvbjpib3JkZXItY29sb3IgLjE1cyBlYXNlLCBiYWNrZ3JvdW5kIC4xNXMgZWFzZSwgY29sb3IgLjE1cyBlYXNlLCBib3gtc2hhZG93IC4xNXMgZWFzZTsKfQouYnRuLWRvd25sb2FkIHN2ZyB7CiAgd2lkdGg6MTJweDsgaGVpZ2h0OjEycHg7IHN0cm9rZTpjdXJyZW50Q29sb3I7IGZpbGw6bm9uZTsgc3Ryb2tlLXdpZHRoOjEuODsKfQouYnRuLWRvd25sb2FkOmhvdmVyIHsKICBib3JkZXItY29sb3I6IzRmYzNmNzsgYmFja2dyb3VuZDpyZ2JhKDQxLDE4MiwyNDYsMC4xNik7CiAgY29sb3I6I2M2ZWNmZjsgYm94LXNoYWRvdzowIDAgMCAxcHggcmdiYSg3OSwxOTUsMjQ3LC4xOCkgaW5zZXQ7Cn0KCi5oaXN0b3J5LXRhYmxlLXdyYXAgeyBvdmVyZmxvdy14OmF1dG87IH0KLmhpc3RvcnktdGFibGUtd3JhcCB0YWJsZSB7CiAgbWluLXdpZHRoOiA4NjBweDsKfQp0YWJsZSB7IHdpZHRoOjEwMCU7IGJvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTsgdGFibGUtbGF5b3V0OmZpeGVkOyB9CnRoZWFkIHRoIHsKICBmb250LXNpemU6OXB4OyBsZXR0ZXItc3BhY2luZzouMWVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgY29sb3I6dmFyKC0tbXV0ZWQpOyBwYWRkaW5nOjlweCAyMnB4OyB0ZXh0LWFsaWduOmxlZnQ7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmMik7IGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo2MDA7CiAgcG9zaXRpb246cmVsYXRpdmU7Cn0KdGJvZHkgdHIgeyBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyB0cmFuc2l0aW9uOmJhY2tncm91bmQgLjEyczsgfQp0Ym9keSB0cjpob3ZlciB7IGJhY2tncm91bmQ6cmdiYSg0MSwxODIsMjQ2LC4wNCk7IH0KdGJvZHkgdHI6bGFzdC1jaGlsZCB7IGJvcmRlci1ib3R0b206bm9uZTsgfQp0Ym9keSB0ZCB7CiAgcGFkZGluZzoxMXB4IDIycHg7IGZvbnQtc2l6ZToxMnB4OwogIG92ZXJmbG93OmhpZGRlbjsgdGV4dC1vdmVyZmxvdzplbGxpcHNpczsgd2hpdGUtc3BhY2U6bm93cmFwOwp9CnRkLmRpbSB7IGNvbG9yOnZhcigtLW11dGVkMik7IGZvbnQtc2l6ZToxMXB4OyB9CnRkLmRpbSAudHMtZGF5IHsgZm9udC1zaXplOjlweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBsaW5lLWhlaWdodDoxLjE7IH0KdGQuZGltIC50cy1ob3VyIHsgZm9udC1zaXplOjExcHg7IGNvbG9yOnZhcigtLW11dGVkMik7IGxpbmUtaGVpZ2h0OjEuMjsgbWFyZ2luLXRvcDoycHg7IH0KLmNvbC1sYWJlbCB7IHBhZGRpbmctcmlnaHQ6MTBweDsgZGlzcGxheTppbmxpbmUtYmxvY2s7IH0KLmNvbC1yZXNpemVyIHsKICBwb3NpdGlvbjphYnNvbHV0ZTsKICB0b3A6MDsKICByaWdodDotNHB4OwogIHdpZHRoOjhweDsKICBoZWlnaHQ6MTAwJTsKICBjdXJzb3I6Y29sLXJlc2l6ZTsKICB1c2VyLXNlbGVjdDpub25lOwogIHRvdWNoLWFjdGlvbjpub25lOwogIHotaW5kZXg6MjsKfQouY29sLXJlc2l6ZXI6OmFmdGVyIHsKICBjb250ZW50OicnOwogIHBvc2l0aW9uOmFic29sdXRlOwogIHRvcDo2cHg7CiAgYm90dG9tOjZweDsKICBsZWZ0OjNweDsKICB3aWR0aDoxcHg7CiAgYmFja2dyb3VuZDpyZ2JhKDEyMiwxNDMsMTY4LC4yOCk7Cn0KLmNvbC1yZXNpemVyOmhvdmVyOjphZnRlciwKLmNvbC1yZXNpemVyLmFjdGl2ZTo6YWZ0ZXIgewogIGJhY2tncm91bmQ6cmdiYSgxMjIsMTQzLDE2OCwuNzUpOwp9Cgouc2JhZGdlIHsKICBkaXNwbGF5OmlubGluZS1ibG9jazsgZm9udC1zaXplOjlweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4wOGVtOyBwYWRkaW5nOjJweCA3cHg7IGJvcmRlci1yYWRpdXM6NHB4OwogIHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKfQouc2JhZGdlLnNpbSB7IGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4tZCk7IGNvbG9yOnZhcigtLWdyZWVuKTsgYm9yZGVyOjFweCBzb2xpZCByZ2JhKDAsMjMwLDExOCwuMik7IH0KLnNiYWRnZS5ub3NpbSB7IGJhY2tncm91bmQ6dmFyKC0tcmVkLWQpOyBjb2xvcjp2YXIoLS1yZWQpOyBib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjU1LDcxLDg3LC4yKTsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEZPT1RFUiAvIEdMT1NBUklPCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouZ2xvc2FyaW8gewogIG1hcmdpbi10b3A6MjBweDsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6MTFweDsgb3ZlcmZsb3c6aGlkZGVuOwogIGFuaW1hdGlvbjpmYWRlVXAgLjVzIC42cyBlYXNlIGJvdGg7Cn0KLmdsb3MtYnRuIHsKICB3aWR0aDoxMDAlOyBiYWNrZ3JvdW5kOnZhcigtLXN1cmYpOyBib3JkZXI6bm9uZTsKICBjb2xvcjp2YXIoLS1tdXRlZDIpOyBmb250LWZhbWlseTp2YXIoLS1tb25vKTsgZm9udC1zaXplOjExcHg7CiAgcGFkZGluZzoxM3B4IDIycHg7IHRleHQtYWxpZ246bGVmdDsgY3Vyc29yOnBvaW50ZXI7CiAgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGp1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuOwogIHRyYW5zaXRpb246Y29sb3IgLjE1czsKfQouZ2xvcy1idG46aG92ZXIgeyBjb2xvcjp2YXIoLS10ZXh0KTsgfQoKLmdsb3MtZ3JpZCB7CiAgZGlzcGxheTpub25lOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYyKTsgYm9yZGVyLXRvcDoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouZ2xvcy1ncmlkLm9wZW4geyBkaXNwbGF5OmdyaWQ7IH0KCi5naSB7CiAgcGFkZGluZzoxNHB4IDIycHg7IGJvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJpZ2h0OjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9Ci5naTpudGgtY2hpbGQoZXZlbil7Ym9yZGVyLXJpZ2h0Om5vbmU7fQouZ2ktdGVybSB7CiAgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtc2l6ZToxMHB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgbWFyZ2luLWJvdHRvbTozcHg7Cn0KLmdpLWRlZiB7IGZvbnQtc2l6ZToxMXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IGxpbmUtaGVpZ2h0OjEuNTsgfQoKZm9vdGVyIHsKICB0ZXh0LWFsaWduOmNlbnRlcjsgcGFkZGluZzoyMnB4OyBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOwogIGJvcmRlci10b3A6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KZm9vdGVyIGEgeyBjb2xvcjp2YXIoLS1tdXRlZDIpOyB0ZXh0LWRlY29yYXRpb246bm9uZTsgfQpmb290ZXIgYTpob3ZlciB7IGNvbG9yOnZhcigtLXRleHQpOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgQU5JTUFUSU9OUwrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KQGtleWZyYW1lcyBmYWRlSW4geyBmcm9te29wYWNpdHk6MDt9dG97b3BhY2l0eToxO30gfQpAa2V5ZnJhbWVzIGZhZGVVcCB7IGZyb217b3BhY2l0eTowO3RyYW5zZm9ybTp0cmFuc2xhdGVZKDEwcHgpO310b3tvcGFjaXR5OjE7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoMCk7fSB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgUkVTUE9OU0lWRQrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KQG1lZGlhKG1heC13aWR0aDo5MDBweCl7CiAgOnJvb3R7IC0tZHJhd2VyLXc6IDEwMHZ3OyB9CiAgLmJvZHktd3JhcC5kcmF3ZXItb3BlbiAubWFpbi1jb250ZW50IHsgbWFyZ2luLXJpZ2h0OjA7IH0KICAuZHJhd2VyIHsgd2lkdGg6MTAwdnc7IH0KICAuZHJhd2VyLXJlc2l6ZXIgeyBkaXNwbGF5Om5vbmU7IH0KfQpAbWVkaWEobWF4LXdpZHRoOjcwMHB4KXsKICAuaGVyby1ncmlkeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjsgfQogIC5oY2FyZC5nYXB7IGdyaWQtY29sdW1uOnNwYW4gMjsgfQogIC5tZXRyaWNzLWdyaWR7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyOyB9CiAgLmhjYXJkLXZhbHsgZm9udC1zaXplOjI2cHg7IH0KICAucGlsbHN7IGZsZXgtd3JhcDp3cmFwOyB9CiAgLnRhYmxlLXJpZ2h0IHsgZ2FwOjhweDsgfQogIC5idG4tZG93bmxvYWQgeyBwYWRkaW5nOjAgOHB4OyB9CiAgdGhlYWQgdGg6bnRoLWNoaWxkKDQpLCB0Ym9keSB0ZDpudGgtY2hpbGQoNCl7IGRpc3BsYXk6bm9uZTsgfQogIC5zLXJpZ2h0IHsgZGlzcGxheTpub25lOyB9CiAgdGQuZGltIC50cy1kYXkgeyBmb250LXNpemU6OHB4OyB9CiAgdGQuZGltIC50cy1ob3VyIHsgZm9udC1zaXplOjEwcHg7IH0KfQpAbWVkaWEobWF4LXdpZHRoOjQ4MHB4KXsKICAuaGVyby1ncmlkeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyOyB9CiAgLmhjYXJkLmdhcHsgZ3JpZC1jb2x1bW46c3BhbiAxOyB9CiAgaGVhZGVyeyBwYWRkaW5nOjAgMTRweDsgfQogIC50YWctbWVyY2Fkb3sgZGlzcGxheTpub25lOyB9CiAgLmJ0bi10YXNhcyBzcGFuLmxhYmVsLWxvbmcgeyBkaXNwbGF5Om5vbmU7IH0KfQoKLyogRFJBV0VSIE9WRVJMQVkgKG1vYmlsZSkgKi8KLm92ZXJsYXkgewogIGRpc3BsYXk6bm9uZTsKICBwb3NpdGlvbjpmaXhlZDsgaW5zZXQ6MDsgei1pbmRleDoxNDA7CiAgYmFja2dyb3VuZDpyZ2JhKDAsMCwwLC41NSk7CiAgYmFja2Ryb3AtZmlsdGVyOmJsdXIoMnB4KTsKfQpAbWVkaWEobWF4LXdpZHRoOjkwMHB4KXsKICAub3ZlcmxheS5zaG93IHsgZGlzcGxheTpibG9jazsgfQp9Cjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+CjxkaXYgY2xhc3M9ImFwcCI+Cgo8IS0tIOKUgOKUgCBIRUFERVIg4pSA4pSAIC0tPgo8aGVhZGVyPgogIDxkaXYgY2xhc3M9ImxvZ28iPgogICAgPHNwYW4gY2xhc3M9ImxpdmUtZG90Ij48L3NwYW4+CiAgICBSQURBUiBNRVAvQ0NMCiAgPC9kaXY+CiAgPGRpdiBjbGFzcz0iaGVhZGVyLXJpZ2h0Ij4KICAgIDxkaXYgY2xhc3M9ImZyZXNoLWJhZGdlIiBpZD0iZnJlc2gtYmFkZ2UiPgogICAgICA8c3BhbiBjbGFzcz0iZnJlc2gtZG90Ij48L3NwYW4+CiAgICAgIDxzcGFuIGlkPSJmcmVzaC1iYWRnZS10ZXh0Ij5BY3R1YWxpemFuZG/igKY8L3NwYW4+CiAgICA8L2Rpdj4KICAgIDxzcGFuIGNsYXNzPSJ0YWctbWVyY2FkbyBjbG9zZWQiIGlkPSJ0YWctbWVyY2FkbyI+TWVyY2FkbyBjZXJyYWRvPC9zcGFuPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi10YXNhcyIgaWQ9ImJ0blRhc2FzIiBvbmNsaWNrPSJ0b2dnbGVEcmF3ZXIoKSI+CiAgICAgIPCfk4ogPHNwYW4gY2xhc3M9ImxhYmVsLWxvbmciPkZvbmRvcyBDb211bmVzIGRlIEludmVyc2nDs248L3NwYW4+CiAgICA8L2J1dHRvbj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tYWxlcnQiPvCflJQgQWxlcnRhczwvYnV0dG9uPgogIDwvZGl2Pgo8L2hlYWRlcj4KCjwhLS0g4pSA4pSAIE9WRVJMQVkgKG1vYmlsZSkg4pSA4pSAIC0tPgo8ZGl2IGNsYXNzPSJvdmVybGF5IiBpZD0ib3ZlcmxheSIgb25jbGljaz0idG9nZ2xlRHJhd2VyKCkiPjwvZGl2PgoKPCEtLSDilIDilIAgQk9EWSBXUkFQIOKUgOKUgCAtLT4KPGRpdiBjbGFzcz0iYm9keS13cmFwIiBpZD0iYm9keVdyYXAiPgoKICA8IS0tIOKVkOKVkOKVkOKVkCBNQUlOIOKVkOKVkOKVkOKVkCAtLT4KICA8ZGl2IGNsYXNzPSJtYWluLWNvbnRlbnQiPgoKICAgIDwhLS0gU1RBVFVTIEJBTk5FUiAtLT4KICAgIDxkaXYgY2xhc3M9InN0YXR1cy1iYW5uZXIgc2ltaWxhciIgaWQ9InN0YXR1cy1iYW5uZXIiPgogICAgICA8ZGl2IGNsYXNzPSJzLWxlZnQiPgogICAgICAgIDxkaXYgY2xhc3M9InMtdGl0bGUiPgogICAgICAgICAgPHNwYW4gaWQ9InN0YXR1cy1sYWJlbCI+TUVQIOKJiCBDQ0w8L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0icy1iYWRnZSIgaWQ9InN0YXR1cy1iYWRnZSI+U2ltaWxhcjwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJzLXN1YiI+TGEgYnJlY2hhIGVzdMOhIGRlbnRybyBkZWwgdW1icmFsIOKAlCBsb3MgcHJlY2lvcyBzb24gY29tcGFyYWJsZXM8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InMtcmlnaHQiPgogICAgICAgIDxkaXY+w5psdGltYSBjb3JyaWRhOiA8c3Ryb25nIGlkPSJsYXN0LXJ1bi10aW1lIj7igJQ8L3N0cm9uZz48L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJjb3VudGRvd24tdGV4dCI+UHLDs3hpbWEgYWN0dWFsaXphY2nDs24gZW4gNTowMDwvZGl2PgogICAgICAgIDxkaXY+Q3JvbiBHTVQtMyDCtyBMdW7igJNWaWUgMTA6MzDigJMxODowMDwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZXJyb3ItYmFubmVyIiBpZD0iZXJyb3ItYmFubmVyIj4KICAgICAgPHNwYW4gaWQ9ImVycm9yLWJhbm5lci10ZXh0Ij5FcnJvciBhbCBhY3R1YWxpemFyIMK3IFJlaW50ZW50YXI8L3NwYW4+CiAgICAgIDxidXR0b24gaWQ9ImVycm9yLXJldHJ5LWJ0biIgdHlwZT0iYnV0dG9uIj5SZWludGVudGFyPC9idXR0b24+CiAgICA8L2Rpdj4KCiAgICA8IS0tIEhFUk8gQ0FSRFMgLS0+CiAgICA8ZGl2IGNsYXNzPSJoZXJvLWdyaWQiPgogICAgICA8ZGl2IGNsYXNzPSJoY2FyZCBtZXAiPgogICAgICAgIDxkaXYgY2xhc3M9ImJhciI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtbGFiZWwiPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImRvdCI+PC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRpcCIgZGF0YS10PSJEw7NsYXIgQm9sc2Eg4oCUIGNvbXByYS92ZW50YSBkZSBib25vcyBlbiAkQVJTIHkgVVNEIj5NRVAgdmVudGEg4pOYPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXZhbCIgaWQ9Im1lcC12YWwiPiQxLjI2NDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXN1YiI+ZG9sYXJpdG8uYXIgwrcgdmVudGE8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImhjYXJkIGNjbCI+CiAgICAgICAgPGRpdiBjbGFzcz0iYmFyIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1sYWJlbCI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0iZG90Ij48L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGlwIiBkYXRhLXQ9IkNvbnRhZG8gY29uIExpcXVpZGFjacOzbiDigJQgc2ltaWxhciBhbCBNRVAgY29uIGdpcm8gYWwgZXh0ZXJpb3IiPkNDTCB2ZW50YSDik5g8L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtdmFsIiBpZD0iY2NsLXZhbCI+JDEuMjcxPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtc3ViIj5kb2xhcml0by5hciDCtyB2ZW50YTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGNhcmQgZ2FwIj4KICAgICAgICA8ZGl2IGNsYXNzPSJiYXIiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLWxhYmVsIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJkb3QiPjwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0aXAiIGRhdGEtdD0iQnJlY2hhIHJlbGF0aXZhIGNvbnRyYSBlbCBwcm9tZWRpbyBlbnRyZSBNRVAgeSBDQ0wiPkJyZWNoYSDik5g8L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtdmFsIiBpZD0iYnJlY2hhLWFicyI+JDc8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1wY3QiIGlkPSJicmVjaGEtcGN0Ij4wLjU1JTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXN1YiI+ZGlmZXJlbmNpYSBhYnNvbHV0YSDCtyBwb3JjZW50dWFsPC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPCEtLSBDSEFSVCAtLT4KICAgIDxkaXYgY2xhc3M9ImNoYXJ0LWNhcmQiPgogICAgICA8ZGl2IGNsYXNzPSJjaGFydC10b3AiPgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXR0bCIgaWQ9InRyZW5kLXRpdGxlIj5UZW5kZW5jaWEgTUVQL0NDTCDigJQgMSBkw61hPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icGlsbHMiPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0icGlsbCBvbiIgZGF0YS1maWx0ZXI9IjFkIj4xIETDrWE8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9InBpbGwiIGRhdGEtZmlsdGVyPSIxdyI+MSBTZW1hbmE8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9InBpbGwiIGRhdGEtZmlsdGVyPSIxbSI+MSBNZXM8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImxlZ2VuZHMiPgogICAgICAgIDxkaXYgY2xhc3M9ImxlZyI+PGRpdiBjbGFzcz0ibGVnLWxpbmUiIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLW1lcCkiPjwvZGl2Pk1FUDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImxlZyI+PGRpdiBjbGFzcz0ibGVnLWxpbmUiIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLWNjbCkiPjwvZGl2PkNDTDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPHN2ZyBjbGFzcz0iY2hhcnQiIGlkPSJ0cmVuZC1jaGFydCIgdmlld0JveD0iMCAwIDg2MCAxNjAiIHByZXNlcnZlQXNwZWN0UmF0aW89Im5vbmUiPgogICAgICAgIDxsaW5lIHgxPSIwIiB5MT0iNDAiIHgyPSI4NjAiIHkyPSI0MCIgc3Ryb2tlPSIjMWUyNTMwIiBzdHJva2Utd2lkdGg9IjEiLz4KICAgICAgICA8bGluZSB4MT0iMCIgeTE9IjgwIiB4Mj0iODYwIiB5Mj0iODAiIHN0cm9rZT0iIzFlMjUzMCIgc3Ryb2tlLXdpZHRoPSIxIi8+CiAgICAgICAgPGxpbmUgeDE9IjAiIHkxPSIxMjAiIHgyPSI4NjAiIHkyPSIxMjAiIHN0cm9rZT0iIzFlMjUzMCIgc3Ryb2tlLXdpZHRoPSIxIi8+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXktdG9wIiB4PSIyIiB5PSIzNyIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI4IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC15LW1pZCIgeD0iMiIgeT0iNzciIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iOCIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteS1sb3ciIHg9IjIiIHk9IjExNyIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI4IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDxwb2x5bGluZSBpZD0idHJlbmQtbWVwLWxpbmUiIHBvaW50cz0iIiBmaWxsPSJub25lIiBzdHJva2U9IiMyOWI2ZjYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogICAgICAgIDxwb2x5bGluZSBpZD0idHJlbmQtY2NsLWxpbmUiIHBvaW50cz0iIiBmaWxsPSJub25lIiBzdHJva2U9IiNiMzlkZGIiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogICAgICAgIDxsaW5lIGlkPSJ0cmVuZC1ob3Zlci1saW5lIiB4MT0iMCIgeTE9IjE4IiB4Mj0iMCIgeTI9IjEzMiIgc3Ryb2tlPSIjMmEzNDQ0IiBzdHJva2Utd2lkdGg9IjEiIG9wYWNpdHk9IjAiLz4KICAgICAgICA8Y2lyY2xlIGlkPSJ0cmVuZC1ob3Zlci1tZXAiIGN4PSIwIiBjeT0iMCIgcj0iMy41IiBmaWxsPSIjMjliNmY2IiBvcGFjaXR5PSIwIi8+CiAgICAgICAgPGNpcmNsZSBpZD0idHJlbmQtaG92ZXItY2NsIiBjeD0iMCIgY3k9IjAiIHI9IjMuNSIgZmlsbD0iI2IzOWRkYiIgb3BhY2l0eT0iMCIvPgogICAgICAgIDxnIGlkPSJ0cmVuZC10b29sdGlwIiBvcGFjaXR5PSIwIj4KICAgICAgICAgIDxyZWN0IGlkPSJ0cmVuZC10b29sdGlwLWJnIiB4PSIwIiB5PSIwIiB3aWR0aD0iMTQ4IiBoZWlnaHQ9IjU2IiByeD0iNiIgZmlsbD0iIzE2MWIyMiIgc3Ryb2tlPSIjMmEzNDQ0Ii8+CiAgICAgICAgICA8dGV4dCBpZD0idHJlbmQtdGlwLXRpbWUiIHg9IjEwIiB5PSIxNCIgZmlsbD0iIzU1NjA3MCIgZm9udC1zaXplPSI4IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgICAgPHRleHQgaWQ9InRyZW5kLXRpcC1tZXAiIHg9IjEwIiB5PSIyOCIgZmlsbD0iIzI5YjZmNiIgZm9udC1zaXplPSI5IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+TUVQIOKAlDwvdGV4dD4KICAgICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC10aXAtY2NsIiB4PSIxMCIgeT0iNDAiIGZpbGw9IiNiMzlkZGIiIGZvbnQtc2l6ZT0iOSIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPkNDTCDigJQ8L3RleHQ+CiAgICAgICAgICA8dGV4dCBpZD0idHJlbmQtdGlwLWdhcCIgeD0iMTAiIHk9IjUyIiBmaWxsPSIjZmZjYzAwIiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj5CcmVjaGEg4oCUPC90ZXh0PgogICAgICAgIDwvZz4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC0xIiB4PSIyOCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtMiIgeD0iMjE4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC0zIiB4PSI0MTgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTQiIHg9IjYwOCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtNSIgeD0iNzk4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgPC9zdmc+CiAgICA8L2Rpdj4KCiAgICA8IS0tIE1FVFJJQ1MgLS0+CiAgICA8ZGl2IGNsYXNzPSJtZXRyaWNzLWdyaWQiPgogICAgICA8ZGl2IGNsYXNzPSJtY2FyZCI+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtbGFiZWwiIGlkPSJtZXRyaWMtY291bnQtbGFiZWwiPk11ZXN0cmFzIDEgZMOtYTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXZhbCIgaWQ9Im1ldHJpYy1jb3VudC0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiIgaWQ9Im1ldHJpYy1jb3VudC1zdWIiPnJlZ2lzdHJvcyBkZWwgcGVyw61vZG8gZmlsdHJhZG88L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im1jYXJkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1sYWJlbCIgaWQ9Im1ldHJpYy1zaW1pbGFyLWxhYmVsIj5WZWNlcyBzaW1pbGFyPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtdmFsIiBzdHlsZT0iY29sb3I6dmFyKC0tZ3JlZW4pIiBpZD0ibWV0cmljLXNpbWlsYXItMjRoIj7igJQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1zdWIiIGlkPSJtZXRyaWMtc2ltaWxhci1zdWIiPm1vbWVudG9zIGVuIHpvbmEg4omkMSUgbyDiiaQkMTA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im1jYXJkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1sYWJlbCIgaWQ9Im1ldHJpYy1taW4tbGFiZWwiPkJyZWNoYSBtw61uLjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXZhbCIgaWQ9Im1ldHJpYy1taW4tMjRoIj7igJQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1zdWIiIGlkPSJtZXRyaWMtbWluLXN1YiI+bcOtbmltYSBkZWwgcGVyw61vZG8gZmlsdHJhZG88L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im1jYXJkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1sYWJlbCIgaWQ9Im1ldHJpYy1tYXgtbGFiZWwiPkJyZWNoYSBtw6F4LjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXZhbCIgc3R5bGU9ImNvbG9yOnZhcigtLXllbGxvdykiIGlkPSJtZXRyaWMtbWF4LTI0aCI+4oCUPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtc3ViIiBpZD0ibWV0cmljLW1heC1zdWIiPm3DoXhpbWEgZGVsIHBlcsOtb2RvIGZpbHRyYWRvPC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPCEtLSBUQUJMRSAtLT4KICAgIDxkaXYgY2xhc3M9InRhYmxlLWNhcmQiPgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS10b3AiPgogICAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXR0bCI+SGlzdG9yaWFsIGRlIHJlZ2lzdHJvczwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXJpZ2h0Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9InRhYmxlLWNhcCIgaWQ9Imhpc3RvcnktY2FwIj7Dmmx0aW1hcyDigJQgbXVlc3RyYXM8L2Rpdj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0bi1kb3dubG9hZCIgaWQ9ImJ0bi1kb3dubG9hZC1jc3YiIHR5cGU9ImJ1dHRvbiIgYXJpYS1sYWJlbD0iRGVzY2FyZ2FyIENTViI+CiAgICAgICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBhcmlhLWhpZGRlbj0idHJ1ZSI+CiAgICAgICAgICAgICAgPHBhdGggZD0iTTEyIDR2MTAiPjwvcGF0aD4KICAgICAgICAgICAgICA8cGF0aCBkPSJNOCAxMGw0IDQgNC00Ij48L3BhdGg+CiAgICAgICAgICAgICAgPHBhdGggZD0iTTUgMTloMTQiPjwvcGF0aD4KICAgICAgICAgICAgPC9zdmc+CiAgICAgICAgICAgIERlc2NhcmdhciBDU1YKICAgICAgICAgIDwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGlzdG9yeS10YWJsZS13cmFwIj4KICAgICAgPHRhYmxlIGlkPSJoaXN0b3J5LXRhYmxlIj4KICAgICAgICA8Y29sZ3JvdXAgaWQ9Imhpc3RvcnktY29sZ3JvdXAiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iMCI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSIxIj4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjIiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iMyI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSI0Ij4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjUiPgogICAgICAgIDwvY29sZ3JvdXA+CiAgICAgICAgPHRoZWFkPgogICAgICAgICAgPHRyPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+RMOtYSAvIEhvcmE8L3NwYW4+PHNwYW4gY2xhc3M9ImNvbC1yZXNpemVyIiBkYXRhLWNvbC1pbmRleD0iMCIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIETDrWEgLyBIb3JhIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPk1FUDwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSIxIiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgTUVQIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPkNDTDwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSIyIiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgQ0NMIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPkRpZiAkPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjMiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBEaWYgJCI+PC9zcGFuPjwvdGg+CiAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iY29sLWxhYmVsIj5EaWYgJTwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSI0IiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgRGlmICUiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+RXN0YWRvPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjUiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBFc3RhZG8iPjwvc3Bhbj48L3RoPgogICAgICAgICAgPC90cj4KICAgICAgICA8L3RoZWFkPgogICAgICAgIDx0Ym9keSBpZD0iaGlzdG9yeS1yb3dzIj48L3Rib2R5PgogICAgICA8L3RhYmxlPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDwhLS0gR0xPU0FSSU8gLS0+CiAgICA8ZGl2IGNsYXNzPSJnbG9zYXJpbyI+CiAgICAgIDxidXR0b24gY2xhc3M9Imdsb3MtYnRuIiBvbmNsaWNrPSJ0b2dnbGVHbG9zKHRoaXMpIj4KICAgICAgICA8c3Bhbj7wn5OWIEdsb3NhcmlvIGRlIHTDqXJtaW5vczwvc3Bhbj4KICAgICAgICA8c3BhbiBpZD0iZ2xvc0Fycm93Ij7ilr48L3NwYW4+CiAgICAgIDwvYnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJnbG9zLWdyaWQiIGlkPSJnbG9zR3JpZCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPk1FUCB2ZW50YTwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+UHJlY2lvIGRlIHZlbnRhIGRlbCBkw7NsYXIgTUVQIChNZXJjYWRvIEVsZWN0csOzbmljbyBkZSBQYWdvcykgdsOtYSBjb21wcmEvdmVudGEgZGUgYm9ub3MgZW4gJEFSUyB5IFVTRC48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+Q0NMIHZlbnRhPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5Db250YWRvIGNvbiBMaXF1aWRhY2nDs24g4oCUIHNpbWlsYXIgYWwgTUVQIHBlcm8gcGVybWl0ZSB0cmFuc2ZlcmlyIGZvbmRvcyBhbCBleHRlcmlvci4gU3VlbGUgY290aXphciBsZXZlbWVudGUgcG9yIGVuY2ltYS48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+RGlmZXJlbmNpYSAlPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5CcmVjaGEgcmVsYXRpdmEgY2FsY3VsYWRhIGNvbnRyYSBlbCBwcm9tZWRpbyBlbnRyZSBNRVAgeSBDQ0wuIFVtYnJhbCBTSU1JTEFSOiDiiaQgMSUgbyDiiaQgJDEwIEFSUy48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+RnJlc2N1cmEgZGVsIGRhdG88L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPlRpZW1wbyBkZXNkZSBlbCDDumx0aW1vIHRpbWVzdGFtcCBkZSBkb2xhcml0by5hci4gRWwgY3JvbiBjb3JyZSBjYWRhIDUgbWluIGVuIGTDrWFzIGjDoWJpbGVzLjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5Fc3RhZG8gU0lNSUxBUjwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+Q3VhbmRvIE1FUCB5IENDTCBlc3TDoW4gZGVudHJvIGRlbCB1bWJyYWwg4oCUIG1vbWVudG8gaWRlYWwgcGFyYSBvcGVyYXIgYnVzY2FuZG8gcGFyaWRhZCBlbnRyZSBhbWJvcyB0aXBvcy48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+TWVyY2FkbyBBUkc8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPlZlbnRhbmEgb3BlcmF0aXZhOiBsdW5lcyBhIHZpZXJuZXMgZGUgMTA6MzAgYSAxNzo1OSAoR01ULTMsIEJ1ZW5vcyBBaXJlcykuPC9kaXY+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPGZvb3Rlcj4KICAgICAgRnVlbnRlOiA8YSBocmVmPSIjIj5kb2xhcml0by5hcjwvYT4gwrcgPGEgaHJlZj0iIyI+YXJnZW50aW5hZGF0b3MuY29tPC9hPiDCtyBEYXRvcyBjYWRhIDUgbWluIGVuIGTDrWFzIGjDoWJpbGVzIMK3IDxhIGhyZWY9IiMiPlJlcG9ydGFyIHByb2JsZW1hPC9hPgogICAgPC9mb290ZXI+CgogIDwvZGl2PjwhLS0gL21haW4tY29udGVudCAtLT4KCiAgPCEtLSDilZDilZDilZDilZAgRFJBV0VSIOKVkOKVkOKVkOKVkCAtLT4KICA8ZGl2IGNsYXNzPSJkcmF3ZXIiIGlkPSJkcmF3ZXIiPgogICAgPGRpdiBjbGFzcz0iZHJhd2VyLXJlc2l6ZXIiIGlkPSJkcmF3ZXItcmVzaXplciIgYXJpYS1oaWRkZW49InRydWUiPjwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImRyYXdlci1oZWFkZXIiPgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImRyYXdlci10aXRsZSI+8J+TiiBGb25kb3MgQ29tdW5lcyBkZSBJbnZlcnNpw7NuPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZHJhd2VyLXNvdXJjZSI+RnVlbnRlczogYXJnZW50aW5hZGF0b3MuY29tPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4tY2xvc2UiIG9uY2xpY2s9InRvZ2dsZURyYXdlcigpIj7inJU8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImRyYXdlci1ib2R5Ij4KICAgICAgPGRpdiBjbGFzcz0iZmNpLWhlYWRlciI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmNpLXRpdGxlLXdyYXAiPgogICAgICAgICAgPGRpdiBjbGFzcz0iZmNpLXRpdGxlIiBpZD0iZmNpLXRpdGxlIj5SZW50YSBmaWphIChGQ0kgQXJnZW50aW5hKTwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZmNpLXRhYnMiPgogICAgICAgICAgICA8YnV0dG9uIGlkPSJmY2ktdGFiLWZpamEiIGNsYXNzPSJmY2ktdGFiLWJ0biBhY3RpdmUiIHR5cGU9ImJ1dHRvbiI+UmVudGEgZmlqYTwvYnV0dG9uPgogICAgICAgICAgICA8YnV0dG9uIGlkPSJmY2ktdGFiLXZhcmlhYmxlIiBjbGFzcz0iZmNpLXRhYi1idG4iIHR5cGU9ImJ1dHRvbiI+UmVudGEgdmFyaWFibGU8L2J1dHRvbj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZjaS1tZXRhIiBpZD0iZmNpLWxhc3QtZGF0ZSI+RmVjaGE6IOKAlDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmNpLWNvbnRyb2xzIj4KICAgICAgICA8aW5wdXQgaWQ9ImZjaS1zZWFyY2giIGNsYXNzPSJmY2ktc2VhcmNoIiB0eXBlPSJ0ZXh0IiBwbGFjZWhvbGRlcj0iQnVzY2FyIGZvbmRvLi4uIiAvPgogICAgICAgIDxkaXYgY2xhc3M9ImZjaS1wYWdpbmF0aW9uIj4KICAgICAgICAgIDxidXR0b24gaWQ9ImZjaS1wcmV2IiBjbGFzcz0iZmNpLXBhZ2UtYnRuIiB0eXBlPSJidXR0b24iPuKXgDwvYnV0dG9uPgogICAgICAgICAgPGRpdiBpZD0iZmNpLXBhZ2UtaW5mbyIgY2xhc3M9ImZjaS1wYWdlLWluZm8iPjEgLyAxPC9kaXY+CiAgICAgICAgICA8YnV0dG9uIGlkPSJmY2ktbmV4dCIgY2xhc3M9ImZjaS1wYWdlLWJ0biIgdHlwZT0iYnV0dG9uIj7ilrY8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZjaS10YWJsZS13cmFwIj4KICAgICAgICA8dGFibGUgY2xhc3M9ImZjaS10YWJsZSI+CiAgICAgICAgICA8Y29sZ3JvdXAgaWQ9ImZjaS1jb2xncm91cCI+CiAgICAgICAgICAgIDxjb2wgc3R5bGU9IndpZHRoOjI4MHB4Ij4KICAgICAgICAgICAgPGNvbCBzdHlsZT0id2lkdGg6MTUwcHgiPgogICAgICAgICAgICA8Y29sIHN0eWxlPSJ3aWR0aDoxOTBweCI+CiAgICAgICAgICAgIDxjb2wgc3R5bGU9IndpZHRoOjE5MHB4Ij4KICAgICAgICAgICAgPGNvbCBzdHlsZT0id2lkdGg6MTIwcHgiPgogICAgICAgICAgICA8Y29sIHN0eWxlPSJ3aWR0aDoxNjBweCI+CiAgICAgICAgICA8L2NvbGdyb3VwPgogICAgICAgICAgPHRoZWFkPgogICAgICAgICAgICA8dHI+CiAgICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJmY2ktY29sLWxhYmVsIj48c3BhbiBjbGFzcz0idGlwIHRpcC1kb3duIiBkYXRhLXQ9Ik5vbWJyZSBkZWwgRm9uZG8gQ29tw7puIGRlIEludmVyc2nDs24uIj5Gb25kbyDik5g8L3NwYW4+PC9zcGFuPjxzcGFuIGNsYXNzPSJmY2ktY29sLXJlc2l6ZXIiIGRhdGEtZmNpLWNvbC1pbmRleD0iMCIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIEZvbmRvIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImZjaS1jb2wtbGFiZWwiPjxzcGFuIGNsYXNzPSJ0aXAgdGlwLWRvd24iIGRhdGEtdD0iVkNQIOKAlCBWYWxvciBDdW90YXBhcnRlLiBQcmVjaW8gdW5pdGFyaW8gZGUgY2FkYSBjdW90YXBhcnRlLiBVc2FsbyBwYXJhIGNvbXBhcmFyIHJlbmRpbWllbnRvIGVudHJlIGZlY2hhcy4iPlZDUCDik5g8L3NwYW4+PC9zcGFuPjxzcGFuIGNsYXNzPSJmY2ktY29sLXJlc2l6ZXIiIGRhdGEtZmNpLWNvbC1pbmRleD0iMSIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIFZDUCI+PC9zcGFuPjwvdGg+CiAgICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJmY2ktY29sLWxhYmVsIj48c3BhbiBjbGFzcz0idGlwIHRpcC1kb3duIiBkYXRhLXQ9IkNDUCDigJQgQ2FudGlkYWQgZGUgQ3VvdGFwYXJ0ZXMuIFRvdGFsIGRlIGN1b3RhcGFydGVzIGVtaXRpZGFzLiBTdWJlIGN1YW5kbyBlbnRyYW4gaW52ZXJzb3JlcywgYmFqYSBjdWFuZG8gcmVzY2F0YW4uIj5DQ1Ag4pOYPC9zcGFuPjwvc3Bhbj48c3BhbiBjbGFzcz0iZmNpLWNvbC1yZXNpemVyIiBkYXRhLWZjaS1jb2wtaW5kZXg9IjIiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBDQ1AiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iZmNpLWNvbC1sYWJlbCI+PHNwYW4gY2xhc3M9InRpcCB0aXAtZG93biIgZGF0YS10PSJQYXRyaW1vbmlvIOKAlCBWQ1Agw5cgQ0NQLiBWYWxvciB0b3RhbCBhZG1pbmlzdHJhZG8gcG9yIGVsIGZvbmRvIGVuIHBlc29zIGEgZXNhIGZlY2hhLiI+UGF0cmltb25pbyDik5g8L3NwYW4+PC9zcGFuPjxzcGFuIGNsYXNzPSJmY2ktY29sLXJlc2l6ZXIiIGRhdGEtZmNpLWNvbC1pbmRleD0iMyIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIFBhdHJpbW9uaW8iPjwvc3Bhbj48L3RoPgogICAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iZmNpLWNvbC1sYWJlbCI+PHNwYW4gY2xhc3M9InRpcCB0aXAtZG93biIgZGF0YS10PSJIb3Jpem9udGUgZGUgaW52ZXJzacOzbiBzdWdlcmlkbyAoY29ydG8sIG1lZGlvIG8gbGFyZ28pLiI+SG9yaXpvbnRlIOKTmDwvc3Bhbj48L3NwYW4+PHNwYW4gY2xhc3M9ImZjaS1jb2wtcmVzaXplciIgZGF0YS1mY2ktY29sLWluZGV4PSI0IiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgSG9yaXpvbnRlIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImZjaS1jb2wtbGFiZWwiPjxzcGFuIGNsYXNzPSJ0aXAgdGlwLWRvd24iIGRhdGEtdD0iU2XDsWFsIHLDoXBpZGEgdXNhbmRvIHJlbmRpbWllbnRvIG1lbnN1YWwgZXN0aW1hZG8gcG9yIFZDUCB2cyBiZW5jaG1hcmsgZGUgcGxhem8gZmlqbyBlIGluZmxhY2nDs24uIj5TZcOxYWwg4pOYPC9zcGFuPjwvc3Bhbj48c3BhbiBjbGFzcz0iZmNpLWNvbC1yZXNpemVyIiBkYXRhLWZjaS1jb2wtaW5kZXg9IjUiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBTZcOxYWwiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8L3RyPgogICAgICAgICAgPC90aGVhZD4KICAgICAgICAgIDx0Ym9keSBpZD0iZmNpLXJvd3MiPgogICAgICAgICAgICA8dHI+PHRkIGNvbHNwYW49IjYiIGNsYXNzPSJkaW0iPkNhcmdhbmRv4oCmPC90ZD48L3RyPgogICAgICAgICAgPC90Ym9keT4KICAgICAgICA8L3RhYmxlPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmNpLWJlbmNoIiBpZD0iZmNpLWJlbmNoLWluZm8iPkJlbmNobWFyazogY2FyZ2FuZG/igKY8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmNpLWVtcHR5IiBpZD0iZmNpLWVtcHR5IiBzdHlsZT0iZGlzcGxheTpub25lIj4KICAgICAgICBObyBoYXkgZGF0b3MgZGUgRkNJIGRpc3BvbmlibGVzIGVuIGVzdGUgbW9tZW50by4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImNvbnRleHQtYm94Ij4KICAgICAgICA8c3Ryb25nPlRpcDo8L3N0cm9uZz48YnI+CiAgICAgICAgU2UgbGlzdGFuIGxvcyBmb25kb3MgZGUgbGEgc2VyaWUgc2VsZWNjaW9uYWRhIG9yZGVuYWRvcyBwb3IgcGF0cmltb25pbyAoZGUgbWF5b3IgYSBtZW5vcikuPGJyPgogICAgICAgIOKWsiBzdWJlIMK3IOKWvCBiYWphIMK3ID0gc2luIGNhbWJpb3MgKHZzIGTDrWEgYW50ZXJpb3IpLjxicj4KICAgICAgICDwn5S0IFBFUkRJRU5ETzogcmluZGUgbWVub3MgcXVlIHBsYXpvIGZpam8geSBxdWUgaW5mbGFjacOzbi48YnI+CiAgICAgICAg8J+foCBPSk86IGxlIGdhbmEgYWwgcGxhem8gZmlqbyBwZXJvIHBpZXJkZSBjb250cmEgaW5mbGFjacOzbi48YnI+CiAgICAgICAg8J+foSBBQ0VQVEFCTEU6IGxlIGdhbmEgYSBpbmZsYWNpw7NuIHBvciBtZW5vcyBkZSAwLjUgcHAuPGJyPgogICAgICAgIPCfn6IgR0FOQU5ETzogbGUgZ2FuYSBhIHBsYXpvIGZpam8gZSBpbmZsYWNpw7NuIGNvbiBtYXJnZW4gbWF5b3IgYSAwLjUgcHAuCiAgICAgIDwvZGl2PgogICAgPC9kaXY+PCEtLSAvZHJhd2VyLWJvZHkgLS0+CiAgPC9kaXY+PCEtLSAvZHJhd2VyIC0tPgoKPC9kaXY+PCEtLSAvYm9keS13cmFwIC0tPgo8L2Rpdj48IS0tIC9hcHAgLS0+CjxkaXYgY2xhc3M9InNtYXJ0LXRpcCIgaWQ9InNtYXJ0LXRpcCIgcm9sZT0idG9vbHRpcCIgYXJpYS1oaWRkZW49InRydWUiPjwvZGl2PgoKPHNjcmlwdD4KICAvLyAxKSBDb25zdGFudGVzIHkgY29uZmlndXJhY2nDs24KICBjb25zdCBFTkRQT0lOVFMgPSB7CiAgICBtZXBDY2w6ICcvYXBpL2RhdGEnLAogICAgZmNpUmVudGFGaWphOiAnL2FwaS9mY2kvcmVudGEtZmlqYS91bHRpbW8nLAogICAgZmNpUmVudGFGaWphUGVudWx0aW1vOiAnL2FwaS9mY2kvcmVudGEtZmlqYS9wZW51bHRpbW8nLAogICAgZmNpUmVudGFGaWphTWVzQmFzZTogJy9hcGkvZmNpL3JlbnRhLWZpamEvbWVzLWJhc2UnLAogICAgZmNpUmVudGFWYXJpYWJsZTogJy9hcGkvZmNpL3JlbnRhLXZhcmlhYmxlL3VsdGltbycsCiAgICBmY2lSZW50YVZhcmlhYmxlUGVudWx0aW1vOiAnL2FwaS9mY2kvcmVudGEtdmFyaWFibGUvcGVudWx0aW1vJywKICAgIGZjaVJlbnRhVmFyaWFibGVNZXNCYXNlOiAnL2FwaS9mY2kvcmVudGEtdmFyaWFibGUvbWVzLWJhc2UnLAogICAgYmVuY2htYXJrUGxhem9GaWpvOiAnL2FwaS9iZW5jaG1hcmsvcGxhem8tZmlqbycsCiAgICBiZW5jaG1hcmtJbmZsYWNpb246ICcvYXBpL2JlbmNobWFyay9pbmZsYWNpb24nCiAgfTsKICBjb25zdCBBUkdfVFogPSAnQW1lcmljYS9BcmdlbnRpbmEvQnVlbm9zX0FpcmVzJzsKICBjb25zdCBGRVRDSF9JTlRFUlZBTF9NUyA9IDMwMDAwMDsKICBjb25zdCBDQUNIRV9LRVkgPSAncmFkYXJfY2FjaGUnOwogIGNvbnN0IEhJU1RPUllfQ09MU19LRVkgPSAncmFkYXJfaGlzdG9yeV9jb2xfd2lkdGhzX3YxJzsKICBjb25zdCBGQ0lfQ09MU19LRVkgPSAncmFkYXJfZmNpX2NvbF93aWR0aHNfdjEnOwogIGNvbnN0IERSQVdFUl9XSURUSF9LRVkgPSAncmFkYXJfZHJhd2VyX3dpZHRoX3YxJzsKICBjb25zdCBGQ0lfU0lHTkFMX1NUUkVBS19LRVkgPSAncmFkYXJfZmNpX3NpZ25hbF9zdHJlYWtzX3YxJzsKICBjb25zdCBDQUNIRV9UVExfTVMgPSAxNSAqIDYwICogMTAwMDsKICBjb25zdCBSRVRSWV9ERUxBWVMgPSBbMTAwMDAsIDMwMDAwLCA2MDAwMF07CiAgY29uc3QgU0lNSUxBUl9QQ1RfVEhSRVNIT0xEID0gMTsKICBjb25zdCBTSU1JTEFSX0FSU19USFJFU0hPTEQgPSAxMDsKICBjb25zdCBUUkVORF9NQVhfUE9JTlRTID0gMjQwOwogIGNvbnN0IEZDSV9QQUdFX1NJWkUgPSAxMDsKICBjb25zdCBEUkFXRVJfTUlOX1cgPSAzNDA7CiAgY29uc3QgRFJBV0VSX01BWF9XID0gNzYwOwogIGNvbnN0IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTID0gWzE3MCwgMTYwLCAxNjAsIDEyMCwgMTIwLCAxNzBdOwogIGNvbnN0IEhJU1RPUllfTUlOX0NPTF9XSURUSFMgPSBbMTIwLCAxMTAsIDExMCwgOTAsIDkwLCAxMjBdOwogIGNvbnN0IEZDSV9ERUZBVUxUX0NPTF9XSURUSFMgPSBbMjgwLCAxNTAsIDE5MCwgMTkwLCAxMjAsIDE2MF07CiAgY29uc3QgRkNJX01JTl9DT0xfV0lEVEhTID0gWzIyMCwgMTIwLCAxNTAsIDE1MCwgMTAwLCAxMzBdOwogIGNvbnN0IE5VTUVSSUNfSURTID0gWwogICAgJ21lcC12YWwnLCAnY2NsLXZhbCcsICdicmVjaGEtYWJzJywgJ2JyZWNoYS1wY3QnCiAgXTsKICBjb25zdCBzdGF0ZSA9IHsKICAgIHJldHJ5SW5kZXg6IDAsCiAgICByZXRyeVRpbWVyOiBudWxsLAogICAgbGFzdFN1Y2Nlc3NBdDogMCwKICAgIGlzRmV0Y2hpbmc6IGZhbHNlLAogICAgZmlsdGVyTW9kZTogJzFkJywKICAgIGxhc3RNZXBQYXlsb2FkOiBudWxsLAogICAgdHJlbmRSb3dzOiBbXSwKICAgIHRyZW5kSG92ZXJCb3VuZDogZmFsc2UsCiAgICBoaXN0b3J5UmVzaXplQm91bmQ6IGZhbHNlLAogICAgZmNpUmVzaXplQm91bmQ6IGZhbHNlLAogICAgaGlzdG9yeUNvbFdpZHRoczogW10sCiAgICBmY2lDb2xXaWR0aHM6IFtdLAogICAgc291cmNlVHNNczogbnVsbCwKICAgIGZyZXNoQmFkZ2VNb2RlOiAnaWRsZScsCiAgICBmcmVzaFRpY2tlcjogbnVsbCwKICAgIGZjaVR5cGU6ICdmaWphJywKICAgIGZjaVJvd3NCeVR5cGU6IHsgZmlqYTogW10sIHZhcmlhYmxlOiBbXSB9LAogICAgZmNpUHJldmlvdXNCeUZvbmRvQnlUeXBlOiB7IGZpamE6IG5ldyBNYXAoKSwgdmFyaWFibGU6IG5ldyBNYXAoKSB9LAogICAgZmNpQmFzZUJ5Rm9uZG9CeVR5cGU6IHsgZmlqYTogbmV3IE1hcCgpLCB2YXJpYWJsZTogbmV3IE1hcCgpIH0sCiAgICBmY2lEYXRlQnlUeXBlOiB7IGZpamE6ICfigJQnLCB2YXJpYWJsZTogJ+KAlCcgfSwKICAgIGZjaVNpZ25hbFN0cmVha3M6IHsgZmlqYToge30sIHZhcmlhYmxlOiB7fSB9LAogICAgZmNpU2lnbmFsU3RyZWFrc0RpcnR5OiBmYWxzZSwKICAgIGJlbmNobWFyazogewogICAgICBwbGF6b0Zpam9Nb250aGx5UGN0OiBudWxsLAogICAgICBpbmZsYWNpb25Nb250aGx5UGN0OiBudWxsLAogICAgICBpbmZsYWNpb25EYXRlOiBudWxsLAogICAgICB1cGRhdGVkQXRIdW1hbkFydDogbnVsbAogICAgfSwKICAgIGZjaVF1ZXJ5OiAnJywKICAgIGZjaVBhZ2U6IDEsCiAgICBzbWFydFRpcEJvdW5kOiBmYWxzZSwKICAgIGRyYXdlclJlc2l6ZUJvdW5kOiBmYWxzZSwKICAgIGxhdGVzdDogewogICAgICBtZXA6IG51bGwsCiAgICAgIGNjbDogbnVsbCwKICAgICAgYnJlY2hhQWJzOiBudWxsLAogICAgICBicmVjaGFQY3Q6IG51bGwKICAgIH0KICB9OwoKICAvLyAyKSBIZWxwZXJzCiAgY29uc3QgZm10QXJnVGltZSA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlcy1BUicsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICBob3VyOiAnMi1kaWdpdCcsCiAgICBtaW51dGU6ICcyLWRpZ2l0JwogIH0pOwogIGNvbnN0IGZtdEFyZ1RpbWVTZWMgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZXMtQVInLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgaG91cjogJzItZGlnaXQnLAogICAgbWludXRlOiAnMi1kaWdpdCcsCiAgICBzZWNvbmQ6ICcyLWRpZ2l0JwogIH0pOwogIGNvbnN0IGZtdEFyZ0hvdXIgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZXMtQVInLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgaG91cjogJzItZGlnaXQnLAogICAgbWludXRlOiAnMi1kaWdpdCcsCiAgICBob3VyMTI6IGZhbHNlCiAgfSk7CiAgY29uc3QgZm10QXJnRGF5TW9udGggPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZXMtQVInLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgZGF5OiAnMi1kaWdpdCcsCiAgICBtb250aDogJzItZGlnaXQnCiAgfSk7CiAgY29uc3QgZm10QXJnRGF0ZSA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1DQScsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICB5ZWFyOiAnbnVtZXJpYycsCiAgICBtb250aDogJzItZGlnaXQnLAogICAgZGF5OiAnMi1kaWdpdCcKICB9KTsKICBjb25zdCBmbXRBcmdXZWVrZGF5ID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VuLVVTJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIHdlZWtkYXk6ICdzaG9ydCcKICB9KTsKICBjb25zdCBmbXRBcmdQYXJ0cyA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1VUycsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICB3ZWVrZGF5OiAnc2hvcnQnLAogICAgaG91cjogJzItZGlnaXQnLAogICAgbWludXRlOiAnMi1kaWdpdCcsCiAgICBzZWNvbmQ6ICcyLWRpZ2l0JywKICAgIGhvdXIxMjogZmFsc2UKICB9KTsKICBjb25zdCBXRUVLREFZID0geyBNb246IDEsIFR1ZTogMiwgV2VkOiAzLCBUaHU6IDQsIEZyaTogNSwgU2F0OiA2LCBTdW46IDcgfTsKCiAgZnVuY3Rpb24gdG9OdW1iZXIodmFsdWUpIHsKICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpIHJldHVybiB2YWx1ZTsKICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7CiAgICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSB2YWx1ZS5yZXBsYWNlKC9ccy9nLCAnJykucmVwbGFjZSgnLCcsICcuJykucmVwbGFjZSgvW15cZC4tXS9nLCAnJyk7CiAgICAgIGNvbnN0IHBhcnNlZCA9IE51bWJlcihub3JtYWxpemVkKTsKICAgICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShwYXJzZWQpID8gcGFyc2VkIDogbnVsbDsKICAgIH0KICAgIHJldHVybiBudWxsOwogIH0KICBmdW5jdGlvbiBnZXRQYXRoKG9iaiwgcGF0aCkgewogICAgcmV0dXJuIHBhdGgucmVkdWNlKChhY2MsIGtleSkgPT4gKGFjYyAmJiBhY2Nba2V5XSAhPT0gdW5kZWZpbmVkID8gYWNjW2tleV0gOiB1bmRlZmluZWQpLCBvYmopOwogIH0KICBmdW5jdGlvbiBwaWNrTnVtYmVyKG9iaiwgcGF0aHMpIHsKICAgIGZvciAoY29uc3QgcGF0aCBvZiBwYXRocykgewogICAgICBjb25zdCB2ID0gZ2V0UGF0aChvYmosIHBhdGgpOwogICAgICBjb25zdCBuID0gdG9OdW1iZXIodik7CiAgICAgIGlmIChuICE9PSBudWxsKSByZXR1cm4gbjsKICAgIH0KICAgIHJldHVybiBudWxsOwogIH0KICBmdW5jdGlvbiBwaWNrQnlLZXlIaW50KG9iaiwgaGludCkgewogICAgaWYgKCFvYmogfHwgdHlwZW9mIG9iaiAhPT0gJ29iamVjdCcpIHJldHVybiBudWxsOwogICAgY29uc3QgbG93ZXIgPSBoaW50LnRvTG93ZXJDYXNlKCk7CiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhvYmopKSB7CiAgICAgIGlmIChrLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMobG93ZXIpKSB7CiAgICAgICAgY29uc3QgbiA9IHRvTnVtYmVyKHYpOwogICAgICAgIGlmIChuICE9PSBudWxsKSByZXR1cm4gbjsKICAgICAgICBpZiAodiAmJiB0eXBlb2YgdiA9PT0gJ29iamVjdCcpIHsKICAgICAgICAgIGNvbnN0IGRlZXAgPSBwaWNrQnlLZXlIaW50KHYsIGhpbnQpOwogICAgICAgICAgaWYgKGRlZXAgIT09IG51bGwpIHJldHVybiBkZWVwOwogICAgICAgIH0KICAgICAgfQogICAgICBpZiAodiAmJiB0eXBlb2YgdiA9PT0gJ29iamVjdCcpIHsKICAgICAgICBjb25zdCBkZWVwID0gcGlja0J5S2V5SGludCh2LCBoaW50KTsKICAgICAgICBpZiAoZGVlcCAhPT0gbnVsbCkgcmV0dXJuIGRlZXA7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBudWxsOwogIH0KICBmdW5jdGlvbiBnZXRBcmdOb3dQYXJ0cyhkYXRlID0gbmV3IERhdGUoKSkgewogICAgY29uc3QgcGFydHMgPSBmbXRBcmdQYXJ0cy5mb3JtYXRUb1BhcnRzKGRhdGUpLnJlZHVjZSgoYWNjLCBwKSA9PiB7CiAgICAgIGFjY1twLnR5cGVdID0gcC52YWx1ZTsKICAgICAgcmV0dXJuIGFjYzsKICAgIH0sIHt9KTsKICAgIHJldHVybiB7CiAgICAgIHdlZWtkYXk6IFdFRUtEQVlbcGFydHMud2Vla2RheV0gfHwgMCwKICAgICAgaG91cjogTnVtYmVyKHBhcnRzLmhvdXIgfHwgJzAnKSwKICAgICAgbWludXRlOiBOdW1iZXIocGFydHMubWludXRlIHx8ICcwJyksCiAgICAgIHNlY29uZDogTnVtYmVyKHBhcnRzLnNlY29uZCB8fCAnMCcpCiAgICB9OwogIH0KICBmdW5jdGlvbiBicmVjaGFQZXJjZW50KG1lcCwgY2NsKSB7CiAgICBpZiAobWVwID09PSBudWxsIHx8IGNjbCA9PT0gbnVsbCkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBhdmcgPSAobWVwICsgY2NsKSAvIDI7CiAgICBpZiAoIWF2ZykgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gKE1hdGguYWJzKG1lcCAtIGNjbCkgLyBhdmcpICogMTAwOwogIH0KICBmdW5jdGlvbiBmb3JtYXRNb25leSh2YWx1ZSwgZGlnaXRzID0gMCkgewogICAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gJyQnICsgdmFsdWUudG9Mb2NhbGVTdHJpbmcoJ2VzLUFSJywgewogICAgICBtaW5pbXVtRnJhY3Rpb25EaWdpdHM6IGRpZ2l0cywKICAgICAgbWF4aW11bUZyYWN0aW9uRGlnaXRzOiBkaWdpdHMKICAgIH0pOwogIH0KICBmdW5jdGlvbiBmb3JtYXRQZXJjZW50KHZhbHVlLCBkaWdpdHMgPSAyKSB7CiAgICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiAn4oCUJzsKICAgIHJldHVybiB2YWx1ZS50b0ZpeGVkKGRpZ2l0cykgKyAnJSc7CiAgfQogIGZ1bmN0aW9uIGZvcm1hdENvbXBhY3RNb25leSh2YWx1ZSwgZGlnaXRzID0gMikgewogICAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gdmFsdWUudG9Mb2NhbGVTdHJpbmcoJ2VzLUFSJywgewogICAgICBtaW5pbXVtRnJhY3Rpb25EaWdpdHM6IGRpZ2l0cywKICAgICAgbWF4aW11bUZyYWN0aW9uRGlnaXRzOiBkaWdpdHMKICAgIH0pOwogIH0KICBmdW5jdGlvbiBlc2NhcGVIdG1sKHZhbHVlKSB7CiAgICByZXR1cm4gU3RyaW5nKHZhbHVlID8/ICcnKS5yZXBsYWNlKC9bJjw+IiddL2csIChjaGFyKSA9PiAoCiAgICAgIHsgJyYnOiAnJmFtcDsnLCAnPCc6ICcmbHQ7JywgJz4nOiAnJmd0OycsICciJzogJyZxdW90OycsICInIjogJyYjMzk7JyB9W2NoYXJdCiAgICApKTsKICB9CiAgZnVuY3Rpb24gc2V0VGV4dChpZCwgdGV4dCwgb3B0aW9ucyA9IHt9KSB7CiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTsKICAgIGlmICghZWwpIHJldHVybjsKICAgIGNvbnN0IG5leHQgPSBTdHJpbmcodGV4dCk7CiAgICBjb25zdCBwcmV2ID0gZWwudGV4dENvbnRlbnQ7CiAgICBlbC50ZXh0Q29udGVudCA9IG5leHQ7CiAgICBlbC5jbGFzc0xpc3QucmVtb3ZlKCdza2VsZXRvbicpOwogICAgaWYgKG9wdGlvbnMuY2hhbmdlQ2xhc3MgJiYgcHJldiAhPT0gbmV4dCkgewogICAgICBlbC5jbGFzc0xpc3QuYWRkKCd2YWx1ZS1jaGFuZ2VkJyk7CiAgICAgIHNldFRpbWVvdXQoKCkgPT4gZWwuY2xhc3NMaXN0LnJlbW92ZSgndmFsdWUtY2hhbmdlZCcpLCA2MDApOwogICAgfQogIH0KICBmdW5jdGlvbiBzZXREYXNoKGlkcykgewogICAgaWRzLmZvckVhY2goKGlkKSA9PiBzZXRUZXh0KGlkLCAn4oCUJykpOwogIH0KICBmdW5jdGlvbiBzZXRMb2FkaW5nKGlkcywgaXNMb2FkaW5nKSB7CiAgICBpZHMuZm9yRWFjaCgoaWQpID0+IHsKICAgICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CiAgICAgIGlmICghZWwpIHJldHVybjsKICAgICAgZWwuY2xhc3NMaXN0LnRvZ2dsZSgnc2tlbGV0b24nLCBpc0xvYWRpbmcpOwogICAgfSk7CiAgfQogIGZ1bmN0aW9uIHNldEZyZXNoQmFkZ2UodGV4dCwgbW9kZSkgewogICAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZnJlc2gtYmFkZ2UnKTsKICAgIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZyZXNoLWJhZGdlLXRleHQnKTsKICAgIGlmICghYmFkZ2UgfHwgIWxhYmVsKSByZXR1cm47CiAgICBsYWJlbC50ZXh0Q29udGVudCA9IHRleHQ7CiAgICBzdGF0ZS5mcmVzaEJhZGdlTW9kZSA9IG1vZGUgfHwgJ2lkbGUnOwogICAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZSgnZmV0Y2hpbmcnLCBtb2RlID09PSAnZmV0Y2hpbmcnKTsKICAgIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoJ2Vycm9yJywgbW9kZSA9PT0gJ2Vycm9yJyk7CiAgICBiYWRnZS5vbmNsaWNrID0gbW9kZSA9PT0gJ2Vycm9yJyA/ICgpID0+IGZldGNoQWxsKHsgbWFudWFsOiB0cnVlIH0pIDogbnVsbDsKICB9CiAgZnVuY3Rpb24gZm9ybWF0U291cmNlQWdlTGFiZWwodHNNcykgewogICAgbGV0IG4gPSB0b051bWJlcih0c01zKTsKICAgIGlmICghTnVtYmVyLmlzRmluaXRlKG4pKSByZXR1cm4gbnVsbDsKICAgIGlmIChuIDwgMWUxMikgbiAqPSAxMDAwOwogICAgY29uc3QgYWdlTWluID0gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcigoRGF0ZS5ub3coKSAtIG4pIC8gNjAwMDApKTsKICAgIGlmIChhZ2VNaW4gPCA2MCkgcmV0dXJuIGAke2FnZU1pbn0gbWluYDsKICAgIGNvbnN0IGggPSBNYXRoLmZsb29yKGFnZU1pbiAvIDYwKTsKICAgIGNvbnN0IG0gPSBhZ2VNaW4gJSA2MDsKICAgIHJldHVybiBtID09PSAwID8gYCR7aH0gaGAgOiBgJHtofSBoICR7bX0gbWluYDsKICB9CiAgZnVuY3Rpb24gcmVmcmVzaEZyZXNoQmFkZ2VGcm9tU291cmNlKCkgewogICAgaWYgKHN0YXRlLmZyZXNoQmFkZ2VNb2RlID09PSAnZmV0Y2hpbmcnIHx8IHN0YXRlLmZyZXNoQmFkZ2VNb2RlID09PSAnZXJyb3InKSByZXR1cm47CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShzdGF0ZS5zb3VyY2VUc01zKSkgcmV0dXJuOwogICAgY29uc3QgYWdlTGFiZWwgPSBmb3JtYXRTb3VyY2VBZ2VMYWJlbChzdGF0ZS5zb3VyY2VUc01zKTsKICAgIGlmICghYWdlTGFiZWwpIHJldHVybjsKICAgIHNldEZyZXNoQmFkZ2UoYMOabHRpbWEgYWN0dWFsaXphY2nDs24gaGFjZTogJHthZ2VMYWJlbH1gLCAnaWRsZScpOwogIH0KICBmdW5jdGlvbiBzdGFydEZyZXNoVGlja2VyKCkgewogICAgaWYgKHN0YXRlLmZyZXNoVGlja2VyKSByZXR1cm47CiAgICBzdGF0ZS5mcmVzaFRpY2tlciA9IHNldEludGVydmFsKHJlZnJlc2hGcmVzaEJhZGdlRnJvbVNvdXJjZSwgMzAwMDApOwogIH0KICBmdW5jdGlvbiBzZXRNYXJrZXRUYWcoaXNPcGVuKSB7CiAgICBjb25zdCB0YWcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndGFnLW1lcmNhZG8nKTsKICAgIGlmICghdGFnKSByZXR1cm47CiAgICB0YWcudGV4dENvbnRlbnQgPSBpc09wZW4gPyAnTWVyY2FkbyBhYmllcnRvJyA6ICdNZXJjYWRvIGNlcnJhZG8nOwogICAgdGFnLmNsYXNzTGlzdC50b2dnbGUoJ2Nsb3NlZCcsICFpc09wZW4pOwogIH0KICBmdW5jdGlvbiBzZXRFcnJvckJhbm5lcihzaG93LCB0ZXh0KSB7CiAgICBjb25zdCBiYW5uZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXJyb3ItYmFubmVyJyk7CiAgICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdlcnJvci1iYW5uZXItdGV4dCcpOwogICAgaWYgKCFiYW5uZXIpIHJldHVybjsKICAgIGlmICh0ZXh0ICYmIGxhYmVsKSBsYWJlbC50ZXh0Q29udGVudCA9IHRleHQ7CiAgICBiYW5uZXIuY2xhc3NMaXN0LnRvZ2dsZSgnc2hvdycsICEhc2hvdyk7CiAgfQogIGZ1bmN0aW9uIGV4dHJhY3RSb290KGpzb24pIHsKICAgIHJldHVybiBqc29uICYmIHR5cGVvZiBqc29uID09PSAnb2JqZWN0JyA/IChqc29uLmRhdGEgfHwganNvbi5yZXN1bHQgfHwganNvbikgOiB7fTsKICB9CiAgZnVuY3Rpb24gbm9ybWFsaXplRmNpUm93cyhwYXlsb2FkKSB7CiAgICBjb25zdCByb290ID0gZXh0cmFjdFJvb3QocGF5bG9hZCk7CiAgICBpZiAoQXJyYXkuaXNBcnJheShyb290KSkgcmV0dXJuIHJvb3Q7CiAgICBpZiAoQXJyYXkuaXNBcnJheShyb290Py5pdGVtcykpIHJldHVybiByb290Lml0ZW1zOwogICAgaWYgKEFycmF5LmlzQXJyYXkocm9vdD8ucm93cykpIHJldHVybiByb290LnJvd3M7CiAgICByZXR1cm4gW107CiAgfQogIGZ1bmN0aW9uIG5vcm1hbGl6ZUZjaUZvbmRvS2V5KHZhbHVlKSB7CiAgICByZXR1cm4gU3RyaW5nKHZhbHVlIHx8ICcnKQogICAgICAudG9Mb3dlckNhc2UoKQogICAgICAubm9ybWFsaXplKCdORkQnKQogICAgICAucmVwbGFjZSgvW1x1MDMwMC1cdTAzNmZdL2csICcnKQogICAgICAucmVwbGFjZSgvXHMrL2csICcgJykKICAgICAgLnRyaW0oKTsKICB9CiAgZnVuY3Rpb24gZmNpVHJlbmREaXIoY3VycmVudCwgcHJldmlvdXMpIHsKICAgIGNvbnN0IGN1cnIgPSB0b051bWJlcihjdXJyZW50KTsKICAgIGNvbnN0IHByZXYgPSB0b051bWJlcihwcmV2aW91cyk7CiAgICBpZiAoY3VyciA9PT0gbnVsbCB8fCBwcmV2ID09PSBudWxsKSByZXR1cm4gJ25hJzsKICAgIGlmIChNYXRoLmFicyhjdXJyIC0gcHJldikgPCAxZS05KSByZXR1cm4gJ2ZsYXQnOwogICAgcmV0dXJuIGN1cnIgPiBwcmV2ID8gJ3VwJyA6ICdkb3duJzsKICB9CiAgZnVuY3Rpb24gZmNpVHJlbmRMYWJlbChkaXIpIHsKICAgIGlmIChkaXIgPT09ICd1cCcpIHJldHVybiAnU3ViacOzIHZzIGTDrWEgYW50ZXJpb3InOwogICAgaWYgKGRpciA9PT0gJ2Rvd24nKSByZXR1cm4gJ0JhasOzIHZzIGTDrWEgYW50ZXJpb3InOwogICAgaWYgKGRpciA9PT0gJ2ZsYXQnKSByZXR1cm4gJ1NpbiBjYW1iaW9zIHZzIGTDrWEgYW50ZXJpb3InOwogICAgcmV0dXJuICdTaW4gZGF0byBkZWwgZMOtYSBhbnRlcmlvcic7CiAgfQogIGZ1bmN0aW9uIHJlbmRlckZjaVRyZW5kVmFsdWUodmFsdWUsIGRpcikgewogICAgY29uc3QgZGlyZWN0aW9uID0gZGlyIHx8ICduYSc7CiAgICBjb25zdCBpY29uID0gZGlyZWN0aW9uID09PSAndXAnID8gJ+KWsicgOiBkaXJlY3Rpb24gPT09ICdkb3duJyA/ICfilrwnIDogZGlyZWN0aW9uID09PSAnZmxhdCcgPyAnPScgOiAnwrcnOwogICAgcmV0dXJuIGA8c3BhbiBjbGFzcz0iZmNpLXRyZW5kICR7ZGlyZWN0aW9ufSIgdGl0bGU9IiR7ZXNjYXBlSHRtbChmY2lUcmVuZExhYmVsKGRpcmVjdGlvbikpfSI+PHNwYW4gY2xhc3M9ImZjaS10cmVuZC1pY29uIj4ke2ljb259PC9zcGFuPjxzcGFuPiR7Zm9ybWF0Q29tcGFjdE1vbmV5KHZhbHVlLCAyKX08L3NwYW4+PC9zcGFuPmA7CiAgfQogIGZ1bmN0aW9uIHJvdW5kMm4odmFsdWUpIHsKICAgIGNvbnN0IG4gPSBOdW1iZXIodmFsdWUpOwogICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobikpIHJldHVybiBudWxsOwogICAgcmV0dXJuIE1hdGgucm91bmQobiAqIDEwMCkgLyAxMDA7CiAgfQogIGZ1bmN0aW9uIGNvbXB1dGVNb250aGx5UGN0KHZjcCwgYmFzZVZjcCkgewogICAgY29uc3QgY3VyciA9IHRvTnVtYmVyKHZjcCk7CiAgICBjb25zdCBwcmV2ID0gdG9OdW1iZXIoYmFzZVZjcCk7CiAgICBpZiAoY3VyciA9PT0gbnVsbCB8fCBwcmV2ID09PSBudWxsIHx8IHByZXYgPD0gMCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gcm91bmQybigoKGN1cnIgLSBwcmV2KSAvIHByZXYpICogMTAwKTsKICB9CiAgZnVuY3Rpb24gY29tcHV0ZUVzdGltYXRlZE1vbnRobHlQY3RGcm9tUHJldmlvdXModmNwLCBwcmV2aW91c1ZjcCkgewogICAgY29uc3QgY3VyciA9IHRvTnVtYmVyKHZjcCk7CiAgICBjb25zdCBwcmV2ID0gdG9OdW1iZXIocHJldmlvdXNWY3ApOwogICAgaWYgKGN1cnIgPT09IG51bGwgfHwgcHJldiA9PT0gbnVsbCB8fCBwcmV2IDw9IDApIHJldHVybiBudWxsOwogICAgY29uc3QgZGFpbHkgPSAoY3VyciAtIHByZXYpIC8gcHJldjsKICAgIHJldHVybiByb3VuZDJuKCgoTWF0aC5wb3coMSArIGRhaWx5LCAzMCkgLSAxKSAqIDEwMCkpOwogIH0KICBmdW5jdGlvbiBmb3JtYXRQY3RWYWwodmFsdWUpIHsKICAgIHJldHVybiB2YWx1ZSA9PT0gbnVsbCA/ICfigJQnIDogYCR7dmFsdWUudG9GaXhlZCgyKX0lYDsKICB9CiAgZnVuY3Rpb24gdG9Nb250aEtleShkYXRlU3RyKSB7CiAgICBpZiAodHlwZW9mIGRhdGVTdHIgIT09ICdzdHJpbmcnKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGNsZWFuID0gZGF0ZVN0ci50cmltKCk7CiAgICBpZiAoL15cZHs0fS1cZHsyfS1cZHsyfSQvLnRlc3QoY2xlYW4pKSByZXR1cm4gY2xlYW4uc2xpY2UoMCwgNyk7CiAgICByZXR1cm4gbnVsbDsKICB9CiAgZnVuY3Rpb24gbG9hZEZjaVNpZ25hbFN0cmVha3MoKSB7CiAgICB0cnkgewogICAgICBjb25zdCByYXcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShGQ0lfU0lHTkFMX1NUUkVBS19LRVkpOwogICAgICBpZiAoIXJhdykgcmV0dXJuIHsgZmlqYToge30sIHZhcmlhYmxlOiB7fSB9OwogICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdyk7CiAgICAgIHJldHVybiB7CiAgICAgICAgZmlqYTogcGFyc2VkPy5maWphICYmIHR5cGVvZiBwYXJzZWQuZmlqYSA9PT0gJ29iamVjdCcgPyBwYXJzZWQuZmlqYSA6IHt9LAogICAgICAgIHZhcmlhYmxlOiBwYXJzZWQ/LnZhcmlhYmxlICYmIHR5cGVvZiBwYXJzZWQudmFyaWFibGUgPT09ICdvYmplY3QnID8gcGFyc2VkLnZhcmlhYmxlIDoge30KICAgICAgfTsKICAgIH0gY2F0Y2ggewogICAgICByZXR1cm4geyBmaWphOiB7fSwgdmFyaWFibGU6IHt9IH07CiAgICB9CiAgfQogIGZ1bmN0aW9uIHNhdmVGY2lTaWduYWxTdHJlYWtzKCkgewogICAgaWYgKCFzdGF0ZS5mY2lTaWduYWxTdHJlYWtzRGlydHkpIHJldHVybjsKICAgIHRyeSB7CiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEZDSV9TSUdOQUxfU1RSRUFLX0tFWSwgSlNPTi5zdHJpbmdpZnkoc3RhdGUuZmNpU2lnbmFsU3RyZWFrcykpOwogICAgICBzdGF0ZS5mY2lTaWduYWxTdHJlYWtzRGlydHkgPSBmYWxzZTsKICAgIH0gY2F0Y2gge30KICB9CiAgZnVuY3Rpb24gcmVzb2x2ZUZjaVNpZ25hbFN0cmVhayh0eXBlLCBmb25kb0tleSwgbGV2ZWwsIG1vbnRoS2V5KSB7CiAgICBpZiAoIXR5cGUgfHwgIWZvbmRvS2V5IHx8ICFtb250aEtleSB8fCAhbGV2ZWwgfHwgbGV2ZWwgPT09ICduYScpIHJldHVybiBudWxsOwogICAgY29uc3QgYnlUeXBlID0gc3RhdGUuZmNpU2lnbmFsU3RyZWFrc1t0eXBlXSB8fCAoc3RhdGUuZmNpU2lnbmFsU3RyZWFrc1t0eXBlXSA9IHt9KTsKICAgIGNvbnN0IGN1cnJlbnQgPSBieVR5cGVbZm9uZG9LZXldOwogICAgaWYgKCFjdXJyZW50KSB7CiAgICAgIGJ5VHlwZVtmb25kb0tleV0gPSB7IGxldmVsLCBtb250aEtleSwgbW9udGhzOiAxIH07CiAgICAgIHN0YXRlLmZjaVNpZ25hbFN0cmVha3NEaXJ0eSA9IHRydWU7CiAgICAgIHJldHVybiAxOwogICAgfQogICAgY29uc3QgcHJldk1vbnRocyA9IE51bWJlci5pc0Zpbml0ZShOdW1iZXIoY3VycmVudC5tb250aHMpKSA/IE51bWJlcihjdXJyZW50Lm1vbnRocykgOiAxOwogICAgaWYgKGN1cnJlbnQubW9udGhLZXkgPT09IG1vbnRoS2V5KSB7CiAgICAgIGlmIChjdXJyZW50LmxldmVsICE9PSBsZXZlbCkgewogICAgICAgIGN1cnJlbnQubGV2ZWwgPSBsZXZlbDsKICAgICAgICBjdXJyZW50Lm1vbnRocyA9IDE7CiAgICAgICAgc3RhdGUuZmNpU2lnbmFsU3RyZWFrc0RpcnR5ID0gdHJ1ZTsKICAgICAgICByZXR1cm4gMTsKICAgICAgfQogICAgICByZXR1cm4gcHJldk1vbnRoczsKICAgIH0KICAgIGN1cnJlbnQubW9udGhzID0gY3VycmVudC5sZXZlbCA9PT0gbGV2ZWwgPyBwcmV2TW9udGhzICsgMSA6IDE7CiAgICBjdXJyZW50LmxldmVsID0gbGV2ZWw7CiAgICBjdXJyZW50Lm1vbnRoS2V5ID0gbW9udGhLZXk7CiAgICBzdGF0ZS5mY2lTaWduYWxTdHJlYWtzRGlydHkgPSB0cnVlOwogICAgcmV0dXJuIGN1cnJlbnQubW9udGhzOwogIH0KICBmdW5jdGlvbiByZW5kZXJGY2lTaWduYWxCYWRnZShzaWduYWwpIHsKICAgIGNvbnN0IHMgPSBzaWduYWwgfHwgeyBraW5kOiAnbmEnLCBsYWJlbDogJ3MvZGF0bycsIGRldGFpbDogJycsIHN0cmVha01vbnRoczogbnVsbCB9OwogICAgY29uc3Qgc3RyZWFrVmFsdWUgPSBOdW1iZXIocy5zdHJlYWtNb250aHMpOwogICAgY29uc3Qgc3RyZWFrID0gTnVtYmVyLmlzRmluaXRlKHN0cmVha1ZhbHVlKSAmJiBzdHJlYWtWYWx1ZSA+PSAxCiAgICAgID8gYDxzcGFuIGNsYXNzPSJmY2ktc2lnbmFsLXN0cmVhayI+TGxldmEgJHtzLnN0cmVha01vbnRoc30gJHtOdW1iZXIocy5zdHJlYWtNb250aHMpID09PSAxID8gJ21lcycgOiAnbWVzZXMnfSBlbiBlc3RlIGVzdGFkby48L3NwYW4+YAogICAgICA6ICcnOwogICAgcmV0dXJuIGA8c3BhbiBjbGFzcz0iZmNpLXNpZ25hbC13cmFwIj48c3BhbiBjbGFzcz0iZmNpLXNpZ25hbCAke3Mua2luZH0iIHRpdGxlPSIke2VzY2FwZUh0bWwocy5kZXRhaWwgfHwgcy5sYWJlbCl9Ij4ke2VzY2FwZUh0bWwocy5sYWJlbCl9PC9zcGFuPiR7c3RyZWFrfTwvc3Bhbj5gOwogIH0KICBmdW5jdGlvbiBjb21wdXRlRmNpU2lnbmFsKHJvdywgdHlwZSkgewogICAgY29uc3QgbW9udGhseVBjdDMwID0gdG9OdW1iZXIocm93Lm1vbnRobHlQY3QpOwogICAgY29uc3QgbW9udGhseVBjdEZhbGxiYWNrID0gY29tcHV0ZUVzdGltYXRlZE1vbnRobHlQY3RGcm9tUHJldmlvdXMocm93LnZjcCwgcm93LnByZXZpb3VzVmNwKTsKICAgIGNvbnN0IG1vbnRobHlQY3QgPSBtb250aGx5UGN0MzAgIT09IG51bGwgPyBtb250aGx5UGN0MzAgOiBtb250aGx5UGN0RmFsbGJhY2s7CiAgICBjb25zdCBwZiA9IHRvTnVtYmVyKHN0YXRlLmJlbmNobWFyay5wbGF6b0Zpam9Nb250aGx5UGN0KTsKICAgIGNvbnN0IGluZiA9IHRvTnVtYmVyKHN0YXRlLmJlbmNobWFyay5pbmZsYWNpb25Nb250aGx5UGN0KTsKICAgIGlmIChtb250aGx5UGN0ID09PSBudWxsIHx8IHBmID09PSBudWxsIHx8IGluZiA9PT0gbnVsbCkgewogICAgICByZXR1cm4geyBraW5kOiAnbmEnLCBsZXZlbDogJ25hJywgbGFiZWw6ICdzL2RhdG8nLCBkZXRhaWw6ICdTaW4gZGF0byBzdWZpY2llbnRlIHBhcmEgY2FsY3VsYXIgc2XDsWFsIG1lbnN1YWwgY29udHJhIHBsYXpvIGZpam8gZSBpbmZsYWNpw7NuLicsIHN0cmVha01vbnRoczogbnVsbCB9OwogICAgfQogICAgY29uc3QgbWFyZ2luVnNJbmYgPSByb3VuZDJuKG1vbnRobHlQY3QgLSBpbmYpOwogICAgY29uc3QgYmFzZUxhYmVsID0gbW9udGhseVBjdDMwICE9PSBudWxsID8gJ1ZDUCB2cyAzMGQnIDogJ2VzdGltYWRvICh2cyBkw61hIGFudGVyaW9yKSc7CiAgICBjb25zdCBkZXRhaWwgPSBgUmVuZC4gbWVuc3VhbCBGQ0kgKCR7YmFzZUxhYmVsfSk6ICR7Zm9ybWF0UGN0VmFsKG1vbnRobHlQY3QpfSDCtyBQRiBtZW5zdWFsOiAke2Zvcm1hdFBjdFZhbChwZil9IMK3IEluZmxhY2nDs24gbWVuc3VhbDogJHtmb3JtYXRQY3RWYWwoaW5mKX1gOwogICAgbGV0IHNpZ25hbCA9IG51bGw7CiAgICBpZiAobW9udGhseVBjdCA8IHBmICYmIG1vbnRobHlQY3QgPCBpbmYpIHsKICAgICAgc2lnbmFsID0geyBraW5kOiAnYmFkJywgbGV2ZWw6ICdwZXJkaWVuZG8nLCBsYWJlbDogJ/CflLQgUEVSRElFTkRPJywgZGV0YWlsIH07CiAgICB9IGVsc2UgaWYgKG1vbnRobHlQY3QgPj0gcGYgJiYgbW9udGhseVBjdCA8IGluZikgewogICAgICBzaWduYWwgPSB7IGtpbmQ6ICdvam8nLCBsZXZlbDogJ29qbycsIGxhYmVsOiAn8J+foCBPSk8nLCBkZXRhaWwgfTsKICAgIH0gZWxzZSBpZiAobW9udGhseVBjdCA+PSBpbmYgJiYgbWFyZ2luVnNJbmYgPD0gMC41KSB7CiAgICAgIHNpZ25hbCA9IHsga2luZDogJ3dhcm4nLCBsZXZlbDogJ2FjZXB0YWJsZScsIGxhYmVsOiAn8J+foSBBQ0VQVEFCTEUnLCBkZXRhaWwgfTsKICAgIH0gZWxzZSBpZiAobW9udGhseVBjdCA+IHBmICYmIG1hcmdpblZzSW5mID4gMC41KSB7CiAgICAgIHNpZ25hbCA9IHsga2luZDogJ2dvb2QnLCBsZXZlbDogJ2dhbmFuZG8nLCBsYWJlbDogJ/Cfn6IgR0FOQU5ETycsIGRldGFpbCB9OwogICAgfSBlbHNlIHsKICAgICAgc2lnbmFsID0geyBraW5kOiAnd2FybicsIGxldmVsOiAnYWNlcHRhYmxlJywgbGFiZWw6ICfwn5+hIEFDRVBUQUJMRScsIGRldGFpbCB9OwogICAgfQogICAgY29uc3QgbW9udGhLZXkgPSB0b01vbnRoS2V5KHJvdy5mZWNoYSk7CiAgICBjb25zdCBzdHJlYWtNb250aHMgPSByZXNvbHZlRmNpU2lnbmFsU3RyZWFrKHR5cGUsIG5vcm1hbGl6ZUZjaUZvbmRvS2V5KHJvdy5mb25kbyksIHNpZ25hbC5sZXZlbCwgbW9udGhLZXkpOwogICAgcmV0dXJuIHsgLi4uc2lnbmFsLCBzdHJlYWtNb250aHMgfTsKICB9CiAgZnVuY3Rpb24gcmVuZGVyRmNpQmVuY2htYXJrSW5mbygpIHsKICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1iZW5jaC1pbmZvJyk7CiAgICBpZiAoIWVsKSByZXR1cm47CiAgICBjb25zdCBwZiA9IHRvTnVtYmVyKHN0YXRlLmJlbmNobWFyay5wbGF6b0Zpam9Nb250aGx5UGN0KTsKICAgIGNvbnN0IGluZiA9IHRvTnVtYmVyKHN0YXRlLmJlbmNobWFyay5pbmZsYWNpb25Nb250aGx5UGN0KTsKICAgIGNvbnN0IGluZkRhdGUgPSBzdGF0ZS5iZW5jaG1hcmsuaW5mbGFjaW9uRGF0ZSB8fCAn4oCUJzsKICAgIGlmIChwZiA9PT0gbnVsbCAmJiBpbmYgPT09IG51bGwpIHsKICAgICAgZWwuaW5uZXJIVE1MID0gJ0JlbmNobWFyazogc2luIGRhdG9zIGRlIHJlZmVyZW5jaWEgcG9yIGFob3JhLic7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IHVwZGF0ZWQgPSBzdGF0ZS5iZW5jaG1hcmsudXBkYXRlZEF0SHVtYW5BcnQgPyBgIMK3IEFjdHVhbGl6YWRvOiAke2VzY2FwZUh0bWwoc3RhdGUuYmVuY2htYXJrLnVwZGF0ZWRBdEh1bWFuQXJ0KX1gIDogJyc7CiAgICBlbC5pbm5lckhUTUwgPSBgPHN0cm9uZz5CZW5jaG1hcms6PC9zdHJvbmc+IFBGIHJlZiBtZW5zdWFsICR7Zm9ybWF0UGN0VmFsKHBmKX0gwrcgSW5mbGFjacOzbiBtZW5zdWFsICgke2VzY2FwZUh0bWwoaW5mRGF0ZSl9KSAke2Zvcm1hdFBjdFZhbChpbmYpfSR7dXBkYXRlZH1gOwogIH0KICBmdW5jdGlvbiBnZXRIaXN0b3J5Q29sRWxlbWVudHMoKSB7CiAgICBjb25zdCBjb2xncm91cCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoaXN0b3J5LWNvbGdyb3VwJyk7CiAgICByZXR1cm4gY29sZ3JvdXAgPyBBcnJheS5mcm9tKGNvbGdyb3VwLnF1ZXJ5U2VsZWN0b3JBbGwoJ2NvbCcpKSA6IFtdOwogIH0KICBmdW5jdGlvbiBjbGFtcEhpc3RvcnlXaWR0aHMod2lkdGhzKSB7CiAgICByZXR1cm4gSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFMubWFwKChmYWxsYmFjaywgaSkgPT4gewogICAgICBjb25zdCByYXcgPSBOdW1iZXIod2lkdGhzPy5baV0pOwogICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShyYXcpKSByZXR1cm4gZmFsbGJhY2s7CiAgICAgIGNvbnN0IG1pbiA9IEhJU1RPUllfTUlOX0NPTF9XSURUSFNbaV0gPz8gODA7CiAgICAgIHJldHVybiBNYXRoLm1heChtaW4sIE1hdGgucm91bmQocmF3KSk7CiAgICB9KTsKICB9CiAgZnVuY3Rpb24gc2F2ZUhpc3RvcnlDb2x1bW5XaWR0aHMod2lkdGhzKSB7CiAgICB0cnkgewogICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShISVNUT1JZX0NPTFNfS0VZLCBKU09OLnN0cmluZ2lmeShjbGFtcEhpc3RvcnlXaWR0aHMod2lkdGhzKSkpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBjb25zb2xlLmVycm9yKCdbUmFkYXJNRVBdIG5vIHNlIHB1ZG8gZ3VhcmRhciBhbmNob3MgZGUgY29sdW1uYXMnLCBlKTsKICAgIH0KICB9CiAgZnVuY3Rpb24gbG9hZEhpc3RvcnlDb2x1bW5XaWR0aHMoKSB7CiAgICB0cnkgewogICAgICBjb25zdCByYXcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShISVNUT1JZX0NPTFNfS0VZKTsKICAgICAgaWYgKCFyYXcpIHJldHVybiBudWxsOwogICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdyk7CiAgICAgIGlmICghQXJyYXkuaXNBcnJheShwYXJzZWQpIHx8IHBhcnNlZC5sZW5ndGggIT09IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTLmxlbmd0aCkgcmV0dXJuIG51bGw7CiAgICAgIHJldHVybiBjbGFtcEhpc3RvcnlXaWR0aHMocGFyc2VkKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgY29uc29sZS5lcnJvcignW1JhZGFyTUVQXSBhbmNob3MgZGUgY29sdW1uYXMgaW52w6FsaWRvcycsIGUpOwogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CiAgZnVuY3Rpb24gYXBwbHlIaXN0b3J5Q29sdW1uV2lkdGhzKHdpZHRocywgcGVyc2lzdCA9IGZhbHNlKSB7CiAgICBjb25zdCBjb2xzID0gZ2V0SGlzdG9yeUNvbEVsZW1lbnRzKCk7CiAgICBpZiAoY29scy5sZW5ndGggIT09IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTLmxlbmd0aCkgcmV0dXJuOwogICAgY29uc3QgbmV4dCA9IGNsYW1wSGlzdG9yeVdpZHRocyh3aWR0aHMpOwogICAgY29scy5mb3JFYWNoKChjb2wsIGkpID0+IHsKICAgICAgY29sLnN0eWxlLndpZHRoID0gYCR7bmV4dFtpXX1weGA7CiAgICB9KTsKICAgIHN0YXRlLmhpc3RvcnlDb2xXaWR0aHMgPSBuZXh0OwogICAgaWYgKHBlcnNpc3QpIHNhdmVIaXN0b3J5Q29sdW1uV2lkdGhzKG5leHQpOwogIH0KICBmdW5jdGlvbiBpbml0SGlzdG9yeUNvbHVtbldpZHRocygpIHsKICAgIGNvbnN0IHNhdmVkID0gbG9hZEhpc3RvcnlDb2x1bW5XaWR0aHMoKTsKICAgIGFwcGx5SGlzdG9yeUNvbHVtbldpZHRocyhzYXZlZCB8fCBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIUywgZmFsc2UpOwogIH0KICBmdW5jdGlvbiBiaW5kSGlzdG9yeUNvbHVtblJlc2l6ZSgpIHsKICAgIGlmIChzdGF0ZS5oaXN0b3J5UmVzaXplQm91bmQpIHJldHVybjsKICAgIGNvbnN0IHRhYmxlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hpc3RvcnktdGFibGUnKTsKICAgIGlmICghdGFibGUpIHJldHVybjsKICAgIGNvbnN0IGhhbmRsZXMgPSBBcnJheS5mcm9tKHRhYmxlLnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb2wtcmVzaXplcicpKTsKICAgIGlmICghaGFuZGxlcy5sZW5ndGgpIHJldHVybjsKICAgIHN0YXRlLmhpc3RvcnlSZXNpemVCb3VuZCA9IHRydWU7CgogICAgaGFuZGxlcy5mb3JFYWNoKChoYW5kbGUpID0+IHsKICAgICAgaGFuZGxlLmFkZEV2ZW50TGlzdGVuZXIoJ2RibGNsaWNrJywgKGV2ZW50KSA9PiB7CiAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKICAgICAgICBjb25zdCBpZHggPSBOdW1iZXIoaGFuZGxlLmRhdGFzZXQuY29sSW5kZXgpOwogICAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGlkeCkpIHJldHVybjsKICAgICAgICBjb25zdCBuZXh0ID0gc3RhdGUuaGlzdG9yeUNvbFdpZHRocy5zbGljZSgpOwogICAgICAgIG5leHRbaWR4XSA9IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTW2lkeF07CiAgICAgICAgYXBwbHlIaXN0b3J5Q29sdW1uV2lkdGhzKG5leHQsIHRydWUpOwogICAgICB9KTsKICAgICAgaGFuZGxlLmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJkb3duJywgKGV2ZW50KSA9PiB7CiAgICAgICAgaWYgKGV2ZW50LmJ1dHRvbiAhPT0gMCkgcmV0dXJuOwogICAgICAgIGNvbnN0IGlkeCA9IE51bWJlcihoYW5kbGUuZGF0YXNldC5jb2xJbmRleCk7CiAgICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoaWR4KSkgcmV0dXJuOwogICAgICAgIGNvbnN0IHN0YXJ0WCA9IGV2ZW50LmNsaWVudFg7CiAgICAgICAgY29uc3Qgc3RhcnRXaWR0aCA9IHN0YXRlLmhpc3RvcnlDb2xXaWR0aHNbaWR4XSA/PyBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIU1tpZHhdOwogICAgICAgIGhhbmRsZS5jbGFzc0xpc3QuYWRkKCdhY3RpdmUnKTsKICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpOwoKICAgICAgICBjb25zdCBvbk1vdmUgPSAobW92ZUV2ZW50KSA9PiB7CiAgICAgICAgICBjb25zdCBkZWx0YSA9IG1vdmVFdmVudC5jbGllbnRYIC0gc3RhcnRYOwogICAgICAgICAgY29uc3QgbWluID0gSElTVE9SWV9NSU5fQ09MX1dJRFRIU1tpZHhdID8/IDgwOwogICAgICAgICAgY29uc3QgbmV4dFdpZHRoID0gTWF0aC5tYXgobWluLCBNYXRoLnJvdW5kKHN0YXJ0V2lkdGggKyBkZWx0YSkpOwogICAgICAgICAgY29uc3QgbmV4dCA9IHN0YXRlLmhpc3RvcnlDb2xXaWR0aHMuc2xpY2UoKTsKICAgICAgICAgIG5leHRbaWR4XSA9IG5leHRXaWR0aDsKICAgICAgICAgIGFwcGx5SGlzdG9yeUNvbHVtbldpZHRocyhuZXh0LCBmYWxzZSk7CiAgICAgICAgfTsKICAgICAgICBjb25zdCBvblVwID0gKCkgPT4gewogICAgICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJtb3ZlJywgb25Nb3ZlKTsKICAgICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdwb2ludGVydXAnLCBvblVwKTsKICAgICAgICAgIGhhbmRsZS5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKTsKICAgICAgICAgIHNhdmVIaXN0b3J5Q29sdW1uV2lkdGhzKHN0YXRlLmhpc3RvcnlDb2xXaWR0aHMpOwogICAgICAgIH07CiAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJtb3ZlJywgb25Nb3ZlKTsKICAgICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcnVwJywgb25VcCk7CiAgICAgIH0pOwogICAgfSk7CiAgfQoKICBmdW5jdGlvbiBnZXRGY2lDb2xFbGVtZW50cygpIHsKICAgIGNvbnN0IGNvbGdyb3VwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1jb2xncm91cCcpOwogICAgcmV0dXJuIGNvbGdyb3VwID8gQXJyYXkuZnJvbShjb2xncm91cC5xdWVyeVNlbGVjdG9yQWxsKCdjb2wnKSkgOiBbXTsKICB9CiAgZnVuY3Rpb24gY2xhbXBGY2lXaWR0aHMod2lkdGhzKSB7CiAgICByZXR1cm4gRkNJX0RFRkFVTFRfQ09MX1dJRFRIUy5tYXAoKGZhbGxiYWNrLCBpKSA9PiB7CiAgICAgIGNvbnN0IHJhdyA9IE51bWJlcih3aWR0aHM/LltpXSk7CiAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHJhdykpIHJldHVybiBmYWxsYmFjazsKICAgICAgY29uc3QgbWluID0gRkNJX01JTl9DT0xfV0lEVEhTW2ldID8/IDgwOwogICAgICByZXR1cm4gTWF0aC5tYXgobWluLCBNYXRoLnJvdW5kKHJhdykpOwogICAgfSk7CiAgfQogIGZ1bmN0aW9uIHNhdmVGY2lDb2x1bW5XaWR0aHMod2lkdGhzKSB7CiAgICB0cnkgewogICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShGQ0lfQ09MU19LRVksIEpTT04uc3RyaW5naWZ5KGNsYW1wRmNpV2lkdGhzKHdpZHRocykpKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgY29uc29sZS5lcnJvcignW1JhZGFyTUVQXSBubyBzZSBwdWRvIGd1YXJkYXIgYW5jaG9zIGRlIGNvbHVtbmFzIEZDSScsIGUpOwogICAgfQogIH0KICBmdW5jdGlvbiBsb2FkRmNpQ29sdW1uV2lkdGhzKCkgewogICAgdHJ5IHsKICAgICAgY29uc3QgcmF3ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oRkNJX0NPTFNfS0VZKTsKICAgICAgaWYgKCFyYXcpIHJldHVybiBudWxsOwogICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdyk7CiAgICAgIGlmICghQXJyYXkuaXNBcnJheShwYXJzZWQpIHx8IHBhcnNlZC5sZW5ndGggIT09IEZDSV9ERUZBVUxUX0NPTF9XSURUSFMubGVuZ3RoKSByZXR1cm4gbnVsbDsKICAgICAgcmV0dXJuIGNsYW1wRmNpV2lkdGhzKHBhcnNlZCk7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tSYWRhck1FUF0gYW5jaG9zIGRlIGNvbHVtbmFzIEZDSSBpbnbDoWxpZG9zJywgZSk7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogIH0KICBmdW5jdGlvbiBhcHBseUZjaUNvbHVtbldpZHRocyh3aWR0aHMsIHBlcnNpc3QgPSBmYWxzZSkgewogICAgY29uc3QgY29scyA9IGdldEZjaUNvbEVsZW1lbnRzKCk7CiAgICBpZiAoY29scy5sZW5ndGggIT09IEZDSV9ERUZBVUxUX0NPTF9XSURUSFMubGVuZ3RoKSByZXR1cm47CiAgICBjb25zdCBuZXh0ID0gY2xhbXBGY2lXaWR0aHMod2lkdGhzKTsKICAgIGNvbHMuZm9yRWFjaCgoY29sLCBpKSA9PiB7CiAgICAgIGNvbC5zdHlsZS53aWR0aCA9IGAke25leHRbaV19cHhgOwogICAgfSk7CiAgICBzdGF0ZS5mY2lDb2xXaWR0aHMgPSBuZXh0OwogICAgaWYgKHBlcnNpc3QpIHNhdmVGY2lDb2x1bW5XaWR0aHMobmV4dCk7CiAgfQogIGZ1bmN0aW9uIGluaXRGY2lDb2x1bW5XaWR0aHMoKSB7CiAgICBjb25zdCBzYXZlZCA9IGxvYWRGY2lDb2x1bW5XaWR0aHMoKTsKICAgIGFwcGx5RmNpQ29sdW1uV2lkdGhzKHNhdmVkIHx8IEZDSV9ERUZBVUxUX0NPTF9XSURUSFMsIGZhbHNlKTsKICB9CiAgZnVuY3Rpb24gYmluZEZjaUNvbHVtblJlc2l6ZSgpIHsKICAgIGlmIChzdGF0ZS5mY2lSZXNpemVCb3VuZCkgcmV0dXJuOwogICAgY29uc3QgdGFibGUgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZmNpLXRhYmxlJyk7CiAgICBpZiAoIXRhYmxlKSByZXR1cm47CiAgICBjb25zdCBoYW5kbGVzID0gQXJyYXkuZnJvbSh0YWJsZS5xdWVyeVNlbGVjdG9yQWxsKCcuZmNpLWNvbC1yZXNpemVyJykpOwogICAgaWYgKCFoYW5kbGVzLmxlbmd0aCkgcmV0dXJuOwogICAgc3RhdGUuZmNpUmVzaXplQm91bmQgPSB0cnVlOwoKICAgIGhhbmRsZXMuZm9yRWFjaCgoaGFuZGxlKSA9PiB7CiAgICAgIGhhbmRsZS5hZGRFdmVudExpc3RlbmVyKCdkYmxjbGljaycsIChldmVudCkgPT4gewogICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgY29uc3QgaWR4ID0gTnVtYmVyKGhhbmRsZS5kYXRhc2V0LmZjaUNvbEluZGV4KTsKICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShpZHgpKSByZXR1cm47CiAgICAgICAgY29uc3QgbmV4dCA9IHN0YXRlLmZjaUNvbFdpZHRocy5zbGljZSgpOwogICAgICAgIG5leHRbaWR4XSA9IEZDSV9ERUZBVUxUX0NPTF9XSURUSFNbaWR4XTsKICAgICAgICBhcHBseUZjaUNvbHVtbldpZHRocyhuZXh0LCB0cnVlKTsKICAgICAgfSk7CiAgICAgIGhhbmRsZS5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVyZG93bicsIChldmVudCkgPT4gewogICAgICAgIGlmIChldmVudC5idXR0b24gIT09IDApIHJldHVybjsKICAgICAgICBjb25zdCBpZHggPSBOdW1iZXIoaGFuZGxlLmRhdGFzZXQuZmNpQ29sSW5kZXgpOwogICAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGlkeCkpIHJldHVybjsKICAgICAgICBjb25zdCBzdGFydFggPSBldmVudC5jbGllbnRYOwogICAgICAgIGNvbnN0IHN0YXJ0V2lkdGggPSBzdGF0ZS5mY2lDb2xXaWR0aHNbaWR4XSA/PyBGQ0lfREVGQVVMVF9DT0xfV0lEVEhTW2lkeF07CiAgICAgICAgaGFuZGxlLmNsYXNzTGlzdC5hZGQoJ2FjdGl2ZScpOwogICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7CgogICAgICAgIGNvbnN0IG9uTW92ZSA9IChtb3ZlRXZlbnQpID0+IHsKICAgICAgICAgIGNvbnN0IGRlbHRhID0gbW92ZUV2ZW50LmNsaWVudFggLSBzdGFydFg7CiAgICAgICAgICBjb25zdCBtaW4gPSBGQ0lfTUlOX0NPTF9XSURUSFNbaWR4XSA/PyA4MDsKICAgICAgICAgIGNvbnN0IG5leHRXaWR0aCA9IE1hdGgubWF4KG1pbiwgTWF0aC5yb3VuZChzdGFydFdpZHRoICsgZGVsdGEpKTsKICAgICAgICAgIGNvbnN0IG5leHQgPSBzdGF0ZS5mY2lDb2xXaWR0aHMuc2xpY2UoKTsKICAgICAgICAgIG5leHRbaWR4XSA9IG5leHRXaWR0aDsKICAgICAgICAgIGFwcGx5RmNpQ29sdW1uV2lkdGhzKG5leHQsIGZhbHNlKTsKICAgICAgICB9OwogICAgICAgIGNvbnN0IG9uVXAgPSAoKSA9PiB7CiAgICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcm1vdmUnLCBvbk1vdmUpOwogICAgICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJ1cCcsIG9uVXApOwogICAgICAgICAgaGFuZGxlLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpOwogICAgICAgICAgc2F2ZUZjaUNvbHVtbldpZHRocyhzdGF0ZS5mY2lDb2xXaWR0aHMpOwogICAgICAgIH07CiAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJtb3ZlJywgb25Nb3ZlKTsKICAgICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcnVwJywgb25VcCk7CiAgICAgIH0pOwogICAgfSk7CiAgfQoKICAvLyAzKSBGdW5jaW9uZXMgZGUgcmVuZGVyCiAgZnVuY3Rpb24gcmVuZGVyTWVwQ2NsKHBheWxvYWQpIHsKICAgIGlmICghcGF5bG9hZCkgewogICAgICBzZXREYXNoKFsnbWVwLXZhbCcsICdjY2wtdmFsJywgJ2JyZWNoYS1hYnMnLCAnYnJlY2hhLXBjdCddKTsKICAgICAgc2V0VGV4dCgnc3RhdHVzLWxhYmVsJywgJ0RhdG9zIGluY29tcGxldG9zJyk7CiAgICAgIHNldFRleHQoJ3N0YXR1cy1iYWRnZScsICdTaW4gZGF0bycpOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBkYXRhID0gZXh0cmFjdFJvb3QocGF5bG9hZCk7CiAgICBjb25zdCBjdXJyZW50ID0gZGF0YSAmJiB0eXBlb2YgZGF0YS5jdXJyZW50ID09PSAnb2JqZWN0JyA/IGRhdGEuY3VycmVudCA6IG51bGw7CiAgICBjb25zdCBtZXAgPSBjdXJyZW50ID8gdG9OdW1iZXIoY3VycmVudC5tZXApIDogKHBpY2tOdW1iZXIoZGF0YSwgW1snbWVwJywgJ3ZlbnRhJ10sIFsnbWVwJywgJ3NlbGwnXSwgWydtZXAnXSwgWydtZXBfdmVudGEnXSwgWydkb2xhcl9tZXAnXV0pID8/IHBpY2tCeUtleUhpbnQoZGF0YSwgJ21lcCcpKTsKICAgIGNvbnN0IGNjbCA9IGN1cnJlbnQgPyB0b051bWJlcihjdXJyZW50LmNjbCkgOiAocGlja051bWJlcihkYXRhLCBbWydjY2wnLCAndmVudGEnXSwgWydjY2wnLCAnc2VsbCddLCBbJ2NjbCddLCBbJ2NjbF92ZW50YSddLCBbJ2RvbGFyX2NjbCddXSkgPz8gcGlja0J5S2V5SGludChkYXRhLCAnY2NsJykpOwogICAgY29uc3QgYWJzID0gY3VycmVudCA/IHRvTnVtYmVyKGN1cnJlbnQuYWJzRGlmZikgPz8gKG1lcCAhPT0gbnVsbCAmJiBjY2wgIT09IG51bGwgPyBNYXRoLmFicyhtZXAgLSBjY2wpIDogbnVsbCkgOiAobWVwICE9PSBudWxsICYmIGNjbCAhPT0gbnVsbCA/IE1hdGguYWJzKG1lcCAtIGNjbCkgOiBudWxsKTsKICAgIGNvbnN0IHBjdCA9IGN1cnJlbnQgPyB0b051bWJlcihjdXJyZW50LnBjdERpZmYpID8/IGJyZWNoYVBlcmNlbnQobWVwLCBjY2wpIDogYnJlY2hhUGVyY2VudChtZXAsIGNjbCk7CiAgICBjb25zdCBpc1NpbWlsYXIgPSBjdXJyZW50ICYmIHR5cGVvZiBjdXJyZW50LnNpbWlsYXIgPT09ICdib29sZWFuJwogICAgICA/IGN1cnJlbnQuc2ltaWxhcgogICAgICA6IChwY3QgIT09IG51bGwgJiYgYWJzICE9PSBudWxsICYmIChwY3QgPD0gU0lNSUxBUl9QQ1RfVEhSRVNIT0xEIHx8IGFicyA8PSBTSU1JTEFSX0FSU19USFJFU0hPTEQpKTsKCiAgICBzZXRUZXh0KCdtZXAtdmFsJywgZm9ybWF0TW9uZXkobWVwLCAyKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ2NjbC12YWwnLCBmb3JtYXRNb25leShjY2wsIDIpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnYnJlY2hhLWFicycsIGFicyA9PT0gbnVsbCA/ICfigJQnIDogZm9ybWF0TW9uZXkoYWJzLCAyKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ2JyZWNoYS1wY3QnLCBmb3JtYXRQZXJjZW50KHBjdCwgMiksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdzdGF0dXMtbGFiZWwnLCBpc1NpbWlsYXIgPyAnTUVQIOKJiCBDQ0wnIDogJ01FUCDiiaAgQ0NMJyk7CiAgICBzZXRUZXh0KCdzdGF0dXMtYmFkZ2UnLCBpc1NpbWlsYXIgPyAnU2ltaWxhcicgOiAnTm8gc2ltaWxhcicpOwogICAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RhdHVzLWJhZGdlJyk7CiAgICBpZiAoYmFkZ2UpIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoJ25vc2ltJywgIWlzU2ltaWxhcik7CgogICAgY29uc3QgYmFubmVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXR1cy1iYW5uZXInKTsKICAgIGlmIChiYW5uZXIpIHsKICAgICAgYmFubmVyLmNsYXNzTGlzdC50b2dnbGUoJ3NpbWlsYXInLCAhIWlzU2ltaWxhcik7CiAgICAgIGJhbm5lci5jbGFzc0xpc3QudG9nZ2xlKCduby1zaW1pbGFyJywgIWlzU2ltaWxhcik7CiAgICB9CiAgICBjb25zdCBzdWIgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcjc3RhdHVzLWJhbm5lciAucy1zdWInKTsKICAgIGlmIChzdWIpIHsKICAgICAgc3ViLnRleHRDb250ZW50ID0gaXNTaW1pbGFyCiAgICAgICAgPyAnTGEgYnJlY2hhIGVzdMOhIGRlbnRybyBkZWwgdW1icmFsIOKAlCBsb3MgcHJlY2lvcyBzb24gY29tcGFyYWJsZXMnCiAgICAgICAgOiAnTGEgYnJlY2hhIHN1cGVyYSBlbCB1bWJyYWwg4oCUIGxvcyBwcmVjaW9zIG5vIHNvbiBjb21wYXJhYmxlcyc7CiAgICB9CiAgICBjb25zdCBpc09wZW4gPSBkYXRhPy5tYXJrZXQgJiYgdHlwZW9mIGRhdGEubWFya2V0LmlzT3BlbiA9PT0gJ2Jvb2xlYW4nID8gZGF0YS5tYXJrZXQuaXNPcGVuIDogbnVsbDsKICAgIGlmIChpc09wZW4gIT09IG51bGwpIHNldE1hcmtldFRhZyhpc09wZW4pOwogICAgc3RhdGUubGF0ZXN0Lm1lcCA9IG1lcDsKICAgIHN0YXRlLmxhdGVzdC5jY2wgPSBjY2w7CiAgICBzdGF0ZS5sYXRlc3QuYnJlY2hhQWJzID0gYWJzOwogICAgc3RhdGUubGF0ZXN0LmJyZWNoYVBjdCA9IHBjdDsKICB9CgogIGZ1bmN0aW9uIGlzU2ltaWxhclJvdyhyb3cpIHsKICAgIGNvbnN0IGFicyA9IHJvdy5hYnNfZGlmZiAhPSBudWxsID8gcm93LmFic19kaWZmIDogTWF0aC5hYnMocm93Lm1lcCAtIHJvdy5jY2wpOwogICAgY29uc3QgcGN0ID0gcm93LnBjdF9kaWZmICE9IG51bGwgPyByb3cucGN0X2RpZmYgOiBjYWxjQnJlY2hhUGN0KHJvdy5tZXAsIHJvdy5jY2wpOwogICAgcmV0dXJuIChOdW1iZXIuaXNGaW5pdGUocGN0KSAmJiBwY3QgPD0gU0lNSUxBUl9QQ1RfVEhSRVNIT0xEKSB8fCAoTnVtYmVyLmlzRmluaXRlKGFicykgJiYgYWJzIDw9IFNJTUlMQVJfQVJTX1RIUkVTSE9MRCk7CiAgfQoKICBmdW5jdGlvbiBmaWx0ZXJEZXNjcmlwdG9yKG1vZGUgPSBzdGF0ZS5maWx0ZXJNb2RlKSB7CiAgICBpZiAobW9kZSA9PT0gJzFtJykgcmV0dXJuICcxIE1lcyc7CiAgICBpZiAobW9kZSA9PT0gJzF3JykgcmV0dXJuICcxIFNlbWFuYSc7CiAgICByZXR1cm4gJzEgRMOtYSc7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJNZXRyaWNzMjRoKHBheWxvYWQpIHsKICAgIGNvbnN0IGZpbHRlcmVkID0gZmlsdGVySGlzdG9yeVJvd3MoZXh0cmFjdEhpc3RvcnlSb3dzKHBheWxvYWQpLCBzdGF0ZS5maWx0ZXJNb2RlKTsKICAgIGNvbnN0IHBjdFZhbHVlcyA9IGZpbHRlcmVkLm1hcCgocikgPT4gKHIucGN0X2RpZmYgIT0gbnVsbCA/IHIucGN0X2RpZmYgOiBjYWxjQnJlY2hhUGN0KHIubWVwLCByLmNjbCkpKS5maWx0ZXIoKHYpID0+IE51bWJlci5pc0Zpbml0ZSh2KSk7CiAgICBjb25zdCBzaW1pbGFyQ291bnQgPSBmaWx0ZXJlZC5maWx0ZXIoKHIpID0+IGlzU2ltaWxhclJvdyhyKSkubGVuZ3RoOwogICAgY29uc3QgZGVzY3JpcHRvciA9IGZpbHRlckRlc2NyaXB0b3IoKTsKCiAgICBzZXRUZXh0KCdtZXRyaWMtY291bnQtbGFiZWwnLCBgTXVlc3RyYXMgJHtkZXNjcmlwdG9yfWApOwogICAgc2V0VGV4dCgnbWV0cmljLWNvdW50LTI0aCcsIFN0cmluZyhmaWx0ZXJlZC5sZW5ndGgpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnbWV0cmljLWNvdW50LXN1YicsICdyZWdpc3Ryb3MgZGVsIHBlcsOtb2RvIGZpbHRyYWRvJyk7CiAgICBzZXRUZXh0KCdtZXRyaWMtc2ltaWxhci1sYWJlbCcsIGBWZWNlcyBzaW1pbGFyICgke2Rlc2NyaXB0b3J9KWApOwogICAgc2V0VGV4dCgnbWV0cmljLXNpbWlsYXItMjRoJywgU3RyaW5nKHNpbWlsYXJDb3VudCksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtc2ltaWxhci1zdWInLCAnbW9tZW50b3MgZW4gem9uYSDiiaQxJSBvIOKJpCQxMCcpOwogICAgc2V0VGV4dCgnbWV0cmljLW1pbi1sYWJlbCcsIGBCcmVjaGEgbcOtbi4gKCR7ZGVzY3JpcHRvcn0pYCk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWluLTI0aCcsIHBjdFZhbHVlcy5sZW5ndGggPyBmb3JtYXRQZXJjZW50KE1hdGgubWluKC4uLnBjdFZhbHVlcyksIDIpIDogJ+KAlCcsIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWluLXN1YicsICdtw61uaW1hIGRlbCBwZXLDrW9kbyBmaWx0cmFkbycpOwogICAgc2V0VGV4dCgnbWV0cmljLW1heC1sYWJlbCcsIGBCcmVjaGEgbcOheC4gKCR7ZGVzY3JpcHRvcn0pYCk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWF4LTI0aCcsIHBjdFZhbHVlcy5sZW5ndGggPyBmb3JtYXRQZXJjZW50KE1hdGgubWF4KC4uLnBjdFZhbHVlcyksIDIpIDogJ+KAlCcsIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWF4LXN1YicsICdtw6F4aW1hIGRlbCBwZXLDrW9kbyBmaWx0cmFkbycpOwogICAgc2V0VGV4dCgndHJlbmQtdGl0bGUnLCBgVGVuZGVuY2lhIE1FUC9DQ0wg4oCUICR7ZGVzY3JpcHRvcn1gKTsKICB9CgogIGZ1bmN0aW9uIHJvd0hvdXJMYWJlbChlcG9jaCkgewogICAgY29uc3QgbiA9IHRvTnVtYmVyKGVwb2NoKTsKICAgIGlmIChuID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gZm10QXJnSG91ci5mb3JtYXQobmV3IERhdGUobiAqIDEwMDApKTsKICB9CiAgZnVuY3Rpb24gcm93RGF5SG91ckxhYmVsKGVwb2NoKSB7CiAgICBjb25zdCBuID0gdG9OdW1iZXIoZXBvY2gpOwogICAgaWYgKG4gPT09IG51bGwpIHJldHVybiAn4oCUJzsKICAgIGNvbnN0IGRhdGUgPSBuZXcgRGF0ZShuICogMTAwMCk7CiAgICByZXR1cm4gYCR7Zm10QXJnRGF5TW9udGguZm9ybWF0KGRhdGUpfSAke2ZtdEFyZ0hvdXIuZm9ybWF0KGRhdGUpfWA7CiAgfQogIGZ1bmN0aW9uIGFydERhdGVLZXkoZXBvY2gpIHsKICAgIGNvbnN0IG4gPSB0b051bWJlcihlcG9jaCk7CiAgICBpZiAobiA9PT0gbnVsbCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gZm10QXJnRGF0ZS5mb3JtYXQobmV3IERhdGUobiAqIDEwMDApKTsKICB9CiAgZnVuY3Rpb24gYXJ0V2Vla2RheShlcG9jaCkgewogICAgY29uc3QgbiA9IHRvTnVtYmVyKGVwb2NoKTsKICAgIGlmIChuID09PSBudWxsKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiBmbXRBcmdXZWVrZGF5LmZvcm1hdChuZXcgRGF0ZShuICogMTAwMCkpOwogIH0KICBmdW5jdGlvbiBleHRyYWN0SGlzdG9yeVJvd3MocGF5bG9hZCkgewogICAgY29uc3QgZGF0YSA9IGV4dHJhY3RSb290KHBheWxvYWQpOwogICAgY29uc3Qgcm93cyA9IEFycmF5LmlzQXJyYXkoZGF0YS5oaXN0b3J5KSA/IGRhdGEuaGlzdG9yeS5zbGljZSgpIDogW107CiAgICByZXR1cm4gcm93cwogICAgICAubWFwKChyKSA9PiAoewogICAgICAgIGVwb2NoOiB0b051bWJlcihyLmVwb2NoKSwKICAgICAgICBtZXA6IHRvTnVtYmVyKHIubWVwKSwKICAgICAgICBjY2w6IHRvTnVtYmVyKHIuY2NsKSwKICAgICAgICBhYnNfZGlmZjogdG9OdW1iZXIoci5hYnNfZGlmZiksCiAgICAgICAgcGN0X2RpZmY6IHRvTnVtYmVyKHIucGN0X2RpZmYpLAogICAgICAgIHNpbWlsYXI6IEJvb2xlYW4oci5zaW1pbGFyKQogICAgICB9KSkKICAgICAgLmZpbHRlcigocikgPT4gci5lcG9jaCAhPSBudWxsICYmIHIubWVwICE9IG51bGwgJiYgci5jY2wgIT0gbnVsbCkKICAgICAgLnNvcnQoKGEsIGIpID0+IGEuZXBvY2ggLSBiLmVwb2NoKTsKICB9CiAgZnVuY3Rpb24gZmlsdGVySGlzdG9yeVJvd3Mocm93cywgbW9kZSkgewogICAgaWYgKCFyb3dzLmxlbmd0aCkgcmV0dXJuIFtdOwogICAgY29uc3QgbGF0ZXN0RXBvY2ggPSByb3dzW3Jvd3MubGVuZ3RoIC0gMV0uZXBvY2g7CiAgICBpZiAobW9kZSA9PT0gJzFtJykgewogICAgICBjb25zdCBjdXRvZmYgPSBsYXRlc3RFcG9jaCAtICgzMCAqIDI0ICogMzYwMCk7CiAgICAgIHJldHVybiByb3dzLmZpbHRlcigocikgPT4gci5lcG9jaCA+PSBjdXRvZmYpOwogICAgfQogICAgaWYgKG1vZGUgPT09ICcxdycpIHsKICAgICAgY29uc3QgYWxsb3dlZERheXMgPSBuZXcgU2V0KCk7CiAgICAgIGZvciAobGV0IGkgPSByb3dzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7CiAgICAgICAgY29uc3QgZGF5ID0gYXJ0RGF0ZUtleShyb3dzW2ldLmVwb2NoKTsKICAgICAgICBjb25zdCB3ZCA9IGFydFdlZWtkYXkocm93c1tpXS5lcG9jaCk7CiAgICAgICAgaWYgKCFkYXkgfHwgd2QgPT09ICdTYXQnIHx8IHdkID09PSAnU3VuJykgY29udGludWU7CiAgICAgICAgYWxsb3dlZERheXMuYWRkKGRheSk7CiAgICAgICAgaWYgKGFsbG93ZWREYXlzLnNpemUgPj0gNSkgYnJlYWs7CiAgICAgIH0KICAgICAgcmV0dXJuIHJvd3MuZmlsdGVyKChyKSA9PiB7CiAgICAgICAgY29uc3QgZGF5ID0gYXJ0RGF0ZUtleShyLmVwb2NoKTsKICAgICAgICByZXR1cm4gZGF5ICYmIGFsbG93ZWREYXlzLmhhcyhkYXkpOwogICAgICB9KTsKICAgIH0KICAgIGNvbnN0IGN1dG9mZiA9IGxhdGVzdEVwb2NoIC0gKDI0ICogMzYwMCk7CiAgICByZXR1cm4gcm93cy5maWx0ZXIoKHIpID0+IHIuZXBvY2ggPj0gY3V0b2ZmKTsKICB9CiAgZnVuY3Rpb24gZG93bnNhbXBsZVJvd3Mocm93cywgbWF4UG9pbnRzKSB7CiAgICBpZiAocm93cy5sZW5ndGggPD0gbWF4UG9pbnRzKSByZXR1cm4gcm93czsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgY29uc3Qgc3RlcCA9IChyb3dzLmxlbmd0aCAtIDEpIC8gKG1heFBvaW50cyAtIDEpOwogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBtYXhQb2ludHM7IGkrKykgewogICAgICBvdXQucHVzaChyb3dzW01hdGgucm91bmQoaSAqIHN0ZXApXSk7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KICBmdW5jdGlvbiBjdXJyZW50RmlsdGVyTGFiZWwoKSB7CiAgICBpZiAoc3RhdGUuZmlsdGVyTW9kZSA9PT0gJzFtJykgcmV0dXJuICcxIE1lcyc7CiAgICBpZiAoc3RhdGUuZmlsdGVyTW9kZSA9PT0gJzF3JykgcmV0dXJuICcxIFNlbWFuYSc7CiAgICByZXR1cm4gJzEgRMOtYSc7CiAgfQogIGZ1bmN0aW9uIGdldEZpbHRlcmVkSGlzdG9yeVJvd3MocGF5bG9hZCA9IHN0YXRlLmxhc3RNZXBQYXlsb2FkKSB7CiAgICBpZiAoIXBheWxvYWQpIHJldHVybiBbXTsKICAgIHJldHVybiBmaWx0ZXJIaXN0b3J5Um93cyhleHRyYWN0SGlzdG9yeVJvd3MocGF5bG9hZCksIHN0YXRlLmZpbHRlck1vZGUpOwogIH0KICBmdW5jdGlvbiBjc3ZFc2NhcGUodmFsdWUpIHsKICAgIGNvbnN0IHYgPSBTdHJpbmcodmFsdWUgPz8gJycpOwogICAgcmV0dXJuIGAiJHt2LnJlcGxhY2UoLyIvZywgJyIiJyl9ImA7CiAgfQogIGZ1bmN0aW9uIGNzdk51bWJlcih2YWx1ZSwgZGlnaXRzID0gMikgewogICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gdmFsdWUudG9GaXhlZChkaWdpdHMpLnJlcGxhY2UoJy4nLCAnLCcpOwogIH0KICBmdW5jdGlvbiBmaWx0ZXJDb2RlKCkgewogICAgaWYgKHN0YXRlLmZpbHRlck1vZGUgPT09ICcxbScpIHJldHVybiAnMW0nOwogICAgaWYgKHN0YXRlLmZpbHRlck1vZGUgPT09ICcxdycpIHJldHVybiAnMXcnOwogICAgcmV0dXJuICcxZCc7CiAgfQogIGZ1bmN0aW9uIGRvd25sb2FkSGlzdG9yeUNzdigpIHsKICAgIGNvbnN0IGZpbHRlcmVkID0gZ2V0RmlsdGVyZWRIaXN0b3J5Um93cygpOwogICAgaWYgKCFmaWx0ZXJlZC5sZW5ndGgpIHsKICAgICAgc2V0RnJlc2hCYWRnZSgnU2luIGRhdG9zIHBhcmEgZXhwb3J0YXIgZW4gZWwgZmlsdHJvIGFjdGl2bycsICdpZGxlJyk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGhlYWRlciA9IFsnZmVjaGEnLCAnaG9yYScsICdtZXAnLCAnY2NsJywgJ2RpZl9hYnMnLCAnZGlmX3BjdCcsICdlc3RhZG8nXTsKICAgIGNvbnN0IHJvd3MgPSBmaWx0ZXJlZC5tYXAoKHIpID0+IHsKICAgICAgY29uc3QgZGF0ZSA9IG5ldyBEYXRlKHIuZXBvY2ggKiAxMDAwKTsKICAgICAgY29uc3QgbWVwID0gdG9OdW1iZXIoci5tZXApOwogICAgICBjb25zdCBjY2wgPSB0b051bWJlcihyLmNjbCk7CiAgICAgIGNvbnN0IGFicyA9IHRvTnVtYmVyKHIuYWJzX2RpZmYpOwogICAgICBjb25zdCBwY3QgPSB0b051bWJlcihyLnBjdF9kaWZmKTsKICAgICAgY29uc3QgZXN0YWRvID0gQm9vbGVhbihyLnNpbWlsYXIpID8gJ1NJTUlMQVInIDogJ05PIFNJTUlMQVInOwogICAgICByZXR1cm4gWwogICAgICAgIGZtdEFyZ0RheU1vbnRoLmZvcm1hdChkYXRlKSwKICAgICAgICBmbXRBcmdIb3VyLmZvcm1hdChkYXRlKSwKICAgICAgICBjc3ZOdW1iZXIobWVwLCAyKSwKICAgICAgICBjc3ZOdW1iZXIoY2NsLCAyKSwKICAgICAgICBjc3ZOdW1iZXIoYWJzLCAyKSwKICAgICAgICBjc3ZOdW1iZXIocGN0LCAyKSwKICAgICAgICBlc3RhZG8KICAgICAgXS5tYXAoY3N2RXNjYXBlKS5qb2luKCc7Jyk7CiAgICB9KTsKICAgIGNvbnN0IGFydERhdGUgPSBmbXRBcmdEYXRlLmZvcm1hdChuZXcgRGF0ZSgpKTsKICAgIGNvbnN0IGZpbGVuYW1lID0gYGhpc3RvcmlhbC1tZXAtY2NsLSR7ZmlsdGVyQ29kZSgpfS0ke2FydERhdGV9LmNzdmA7CiAgICBjb25zdCBjc3YgPSAnXHVGRUZGJyArIFtoZWFkZXIuam9pbignOycpLCAuLi5yb3dzXS5qb2luKCdcbicpOwogICAgY29uc3QgYmxvYiA9IG5ldyBCbG9iKFtjc3ZdLCB7IHR5cGU6ICd0ZXh0L2NzdjtjaGFyc2V0PXV0Zi04OycgfSk7CiAgICBjb25zdCB1cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKGJsb2IpOwogICAgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2EnKTsKICAgIGEuaHJlZiA9IHVybDsKICAgIGEuZG93bmxvYWQgPSBmaWxlbmFtZTsKICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoYSk7CiAgICBhLmNsaWNrKCk7CiAgICBhLnJlbW92ZSgpOwogICAgVVJMLnJldm9rZU9iamVjdFVSTCh1cmwpOwogIH0KICBmdW5jdGlvbiBhcHBseUZpbHRlcihtb2RlKSB7CiAgICBzdGF0ZS5maWx0ZXJNb2RlID0gbW9kZTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5waWxsW2RhdGEtZmlsdGVyXScpLmZvckVhY2goKGJ0bikgPT4gewogICAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZSgnb24nLCBidG4uZGF0YXNldC5maWx0ZXIgPT09IG1vZGUpOwogICAgfSk7CiAgICBpZiAoc3RhdGUubGFzdE1lcFBheWxvYWQpIHsKICAgICAgcmVuZGVyVHJlbmQoc3RhdGUubGFzdE1lcFBheWxvYWQpOwogICAgICByZW5kZXJIaXN0b3J5KHN0YXRlLmxhc3RNZXBQYXlsb2FkKTsKICAgICAgcmVuZGVyTWV0cmljczI0aChzdGF0ZS5sYXN0TWVwUGF5bG9hZCk7CiAgICB9CiAgfQoKICBmdW5jdGlvbiByZW5kZXJIaXN0b3J5KHBheWxvYWQpIHsKICAgIGNvbnN0IHRib2R5ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hpc3Rvcnktcm93cycpOwogICAgY29uc3QgY2FwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hpc3RvcnktY2FwJyk7CiAgICBpZiAoIXRib2R5KSByZXR1cm47CiAgICBjb25zdCBmaWx0ZXJlZCA9IGdldEZpbHRlcmVkSGlzdG9yeVJvd3MocGF5bG9hZCk7CiAgICBjb25zdCByb3dzID0gZmlsdGVyZWQuc2xpY2UoKS5yZXZlcnNlKCk7CiAgICBpZiAoY2FwKSBjYXAudGV4dENvbnRlbnQgPSBgJHtjdXJyZW50RmlsdGVyTGFiZWwoKX0gwrcgJHtyb3dzLmxlbmd0aH0gcmVnaXN0cm9zYDsKICAgIGlmICghcm93cy5sZW5ndGgpIHsKICAgICAgdGJvZHkuaW5uZXJIVE1MID0gJzx0cj48dGQgY2xhc3M9ImRpbSIgY29sc3Bhbj0iNiI+U2luIHJlZ2lzdHJvcyB0b2RhdsOtYTwvdGQ+PC90cj4nOwogICAgICByZXR1cm47CiAgICB9CiAgICB0Ym9keS5pbm5lckhUTUwgPSByb3dzLm1hcCgocikgPT4gewogICAgICBjb25zdCBtZXAgPSB0b051bWJlcihyLm1lcCk7CiAgICAgIGNvbnN0IGNjbCA9IHRvTnVtYmVyKHIuY2NsKTsKICAgICAgY29uc3QgYWJzID0gdG9OdW1iZXIoci5hYnNfZGlmZik7CiAgICAgIGNvbnN0IHBjdCA9IHRvTnVtYmVyKHIucGN0X2RpZmYpOwogICAgICBjb25zdCBzaW0gPSBCb29sZWFuKHIuc2ltaWxhcik7CiAgICAgIHJldHVybiBgPHRyPgogICAgICAgIDx0ZCBjbGFzcz0iZGltIj48ZGl2IGNsYXNzPSJ0cy1kYXkiPiR7Zm10QXJnRGF5TW9udGguZm9ybWF0KG5ldyBEYXRlKHIuZXBvY2ggKiAxMDAwKSl9PC9kaXY+PGRpdiBjbGFzcz0idHMtaG91ciI+JHtyb3dIb3VyTGFiZWwoci5lcG9jaCl9PC9kaXY+PC90ZD4KICAgICAgICA8dGQgc3R5bGU9ImNvbG9yOnZhcigtLW1lcCkiPiR7Zm9ybWF0TW9uZXkobWVwLCAyKX08L3RkPgogICAgICAgIDx0ZCBzdHlsZT0iY29sb3I6dmFyKC0tY2NsKSI+JHtmb3JtYXRNb25leShjY2wsIDIpfTwvdGQ+CiAgICAgICAgPHRkPiR7Zm9ybWF0TW9uZXkoYWJzLCAyKX08L3RkPgogICAgICAgIDx0ZD4ke2Zvcm1hdFBlcmNlbnQocGN0LCAyKX08L3RkPgogICAgICAgIDx0ZD48c3BhbiBjbGFzcz0ic2JhZGdlICR7c2ltID8gJ3NpbScgOiAnbm9zaW0nfSI+JHtzaW0gPyAnU2ltaWxhcicgOiAnTm8gc2ltaWxhcid9PC9zcGFuPjwvdGQ+CiAgICAgIDwvdHI+YDsKICAgIH0pLmpvaW4oJycpOwogIH0KCiAgZnVuY3Rpb24gbGluZVBvaW50cyh2YWx1ZXMsIHgwLCB4MSwgeTAsIHkxLCBtaW5WYWx1ZSwgbWF4VmFsdWUpIHsKICAgIGlmICghdmFsdWVzLmxlbmd0aCkgcmV0dXJuICcnOwogICAgY29uc3QgbWluID0gTnVtYmVyLmlzRmluaXRlKG1pblZhbHVlKSA/IG1pblZhbHVlIDogTWF0aC5taW4oLi4udmFsdWVzKTsKICAgIGNvbnN0IG1heCA9IE51bWJlci5pc0Zpbml0ZShtYXhWYWx1ZSkgPyBtYXhWYWx1ZSA6IE1hdGgubWF4KC4uLnZhbHVlcyk7CiAgICBjb25zdCBzcGFuID0gTWF0aC5tYXgoMC4wMDAwMDEsIG1heCAtIG1pbik7CiAgICByZXR1cm4gdmFsdWVzLm1hcCgodiwgaSkgPT4gewogICAgICBjb25zdCB4ID0geDAgKyAoKHgxIC0geDApICogaSAvIE1hdGgubWF4KDEsIHZhbHVlcy5sZW5ndGggLSAxKSk7CiAgICAgIGNvbnN0IHkgPSB5MSAtICgodiAtIG1pbikgLyBzcGFuKSAqICh5MSAtIHkwKTsKICAgICAgcmV0dXJuIGAke3gudG9GaXhlZCgyKX0sJHt5LnRvRml4ZWQoMil9YDsKICAgIH0pLmpvaW4oJyAnKTsKICB9CiAgZnVuY3Rpb24gdmFsdWVUb1kodmFsdWUsIHkwLCB5MSwgbWluVmFsdWUsIG1heFZhbHVlKSB7CiAgICBjb25zdCBzcGFuID0gTWF0aC5tYXgoMC4wMDAwMDEsIG1heFZhbHVlIC0gbWluVmFsdWUpOwogICAgcmV0dXJuIHkxIC0gKCh2YWx1ZSAtIG1pblZhbHVlKSAvIHNwYW4pICogKHkxIC0geTApOwogIH0KICBmdW5jdGlvbiBjYWxjQnJlY2hhUGN0KG1lcCwgY2NsKSB7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShtZXApIHx8ICFOdW1iZXIuaXNGaW5pdGUoY2NsKSkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBhdmcgPSAobWVwICsgY2NsKSAvIDI7CiAgICBpZiAoIWF2ZykgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gKE1hdGguYWJzKG1lcCAtIGNjbCkgLyBhdmcpICogMTAwOwogIH0KICBmdW5jdGlvbiBoaWRlVHJlbmRIb3ZlcigpIHsKICAgIGNvbnN0IHRpcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC10b29sdGlwJyk7CiAgICBjb25zdCBsaW5lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLWxpbmUnKTsKICAgIGNvbnN0IG1lcERvdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1tZXAnKTsKICAgIGNvbnN0IGNjbERvdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1jY2wnKTsKICAgIGlmICh0aXApIHRpcC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMCcpOwogICAgaWYgKGxpbmUpIGxpbmUuc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzAnKTsKICAgIGlmIChtZXBEb3QpIG1lcERvdC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMCcpOwogICAgaWYgKGNjbERvdCkgY2NsRG90LnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcwJyk7CiAgfQogIGZ1bmN0aW9uIHJlbmRlclRyZW5kSG92ZXIocG9pbnQpIHsKICAgIGNvbnN0IHRpcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC10b29sdGlwJyk7CiAgICBjb25zdCBiZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC10b29sdGlwLWJnJyk7CiAgICBjb25zdCBsaW5lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLWxpbmUnKTsKICAgIGNvbnN0IG1lcERvdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1tZXAnKTsKICAgIGNvbnN0IGNjbERvdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1jY2wnKTsKICAgIGlmICghdGlwIHx8ICFiZyB8fCAhbGluZSB8fCAhbWVwRG90IHx8ICFjY2xEb3QgfHwgIXBvaW50KSByZXR1cm47CgogICAgbGluZS5zZXRBdHRyaWJ1dGUoJ3gxJywgcG9pbnQueC50b0ZpeGVkKDIpKTsKICAgIGxpbmUuc2V0QXR0cmlidXRlKCd4MicsIHBvaW50LngudG9GaXhlZCgyKSk7CiAgICBsaW5lLnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcxJyk7CiAgICBtZXBEb3Quc2V0QXR0cmlidXRlKCdjeCcsIHBvaW50LngudG9GaXhlZCgyKSk7CiAgICBtZXBEb3Quc2V0QXR0cmlidXRlKCdjeScsIHBvaW50Lm1lcFkudG9GaXhlZCgyKSk7CiAgICBtZXBEb3Quc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzEnKTsKICAgIGNjbERvdC5zZXRBdHRyaWJ1dGUoJ2N4JywgcG9pbnQueC50b0ZpeGVkKDIpKTsKICAgIGNjbERvdC5zZXRBdHRyaWJ1dGUoJ2N5JywgcG9pbnQuY2NsWS50b0ZpeGVkKDIpKTsKICAgIGNjbERvdC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMScpOwoKICAgIHNldFRleHQoJ3RyZW5kLXRpcC10aW1lJywgcm93RGF5SG91ckxhYmVsKHBvaW50LmVwb2NoKSk7CiAgICBzZXRUZXh0KCd0cmVuZC10aXAtbWVwJywgYE1FUCAke2Zvcm1hdE1vbmV5KHBvaW50Lm1lcCwgMil9YCk7CiAgICBzZXRUZXh0KCd0cmVuZC10aXAtY2NsJywgYENDTCAke2Zvcm1hdE1vbmV5KHBvaW50LmNjbCwgMil9YCk7CiAgICBzZXRUZXh0KCd0cmVuZC10aXAtZ2FwJywgYEJyZWNoYSAke2Zvcm1hdFBlcmNlbnQocG9pbnQucGN0LCAyKX1gKTsKCiAgICBjb25zdCB0aXBXID0gMTQ4OwogICAgY29uc3QgdGlwSCA9IDU2OwogICAgY29uc3QgdGlwWCA9IE1hdGgubWluKDg0MCAtIHRpcFcsIE1hdGgubWF4KDMwLCBwb2ludC54ICsgMTApKTsKICAgIGNvbnN0IHRpcFkgPSBNYXRoLm1pbigxMDAsIE1hdGgubWF4KDE4LCBNYXRoLm1pbihwb2ludC5tZXBZLCBwb2ludC5jY2xZKSAtIHRpcEggLSA0KSk7CiAgICB0aXAuc2V0QXR0cmlidXRlKCd0cmFuc2Zvcm0nLCBgdHJhbnNsYXRlKCR7dGlwWC50b0ZpeGVkKDIpfSAke3RpcFkudG9GaXhlZCgyKX0pYCk7CiAgICBiZy5zZXRBdHRyaWJ1dGUoJ3dpZHRoJywgU3RyaW5nKHRpcFcpKTsKICAgIGJnLnNldEF0dHJpYnV0ZSgnaGVpZ2h0JywgU3RyaW5nKHRpcEgpKTsKICAgIHRpcC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMScpOwogIH0KICBmdW5jdGlvbiBiaW5kVHJlbmRIb3ZlcigpIHsKICAgIGlmIChzdGF0ZS50cmVuZEhvdmVyQm91bmQpIHJldHVybjsKICAgIGNvbnN0IGNoYXJ0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWNoYXJ0Jyk7CiAgICBpZiAoIWNoYXJ0KSByZXR1cm47CiAgICBzdGF0ZS50cmVuZEhvdmVyQm91bmQgPSB0cnVlOwoKICAgIGNoYXJ0LmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbGVhdmUnLCAoKSA9PiBoaWRlVHJlbmRIb3ZlcigpKTsKICAgIGNoYXJ0LmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbW92ZScsIChldmVudCkgPT4gewogICAgICBpZiAoIXN0YXRlLnRyZW5kUm93cy5sZW5ndGgpIHJldHVybjsKICAgICAgY29uc3QgY3RtID0gY2hhcnQuZ2V0U2NyZWVuQ1RNKCk7CiAgICAgIGlmICghY3RtKSByZXR1cm47CiAgICAgIGNvbnN0IHB0ID0gY2hhcnQuY3JlYXRlU1ZHUG9pbnQoKTsKICAgICAgcHQueCA9IGV2ZW50LmNsaWVudFg7CiAgICAgIHB0LnkgPSBldmVudC5jbGllbnRZOwogICAgICBjb25zdCBsb2NhbCA9IHB0Lm1hdHJpeFRyYW5zZm9ybShjdG0uaW52ZXJzZSgpKTsKICAgICAgY29uc3QgeCA9IE1hdGgubWF4KDMwLCBNYXRoLm1pbig4NDAsIGxvY2FsLngpKTsKICAgICAgbGV0IG5lYXJlc3QgPSBzdGF0ZS50cmVuZFJvd3NbMF07CiAgICAgIGxldCBiZXN0ID0gTWF0aC5hYnMobmVhcmVzdC54IC0geCk7CiAgICAgIGZvciAobGV0IGkgPSAxOyBpIDwgc3RhdGUudHJlbmRSb3dzLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgY29uc3QgZCA9IE1hdGguYWJzKHN0YXRlLnRyZW5kUm93c1tpXS54IC0geCk7CiAgICAgICAgaWYgKGQgPCBiZXN0KSB7CiAgICAgICAgICBiZXN0ID0gZDsKICAgICAgICAgIG5lYXJlc3QgPSBzdGF0ZS50cmVuZFJvd3NbaV07CiAgICAgICAgfQogICAgICB9CiAgICAgIHJlbmRlclRyZW5kSG92ZXIobmVhcmVzdCk7CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlclRyZW5kKHBheWxvYWQpIHsKICAgIGNvbnN0IGhpc3RvcnkgPSBkb3duc2FtcGxlUm93cyhmaWx0ZXJIaXN0b3J5Um93cyhleHRyYWN0SGlzdG9yeVJvd3MocGF5bG9hZCksIHN0YXRlLmZpbHRlck1vZGUpLCBUUkVORF9NQVhfUE9JTlRTKTsKICAgIGNvbnN0IG1lcExpbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtbWVwLWxpbmUnKTsKICAgIGNvbnN0IGNjbExpbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtY2NsLWxpbmUnKTsKICAgIGlmICghbWVwTGluZSB8fCAhY2NsTGluZSkgcmV0dXJuOwogICAgYmluZFRyZW5kSG92ZXIoKTsKICAgIGlmICghaGlzdG9yeS5sZW5ndGgpIHsKICAgICAgbWVwTGluZS5zZXRBdHRyaWJ1dGUoJ3BvaW50cycsICcnKTsKICAgICAgY2NsTGluZS5zZXRBdHRyaWJ1dGUoJ3BvaW50cycsICcnKTsKICAgICAgc3RhdGUudHJlbmRSb3dzID0gW107CiAgICAgIGhpZGVUcmVuZEhvdmVyKCk7CiAgICAgIFsndHJlbmQteS10b3AnLCAndHJlbmQteS1taWQnLCAndHJlbmQteS1sb3cnLCAndHJlbmQteC0xJywgJ3RyZW5kLXgtMicsICd0cmVuZC14LTMnLCAndHJlbmQteC00JywgJ3RyZW5kLXgtNSddLmZvckVhY2goKGlkKSA9PiBzZXRUZXh0KGlkLCAn4oCUJykpOwogICAgICByZXR1cm47CiAgICB9CgogICAgY29uc3Qgcm93cyA9IGhpc3RvcnkKICAgICAgLm1hcCgocikgPT4gKHsKICAgICAgICBlcG9jaDogci5lcG9jaCwKICAgICAgICBtZXA6IHRvTnVtYmVyKHIubWVwKSwKICAgICAgICBjY2w6IHRvTnVtYmVyKHIuY2NsKSwKICAgICAgICBwY3Q6IHRvTnVtYmVyKHIucGN0X2RpZmYpCiAgICAgIH0pKQogICAgICAuZmlsdGVyKChyKSA9PiByLm1lcCAhPSBudWxsICYmIHIuY2NsICE9IG51bGwpOwogICAgaWYgKCFyb3dzLmxlbmd0aCkgcmV0dXJuOwoKICAgIGNvbnN0IG1lcFZhbHMgPSByb3dzLm1hcCgocikgPT4gci5tZXApOwogICAgY29uc3QgY2NsVmFscyA9IHJvd3MubWFwKChyKSA9PiByLmNjbCk7CgogICAgLy8gRXNjYWxhIGNvbXBhcnRpZGEgcGFyYSBNRVAgeSBDQ0w6IGNvbXBhcmFjacOzbiB2aXN1YWwgZmllbC4KICAgIGNvbnN0IGFsbFByaWNlVmFscyA9IG1lcFZhbHMuY29uY2F0KGNjbFZhbHMpOwogICAgY29uc3QgcmF3TWluID0gTWF0aC5taW4oLi4uYWxsUHJpY2VWYWxzKTsKICAgIGNvbnN0IHJhd01heCA9IE1hdGgubWF4KC4uLmFsbFByaWNlVmFscyk7CiAgICBjb25zdCBwcmljZVBhZCA9IE1hdGgubWF4KDEsIChyYXdNYXggLSByYXdNaW4pICogMC4wOCk7CiAgICBjb25zdCBwcmljZU1pbiA9IHJhd01pbiAtIHByaWNlUGFkOwogICAgY29uc3QgcHJpY2VNYXggPSByYXdNYXggKyBwcmljZVBhZDsKCiAgICBtZXBMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgbGluZVBvaW50cyhtZXBWYWxzLCAzMCwgODQwLCAyNSwgMTMwLCBwcmljZU1pbiwgcHJpY2VNYXgpKTsKICAgIGNjbExpbmUuc2V0QXR0cmlidXRlKCdwb2ludHMnLCBsaW5lUG9pbnRzKGNjbFZhbHMsIDMwLCA4NDAsIDI1LCAxMzAsIHByaWNlTWluLCBwcmljZU1heCkpOwogICAgc3RhdGUudHJlbmRSb3dzID0gcm93cy5tYXAoKHIsIGkpID0+IHsKICAgICAgY29uc3QgeCA9IDMwICsgKCg4NDAgLSAzMCkgKiBpIC8gTWF0aC5tYXgoMSwgcm93cy5sZW5ndGggLSAxKSk7CiAgICAgIHJldHVybiB7CiAgICAgICAgZXBvY2g6IHIuZXBvY2gsCiAgICAgICAgbWVwOiByLm1lcCwKICAgICAgICBjY2w6IHIuY2NsLAogICAgICAgIHBjdDogY2FsY0JyZWNoYVBjdChyLm1lcCwgci5jY2wpLAogICAgICAgIHgsCiAgICAgICAgbWVwWTogdmFsdWVUb1koci5tZXAsIDI1LCAxMzAsIHByaWNlTWluLCBwcmljZU1heCksCiAgICAgICAgY2NsWTogdmFsdWVUb1koci5jY2wsIDI1LCAxMzAsIHByaWNlTWluLCBwcmljZU1heCkKICAgICAgfTsKICAgIH0pOwogICAgaGlkZVRyZW5kSG92ZXIoKTsKCiAgICBjb25zdCBtaWQgPSAocHJpY2VNaW4gKyBwcmljZU1heCkgLyAyOwogICAgc2V0VGV4dCgndHJlbmQteS10b3AnLCAocHJpY2VNYXggLyAxMDAwKS50b0ZpeGVkKDMpKTsKICAgIHNldFRleHQoJ3RyZW5kLXktbWlkJywgKG1pZCAvIDEwMDApLnRvRml4ZWQoMykpOwogICAgc2V0VGV4dCgndHJlbmQteS1sb3cnLCAocHJpY2VNaW4gLyAxMDAwKS50b0ZpeGVkKDMpKTsKCiAgICBjb25zdCBpZHggPSBbMCwgMC4yNSwgMC41LCAwLjc1LCAxXS5tYXAoKHApID0+IE1hdGgubWluKHJvd3MubGVuZ3RoIC0gMSwgTWF0aC5mbG9vcigocm93cy5sZW5ndGggLSAxKSAqIHApKSk7CiAgICBjb25zdCBsYWJzID0gaWR4Lm1hcCgoaSkgPT4gcm93RGF5SG91ckxhYmVsKHJvd3NbaV0/LmVwb2NoKSk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTEnLCBsYWJzWzBdIHx8ICfigJQnKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtMicsIGxhYnNbMV0gfHwgJ+KAlCcpOwogICAgc2V0VGV4dCgndHJlbmQteC0zJywgbGFic1syXSB8fCAn4oCUJyk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTQnLCBsYWJzWzNdIHx8ICfigJQnKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtNScsIGxhYnNbNF0gfHwgJ+KAlCcpOwogIH0KCiAgZnVuY3Rpb24gZ2V0RmNpVHlwZUxhYmVsKHR5cGUpIHsKICAgIHJldHVybiB0eXBlID09PSAndmFyaWFibGUnID8gJ1JlbnRhIHZhcmlhYmxlIChGQ0kgQXJnZW50aW5hKScgOiAnUmVudGEgZmlqYSAoRkNJIEFyZ2VudGluYSknOwogIH0KCiAgZnVuY3Rpb24gc2V0RmNpVHlwZSh0eXBlKSB7CiAgICBjb25zdCBuZXh0ID0gdHlwZSA9PT0gJ3ZhcmlhYmxlJyA/ICd2YXJpYWJsZScgOiAnZmlqYSc7CiAgICBpZiAoc3RhdGUuZmNpVHlwZSA9PT0gbmV4dCkgcmV0dXJuOwogICAgc3RhdGUuZmNpVHlwZSA9IG5leHQ7CiAgICBzdGF0ZS5mY2lQYWdlID0gMTsKICAgIHJlbmRlckZjaVJlbnRhRmlqYSgpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyRmNpUmVudGFGaWphKHBheWxvYWQsIHByZXZpb3VzUGF5bG9hZCwgdHlwZSA9IHN0YXRlLmZjaVR5cGUsIGJhc2VQYXlsb2FkKSB7CiAgICBjb25zdCBub3JtYWxpemVkVHlwZSA9IHR5cGUgPT09ICd2YXJpYWJsZScgPyAndmFyaWFibGUnIDogJ2ZpamEnOwogICAgY29uc3Qgcm93c0VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1yb3dzJyk7CiAgICBjb25zdCBlbXB0eUVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1lbXB0eScpOwogICAgaWYgKCFyb3dzRWwgfHwgIWVtcHR5RWwpIHJldHVybjsKCiAgICBjb25zdCB0aXRsZUVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS10aXRsZScpOwogICAgaWYgKHRpdGxlRWwpIHRpdGxlRWwudGV4dENvbnRlbnQgPSBnZXRGY2lUeXBlTGFiZWwoc3RhdGUuZmNpVHlwZSk7CiAgICBjb25zdCB0YWJGaWphID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS10YWItZmlqYScpOwogICAgY29uc3QgdGFiVmFyaWFibGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLXRhYi12YXJpYWJsZScpOwogICAgaWYgKHRhYkZpamEpIHRhYkZpamEuY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgc3RhdGUuZmNpVHlwZSA9PT0gJ2ZpamEnKTsKICAgIGlmICh0YWJWYXJpYWJsZSkgdGFiVmFyaWFibGUuY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgc3RhdGUuZmNpVHlwZSA9PT0gJ3ZhcmlhYmxlJyk7CgogICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPiAxKSB7CiAgICAgIGNvbnN0IHByZXZpb3VzUm93cyA9IG5vcm1hbGl6ZUZjaVJvd3MocHJldmlvdXNQYXlsb2FkKQogICAgICAgIC5tYXAoKGl0ZW0pID0+IHsKICAgICAgICAgIGNvbnN0IGZvbmRvID0gU3RyaW5nKGl0ZW0/LmZvbmRvIHx8IGl0ZW0/Lm5vbWJyZSB8fCBpdGVtPy5mY2kgfHwgJycpLnRyaW0oKTsKICAgICAgICAgIHJldHVybiB7CiAgICAgICAgICAgIGZvbmRvLAogICAgICAgICAgICB2Y3A6IHRvTnVtYmVyKGl0ZW0/LnZjcCksCiAgICAgICAgICAgIGNjcDogdG9OdW1iZXIoaXRlbT8uY2NwKSwKICAgICAgICAgICAgcGF0cmltb25pbzogdG9OdW1iZXIoaXRlbT8ucGF0cmltb25pbyksCiAgICAgICAgICB9OwogICAgICAgIH0pCiAgICAgICAgLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5mb25kbyk7CiAgICAgIGNvbnN0IHByZXZpb3VzQnlGb25kbyA9IG5ldyBNYXAoKTsKICAgICAgcHJldmlvdXNSb3dzLmZvckVhY2goKGl0ZW0pID0+IHsKICAgICAgICBwcmV2aW91c0J5Rm9uZG8uc2V0KG5vcm1hbGl6ZUZjaUZvbmRvS2V5KGl0ZW0uZm9uZG8pLCBpdGVtKTsKICAgICAgfSk7CiAgICAgIHN0YXRlLmZjaVByZXZpb3VzQnlGb25kb0J5VHlwZVtub3JtYWxpemVkVHlwZV0gPSBwcmV2aW91c0J5Rm9uZG87CiAgICB9CiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+IDMpIHsKICAgICAgY29uc3QgYmFzZVJvd3MgPSBub3JtYWxpemVGY2lSb3dzKGJhc2VQYXlsb2FkKQogICAgICAgIC5tYXAoKGl0ZW0pID0+IHsKICAgICAgICAgIGNvbnN0IGZvbmRvID0gU3RyaW5nKGl0ZW0/LmZvbmRvIHx8IGl0ZW0/Lm5vbWJyZSB8fCBpdGVtPy5mY2kgfHwgJycpLnRyaW0oKTsKICAgICAgICAgIHJldHVybiB7CiAgICAgICAgICAgIGZvbmRvLAogICAgICAgICAgICB2Y3A6IHRvTnVtYmVyKGl0ZW0/LnZjcCkKICAgICAgICAgIH07CiAgICAgICAgfSkKICAgICAgICAuZmlsdGVyKChpdGVtKSA9PiBpdGVtLmZvbmRvICYmIGl0ZW0udmNwICE9PSBudWxsKTsKICAgICAgY29uc3QgYmFzZUJ5Rm9uZG8gPSBuZXcgTWFwKCk7CiAgICAgIGJhc2VSb3dzLmZvckVhY2goKGl0ZW0pID0+IHsKICAgICAgICBiYXNlQnlGb25kby5zZXQobm9ybWFsaXplRmNpRm9uZG9LZXkoaXRlbS5mb25kbyksIGl0ZW0pOwogICAgICB9KTsKICAgICAgc3RhdGUuZmNpQmFzZUJ5Rm9uZG9CeVR5cGVbbm9ybWFsaXplZFR5cGVdID0gYmFzZUJ5Rm9uZG87CiAgICB9CiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+IDApIHsKICAgICAgY29uc3Qgcm93cyA9IG5vcm1hbGl6ZUZjaVJvd3MocGF5bG9hZCkKICAgICAgICAubWFwKChpdGVtKSA9PiB7CiAgICAgICAgICBjb25zdCBmb25kbyA9IFN0cmluZyhpdGVtPy5mb25kbyB8fCBpdGVtPy5ub21icmUgfHwgaXRlbT8uZmNpIHx8ICcnKS50cmltKCk7CiAgICAgICAgICBjb25zdCBmZWNoYSA9IFN0cmluZyhpdGVtPy5mZWNoYSB8fCAnJykudHJpbSgpOwogICAgICAgICAgY29uc3QgdmNwID0gdG9OdW1iZXIoaXRlbT8udmNwKTsKICAgICAgICAgIGNvbnN0IGNjcCA9IHRvTnVtYmVyKGl0ZW0/LmNjcCk7CiAgICAgICAgICBjb25zdCBwYXRyaW1vbmlvID0gdG9OdW1iZXIoaXRlbT8ucGF0cmltb25pbyk7CiAgICAgICAgICBjb25zdCBob3Jpem9udGUgPSBTdHJpbmcoaXRlbT8uaG9yaXpvbnRlIHx8ICcnKS50cmltKCk7CiAgICAgICAgICBjb25zdCBmb25kb0tleSA9IG5vcm1hbGl6ZUZjaUZvbmRvS2V5KGZvbmRvKTsKICAgICAgICAgIGNvbnN0IHByZXZpb3VzID0gc3RhdGUuZmNpUHJldmlvdXNCeUZvbmRvQnlUeXBlW25vcm1hbGl6ZWRUeXBlXS5nZXQoZm9uZG9LZXkpOwogICAgICAgICAgY29uc3QgYmFzZSA9IHN0YXRlLmZjaUJhc2VCeUZvbmRvQnlUeXBlW25vcm1hbGl6ZWRUeXBlXS5nZXQoZm9uZG9LZXkpOwogICAgICAgICAgY29uc3QgbW9udGhseVBjdCA9IGNvbXB1dGVNb250aGx5UGN0KHZjcCwgYmFzZT8udmNwKTsKICAgICAgICAgIHJldHVybiB7CiAgICAgICAgICAgIGZvbmRvLAogICAgICAgICAgICBmZWNoYSwKICAgICAgICAgICAgdmNwLAogICAgICAgICAgICBjY3AsCiAgICAgICAgICAgIHBhdHJpbW9uaW8sCiAgICAgICAgICAgIGhvcml6b250ZSwKICAgICAgICAgICAgbW9udGhseVBjdCwKICAgICAgICAgICAgcHJldmlvdXNWY3A6IHByZXZpb3VzPy52Y3AgPz8gbnVsbCwKICAgICAgICAgICAgdmNwVHJlbmQ6IGZjaVRyZW5kRGlyKHZjcCwgcHJldmlvdXM/LnZjcCksCiAgICAgICAgICAgIGNjcFRyZW5kOiBmY2lUcmVuZERpcihjY3AsIHByZXZpb3VzPy5jY3ApLAogICAgICAgICAgICBwYXRyaW1vbmlvVHJlbmQ6IGZjaVRyZW5kRGlyKHBhdHJpbW9uaW8sIHByZXZpb3VzPy5wYXRyaW1vbmlvKSwKICAgICAgICAgIH07CiAgICAgICAgfSkKICAgICAgICAuZmlsdGVyKChpdGVtKSA9PiBpdGVtLmZvbmRvICYmIChpdGVtLnZjcCAhPT0gbnVsbCB8fCBpdGVtLmZlY2hhKSk7CiAgICAgIGNvbnN0IHNvcnRlZFJvd3MgPSByb3dzLnNsaWNlKCkuc29ydCgoYSwgYikgPT4gKGIucGF0cmltb25pbyA/PyAtSW5maW5pdHkpIC0gKGEucGF0cmltb25pbyA/PyAtSW5maW5pdHkpKTsKICAgICAgc3RhdGUuZmNpUm93c0J5VHlwZVtub3JtYWxpemVkVHlwZV0gPSBzb3J0ZWRSb3dzOwogICAgICBzdGF0ZS5mY2lEYXRlQnlUeXBlW25vcm1hbGl6ZWRUeXBlXSA9IHNvcnRlZFJvd3MuZmluZCgocm93KSA9PiByb3cuZmVjaGEpPy5mZWNoYSB8fCAn4oCUJzsKICAgICAgaWYgKG5vcm1hbGl6ZWRUeXBlID09PSBzdGF0ZS5mY2lUeXBlKSBzdGF0ZS5mY2lQYWdlID0gMTsKICAgIH0KCiAgICBjb25zdCBhY3RpdmVSb3dzID0gc3RhdGUuZmNpUm93c0J5VHlwZVtzdGF0ZS5mY2lUeXBlXSB8fCBbXTsKICAgIGNvbnN0IHF1ZXJ5ID0gc3RhdGUuZmNpUXVlcnkudHJpbSgpLnRvTG93ZXJDYXNlKCk7CiAgICBjb25zdCBmaWx0ZXJlZCA9IHF1ZXJ5CiAgICAgID8gYWN0aXZlUm93cy5maWx0ZXIoKHJvdykgPT4gcm93LmZvbmRvLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocXVlcnkpKQogICAgICA6IGFjdGl2ZVJvd3Muc2xpY2UoKTsKCiAgICBjb25zdCB0b3RhbFBhZ2VzID0gTWF0aC5tYXgoMSwgTWF0aC5jZWlsKGZpbHRlcmVkLmxlbmd0aCAvIEZDSV9QQUdFX1NJWkUpKTsKICAgIHN0YXRlLmZjaVBhZ2UgPSBNYXRoLm1pbihNYXRoLm1heCgxLCBzdGF0ZS5mY2lQYWdlKSwgdG90YWxQYWdlcyk7CiAgICBjb25zdCBmcm9tID0gKHN0YXRlLmZjaVBhZ2UgLSAxKSAqIEZDSV9QQUdFX1NJWkU7CiAgICBjb25zdCBwYWdlUm93cyA9IGZpbHRlcmVkLnNsaWNlKGZyb20sIGZyb20gKyBGQ0lfUEFHRV9TSVpFKTsKCiAgICBjb25zdCBkYXRlRWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLWxhc3QtZGF0ZScpOwogICAgY29uc3QgZmlyc3REYXRlID0gZmlsdGVyZWQuZmluZCgocm93KSA9PiByb3cuZmVjaGEpPy5mZWNoYSB8fCBzdGF0ZS5mY2lEYXRlQnlUeXBlW3N0YXRlLmZjaVR5cGVdIHx8ICfigJQnOwogICAgaWYgKGRhdGVFbCkgZGF0ZUVsLnRleHRDb250ZW50ID0gYEZlY2hhOiAke2ZpcnN0RGF0ZX1gOwogICAgc2V0VGV4dCgnZmNpLXBhZ2UtaW5mbycsIGAke3N0YXRlLmZjaVBhZ2V9IC8gJHt0b3RhbFBhZ2VzfWApOwogICAgY29uc3QgcHJldkJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktcHJldicpOwogICAgY29uc3QgbmV4dEJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktbmV4dCcpOwogICAgaWYgKHByZXZCdG4pIHByZXZCdG4uZGlzYWJsZWQgPSBzdGF0ZS5mY2lQYWdlIDw9IDE7CiAgICBpZiAobmV4dEJ0bikgbmV4dEJ0bi5kaXNhYmxlZCA9IHN0YXRlLmZjaVBhZ2UgPj0gdG90YWxQYWdlczsKCiAgICBpZiAoIXBhZ2VSb3dzLmxlbmd0aCkgewogICAgICByb3dzRWwuaW5uZXJIVE1MID0gJyc7CiAgICAgIGlmIChxdWVyeSkgZW1wdHlFbC50ZXh0Q29udGVudCA9ICdObyBoYXkgcmVzdWx0YWRvcyBwYXJhIGxhIGLDunNxdWVkYSBpbmRpY2FkYS4nOwogICAgICBlbHNlIGVtcHR5RWwudGV4dENvbnRlbnQgPSBgTm8gaGF5IGRhdG9zIGRlICR7c3RhdGUuZmNpVHlwZSA9PT0gJ3ZhcmlhYmxlJyA/ICdyZW50YSB2YXJpYWJsZScgOiAncmVudGEgZmlqYSd9IGRpc3BvbmlibGVzIGVuIGVzdGUgbW9tZW50by5gOwogICAgICBlbXB0eUVsLnN0eWxlLmRpc3BsYXkgPSAnYmxvY2snOwogICAgICByZW5kZXJGY2lCZW5jaG1hcmtJbmZvKCk7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICBlbXB0eUVsLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgICByb3dzRWwuaW5uZXJIVE1MID0gcGFnZVJvd3MubWFwKChyb3cpID0+IGAKICAgICAgPHRyPgogICAgICAgIDx0ZCB0aXRsZT0iJHtlc2NhcGVIdG1sKHJvdy5mb25kbyl9Ij4ke2VzY2FwZUh0bWwocm93LmZvbmRvKX08L3RkPgogICAgICAgIDx0ZD4ke3JlbmRlckZjaVRyZW5kVmFsdWUocm93LnZjcCwgcm93LnZjcFRyZW5kKX08L3RkPgogICAgICAgIDx0ZD4ke3JlbmRlckZjaVRyZW5kVmFsdWUocm93LmNjcCwgcm93LmNjcFRyZW5kKX08L3RkPgogICAgICAgIDx0ZD4ke3JlbmRlckZjaVRyZW5kVmFsdWUocm93LnBhdHJpbW9uaW8sIHJvdy5wYXRyaW1vbmlvVHJlbmQpfTwvdGQ+CiAgICAgICAgPHRkPiR7ZXNjYXBlSHRtbChyb3cuaG9yaXpvbnRlIHx8ICfigJQnKX08L3RkPgogICAgICAgIDx0ZCBjbGFzcz0iZmNpLXNpZ25hbC1jZWxsIj4ke3JlbmRlckZjaVNpZ25hbEJhZGdlKGNvbXB1dGVGY2lTaWduYWwocm93LCBzdGF0ZS5mY2lUeXBlKSl9PC90ZD4KICAgICAgPC90cj4KICAgIGApLmpvaW4oJycpOwogICAgc2F2ZUZjaVNpZ25hbFN0cmVha3MoKTsKICAgIHJlbmRlckZjaUJlbmNobWFya0luZm8oKTsKICB9CgogIC8vIDQpIEZ1bmNpw7NuIGNlbnRyYWwgZmV0Y2hBbGwoKQogIGFzeW5jIGZ1bmN0aW9uIGZldGNoSnNvbih1cmwpIHsKICAgIGNvbnN0IGN0cmwgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7CiAgICBjb25zdCB0aW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiBjdHJsLmFib3J0KCksIDEyMDAwKTsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKHVybCwgeyBjYWNoZTogJ25vLXN0b3JlJywgc2lnbmFsOiBjdHJsLnNpZ25hbCB9KTsKICAgICAgaWYgKCFyZXMub2spIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlcy5zdGF0dXN9YCk7CiAgICAgIHJldHVybiBhd2FpdCByZXMuanNvbigpOwogICAgfSBmaW5hbGx5IHsKICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpOwogICAgfQogIH0KCiAgYXN5bmMgZnVuY3Rpb24gZmV0Y2hBbGwob3B0aW9ucyA9IHt9KSB7CiAgICBpZiAoc3RhdGUuaXNGZXRjaGluZykgcmV0dXJuOwogICAgc3RhdGUuaXNGZXRjaGluZyA9IHRydWU7CiAgICBzZXRMb2FkaW5nKE5VTUVSSUNfSURTLCB0cnVlKTsKICAgIHNldEZyZXNoQmFkZ2UoJ0FjdHVhbGl6YW5kb+KApicsICdmZXRjaGluZycpOwogICAgc2V0RXJyb3JCYW5uZXIoZmFsc2UpOwogICAgdHJ5IHsKICAgICAgY29uc3QgdGFza3MgPSBbCiAgICAgICAgWydtZXBDY2wnLCBFTkRQT0lOVFMubWVwQ2NsXSwKICAgICAgICBbJ2ZjaVJlbnRhRmlqYScsIEVORFBPSU5UUy5mY2lSZW50YUZpamFdLAogICAgICAgIFsnZmNpUmVudGFGaWphUGVudWx0aW1vJywgRU5EUE9JTlRTLmZjaVJlbnRhRmlqYVBlbnVsdGltb10sCiAgICAgICAgWydmY2lSZW50YUZpamFNZXNCYXNlJywgRU5EUE9JTlRTLmZjaVJlbnRhRmlqYU1lc0Jhc2VdLAogICAgICAgIFsnZmNpUmVudGFWYXJpYWJsZScsIEVORFBPSU5UUy5mY2lSZW50YVZhcmlhYmxlXSwKICAgICAgICBbJ2ZjaVJlbnRhVmFyaWFibGVQZW51bHRpbW8nLCBFTkRQT0lOVFMuZmNpUmVudGFWYXJpYWJsZVBlbnVsdGltb10sCiAgICAgICAgWydmY2lSZW50YVZhcmlhYmxlTWVzQmFzZScsIEVORFBPSU5UUy5mY2lSZW50YVZhcmlhYmxlTWVzQmFzZV0sCiAgICAgICAgWydiZW5jaG1hcmtQbGF6b0Zpam8nLCBFTkRQT0lOVFMuYmVuY2htYXJrUGxhem9GaWpvXSwKICAgICAgICBbJ2JlbmNobWFya0luZmxhY2lvbicsIEVORFBPSU5UUy5iZW5jaG1hcmtJbmZsYWNpb25dCiAgICAgIF07CgogICAgICBjb25zdCBzZXR0bGVkID0gYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKHRhc2tzLm1hcChhc3luYyAoW25hbWUsIHVybF0pID0+IHsKICAgICAgICB0cnkgewogICAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IGZldGNoSnNvbih1cmwpOwogICAgICAgICAgcmV0dXJuIHsgbmFtZSwgZGF0YSB9OwogICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgICAgICBjb25zb2xlLmVycm9yKGBbUmFkYXJNRVBdIGVycm9yIGVuICR7bmFtZX1gLCBlcnJvcik7CiAgICAgICAgICB0aHJvdyB7IG5hbWUsIGVycm9yIH07CiAgICAgICAgfQogICAgICB9KSk7CgogICAgICBjb25zdCBiYWcgPSB7CiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLAogICAgICAgIG1lcENjbDogbnVsbCwKICAgICAgICBmY2lSZW50YUZpamE6IG51bGwsCiAgICAgICAgZmNpUmVudGFGaWphUGVudWx0aW1vOiBudWxsLAogICAgICAgIGZjaVJlbnRhRmlqYU1lc0Jhc2U6IG51bGwsCiAgICAgICAgZmNpUmVudGFWYXJpYWJsZTogbnVsbCwKICAgICAgICBmY2lSZW50YVZhcmlhYmxlUGVudWx0aW1vOiBudWxsLAogICAgICAgIGZjaVJlbnRhVmFyaWFibGVNZXNCYXNlOiBudWxsLAogICAgICAgIGJlbmNobWFya1BsYXpvRmlqbzogbnVsbCwKICAgICAgICBiZW5jaG1hcmtJbmZsYWNpb246IG51bGwKICAgICAgfTsKICAgICAgY29uc3QgZmFpbGVkID0gW107CiAgICAgIHNldHRsZWQuZm9yRWFjaCgociwgaWR4KSA9PiB7CiAgICAgICAgY29uc3QgbmFtZSA9IHRhc2tzW2lkeF1bMF07CiAgICAgICAgaWYgKHIuc3RhdHVzID09PSAnZnVsZmlsbGVkJykgYmFnW25hbWVdID0gci52YWx1ZS5kYXRhOwogICAgICAgIGVsc2UgZmFpbGVkLnB1c2gobmFtZSk7CiAgICAgIH0pOwoKICAgICAgY29uc3QgcGZEYXRhID0gYmFnLmJlbmNobWFya1BsYXpvRmlqbz8uZGF0YSB8fCB7fTsKICAgICAgY29uc3QgaW5mRGF0YSA9IGJhZy5iZW5jaG1hcmtJbmZsYWNpb24/LmRhdGEgfHwge307CiAgICAgIHN0YXRlLmJlbmNobWFyayA9IHsKICAgICAgICBwbGF6b0Zpam9Nb250aGx5UGN0OiB0b051bWJlcihwZkRhdGE/Lm1vbnRobHlQY3QpLAogICAgICAgIGluZmxhY2lvbk1vbnRobHlQY3Q6IHRvTnVtYmVyKGluZkRhdGE/Lm1vbnRobHlQY3QpLAogICAgICAgIGluZmxhY2lvbkRhdGU6IHR5cGVvZiBpbmZEYXRhPy5kYXRlID09PSAnc3RyaW5nJyA/IGluZkRhdGEuZGF0ZSA6IG51bGwsCiAgICAgICAgdXBkYXRlZEF0SHVtYW5BcnQ6IGJhZy5iZW5jaG1hcmtQbGF6b0Zpam8/LmZldGNoZWRBdEh1bWFuQXJ0IHx8IGJhZy5iZW5jaG1hcmtJbmZsYWNpb24/LmZldGNoZWRBdEh1bWFuQXJ0IHx8IG51bGwKICAgICAgfTsKCiAgICAgIHJlbmRlck1lcENjbChiYWcubWVwQ2NsKTsKICAgICAgaWYgKGJhZy5mY2lSZW50YUZpamEgfHwgYmFnLmZjaVJlbnRhRmlqYVBlbnVsdGltbykgewogICAgICAgIHJlbmRlckZjaVJlbnRhRmlqYShiYWcuZmNpUmVudGFGaWphLCBiYWcuZmNpUmVudGFGaWphUGVudWx0aW1vLCAnZmlqYScsIGJhZy5mY2lSZW50YUZpamFNZXNCYXNlKTsKICAgICAgfQogICAgICBpZiAoYmFnLmZjaVJlbnRhVmFyaWFibGUgfHwgYmFnLmZjaVJlbnRhVmFyaWFibGVQZW51bHRpbW8pIHsKICAgICAgICByZW5kZXJGY2lSZW50YUZpamEoYmFnLmZjaVJlbnRhVmFyaWFibGUsIGJhZy5mY2lSZW50YVZhcmlhYmxlUGVudWx0aW1vLCAndmFyaWFibGUnLCBiYWcuZmNpUmVudGFWYXJpYWJsZU1lc0Jhc2UpOwogICAgICB9CiAgICAgIHJlbmRlckZjaVJlbnRhRmlqYSgpOwogICAgICBzdGF0ZS5sYXN0TWVwUGF5bG9hZCA9IGJhZy5tZXBDY2w7CiAgICAgIHJlbmRlck1ldHJpY3MyNGgoYmFnLm1lcENjbCk7CiAgICAgIHJlbmRlclRyZW5kKGJhZy5tZXBDY2wpOwogICAgICByZW5kZXJIaXN0b3J5KGJhZy5tZXBDY2wpOwogICAgICBjb25zdCBtZXBSb290ID0gZXh0cmFjdFJvb3QoYmFnLm1lcENjbCk7CiAgICAgIGNvbnN0IHVwZGF0ZWRBcnQgPSB0eXBlb2YgbWVwUm9vdD8udXBkYXRlZEF0SHVtYW5BcnQgPT09ICdzdHJpbmcnID8gbWVwUm9vdC51cGRhdGVkQXRIdW1hbkFydCA6IG51bGw7CiAgICAgIGNvbnN0IHNvdXJjZVRzTXMgPSB0b051bWJlcihtZXBSb290Py5zb3VyY2VTdGF0dXM/LmxhdGVzdFNvdXJjZVRzTXMpCiAgICAgICAgPz8gdG9OdW1iZXIobWVwUm9vdD8uY3VycmVudD8ubWVwVHNNcykKICAgICAgICA/PyB0b051bWJlcihtZXBSb290Py5jdXJyZW50Py5jY2xUc01zKQogICAgICAgID8/IG51bGw7CiAgICAgIHN0YXRlLnNvdXJjZVRzTXMgPSBzb3VyY2VUc01zOwogICAgICBzZXRUZXh0KCdsYXN0LXJ1bi10aW1lJywgdXBkYXRlZEFydCB8fCBmbXRBcmdUaW1lU2VjLmZvcm1hdChuZXcgRGF0ZSgpKSk7CgogICAgICBjb25zdCBzdWNjZXNzQ291bnQgPSB0YXNrcy5sZW5ndGggLSBmYWlsZWQubGVuZ3RoOwogICAgICBpZiAoc3VjY2Vzc0NvdW50ID4gMCkgewogICAgICAgIHN0YXRlLmxhc3RTdWNjZXNzQXQgPSBEYXRlLm5vdygpOwogICAgICAgIHN0YXRlLnJldHJ5SW5kZXggPSAwOwogICAgICAgIGlmIChzdGF0ZS5yZXRyeVRpbWVyKSBjbGVhclRpbWVvdXQoc3RhdGUucmV0cnlUaW1lcik7CiAgICAgICAgc2F2ZUNhY2hlKGJhZyk7CiAgICAgICAgY29uc3QgYWdlTGFiZWwgPSBzb3VyY2VUc01zICE9IG51bGwgPyBmb3JtYXRTb3VyY2VBZ2VMYWJlbChzb3VyY2VUc01zKSA6IG51bGw7CiAgICAgICAgY29uc3QgYmFkZ2VCYXNlID0gYWdlTGFiZWwgPyBgw5psdGltYSBhY3R1YWxpemFjacOzbiBoYWNlOiAke2FnZUxhYmVsfWAgOiBgQWN0dWFsaXphZG8gwrcgJHtmbXRBcmdUaW1lLmZvcm1hdChuZXcgRGF0ZSgpKX1gOwogICAgICAgIGlmIChmYWlsZWQubGVuZ3RoKSBzZXRGcmVzaEJhZGdlKGBBY3R1YWxpemFjacOzbiBwYXJjaWFsIMK3ICR7YmFkZ2VCYXNlfWAsICdpZGxlJyk7CiAgICAgICAgZWxzZSBzZXRGcmVzaEJhZGdlKGJhZGdlQmFzZSwgJ2lkbGUnKTsKICAgICAgICByZWZyZXNoRnJlc2hCYWRnZUZyb21Tb3VyY2UoKTsKICAgICAgfSBlbHNlIHsKICAgICAgICBjb25zdCBhdHRlbXB0ID0gc3RhdGUucmV0cnlJbmRleCArIDE7CiAgICAgICAgaWYgKHN0YXRlLnJldHJ5SW5kZXggPCBSRVRSWV9ERUxBWVMubGVuZ3RoKSB7CiAgICAgICAgICBjb25zdCBkZWxheSA9IFJFVFJZX0RFTEFZU1tzdGF0ZS5yZXRyeUluZGV4XTsKICAgICAgICAgIHN0YXRlLnJldHJ5SW5kZXggKz0gMTsKICAgICAgICAgIHNldEZyZXNoQmFkZ2UoYEVycm9yIMK3IFJlaW50ZW50byBlbiAke01hdGgucm91bmQoZGVsYXkgLyAxMDAwKX1zYCwgJ2Vycm9yJyk7CiAgICAgICAgICBpZiAoc3RhdGUucmV0cnlUaW1lcikgY2xlYXJUaW1lb3V0KHN0YXRlLnJldHJ5VGltZXIpOwogICAgICAgICAgc3RhdGUucmV0cnlUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gZmV0Y2hBbGwoeyBtYW51YWw6IHRydWUgfSksIGRlbGF5KTsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgc2V0RnJlc2hCYWRnZSgnRXJyb3IgwrcgUmVpbnRlbnRhcicsICdlcnJvcicpOwogICAgICAgICAgc2V0RXJyb3JCYW5uZXIodHJ1ZSwgJ0Vycm9yIGFsIGFjdHVhbGl6YXIgwrcgUmVpbnRlbnRhcicpOwogICAgICAgICAgY29uc29sZS5lcnJvcihgW1JhZGFyTUVQXSBzZSBhZ290YXJvbiByZXRyaWVzICgke2F0dGVtcHR9IGludGVudG9zKWApOwogICAgICAgICAgaWYgKHdpbmRvdy5zY2hlZHVsZXIpIHdpbmRvdy5zY2hlZHVsZXIuc3RvcCgpOwogICAgICAgIH0KICAgICAgfQogICAgfSBmaW5hbGx5IHsKICAgICAgc2V0TG9hZGluZyhOVU1FUklDX0lEUywgZmFsc2UpOwogICAgICBzdGF0ZS5pc0ZldGNoaW5nID0gZmFsc2U7CiAgICB9CiAgfQoKICAvLyA1KSBDbGFzZSBNYXJrZXRTY2hlZHVsZXIKICBjbGFzcyBNYXJrZXRTY2hlZHVsZXIgewogICAgY29uc3RydWN0b3IoZmV0Y2hGbiwgaW50ZXJ2YWxNcyA9IDMwMDAwMCkgewogICAgICB0aGlzLmZldGNoRm4gPSBmZXRjaEZuOwogICAgICB0aGlzLmludGVydmFsTXMgPSBpbnRlcnZhbE1zOwogICAgICB0aGlzLnRpbWVyID0gbnVsbDsKICAgICAgdGhpcy53YWl0VGltZXIgPSBudWxsOwogICAgICB0aGlzLmNvdW50ZG93blRpbWVyID0gbnVsbDsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBudWxsOwogICAgICB0aGlzLnJ1bm5pbmcgPSBmYWxzZTsKICAgICAgdGhpcy5wYXVzZWQgPSBmYWxzZTsKICAgIH0KCiAgICBzdGFydCgpIHsKICAgICAgaWYgKHRoaXMucnVubmluZykgcmV0dXJuOwogICAgICB0aGlzLnJ1bm5pbmcgPSB0cnVlOwogICAgICB0aGlzLnBhdXNlZCA9IGZhbHNlOwogICAgICBpZiAodGhpcy5pc01hcmtldE9wZW4oKSkgewogICAgICAgIHNldE1hcmtldFRhZyh0cnVlKTsKICAgICAgICB0aGlzLl9zY2hlZHVsZSh0aGlzLmludGVydmFsTXMpOwogICAgICB9IGVsc2UgewogICAgICAgIHNldE1hcmtldFRhZyhmYWxzZSk7CiAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgfQogICAgICB0aGlzLl9zdGFydENvdW50ZG93bigpOwogICAgfQoKICAgIHBhdXNlKCkgewogICAgICB0aGlzLnBhdXNlZCA9IHRydWU7CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLnRpbWVyKTsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMud2FpdFRpbWVyKTsKICAgICAgdGhpcy50aW1lciA9IG51bGw7CiAgICAgIHRoaXMud2FpdFRpbWVyID0gbnVsbDsKICAgICAgdGhpcy5fc3RvcENvdW50ZG93bigpOwogICAgICBjb25zdCBjb3VudGRvd24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY291bnRkb3duLXRleHQnKTsKICAgICAgaWYgKGNvdW50ZG93bikgY291bnRkb3duLnRleHRDb250ZW50ID0gJ0FjdHVhbGl6YWNpw7NuIHBhdXNhZGEnOwogICAgfQoKICAgIHJlc3VtZSgpIHsKICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcpIHRoaXMucnVubmluZyA9IHRydWU7CiAgICAgIHRoaXMucGF1c2VkID0gZmFsc2U7CiAgICAgIGNvbnN0IGNvbnRpbnVlUmVzdW1lID0gKCkgPT4gewogICAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcodHJ1ZSk7CiAgICAgICAgICB0aGlzLl9zY2hlZHVsZSh0aGlzLmludGVydmFsTXMpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcoZmFsc2UpOwogICAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgICB9CiAgICAgICAgdGhpcy5fc3RhcnRDb3VudGRvd24oKTsKICAgICAgfTsKICAgICAgaWYgKERhdGUubm93KCkgLSBzdGF0ZS5sYXN0U3VjY2Vzc0F0ID4gdGhpcy5pbnRlcnZhbE1zKSB7CiAgICAgICAgUHJvbWlzZS5yZXNvbHZlKHRoaXMuZmV0Y2hGbih7IG1hbnVhbDogdHJ1ZSB9KSkuZmluYWxseShjb250aW51ZVJlc3VtZSk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgY29udGludWVSZXN1bWUoKTsKICAgICAgfQogICAgfQoKICAgIHN0b3AoKSB7CiAgICAgIHRoaXMucnVubmluZyA9IGZhbHNlOwogICAgICB0aGlzLnBhdXNlZCA9IGZhbHNlOwogICAgICBjbGVhclRpbWVvdXQodGhpcy50aW1lcik7CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLndhaXRUaW1lcik7CiAgICAgIHRoaXMudGltZXIgPSBudWxsOwogICAgICB0aGlzLndhaXRUaW1lciA9IG51bGw7CiAgICAgIHRoaXMubmV4dFJ1bkF0ID0gbnVsbDsKICAgICAgdGhpcy5fc3RvcENvdW50ZG93bigpOwogICAgfQoKICAgIGlzTWFya2V0T3BlbigpIHsKICAgICAgY29uc3QgcCA9IGdldEFyZ05vd1BhcnRzKCk7CiAgICAgIGNvbnN0IGJ1c2luZXNzRGF5ID0gcC53ZWVrZGF5ID49IDEgJiYgcC53ZWVrZGF5IDw9IDU7CiAgICAgIGNvbnN0IHNlY29uZHMgPSBwLmhvdXIgKiAzNjAwICsgcC5taW51dGUgKiA2MCArIHAuc2Vjb25kOwogICAgICBjb25zdCBmcm9tID0gMTAgKiAzNjAwICsgMzAgKiA2MDsKICAgICAgY29uc3QgdG8gPSAxOCAqIDM2MDA7CiAgICAgIHJldHVybiBidXNpbmVzc0RheSAmJiBzZWNvbmRzID49IGZyb20gJiYgc2Vjb25kcyA8IHRvOwogICAgfQoKICAgIGdldE5leHRSdW5UaW1lKCkgewogICAgICByZXR1cm4gdGhpcy5uZXh0UnVuQXQgPyBuZXcgRGF0ZSh0aGlzLm5leHRSdW5BdCkgOiBudWxsOwogICAgfQoKICAgIF9zY2hlZHVsZShkZWxheU1zKSB7CiAgICAgIGlmICghdGhpcy5ydW5uaW5nIHx8IHRoaXMucGF1c2VkKSByZXR1cm47CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLnRpbWVyKTsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBEYXRlLm5vdygpICsgZGVsYXlNczsKICAgICAgdGhpcy50aW1lciA9IHNldFRpbWVvdXQoYXN5bmMgKCkgPT4gewogICAgICAgIGlmICghdGhpcy5ydW5uaW5nIHx8IHRoaXMucGF1c2VkKSByZXR1cm47CiAgICAgICAgaWYgKCF0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcoZmFsc2UpOwogICAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgc2V0TWFya2V0VGFnKHRydWUpOwogICAgICAgIGF3YWl0IHRoaXMuZmV0Y2hGbigpOwogICAgICAgIHRoaXMuX3NjaGVkdWxlKHRoaXMuaW50ZXJ2YWxNcyk7CiAgICAgIH0sIGRlbGF5TXMpOwogICAgfQoKICAgIF93YWl0Rm9yT3BlbigpIHsKICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMud2FpdFRpbWVyKTsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBEYXRlLm5vdygpICsgNjAwMDA7CiAgICAgIHRoaXMud2FpdFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7CiAgICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgICBpZiAodGhpcy5pc01hcmtldE9wZW4oKSkgewogICAgICAgICAgc2V0TWFya2V0VGFnKHRydWUpOwogICAgICAgICAgdGhpcy5mZXRjaEZuKHsgbWFudWFsOiB0cnVlIH0pOwogICAgICAgICAgdGhpcy5fc2NoZWR1bGUodGhpcy5pbnRlcnZhbE1zKTsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgc2V0TWFya2V0VGFnKGZhbHNlKTsKICAgICAgICAgIHRoaXMuX3dhaXRGb3JPcGVuKCk7CiAgICAgICAgfQogICAgICB9LCA2MDAwMCk7CiAgICB9CgogICAgX3N0YXJ0Q291bnRkb3duKCkgewogICAgICB0aGlzLl9zdG9wQ291bnRkb3duKCk7CiAgICAgIHRoaXMuY291bnRkb3duVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7CiAgICAgICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY291bnRkb3duLXRleHQnKTsKICAgICAgICBpZiAoIWVsIHx8IHRoaXMucGF1c2VkKSByZXR1cm47CiAgICAgICAgY29uc3QgbmV4dCA9IHRoaXMuZ2V0TmV4dFJ1blRpbWUoKTsKICAgICAgICBpZiAoIW5leHQpIHsKICAgICAgICAgIGVsLnRleHRDb250ZW50ID0gdGhpcy5pc01hcmtldE9wZW4oKSA/ICdQcsOzeGltYSBhY3R1YWxpemFjacOzbiBlbiDigJQnIDogJ01lcmNhZG8gY2VycmFkbyc7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIGNvbnN0IGRpZmYgPSBNYXRoLm1heCgwLCBuZXh0LmdldFRpbWUoKSAtIERhdGUubm93KCkpOwogICAgICAgIGNvbnN0IG0gPSBNYXRoLmZsb29yKGRpZmYgLyA2MDAwMCk7CiAgICAgICAgY29uc3QgcyA9IE1hdGguZmxvb3IoKGRpZmYgJSA2MDAwMCkgLyAxMDAwKTsKICAgICAgICBpZiAodGhpcy5pc01hcmtldE9wZW4oKSkgZWwudGV4dENvbnRlbnQgPSBgUHLDs3hpbWEgYWN0dWFsaXphY2nDs24gZW4gJHttfToke1N0cmluZyhzKS5wYWRTdGFydCgyLCAnMCcpfWA7CiAgICAgICAgZWxzZSBlbC50ZXh0Q29udGVudCA9ICdNZXJjYWRvIGNlcnJhZG8nOwogICAgICB9LCAxMDAwKTsKICAgIH0KCiAgICBfc3RvcENvdW50ZG93bigpIHsKICAgICAgY2xlYXJJbnRlcnZhbCh0aGlzLmNvdW50ZG93blRpbWVyKTsKICAgICAgdGhpcy5jb3VudGRvd25UaW1lciA9IG51bGw7CiAgICB9CiAgfQoKICAvLyA2KSBMw7NnaWNhIGRlIGNhY2jDqQogIGZ1bmN0aW9uIHNhdmVDYWNoZShkYXRhKSB7CiAgICB0cnkgewogICAgICBzZXNzaW9uU3RvcmFnZS5zZXRJdGVtKENBQ0hFX0tFWSwgSlNPTi5zdHJpbmdpZnkoewogICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSwKICAgICAgICBtZXBDY2w6IGRhdGEubWVwQ2NsLAogICAgICAgIGZjaVJlbnRhRmlqYTogZGF0YS5mY2lSZW50YUZpamEsCiAgICAgICAgZmNpUmVudGFGaWphUGVudWx0aW1vOiBkYXRhLmZjaVJlbnRhRmlqYVBlbnVsdGltbywKICAgICAgICBmY2lSZW50YUZpamFNZXNCYXNlOiBkYXRhLmZjaVJlbnRhRmlqYU1lc0Jhc2UsCiAgICAgICAgZmNpUmVudGFWYXJpYWJsZTogZGF0YS5mY2lSZW50YVZhcmlhYmxlLAogICAgICAgIGZjaVJlbnRhVmFyaWFibGVQZW51bHRpbW86IGRhdGEuZmNpUmVudGFWYXJpYWJsZVBlbnVsdGltbywKICAgICAgICBmY2lSZW50YVZhcmlhYmxlTWVzQmFzZTogZGF0YS5mY2lSZW50YVZhcmlhYmxlTWVzQmFzZSwKICAgICAgICBiZW5jaG1hcmtQbGF6b0Zpam86IGRhdGEuYmVuY2htYXJrUGxhem9GaWpvLAogICAgICAgIGJlbmNobWFya0luZmxhY2lvbjogZGF0YS5iZW5jaG1hcmtJbmZsYWNpb24KICAgICAgfSkpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBjb25zb2xlLmVycm9yKCdbUmFkYXJNRVBdIG5vIHNlIHB1ZG8gZ3VhcmRhciBjYWNoZScsIGUpOwogICAgfQogIH0KCiAgZnVuY3Rpb24gbG9hZENhY2hlKCkgewogICAgdHJ5IHsKICAgICAgY29uc3QgcmF3ID0gc2Vzc2lvblN0b3JhZ2UuZ2V0SXRlbShDQUNIRV9LRVkpOwogICAgICBpZiAoIXJhdykgcmV0dXJuIG51bGw7CiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTsKICAgICAgaWYgKCFwYXJzZWQudGltZXN0YW1wIHx8IERhdGUubm93KCkgLSBwYXJzZWQudGltZXN0YW1wID4gQ0FDSEVfVFRMX01TKSByZXR1cm4gbnVsbDsKICAgICAgcmV0dXJuIHBhcnNlZDsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgY29uc29sZS5lcnJvcignW1JhZGFyTUVQXSBjYWNoZSBpbnbDoWxpZGEnLCBlKTsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBjbGFtcERyYXdlcldpZHRoKHB4KSB7CiAgICByZXR1cm4gTWF0aC5tYXgoRFJBV0VSX01JTl9XLCBNYXRoLm1pbihEUkFXRVJfTUFYX1csIE1hdGgucm91bmQocHgpKSk7CiAgfQogIGZ1bmN0aW9uIHNhdmVEcmF3ZXJXaWR0aChweCkgewogICAgdHJ5IHsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oRFJBV0VSX1dJRFRIX0tFWSwgU3RyaW5nKGNsYW1wRHJhd2VyV2lkdGgocHgpKSk7IH0gY2F0Y2gge30KICB9CiAgZnVuY3Rpb24gbG9hZERyYXdlcldpZHRoKCkgewogICAgdHJ5IHsKICAgICAgY29uc3QgcmF3ID0gTnVtYmVyKGxvY2FsU3RvcmFnZS5nZXRJdGVtKERSQVdFUl9XSURUSF9LRVkpKTsKICAgICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShyYXcpID8gY2xhbXBEcmF3ZXJXaWR0aChyYXcpIDogbnVsbDsKICAgIH0gY2F0Y2ggewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CiAgZnVuY3Rpb24gYXBwbHlEcmF3ZXJXaWR0aChweCwgcGVyc2lzdCA9IGZhbHNlKSB7CiAgICBpZiAod2luZG93LmlubmVyV2lkdGggPD0gOTAwKSByZXR1cm47CiAgICBjb25zdCBuZXh0ID0gY2xhbXBEcmF3ZXJXaWR0aChweCk7CiAgICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuc3R5bGUuc2V0UHJvcGVydHkoJy0tZHJhd2VyLXcnLCBgJHtuZXh0fXB4YCk7CiAgICBpZiAocGVyc2lzdCkgc2F2ZURyYXdlcldpZHRoKG5leHQpOwogIH0KICBmdW5jdGlvbiBpbml0RHJhd2VyV2lkdGgoKSB7CiAgICBjb25zdCBzYXZlZCA9IGxvYWREcmF3ZXJXaWR0aCgpOwogICAgaWYgKHNhdmVkICE9PSBudWxsKSBhcHBseURyYXdlcldpZHRoKHNhdmVkLCBmYWxzZSk7CiAgfQogIGZ1bmN0aW9uIGJpbmREcmF3ZXJSZXNpemUoKSB7CiAgICBpZiAoc3RhdGUuZHJhd2VyUmVzaXplQm91bmQpIHJldHVybjsKICAgIGNvbnN0IGhhbmRsZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdkcmF3ZXItcmVzaXplcicpOwogICAgY29uc3QgZHJhd2VyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2RyYXdlcicpOwogICAgaWYgKCFoYW5kbGUgfHwgIWRyYXdlcikgcmV0dXJuOwogICAgc3RhdGUuZHJhd2VyUmVzaXplQm91bmQgPSB0cnVlOwogICAgaGFuZGxlLmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJkb3duJywgKGV2ZW50KSA9PiB7CiAgICAgIGlmICh3aW5kb3cuaW5uZXJXaWR0aCA8PSA5MDAgfHwgZXZlbnQuYnV0dG9uICE9PSAwKSByZXR1cm47CiAgICAgIGNvbnN0IHN0YXJ0WCA9IGV2ZW50LmNsaWVudFg7CiAgICAgIGNvbnN0IHN0YXJ0V2lkdGggPSBkcmF3ZXIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkud2lkdGg7CiAgICAgIGhhbmRsZS5jbGFzc0xpc3QuYWRkKCdhY3RpdmUnKTsKICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKICAgICAgY29uc3Qgb25Nb3ZlID0gKG1vdmVFdmVudCkgPT4gewogICAgICAgIGNvbnN0IGRlbHRhID0gbW92ZUV2ZW50LmNsaWVudFggLSBzdGFydFg7CiAgICAgICAgYXBwbHlEcmF3ZXJXaWR0aChzdGFydFdpZHRoIC0gZGVsdGEsIGZhbHNlKTsKICAgICAgfTsKICAgICAgY29uc3Qgb25VcCA9ICgpID0+IHsKICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcm1vdmUnLCBvbk1vdmUpOwogICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdwb2ludGVydXAnLCBvblVwKTsKICAgICAgICBoYW5kbGUuY2xhc3NMaXN0LnJlbW92ZSgnYWN0aXZlJyk7CiAgICAgICAgY29uc3Qgd2lkdGggPSBkcmF3ZXIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkud2lkdGg7CiAgICAgICAgYXBwbHlEcmF3ZXJXaWR0aCh3aWR0aCwgdHJ1ZSk7CiAgICAgIH07CiAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVybW92ZScsIG9uTW92ZSk7CiAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVydXAnLCBvblVwKTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gaGlkZVNtYXJ0VGlwKCkgewogICAgY29uc3QgdGlwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NtYXJ0LXRpcCcpOwogICAgaWYgKCF0aXApIHJldHVybjsKICAgIHRpcC5jbGFzc0xpc3QucmVtb3ZlKCdzaG93Jyk7CiAgICB0aXAuc2V0QXR0cmlidXRlKCdhcmlhLWhpZGRlbicsICd0cnVlJyk7CiAgfQogIGZ1bmN0aW9uIHNob3dTbWFydFRpcChhbmNob3IpIHsKICAgIGNvbnN0IHRpcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzbWFydC10aXAnKTsKICAgIGlmICghdGlwIHx8ICFhbmNob3IpIHJldHVybjsKICAgIGNvbnN0IHRleHQgPSBhbmNob3IuZ2V0QXR0cmlidXRlKCdkYXRhLXQnKTsKICAgIGlmICghdGV4dCkgcmV0dXJuOwogICAgdGlwLnRleHRDb250ZW50ID0gdGV4dDsKICAgIHRpcC5jbGFzc0xpc3QuYWRkKCdzaG93Jyk7CiAgICB0aXAuc2V0QXR0cmlidXRlKCdhcmlhLWhpZGRlbicsICdmYWxzZScpOwoKICAgIGNvbnN0IG1hcmdpbiA9IDg7CiAgICBjb25zdCByZWN0ID0gYW5jaG9yLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgY29uc3QgdGlwUmVjdCA9IHRpcC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICAgIGxldCBsZWZ0ID0gcmVjdC5sZWZ0OwogICAgaWYgKGxlZnQgKyB0aXBSZWN0LndpZHRoICsgbWFyZ2luID4gd2luZG93LmlubmVyV2lkdGgpIGxlZnQgPSB3aW5kb3cuaW5uZXJXaWR0aCAtIHRpcFJlY3Qud2lkdGggLSBtYXJnaW47CiAgICBpZiAobGVmdCA8IG1hcmdpbikgbGVmdCA9IG1hcmdpbjsKICAgIGxldCB0b3AgPSByZWN0LmJvdHRvbSArIDg7CiAgICBpZiAodG9wICsgdGlwUmVjdC5oZWlnaHQgKyBtYXJnaW4gPiB3aW5kb3cuaW5uZXJIZWlnaHQpIHRvcCA9IE1hdGgubWF4KG1hcmdpbiwgcmVjdC50b3AgLSB0aXBSZWN0LmhlaWdodCAtIDgpOwogICAgdGlwLnN0eWxlLmxlZnQgPSBgJHtNYXRoLnJvdW5kKGxlZnQpfXB4YDsKICAgIHRpcC5zdHlsZS50b3AgPSBgJHtNYXRoLnJvdW5kKHRvcCl9cHhgOwogIH0KICBmdW5jdGlvbiBpbml0U21hcnRUaXBzKCkgewogICAgaWYgKHN0YXRlLnNtYXJ0VGlwQm91bmQpIHJldHVybjsKICAgIHN0YXRlLnNtYXJ0VGlwQm91bmQgPSB0cnVlOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRpcC50aXAtZG93bicpLmZvckVhY2goKGVsKSA9PiB7CiAgICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlZW50ZXInLCAoKSA9PiBzaG93U21hcnRUaXAoZWwpKTsKICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignZm9jdXMnLCAoKSA9PiBzaG93U21hcnRUaXAoZWwpKTsKICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZXZlbnQpID0+IHsKICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIHNob3dTbWFydFRpcChlbCk7CiAgICAgIH0pOwogICAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWxlYXZlJywgaGlkZVNtYXJ0VGlwKTsKICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignYmx1cicsIGhpZGVTbWFydFRpcCk7CiAgICB9KTsKICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdzY3JvbGwnLCBoaWRlU21hcnRUaXAsIHRydWUpOwogICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3Jlc2l6ZScsICgpID0+IHsKICAgICAgaGlkZVNtYXJ0VGlwKCk7CiAgICAgIGluaXREcmF3ZXJXaWR0aCgpOwogICAgfSk7CiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChldmVudCkgPT4gewogICAgICBpZiAoIShldmVudC50YXJnZXQgaW5zdGFuY2VvZiBFbGVtZW50KSkgcmV0dXJuOwogICAgICBpZiAoIWV2ZW50LnRhcmdldC5jbG9zZXN0KCcudGlwLnRpcC1kb3duJykgJiYgIWV2ZW50LnRhcmdldC5jbG9zZXN0KCcjc21hcnQtdGlwJykpIGhpZGVTbWFydFRpcCgpOwogICAgfSk7CiAgfQoKICAvLyA3KSBJbmljaWFsaXphY2nDs24KICBzdGFydEZyZXNoVGlja2VyKCk7CiAgaW5pdERyYXdlcldpZHRoKCk7CiAgYmluZERyYXdlclJlc2l6ZSgpOwogIGluaXRTbWFydFRpcHMoKTsKICBmdW5jdGlvbiB0b2dnbGVEcmF3ZXIoKSB7CiAgICBjb25zdCBkcmF3ZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZHJhd2VyJyk7CiAgICBjb25zdCB3cmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2JvZHlXcmFwJyk7CiAgICBjb25zdCBidG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYnRuVGFzYXMnKTsKICAgIGNvbnN0IG92bCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdvdmVybGF5Jyk7CiAgICBjb25zdCBpc09wZW4gPSBkcmF3ZXIuY2xhc3NMaXN0LmNvbnRhaW5zKCdvcGVuJyk7CiAgICBkcmF3ZXIuY2xhc3NMaXN0LnRvZ2dsZSgnb3BlbicsICFpc09wZW4pOwogICAgd3JhcC5jbGFzc0xpc3QudG9nZ2xlKCdkcmF3ZXItb3BlbicsICFpc09wZW4pOwogICAgYnRuLmNsYXNzTGlzdC50b2dnbGUoJ2FjdGl2ZScsICFpc09wZW4pOwogICAgb3ZsLmNsYXNzTGlzdC50b2dnbGUoJ3Nob3cnLCAhaXNPcGVuKTsKICB9CgogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5waWxsW2RhdGEtZmlsdGVyXScpLmZvckVhY2goKHApID0+IHsKICAgIHAuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBhcHBseUZpbHRlcihwLmRhdGFzZXQuZmlsdGVyKSk7CiAgfSk7CiAgY29uc3QgY3N2QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2J0bi1kb3dubG9hZC1jc3YnKTsKICBpZiAoY3N2QnRuKSBjc3ZCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBkb3dubG9hZEhpc3RvcnlDc3YpOwogIGNvbnN0IGZjaVRhYkZpamEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLXRhYi1maWphJyk7CiAgaWYgKGZjaVRhYkZpamEpIHsKICAgIGZjaVRhYkZpamEuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBzZXRGY2lUeXBlKCdmaWphJykpOwogIH0KICBjb25zdCBmY2lUYWJWYXJpYWJsZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktdGFiLXZhcmlhYmxlJyk7CiAgaWYgKGZjaVRhYlZhcmlhYmxlKSB7CiAgICBmY2lUYWJWYXJpYWJsZS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHNldEZjaVR5cGUoJ3ZhcmlhYmxlJykpOwogIH0KICBjb25zdCBmY2lTZWFyY2ggPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLXNlYXJjaCcpOwogIGlmIChmY2lTZWFyY2gpIHsKICAgIGZjaVNlYXJjaC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IHsKICAgICAgc3RhdGUuZmNpUXVlcnkgPSBmY2lTZWFyY2gudmFsdWUgfHwgJyc7CiAgICAgIHN0YXRlLmZjaVBhZ2UgPSAxOwogICAgICByZW5kZXJGY2lSZW50YUZpamEoKTsKICAgIH0pOwogIH0KICBjb25zdCBmY2lQcmV2ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1wcmV2Jyk7CiAgaWYgKGZjaVByZXYpIHsKICAgIGZjaVByZXYuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIHN0YXRlLmZjaVBhZ2UgPSBNYXRoLm1heCgxLCBzdGF0ZS5mY2lQYWdlIC0gMSk7CiAgICAgIHJlbmRlckZjaVJlbnRhRmlqYSgpOwogICAgfSk7CiAgfQogIGNvbnN0IGZjaU5leHQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLW5leHQnKTsKICBpZiAoZmNpTmV4dCkgewogICAgZmNpTmV4dC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgc3RhdGUuZmNpUGFnZSArPSAxOwogICAgICByZW5kZXJGY2lSZW50YUZpamEoKTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gdG9nZ2xlR2xvcygpIHsKICAgIGNvbnN0IGdyaWQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZ2xvc0dyaWQnKTsKICAgIGNvbnN0IGFycm93ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2dsb3NBcnJvdycpOwogICAgY29uc3Qgb3BlbiA9IGdyaWQuY2xhc3NMaXN0LnRvZ2dsZSgnb3BlbicpOwogICAgYXJyb3cudGV4dENvbnRlbnQgPSBvcGVuID8gJ+KWtCcgOiAn4pa+JzsKICB9CgogIGNvbnN0IHJldHJ5QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Vycm9yLXJldHJ5LWJ0bicpOwogIGlmIChyZXRyeUJ0bikgewogICAgcmV0cnlCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIGlmICh3aW5kb3cuc2NoZWR1bGVyKSB3aW5kb3cuc2NoZWR1bGVyLnJlc3VtZSgpOwogICAgICBmZXRjaEFsbCh7IG1hbnVhbDogdHJ1ZSB9KTsKICAgIH0pOwogIH0KCiAgY29uc3QgY2FjaGVkID0gbG9hZENhY2hlKCk7CiAgaW5pdEhpc3RvcnlDb2x1bW5XaWR0aHMoKTsKICBiaW5kSGlzdG9yeUNvbHVtblJlc2l6ZSgpOwogIGluaXRGY2lDb2x1bW5XaWR0aHMoKTsKICBiaW5kRmNpQ29sdW1uUmVzaXplKCk7CiAgc3RhdGUuZmNpU2lnbmFsU3RyZWFrcyA9IGxvYWRGY2lTaWduYWxTdHJlYWtzKCk7CiAgaWYgKGNhY2hlZCkgewogICAgc3RhdGUubGFzdE1lcFBheWxvYWQgPSBjYWNoZWQubWVwQ2NsOwogICAgY29uc3QgcGZEYXRhID0gY2FjaGVkLmJlbmNobWFya1BsYXpvRmlqbz8uZGF0YSB8fCB7fTsKICAgIGNvbnN0IGluZkRhdGEgPSBjYWNoZWQuYmVuY2htYXJrSW5mbGFjaW9uPy5kYXRhIHx8IHt9OwogICAgc3RhdGUuYmVuY2htYXJrID0gewogICAgICBwbGF6b0Zpam9Nb250aGx5UGN0OiB0b051bWJlcihwZkRhdGE/Lm1vbnRobHlQY3QpLAogICAgICBpbmZsYWNpb25Nb250aGx5UGN0OiB0b051bWJlcihpbmZEYXRhPy5tb250aGx5UGN0KSwKICAgICAgaW5mbGFjaW9uRGF0ZTogdHlwZW9mIGluZkRhdGE/LmRhdGUgPT09ICdzdHJpbmcnID8gaW5mRGF0YS5kYXRlIDogbnVsbCwKICAgICAgdXBkYXRlZEF0SHVtYW5BcnQ6IGNhY2hlZC5iZW5jaG1hcmtQbGF6b0Zpam8/LmZldGNoZWRBdEh1bWFuQXJ0IHx8IGNhY2hlZC5iZW5jaG1hcmtJbmZsYWNpb24/LmZldGNoZWRBdEh1bWFuQXJ0IHx8IG51bGwKICAgIH07CiAgICBpZiAoY2FjaGVkLmZjaVJlbnRhRmlqYSB8fCBjYWNoZWQuZmNpUmVudGFGaWphUGVudWx0aW1vIHx8IGNhY2hlZC5mY2lSZW50YUZpamFNZXNCYXNlKSB7CiAgICAgIHJlbmRlckZjaVJlbnRhRmlqYShjYWNoZWQuZmNpUmVudGFGaWphLCBjYWNoZWQuZmNpUmVudGFGaWphUGVudWx0aW1vLCAnZmlqYScsIGNhY2hlZC5mY2lSZW50YUZpamFNZXNCYXNlKTsKICAgIH0KICAgIGlmIChjYWNoZWQuZmNpUmVudGFWYXJpYWJsZSB8fCBjYWNoZWQuZmNpUmVudGFWYXJpYWJsZVBlbnVsdGltbyB8fCBjYWNoZWQuZmNpUmVudGFWYXJpYWJsZU1lc0Jhc2UpIHsKICAgICAgcmVuZGVyRmNpUmVudGFGaWphKGNhY2hlZC5mY2lSZW50YVZhcmlhYmxlLCBjYWNoZWQuZmNpUmVudGFWYXJpYWJsZVBlbnVsdGltbywgJ3ZhcmlhYmxlJywgY2FjaGVkLmZjaVJlbnRhVmFyaWFibGVNZXNCYXNlKTsKICAgIH0KICAgIHJlbmRlckZjaVJlbnRhRmlqYSgpOwogICAgcmVuZGVyTWVwQ2NsKGNhY2hlZC5tZXBDY2wpOwogICAgcmVuZGVyTWV0cmljczI0aChjYWNoZWQubWVwQ2NsKTsKICAgIHJlbmRlclRyZW5kKGNhY2hlZC5tZXBDY2wpOwogICAgcmVuZGVySGlzdG9yeShjYWNoZWQubWVwQ2NsKTsKICAgIGNvbnN0IGNhY2hlZFJvb3QgPSBleHRyYWN0Um9vdChjYWNoZWQubWVwQ2NsKTsKICAgIHN0YXRlLnNvdXJjZVRzTXMgPSB0b051bWJlcihjYWNoZWRSb290Py5zb3VyY2VTdGF0dXM/LmxhdGVzdFNvdXJjZVRzTXMpCiAgICAgID8/IHRvTnVtYmVyKGNhY2hlZFJvb3Q/LmN1cnJlbnQ/Lm1lcFRzTXMpCiAgICAgID8/IHRvTnVtYmVyKGNhY2hlZFJvb3Q/LmN1cnJlbnQ/LmNjbFRzTXMpCiAgICAgID8/IG51bGw7CiAgICByZWZyZXNoRnJlc2hCYWRnZUZyb21Tb3VyY2UoKTsKICB9CgogIGFwcGx5RmlsdGVyKHN0YXRlLmZpbHRlck1vZGUpOwoKICB3aW5kb3cuc2NoZWR1bGVyID0gbmV3IE1hcmtldFNjaGVkdWxlcihmZXRjaEFsbCwgRkVUQ0hfSU5URVJWQUxfTVMpOwogIHdpbmRvdy5zY2hlZHVsZXIuc3RhcnQoKTsKICBmZXRjaEFsbCh7IG1hbnVhbDogdHJ1ZSB9KTsKCiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigndmlzaWJpbGl0eWNoYW5nZScsICgpID0+IHsKICAgIGlmIChkb2N1bWVudC5oaWRkZW4pIHdpbmRvdy5zY2hlZHVsZXIucGF1c2UoKTsKICAgIGVsc2Ugd2luZG93LnNjaGVkdWxlci5yZXN1bWUoKTsKICB9KTsKPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo=`;

function decodeBase64Utf8(b64) {
  const compact = b64.replace(/\s+/g, "");
  const binary = atob(compact);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function renderDashboardHtml() {
  return decodeBase64Utf8(DASHBOARD_HTML_B64);
}
