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
const STATE_KEY = "mep_ccl_state_v1";
const HISTORY_KEY = "mep_ccl_history_v1";
const SNAPSHOT_PREFIX = "mep_ccl_snapshot_";
const FCI_LAST_KEY = "fci_renta_fija_ultimo_v1";
const FCI_PREV_KEY = "fci_renta_fija_penultimo_v1";
const FCI_STATE_KEY = "fci_renta_fija_state_v1";
const FCI_SNAPSHOT_PREFIX = "fci_renta_fija_snapshot_";
const FCI_RV_LAST_KEY = "fci_renta_variable_ultimo_v1";
const FCI_RV_PREV_KEY = "fci_renta_variable_penultimo_v1";
const FCI_RV_STATE_KEY = "fci_renta_variable_state_v1";
const FCI_RV_SNAPSHOT_PREFIX = "fci_renta_variable_snapshot_";
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

    if (path === "/api/fci/renta-variable/status") {
      const status = await loadFciStatus(env, FCI_RV_STATE_KEY);
      return jsonResponse(status || buildEmptyFciStatus(), false);
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
    ctx.waitUntil(Promise.allSettled([runUpdate(env), refreshFciRentaFijaData(env), refreshFciRentaVariableData(env)]));
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

async function saveFciDailySnapshot(env, snapshotPrefix, ultimoPayload, penultimoPayload, now) {
  const key = snapshotPrefix + snapshotKeyDateArt(now);
  const payload = {
    dateArt: key.replace(FCI_SNAPSHOT_PREFIX, ""),
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

async function refreshFciSeriesData(env, config) {
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

  if (!ultimoPayload) ultimoPayload = await loadFciPayload(env, config.lastKey);
  if (!penultimoPayload) penultimoPayload = await loadFciPayload(env, config.prevKey);

  const status = {
    source: "argentinadatos",
    ok: Boolean(ultimoPayload && penultimoPayload),
    updatedAtIso: now.toISOString(),
    updatedAtHumanArt: formatArtDate(now),
    lastDecision: errorCount === 0 ? "updated" : (ultimoPayload || penultimoPayload) ? "partial_update" : "error",
    lastError: lastError || null,
    ultimoRows: Number(ultimoPayload?.rowsCount || 0),
    penultimoRows: Number(penultimoPayload?.rowsCount || 0),
    snapshotKey: null,
  };

  if (ultimoPayload || penultimoPayload) {
    status.snapshotKey = await saveFciDailySnapshot(env, config.snapshotPrefix, ultimoPayload, penultimoPayload, now);
  }
  await env.MONITOR_KV.put(config.stateKey, JSON.stringify(status));
  return { ultimo: ultimoPayload, penultimo: penultimoPayload, status };
}

async function refreshFciRentaFijaData(env) {
  return refreshFciSeriesData(env, {
    apiBase: FCI_RF_API_BASE,
    lastKey: FCI_LAST_KEY,
    prevKey: FCI_PREV_KEY,
    stateKey: FCI_STATE_KEY,
    snapshotPrefix: FCI_SNAPSHOT_PREFIX,
  });
}

async function refreshFciRentaVariableData(env) {
  return refreshFciSeriesData(env, {
    apiBase: FCI_RV_API_BASE,
    lastKey: FCI_RV_LAST_KEY,
    prevKey: FCI_RV_PREV_KEY,
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

const DASHBOARD_HTML_B64 = `PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVzIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+UmFkYXIgTUVQL0NDTCDCtyBNZXJjYWRvIEFSRzwvdGl0bGU+CjxsaW5rIHJlbD0icHJlY29ubmVjdCIgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbSI+CjxsaW5rIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20vY3NzMj9mYW1pbHk9U3BhY2UrTW9ubzp3Z2h0QDQwMDs3MDAmZmFtaWx5PVN5bmU6d2dodEA0MDA7NjAwOzcwMDs4MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c3R5bGU+Ci8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBUT0tFTlMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCjpyb290IHsKICAtLWJnOiAgICAgICAjMDgwYjBlOwogIC0tc3VyZjogICAgICMwZjEzMTg7CiAgLS1zdXJmMjogICAgIzE2MWIyMjsKICAtLXN1cmYzOiAgICAjMWMyMzMwOwogIC0tYm9yZGVyOiAgICMxZTI1MzA7CiAgLS1ib3JkZXJCOiAgIzJhMzQ0NDsKCiAgLS1ncmVlbjogICAgIzAwZTY3NjsKICAtLWdyZWVuLWQ6ICByZ2JhKDAsMjMwLDExOCwuMDkpOwogIC0tZ3JlZW4tZzogIHJnYmEoMCwyMzAsMTE4LC4yMik7CiAgLS1yZWQ6ICAgICAgI2ZmNDc1NzsKICAtLXJlZC1kOiAgICByZ2JhKDI1NSw3MSw4NywuMDkpOwogIC0teWVsbG93OiAgICNmZmMgYzAwOwogIC0teWVsbG93OiAgICNmZmNjMDA7CiAgLS15ZWxsb3ctZDogcmdiYSgyNTUsMjA0LDAsLjA5KTsKCiAgLS1tZXA6ICAgICAgIzI5YjZmNjsKICAtLWNjbDogICAgICAjYjM5ZGRiOwogIC0tdGV4dDogICAgICNkZGU0ZWU7CiAgLS1tdXRlZDogICAgIzU1NjA3MDsKICAtLW11dGVkMjogICAjN2E4ZmE4OwoKICAtLW1vbm86ICdTcGFjZSBNb25vJywgbW9ub3NwYWNlOwogIC0tc2FuczogJ1N5bmUnLCBzYW5zLXNlcmlmOwoKICAtLWRyYXdlci13OiA0MDBweDsKICAtLWhlYWRlci1oOiA1NHB4Owp9CgoqLCAqOjpiZWZvcmUsICo6OmFmdGVyIHsgYm94LXNpemluZzogYm9yZGVyLWJveDsgbWFyZ2luOiAwOyBwYWRkaW5nOiAwOyB9CgpodG1sIHsgc2Nyb2xsLWJlaGF2aW9yOiBzbW9vdGg7IH0KCmJvZHkgewogIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgZm9udC1mYW1pbHk6IHZhcigtLW1vbm8pOwogIG1pbi1oZWlnaHQ6IDEwMHZoOwogIG92ZXJmbG93LXg6IGhpZGRlbjsKfQoKYm9keTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogZml4ZWQ7IGluc2V0OiAwOwogIGJhY2tncm91bmQtaW1hZ2U6CiAgICBsaW5lYXItZ3JhZGllbnQocmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KSwKICAgIGxpbmVhci1ncmFkaWVudCg5MGRlZywgcmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KTsKICBiYWNrZ3JvdW5kLXNpemU6IDQ0cHggNDRweDsKICBwb2ludGVyLWV2ZW50czogbm9uZTsgei1pbmRleDogMDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIExBWU9VVCBTSEVMTArilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmFwcCB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBtaW4taGVpZ2h0OiAxMDB2aDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEhFQURFUgrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KaGVhZGVyIHsKICBwb3NpdGlvbjogc3RpY2t5OyB0b3A6IDA7IHotaW5kZXg6IDIwMDsKICBoZWlnaHQ6IHZhcigtLWhlYWRlci1oKTsKICBiYWNrZ3JvdW5kOiByZ2JhKDgsMTEsMTQsLjkzKTsKICBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMThweCk7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogMCAyMnB4OwogIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKfQoKLmxvZ28gewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6IDgwMDsgZm9udC1zaXplOiAxNXB4OwogIGxldHRlci1zcGFjaW5nOiAuMDVlbTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA5cHg7Cn0KCi5saXZlLWRvdCB7CiAgd2lkdGg6IDdweDsgaGVpZ2h0OiA3cHg7IGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbik7CiAgYm94LXNoYWRvdzogMCAwIDhweCB2YXIoLS1ncmVlbik7CiAgYW5pbWF0aW9uOiBibGluayAyLjJzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9CkBrZXlmcmFtZXMgYmxpbmsgewogIDAlLDEwMCV7b3BhY2l0eToxO2JveC1zaGFkb3c6MCAwIDhweCB2YXIoLS1ncmVlbik7fQogIDUwJXtvcGFjaXR5Oi4zNTtib3gtc2hhZG93OjAgMCAzcHggdmFyKC0tZ3JlZW4pO30KfQoKLmhlYWRlci1yaWdodCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTJweDsgfQoKLmZyZXNoLWJhZGdlIHsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDVweDsKICBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAyMHB4OyBwYWRkaW5nOiAzcHggMTFweDsKfQouZnJlc2gtZG90IHsgd2lkdGg6NXB4O2hlaWdodDo1cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDp2YXIoLS1ncmVlbik7YW5pbWF0aW9uOmJsaW5rIDIuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmZldGNoaW5nIHsgYW5pbWF0aW9uOiBiYWRnZVB1bHNlIDEuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmVycm9yIHsgY29sb3I6I2ZmZDBkMDsgYm9yZGVyLWNvbG9yOnJnYmEoMjU1LDgyLDgyLC40NSk7IGJhY2tncm91bmQ6cmdiYSgyNTUsODIsODIsLjEyKTsgY3Vyc29yOnBvaW50ZXI7IH0KQGtleWZyYW1lcyBiYWRnZVB1bHNlIHsKICAwJSwxMDAlIHsgb3BhY2l0eToxOyB9CiAgNTAlIHsgb3BhY2l0eTouNjU7IH0KfQoKLnRhZy1tZXJjYWRvIHsKICBmb250LWZhbWlseTogdmFyKC0tc2Fucyk7IGZvbnQtc2l6ZToxMHB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsKICBwYWRkaW5nOjNweCA5cHg7IGJvcmRlci1yYWRpdXM6NHB4Owp9Ci50YWctbWVyY2Fkby5jbG9zZWQgeyBiYWNrZ3JvdW5kOnZhcigtLW11dGVkKTsgY29sb3I6IzBhMGMwZjsgfQoKLmJ0biB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOyBmb250LXNpemU6MTFweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4wN2VtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgYm9yZGVyLXJhZGl1czo2cHg7IHBhZGRpbmc6NnB4IDE0cHg7IGN1cnNvcjpwb2ludGVyOwogIGJvcmRlcjpub25lOyB0cmFuc2l0aW9uOiBhbGwgLjE4czsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo2cHg7Cn0KLmJ0bi1hbGVydCB7IGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4pOyBjb2xvcjojMDAwOyB9Ci5idG4tYWxlcnQ6aG92ZXIgeyBiYWNrZ3JvdW5kOiMwMGZmODg7IHRyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpOyB9CgouYnRuLXRhc2FzIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMik7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6IHZhcigtLXRleHQpOwp9Ci5idG4tdGFzYXM6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMyk7IGJvcmRlci1jb2xvcjogdmFyKC0tbXV0ZWQyKTsgfQouYnRuLXRhc2FzLmFjdGl2ZSB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZjMpOwogIGJvcmRlci1jb2xvcjogdmFyKC0teWVsbG93KTsKICBjb2xvcjogdmFyKC0teWVsbG93KTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIE1BSU4gKyBEUkFXRVIgTEFZT1VUCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouYm9keS13cmFwIHsKICBmbGV4OiAxOwogIGRpc3BsYXk6IGZsZXg7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIHotaW5kZXg6IDE7CiAgdHJhbnNpdGlvbjogbm9uZTsKfQoKLm1haW4tY29udGVudCB7CiAgZmxleDogMTsKICBtYXgtd2lkdGg6IDEwMCU7CiAgcGFkZGluZzogMjJweCAyMnB4IDYwcHg7CiAgdHJhbnNpdGlvbjogbWFyZ2luLXJpZ2h0IC4zNXMgY3ViaWMtYmV6aWVyKC40LDAsLjIsMSk7Cn0KCi5ib2R5LXdyYXAuZHJhd2VyLW9wZW4gLm1haW4tY29udGVudCB7CiAgbWFyZ2luLXJpZ2h0OiB2YXIoLS1kcmF3ZXItdyk7Cn0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBEUkFXRVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5kcmF3ZXIgewogIHBvc2l0aW9uOiBmaXhlZDsKICB0b3A6IHZhcigtLWhlYWRlci1oKTsKICByaWdodDogMDsKICB3aWR0aDogdmFyKC0tZHJhd2VyLXcpOwogIGhlaWdodDogY2FsYygxMDB2aCAtIHZhcigtLWhlYWRlci1oKSk7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZik7CiAgYm9yZGVyLWxlZnQ6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHRyYW5zZm9ybTogdHJhbnNsYXRlWCgxMDAlKTsKICB0cmFuc2l0aW9uOiB0cmFuc2Zvcm0gLjM1cyBjdWJpYy1iZXppZXIoLjQsMCwuMiwxKTsKICBvdmVyZmxvdy15OiBhdXRvOwogIHotaW5kZXg6IDE1MDsKICBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwp9CgouZHJhd2VyLm9wZW4geyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMCk7IH0KCi5kcmF3ZXItcmVzaXplciB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IC00cHg7CiAgdG9wOiAwOwogIHdpZHRoOiA4cHg7CiAgaGVpZ2h0OiAxMDAlOwogIGN1cnNvcjogY29sLXJlc2l6ZTsKICB6LWluZGV4OiAxODA7Cn0KLmRyYXdlci1yZXNpemVyOjpiZWZvcmUgewogIGNvbnRlbnQ6ICcnOwogIHBvc2l0aW9uOiBhYnNvbHV0ZTsKICBsZWZ0OiAzcHg7CiAgdG9wOiAwOwogIHdpZHRoOiAycHg7CiAgaGVpZ2h0OiAxMDAlOwogIGJhY2tncm91bmQ6IHRyYW5zcGFyZW50OwogIHRyYW5zaXRpb246IGJhY2tncm91bmQgLjE1czsKfQouZHJhd2VyLXJlc2l6ZXI6aG92ZXI6OmJlZm9yZSwKLmRyYXdlci1yZXNpemVyLmFjdGl2ZTo6YmVmb3JlIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1tdXRlZDIpOwp9CgouZHJhd2VyLWhlYWRlciB7CiAgcG9zaXRpb246IHN0aWNreTsgdG9wOiAwOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYpOwogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHBhZGRpbmc6IDE2cHggMjBweDsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgei1pbmRleDogMTA7Cn0KCi5kcmF3ZXItdGl0bGUgewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6IDgwMDsgZm9udC1zaXplOiAxM3B4OwogIGxldHRlci1zcGFjaW5nOi4wNGVtOyBjb2xvcjogdmFyKC0tdGV4dCk7CiAgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6OHB4Owp9CgouZHJhd2VyLXNvdXJjZSB7CiAgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgZm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7Cn0KCi5idG4tY2xvc2UgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgY29sb3I6dmFyKC0tbXV0ZWQyKTsgYm9yZGVyLXJhZGl1czo2cHg7IHBhZGRpbmc6NXB4IDEwcHg7CiAgY3Vyc29yOnBvaW50ZXI7IGZvbnQtc2l6ZToxM3B4OyB0cmFuc2l0aW9uOiBhbGwgLjE1czsKfQouYnRuLWNsb3NlOmhvdmVyIHsgY29sb3I6dmFyKC0tdGV4dCk7IGJvcmRlci1jb2xvcjp2YXIoLS1tdXRlZDIpOyB9CgouZHJhd2VyLWJvZHkgeyBwYWRkaW5nOiAxNnB4IDIwcHg7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogMjJweDsgfQoKLmNvbnRleHQtYm94IHsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyMDQsMCwuMDYpOwogIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjU1LDIwNCwwLC4yKTsKICBib3JkZXItcmFkaXVzOiA5cHg7CiAgcGFkZGluZzogMTNweCAxNXB4OwogIGZvbnQtc2l6ZTogMTFweDsKICBsaW5lLWhlaWdodDoxLjY1OwogIGNvbG9yOnZhcigtLW11dGVkMik7Cn0KLmNvbnRleHQtYm94IHN0cm9uZyB7IGNvbG9yOnZhcigtLXllbGxvdyk7IH0KCi5mY2ktaGVhZGVyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBiYXNlbGluZTsKICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgZ2FwOiAxMHB4Owp9Ci5mY2ktdGl0bGUgewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsKICBmb250LXNpemU6IDEycHg7CiAgZm9udC13ZWlnaHQ6IDcwMDsKICBsZXR0ZXItc3BhY2luZzogLjA1ZW07CiAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsKICBjb2xvcjogdmFyKC0tdGV4dCk7Cn0KLmZjaS10aXRsZS13cmFwIHsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgZ2FwOiA4cHg7Cn0KLmZjaS10YWJzIHsKICBkaXNwbGF5OiBmbGV4OwogIGdhcDogOHB4OwogIGZsZXgtd3JhcDogd3JhcDsKfQouZmNpLXRhYi1idG4gewogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsKICBjb2xvcjogdmFyKC0tbXV0ZWQyKTsKICBib3JkZXItcmFkaXVzOiA5OTlweDsKICBmb250LXNpemU6IDEwcHg7CiAgZm9udC13ZWlnaHQ6IDcwMDsKICBsZXR0ZXItc3BhY2luZzogLjA1ZW07CiAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsKICBwYWRkaW5nOiA0cHggMTBweDsKICBjdXJzb3I6IHBvaW50ZXI7Cn0KLmZjaS10YWItYnRuLmFjdGl2ZSB7CiAgY29sb3I6IHZhcigtLXllbGxvdyk7CiAgYm9yZGVyLWNvbG9yOiB2YXIoLS15ZWxsb3cpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LCAyMDQsIDAsIC4wOCk7Cn0KLmZjaS1tZXRhIHsKICBmb250LXNpemU6IDEwcHg7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKfQouZmNpLXRhYmxlLXdyYXAgewogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czogMTBweDsKICBvdmVyZmxvdzogYXV0bzsKfQouZmNpLXRhYmxlIHsKICB3aWR0aDogMTAwJTsKICBtaW4td2lkdGg6IDk4MHB4OwogIGJvcmRlci1jb2xsYXBzZTogY29sbGFwc2U7CiAgdGFibGUtbGF5b3V0OiBmaXhlZDsKfQouZmNpLXRhYmxlIHRoZWFkIHRoIHsKICBwb3NpdGlvbjogc3RpY2t5OwogIHRvcDogMDsKICB6LWluZGV4OiA1OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsKICBjb2xvcjogdmFyKC0tbXV0ZWQyKTsKICBmb250LXNpemU6IDEwcHg7CiAgbGV0dGVyLXNwYWNpbmc6IC4wOGVtOwogIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7CiAgdGV4dC1hbGlnbjogbGVmdDsKICBwYWRkaW5nOiA5cHggMTBweDsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouZmNpLXRhYmxlIHRoZWFkIHRoOmhvdmVyIHsKICB6LWluZGV4OiA4MDsKfQouZmNpLXRhYmxlIHRib2R5IHRyIHsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouZmNpLXRhYmxlIHRib2R5IHRyOmxhc3QtY2hpbGQgewogIGJvcmRlci1ib3R0b206IG5vbmU7Cn0KLmZjaS10YWJsZSB0ZCB7CiAgZm9udC1zaXplOiAxMXB4OwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBwYWRkaW5nOiA5cHggMTBweDsKICBvdmVyZmxvdzogaGlkZGVuOwogIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7Cn0KLmZjaS1jb2wtbGFiZWwgewogIHBhZGRpbmctcmlnaHQ6IDEwcHg7CiAgZGlzcGxheTogaW5saW5lLWJsb2NrOwp9Ci5mY2ktY29sLXJlc2l6ZXIgewogIHBvc2l0aW9uOiBhYnNvbHV0ZTsKICB0b3A6IDA7CiAgcmlnaHQ6IC00cHg7CiAgd2lkdGg6IDhweDsKICBoZWlnaHQ6IDEwMCU7CiAgY3Vyc29yOiBjb2wtcmVzaXplOwogIHVzZXItc2VsZWN0OiBub25lOwogIHRvdWNoLWFjdGlvbjogbm9uZTsKICB6LWluZGV4OiAzOwp9Ci5mY2ktY29sLXJlc2l6ZXI6OmFmdGVyIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgdG9wOiA2cHg7CiAgYm90dG9tOiA2cHg7CiAgbGVmdDogM3B4OwogIHdpZHRoOiAxcHg7CiAgYmFja2dyb3VuZDogcmdiYSgxMjIsMTQzLDE2OCwuMjgpOwp9Ci5mY2ktY29sLXJlc2l6ZXI6aG92ZXI6OmFmdGVyLAouZmNpLWNvbC1yZXNpemVyLmFjdGl2ZTo6YWZ0ZXIgewogIGJhY2tncm91bmQ6IHJnYmEoMTIyLDE0MywxNjgsLjc1KTsKfQouZmNpLWVtcHR5IHsKICBmb250LXNpemU6IDExcHg7CiAgY29sb3I6IHZhcigtLW11dGVkMik7CiAgcGFkZGluZzogMTJweDsKICBib3JkZXI6IDFweCBkYXNoZWQgdmFyKC0tYm9yZGVyQik7CiAgYm9yZGVyLXJhZGl1czogMTBweDsKfQouZmNpLWNvbnRyb2xzIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOwogIGdhcDogMTBweDsKfQouZmNpLXNlYXJjaCB7CiAgd2lkdGg6IDEwMCU7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZjIpOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlckIpOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgcGFkZGluZzogOHB4IDEwcHg7CiAgZm9udC1zaXplOiAxMXB4OwogIG91dGxpbmU6IG5vbmU7Cn0KLmZjaS1zZWFyY2g6Zm9jdXMgewogIGJvcmRlci1jb2xvcjogdmFyKC0tbXV0ZWQyKTsKfQouZmNpLXBhZ2luYXRpb24gewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBmbGV4LXNocmluazogMDsKfQouZmNpLXBhZ2UtYnRuIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMik7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6IHZhcigtLXRleHQpOwogIGJvcmRlci1yYWRpdXM6IDZweDsKICBmb250LXNpemU6IDEwcHg7CiAgZm9udC13ZWlnaHQ6IDcwMDsKICB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOwogIGxldHRlci1zcGFjaW5nOiAuMDZlbTsKICBwYWRkaW5nOiA1cHggOHB4OwogIGN1cnNvcjogcG9pbnRlcjsKfQouZmNpLXBhZ2UtYnRuOmRpc2FibGVkIHsKICBvcGFjaXR5OiAuNDsKICBjdXJzb3I6IGRlZmF1bHQ7Cn0KLmZjaS1wYWdlLWluZm8gewogIGZvbnQtc2l6ZTogMTBweDsKICBjb2xvcjogdmFyKC0tbXV0ZWQyKTsKfQouZmNpLXRyZW5kIHsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNXB4Owp9Ci5mY2ktdHJlbmQtaWNvbiB7CiAgZm9udC1zaXplOiAxMHB4OwogIGZvbnQtd2VpZ2h0OiA3MDA7Cn0KLmZjaS10cmVuZC51cCAuZmNpLXRyZW5kLWljb24geyBjb2xvcjogdmFyKC0tZ3JlZW4pOyB9Ci5mY2ktdHJlbmQuZG93biAuZmNpLXRyZW5kLWljb24geyBjb2xvcjogdmFyKC0tcmVkKTsgfQouZmNpLXRyZW5kLmZsYXQgLmZjaS10cmVuZC1pY29uIHsgY29sb3I6IHZhcigtLW11dGVkMik7IH0KLmZjaS10cmVuZC5uYSAuZmNpLXRyZW5kLWljb24geyBjb2xvcjogdmFyKC0tbXV0ZWQpOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgU1RBVFVTIEJBTk5FUgrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLnN0YXR1cy1iYW5uZXIgewogIGJvcmRlci1yYWRpdXM6MTFweDsgcGFkZGluZzoxOHB4IDI0cHg7IG1hcmdpbi1ib3R0b206MjBweDsKICBib3JkZXI6MXB4IHNvbGlkOyBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKICBhbmltYXRpb246ZmFkZUluIC40cyBlYXNlOwogIG92ZXJmbG93OmhpZGRlbjsgcG9zaXRpb246cmVsYXRpdmU7Cn0KLnN0YXR1cy1iYW5uZXIuc2ltaWxhciB7CiAgYmFja2dyb3VuZDp2YXIoLS1ncmVlbi1kKTsgYm9yZGVyLWNvbG9yOnJnYmEoMCwyMzAsMTE4LC4yOCk7Cn0KLnN0YXR1cy1iYW5uZXIuc2ltaWxhcjo6YWZ0ZXIgewogIGNvbnRlbnQ6Jyc7IHBvc2l0aW9uOmFic29sdXRlOyByaWdodDotNTBweDsgdG9wOjUwJTsKICB0cmFuc2Zvcm06dHJhbnNsYXRlWSgtNTAlKTsgd2lkdGg6MjAwcHg7IGhlaWdodDoyMDBweDsKICBib3JkZXItcmFkaXVzOjUwJTsKICBiYWNrZ3JvdW5kOnJhZGlhbC1ncmFkaWVudChjaXJjbGUsdmFyKC0tZ3JlZW4tZykgMCUsdHJhbnNwYXJlbnQgNzAlKTsKICBwb2ludGVyLWV2ZW50czpub25lOwp9Ci5zdGF0dXMtYmFubmVyLm5vLXNpbWlsYXIgewogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDgyLDgyLC4wOCk7CiAgYm9yZGVyLWNvbG9yOiByZ2JhKDI1NSw4Miw4MiwuMzUpOwp9Ci5zdGF0dXMtYmFubmVyLm5vLXNpbWlsYXI6OmFmdGVyIHsKICBjb250ZW50OicnOwogIHBvc2l0aW9uOmFic29sdXRlOwogIHJpZ2h0Oi01MHB4OwogIHRvcDo1MCU7CiAgdHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTUwJSk7CiAgd2lkdGg6MjAwcHg7CiAgaGVpZ2h0OjIwMHB4OwogIGJvcmRlci1yYWRpdXM6NTAlOwogIGJhY2tncm91bmQ6cmFkaWFsLWdyYWRpZW50KGNpcmNsZSxyZ2JhKDI1NSw4Miw4MiwuMTgpIDAlLHRyYW5zcGFyZW50IDcwJSk7CiAgcG9pbnRlci1ldmVudHM6bm9uZTsKfQoKLnMtbGVmdCB7fQoucy10aXRsZSB7CiAgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtd2VpZ2h0OjgwMDsgZm9udC1zaXplOjI2cHg7CiAgbGV0dGVyLXNwYWNpbmc6LS4wMmVtOyBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsgZ2FwOjEycHg7Cn0KLnMtYmFkZ2UgewogIGZvbnQtc2l6ZToxMHB4OyBmb250LXdlaWdodDo3MDA7IGxldHRlci1zcGFjaW5nOi4xZW07CiAgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOyBwYWRkaW5nOjJweCA5cHg7IGJvcmRlci1yYWRpdXM6NHB4OwogIGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4pOyBjb2xvcjojMDAwOyBhbGlnbi1zZWxmOmNlbnRlcjsKfQoucy1iYWRnZS5ub3NpbSB7IGJhY2tncm91bmQ6IHZhcigtLXJlZCk7IGNvbG9yOiAjZmZmOyB9Ci5zLXN1YiB7IGZvbnQtc2l6ZToxMXB4OyBjb2xvcjp2YXIoLS1tdXRlZDIpOyBtYXJnaW4tdG9wOjRweDsgfQoKLmVycm9yLWJhbm5lciB7CiAgZGlzcGxheTpub25lOwogIG1hcmdpbjogMCAwIDE0cHggMDsKICBwYWRkaW5nOiAxMHB4IDEycHg7CiAgYm9yZGVyLXJhZGl1czogOHB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjU1LDgyLDgyLC40NSk7CiAgYmFja2dyb3VuZDogcmdiYSgyNTUsODIsODIsLjEyKTsKICBjb2xvcjogI2ZmZDBkMDsKICBmb250LXNpemU6IDExcHg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgZ2FwOiAxMHB4Owp9Ci5lcnJvci1iYW5uZXIuc2hvdyB7IGRpc3BsYXk6ZmxleDsgfQouZXJyb3ItYmFubmVyIGJ1dHRvbiB7CiAgYm9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSw4Miw4MiwuNSk7CiAgYmFja2dyb3VuZDogcmdiYSgyNTUsODIsODIsLjE1KTsKICBjb2xvcjojZmZkZWRlOwogIGJvcmRlci1yYWRpdXM6NnB4OwogIHBhZGRpbmc6NHB4IDEwcHg7CiAgZm9udC1zaXplOjEwcHg7CiAgZm9udC13ZWlnaHQ6NzAwOwogIHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBsZXR0ZXItc3BhY2luZzouMDZlbTsKICBjdXJzb3I6cG9pbnRlcjsKfQoKLnNrZWxldG9uIHsKICBiYWNrZ3JvdW5kOiBsaW5lYXItZ3JhZGllbnQoOTBkZWcsICMxYzIzMzAgMjUlLCAjMmEzNDQ0IDUwJSwgIzFjMjMzMCA3NSUpOwogIGJhY2tncm91bmQtc2l6ZTogMjAwJSAxMDAlOwogIGFuaW1hdGlvbjogc2hpbW1lciAxLjRzIGluZmluaXRlOwogIGJvcmRlci1yYWRpdXM6IDRweDsKICBjb2xvcjogdHJhbnNwYXJlbnQ7CiAgdXNlci1zZWxlY3Q6IG5vbmU7Cn0KQGtleWZyYW1lcyBzaGltbWVyIHsKICAwJSAgIHsgYmFja2dyb3VuZC1wb3NpdGlvbjogMjAwJSAwOyB9CiAgMTAwJSB7IGJhY2tncm91bmQtcG9zaXRpb246IC0yMDAlIDA7IH0KfQoKLnZhbHVlLWNoYW5nZWQgewogIGFuaW1hdGlvbjogZmxhc2hWYWx1ZSA2MDBtcyBlYXNlOwp9CkBrZXlmcmFtZXMgZmxhc2hWYWx1ZSB7CiAgMCUgICB7IGNvbG9yOiAjZmZjYzAwOyB9CiAgMTAwJSB7IGNvbG9yOiBpbmhlcml0OyB9Cn0KCi5zLXJpZ2h0IHsgdGV4dC1hbGlnbjpyaWdodDsgZm9udC1zaXplOjExcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgbGluZS1oZWlnaHQ6MS45OyB9Ci5zLXJpZ2h0IHN0cm9uZyB7IGNvbG9yOnZhcigtLW11dGVkMik7IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBIRVJPIENBUkRTCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouaGVyby1ncmlkIHsKICBkaXNwbGF5OmdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyIDFmcjsKICBnYXA6MTRweDsgbWFyZ2luLWJvdHRvbToyMHB4Owp9CgouaGNhcmQgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZik7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOjExcHg7IHBhZGRpbmc6MjBweCAyMnB4OwogIHBvc2l0aW9uOnJlbGF0aXZlOyBvdmVyZmxvdzpoaWRkZW47CiAgdHJhbnNpdGlvbjpib3JkZXItY29sb3IgLjE4czsKICBhbmltYXRpb246IGZhZGVVcCAuNXMgZWFzZSBib3RoOwp9Ci5oY2FyZDpudGgtY2hpbGQoMSl7YW5pbWF0aW9uLWRlbGF5Oi4wOHM7fQouaGNhcmQ6bnRoLWNoaWxkKDIpe2FuaW1hdGlvbi1kZWxheTouMTZzO30KLmhjYXJkOm50aC1jaGlsZCgzKXthbmltYXRpb24tZGVsYXk6LjI0czt9Ci5oY2FyZDpob3ZlciB7IGJvcmRlci1jb2xvcjp2YXIoLS1ib3JkZXJCKTsgfQoKLmhjYXJkIC5iYXIgeyBwb3NpdGlvbjphYnNvbHV0ZTsgdG9wOjA7bGVmdDowO3JpZ2h0OjA7IGhlaWdodDoycHg7IH0KLmhjYXJkLm1lcCAuYmFyIHsgYmFja2dyb3VuZDp2YXIoLS1tZXApOyB9Ci5oY2FyZC5jY2wgLmJhciB7IGJhY2tncm91bmQ6dmFyKC0tY2NsKTsgfQouaGNhcmQuZ2FwIC5iYXIgeyBiYWNrZ3JvdW5kOnZhcigtLXllbGxvdyk7IH0KCi5oY2FyZC1sYWJlbCB7CiAgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtc2l6ZToxMHB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjEyZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgY29sb3I6dmFyKC0tbXV0ZWQpOwogIG1hcmdpbi1ib3R0b206OXB4OyBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsgZ2FwOjVweDsKfQouaGNhcmQtbGFiZWwgLmRvdCB7IHdpZHRoOjVweDtoZWlnaHQ6NXB4O2JvcmRlci1yYWRpdXM6NTAlOyB9Ci5tZXAgLmRvdHtiYWNrZ3JvdW5kOnZhcigtLW1lcCk7fQouY2NsIC5kb3R7YmFja2dyb3VuZDp2YXIoLS1jY2wpO30KLmdhcCAuZG90e2JhY2tncm91bmQ6dmFyKC0teWVsbG93KTt9CgouaGNhcmQtdmFsIHsKICBmb250LXNpemU6MzRweDsgZm9udC13ZWlnaHQ6NzAwOyBsZXR0ZXItc3BhY2luZzotLjAyZW07IGxpbmUtaGVpZ2h0OjE7Cn0KLm1lcCAuaGNhcmQtdmFse2NvbG9yOnZhcigtLW1lcCk7fQouY2NsIC5oY2FyZC12YWx7Y29sb3I6dmFyKC0tY2NsKTt9CgouaGNhcmQtcGN0IHsgZm9udC1zaXplOjIwcHg7IGNvbG9yOnZhcigtLXllbGxvdyk7IGZvbnQtd2VpZ2h0OjcwMDsgbWFyZ2luLXRvcDozcHg7IH0KLmhjYXJkLXN1YiB7IGZvbnQtc2l6ZToxMHB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IG1hcmdpbi10b3A6N3B4OyB9CgovKiB0b29sdGlwICovCi50aXAgeyBwb3NpdGlvbjpyZWxhdGl2ZTsgY3Vyc29yOmhlbHA7IH0KLnRpcDo6YWZ0ZXIgewogIGNvbnRlbnQ6YXR0cihkYXRhLXQpOwogIHBvc2l0aW9uOmFic29sdXRlOyBib3R0b206Y2FsYygxMDAlICsgN3B4KTsgbGVmdDo1MCU7CiAgdHJhbnNmb3JtOnRyYW5zbGF0ZVgoLTUwJSk7CiAgYmFja2dyb3VuZDojMWEyMjMyOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlckIpOwogIGNvbG9yOnZhcigtLXRleHQpOyBmb250LXNpemU6MTBweDsgcGFkZGluZzo1cHggOXB4OwogIGJvcmRlci1yYWRpdXM6NnB4OyB3aGl0ZS1zcGFjZTpub3dyYXA7CiAgb3BhY2l0eTowOyBwb2ludGVyLWV2ZW50czpub25lOyB0cmFuc2l0aW9uOm9wYWNpdHkgLjE4czsgei1pbmRleDo5OTsKfQoudGlwOmhvdmVyOjphZnRlcntvcGFjaXR5OjE7fQoudGlwLnRpcC1kb3duOjphZnRlciB7CiAgZGlzcGxheTogbm9uZTsKfQoKLnNtYXJ0LXRpcCB7CiAgcG9zaXRpb246IGZpeGVkOwogIGxlZnQ6IDA7CiAgdG9wOiAwOwogIG1heC13aWR0aDogbWluKDI4MHB4LCBjYWxjKDEwMHZ3IC0gMTZweCkpOwogIGJhY2tncm91bmQ6ICMxYTIyMzI7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6IHZhcigtLXRleHQpOwogIGZvbnQtc2l6ZTogMTBweDsKICBsaW5lLWhlaWdodDogMS40NTsKICBwYWRkaW5nOiA2cHggOXB4OwogIGJvcmRlci1yYWRpdXM6IDZweDsKICB6LWluZGV4OiA0MDA7CiAgb3BhY2l0eTogMDsKICBwb2ludGVyLWV2ZW50czogbm9uZTsKICB0cmFuc2l0aW9uOiBvcGFjaXR5IC4xMnM7Cn0KLnNtYXJ0LXRpcC5zaG93IHsKICBvcGFjaXR5OiAxOwp9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgQ0hBUlQK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5jaGFydC1jYXJkIHsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBwYWRkaW5nOjIycHg7IG1hcmdpbi1ib3R0b206MjBweDsKICBhbmltYXRpb246ZmFkZVVwIC41cyAuMzJzIGVhc2UgYm90aDsKfQouY2hhcnQtdG9wIHsKICBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgbWFyZ2luLWJvdHRvbToxNnB4Owp9Ci5jaGFydC10dGwgeyBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6NzAwOyBmb250LXNpemU6MTNweDsgfQoKLnBpbGxzIHsgZGlzcGxheTpmbGV4OyBnYXA6NXB4OyB9Ci5waWxsIHsKICBmb250LXNpemU6MTBweDsgcGFkZGluZzozcHggMTFweDsgYm9yZGVyLXJhZGl1czoyMHB4OwogIGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyQik7IGNvbG9yOnZhcigtLW11dGVkMik7CiAgYmFja2dyb3VuZDp0cmFuc3BhcmVudDsgY3Vyc29yOnBvaW50ZXI7IGZvbnQtZmFtaWx5OnZhcigtLW1vbm8pOwogIHRyYW5zaXRpb246YWxsIC4xM3M7Cn0KLnBpbGwub24geyBiYWNrZ3JvdW5kOnZhcigtLW1lcCk7IGJvcmRlci1jb2xvcjp2YXIoLS1tZXApOyBjb2xvcjojMDAwOyBmb250LXdlaWdodDo3MDA7IH0KCi5sZWdlbmRzIHsgZGlzcGxheTpmbGV4OyBnYXA6MThweDsgbWFyZ2luLWJvdHRvbToxNHB4OyBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgfQoubGVnIHsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo1cHg7IH0KLmxlZy1saW5lIHsgd2lkdGg6MThweDsgaGVpZ2h0OjJweDsgYm9yZGVyLXJhZGl1czoycHg7IH0KCnN2Zy5jaGFydCB7IHdpZHRoOjEwMCU7IGhlaWdodDoxNzBweDsgb3ZlcmZsb3c6dmlzaWJsZTsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIE1FVFJJQ1MK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5tZXRyaWNzLWdyaWQgewogIGRpc3BsYXk6Z3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCg0LDFmcik7CiAgZ2FwOjEycHg7IG1hcmdpbi1ib3R0b206MjBweDsKfQoubWNhcmQgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czo5cHg7IHBhZGRpbmc6MTRweCAxNnB4OwogIGFuaW1hdGlvbjpmYWRlVXAgLjVzIGVhc2UgYm90aDsKfQoubWNhcmQ6bnRoLWNoaWxkKDEpe2FuaW1hdGlvbi1kZWxheTouMzhzO30KLm1jYXJkOm50aC1jaGlsZCgyKXthbmltYXRpb24tZGVsYXk6LjQzczt9Ci5tY2FyZDpudGgtY2hpbGQoMyl7YW5pbWF0aW9uLWRlbGF5Oi40OHM7fQoubWNhcmQ6bnRoLWNoaWxkKDQpe2FuaW1hdGlvbi1kZWxheTouNTNzO30KLm1jYXJkLWxhYmVsIHsKICBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC1zaXplOjlweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4xZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tYm90dG9tOjdweDsKfQoubWNhcmQtdmFsIHsgZm9udC1zaXplOjIwcHg7IGZvbnQtd2VpZ2h0OjcwMDsgfQoubWNhcmQtc3ViIHsgZm9udC1zaXplOjlweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tdG9wOjNweDsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIFRBQkxFCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwoudGFibGUtY2FyZCB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmKTsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6MTFweDsgb3ZlcmZsb3c6aGlkZGVuOwogIGFuaW1hdGlvbjpmYWRlVXAgLjVzIC41NnMgZWFzZSBib3RoOwp9Ci50YWJsZS10b3AgewogIHBhZGRpbmc6MTRweCAyMnB4OyBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKfQoudGFibGUtdHRsIHsgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtd2VpZ2h0OjcwMDsgZm9udC1zaXplOjEzcHg7IH0KLnRhYmxlLXJpZ2h0IHsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDoxMHB4OyB9Ci50YWJsZS1jYXAgeyBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyB9Ci5idG4tZG93bmxvYWQgewogIGRpc3BsYXk6aW5saW5lLWZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsgZ2FwOjZweDsKICBoZWlnaHQ6MjZweDsgcGFkZGluZzowIDEwcHg7IGJvcmRlci1yYWRpdXM6N3B4OwogIGJvcmRlcjoxcHggc29saWQgIzJmNGY2ODsgYmFja2dyb3VuZDpyZ2JhKDQxLDE4MiwyNDYsMC4wNik7CiAgY29sb3I6IzhmZDhmZjsgY3Vyc29yOnBvaW50ZXI7IGZvbnQtZmFtaWx5OnZhcigtLW1vbm8pOyBmb250LXNpemU6MTBweDsKICBsZXR0ZXItc3BhY2luZzouMDJlbTsKICB0cmFuc2l0aW9uOmJvcmRlci1jb2xvciAuMTVzIGVhc2UsIGJhY2tncm91bmQgLjE1cyBlYXNlLCBjb2xvciAuMTVzIGVhc2UsIGJveC1zaGFkb3cgLjE1cyBlYXNlOwp9Ci5idG4tZG93bmxvYWQgc3ZnIHsKICB3aWR0aDoxMnB4OyBoZWlnaHQ6MTJweDsgc3Ryb2tlOmN1cnJlbnRDb2xvcjsgZmlsbDpub25lOyBzdHJva2Utd2lkdGg6MS44Owp9Ci5idG4tZG93bmxvYWQ6aG92ZXIgewogIGJvcmRlci1jb2xvcjojNGZjM2Y3OyBiYWNrZ3JvdW5kOnJnYmEoNDEsMTgyLDI0NiwwLjE2KTsKICBjb2xvcjojYzZlY2ZmOyBib3gtc2hhZG93OjAgMCAwIDFweCByZ2JhKDc5LDE5NSwyNDcsLjE4KSBpbnNldDsKfQoKLmhpc3RvcnktdGFibGUtd3JhcCB7IG92ZXJmbG93LXg6YXV0bzsgfQouaGlzdG9yeS10YWJsZS13cmFwIHRhYmxlIHsKICBtaW4td2lkdGg6IDg2MHB4Owp9CnRhYmxlIHsgd2lkdGg6MTAwJTsgYm9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlOyB0YWJsZS1sYXlvdXQ6Zml4ZWQ7IH0KdGhlYWQgdGggewogIGZvbnQtc2l6ZTo5cHg7IGxldHRlci1zcGFjaW5nOi4xZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBjb2xvcjp2YXIoLS1tdXRlZCk7IHBhZGRpbmc6OXB4IDIycHg7IHRleHQtYWxpZ246bGVmdDsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYyKTsgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtd2VpZ2h0OjYwMDsKICBwb3NpdGlvbjpyZWxhdGl2ZTsKfQp0Ym9keSB0ciB7IGJvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7IHRyYW5zaXRpb246YmFja2dyb3VuZCAuMTJzOyB9CnRib2R5IHRyOmhvdmVyIHsgYmFja2dyb3VuZDpyZ2JhKDQxLDE4MiwyNDYsLjA0KTsgfQp0Ym9keSB0cjpsYXN0LWNoaWxkIHsgYm9yZGVyLWJvdHRvbTpub25lOyB9CnRib2R5IHRkIHsKICBwYWRkaW5nOjExcHggMjJweDsgZm9udC1zaXplOjEycHg7CiAgb3ZlcmZsb3c6aGlkZGVuOyB0ZXh0LW92ZXJmbG93OmVsbGlwc2lzOyB3aGl0ZS1zcGFjZTpub3dyYXA7Cn0KdGQuZGltIHsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgZm9udC1zaXplOjExcHg7IH0KdGQuZGltIC50cy1kYXkgeyBmb250LXNpemU6OXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IGxpbmUtaGVpZ2h0OjEuMTsgfQp0ZC5kaW0gLnRzLWhvdXIgeyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgbGluZS1oZWlnaHQ6MS4yOyBtYXJnaW4tdG9wOjJweDsgfQouY29sLWxhYmVsIHsgcGFkZGluZy1yaWdodDoxMHB4OyBkaXNwbGF5OmlubGluZS1ibG9jazsgfQouY29sLXJlc2l6ZXIgewogIHBvc2l0aW9uOmFic29sdXRlOwogIHRvcDowOwogIHJpZ2h0Oi00cHg7CiAgd2lkdGg6OHB4OwogIGhlaWdodDoxMDAlOwogIGN1cnNvcjpjb2wtcmVzaXplOwogIHVzZXItc2VsZWN0Om5vbmU7CiAgdG91Y2gtYWN0aW9uOm5vbmU7CiAgei1pbmRleDoyOwp9Ci5jb2wtcmVzaXplcjo6YWZ0ZXIgewogIGNvbnRlbnQ6Jyc7CiAgcG9zaXRpb246YWJzb2x1dGU7CiAgdG9wOjZweDsKICBib3R0b206NnB4OwogIGxlZnQ6M3B4OwogIHdpZHRoOjFweDsKICBiYWNrZ3JvdW5kOnJnYmEoMTIyLDE0MywxNjgsLjI4KTsKfQouY29sLXJlc2l6ZXI6aG92ZXI6OmFmdGVyLAouY29sLXJlc2l6ZXIuYWN0aXZlOjphZnRlciB7CiAgYmFja2dyb3VuZDpyZ2JhKDEyMiwxNDMsMTY4LC43NSk7Cn0KCi5zYmFkZ2UgewogIGRpc3BsYXk6aW5saW5lLWJsb2NrOyBmb250LXNpemU6OXB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHBhZGRpbmc6MnB4IDdweDsgYm9yZGVyLXJhZGl1czo0cHg7CiAgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOwp9Ci5zYmFkZ2Uuc2ltIHsgYmFja2dyb3VuZDp2YXIoLS1ncmVlbi1kKTsgY29sb3I6dmFyKC0tZ3JlZW4pOyBib3JkZXI6MXB4IHNvbGlkIHJnYmEoMCwyMzAsMTE4LC4yKTsgfQouc2JhZGdlLm5vc2ltIHsgYmFja2dyb3VuZDp2YXIoLS1yZWQtZCk7IGNvbG9yOnZhcigtLXJlZCk7IGJvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsNzEsODcsLjIpOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgRk9PVEVSIC8gR0xPU0FSSU8K4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5nbG9zYXJpbyB7CiAgbWFyZ2luLXRvcDoyMHB4OyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBvdmVyZmxvdzpoaWRkZW47CiAgYW5pbWF0aW9uOmZhZGVVcCAuNXMgLjZzIGVhc2UgYm90aDsKfQouZ2xvcy1idG4gewogIHdpZHRoOjEwMCU7IGJhY2tncm91bmQ6dmFyKC0tc3VyZik7IGJvcmRlcjpub25lOwogIGNvbG9yOnZhcigtLW11dGVkMik7IGZvbnQtZmFtaWx5OnZhcigtLW1vbm8pOyBmb250LXNpemU6MTFweDsKICBwYWRkaW5nOjEzcHggMjJweDsgdGV4dC1hbGlnbjpsZWZ0OyBjdXJzb3I6cG9pbnRlcjsKICBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgdHJhbnNpdGlvbjpjb2xvciAuMTVzOwp9Ci5nbG9zLWJ0bjpob3ZlciB7IGNvbG9yOnZhcigtLXRleHQpOyB9CgouZ2xvcy1ncmlkIHsKICBkaXNwbGF5Om5vbmU7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyOwogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOyBib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9Ci5nbG9zLWdyaWQub3BlbiB7IGRpc3BsYXk6Z3JpZDsgfQoKLmdpIHsKICBwYWRkaW5nOjE0cHggMjJweDsgYm9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmlnaHQ6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmdpOm50aC1jaGlsZChldmVuKXtib3JkZXItcmlnaHQ6bm9uZTt9Ci5naS10ZXJtIHsKICBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC1zaXplOjEwcHg7IGZvbnQtd2VpZ2h0OjcwMDsKICBsZXR0ZXItc3BhY2luZzouMDhlbTsgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOyBjb2xvcjp2YXIoLS1tdXRlZDIpOyBtYXJnaW4tYm90dG9tOjNweDsKfQouZ2ktZGVmIHsgZm9udC1zaXplOjExcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgbGluZS1oZWlnaHQ6MS41OyB9Cgpmb290ZXIgewogIHRleHQtYWxpZ246Y2VudGVyOyBwYWRkaW5nOjIycHg7IGZvbnQtc2l6ZToxMHB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7CiAgYm9yZGVyLXRvcDoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQpmb290ZXIgYSB7IGNvbG9yOnZhcigtLW11dGVkMik7IHRleHQtZGVjb3JhdGlvbjpub25lOyB9CmZvb3RlciBhOmhvdmVyIHsgY29sb3I6dmFyKC0tdGV4dCk7IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBBTklNQVRJT05TCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwpAa2V5ZnJhbWVzIGZhZGVJbiB7IGZyb217b3BhY2l0eTowO310b3tvcGFjaXR5OjE7fSB9CkBrZXlmcmFtZXMgZmFkZVVwIHsgZnJvbXtvcGFjaXR5OjA7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoMTBweCk7fXRve29wYWNpdHk6MTt0cmFuc2Zvcm06dHJhbnNsYXRlWSgwKTt9IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBSRVNQT05TSVZFCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwpAbWVkaWEobWF4LXdpZHRoOjkwMHB4KXsKICA6cm9vdHsgLS1kcmF3ZXItdzogMTAwdnc7IH0KICAuYm9keS13cmFwLmRyYXdlci1vcGVuIC5tYWluLWNvbnRlbnQgeyBtYXJnaW4tcmlnaHQ6MDsgfQogIC5kcmF3ZXIgeyB3aWR0aDoxMDB2dzsgfQogIC5kcmF3ZXItcmVzaXplciB7IGRpc3BsYXk6bm9uZTsgfQp9CkBtZWRpYShtYXgtd2lkdGg6NzAwcHgpewogIC5oZXJvLWdyaWR7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyOyB9CiAgLmhjYXJkLmdhcHsgZ3JpZC1jb2x1bW46c3BhbiAyOyB9CiAgLm1ldHJpY3MtZ3JpZHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7IH0KICAuaGNhcmQtdmFseyBmb250LXNpemU6MjZweDsgfQogIC5waWxsc3sgZmxleC13cmFwOndyYXA7IH0KICAudGFibGUtcmlnaHQgeyBnYXA6OHB4OyB9CiAgLmJ0bi1kb3dubG9hZCB7IHBhZGRpbmc6MCA4cHg7IH0KICB0aGVhZCB0aDpudGgtY2hpbGQoNCksIHRib2R5IHRkOm50aC1jaGlsZCg0KXsgZGlzcGxheTpub25lOyB9CiAgLnMtcmlnaHQgeyBkaXNwbGF5Om5vbmU7IH0KICB0ZC5kaW0gLnRzLWRheSB7IGZvbnQtc2l6ZTo4cHg7IH0KICB0ZC5kaW0gLnRzLWhvdXIgeyBmb250LXNpemU6MTBweDsgfQp9CkBtZWRpYShtYXgtd2lkdGg6NDgwcHgpewogIC5oZXJvLWdyaWR7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnI7IH0KICAuaGNhcmQuZ2FweyBncmlkLWNvbHVtbjpzcGFuIDE7IH0KICBoZWFkZXJ7IHBhZGRpbmc6MCAxNHB4OyB9CiAgLnRhZy1tZXJjYWRveyBkaXNwbGF5Om5vbmU7IH0KICAuYnRuLXRhc2FzIHNwYW4ubGFiZWwtbG9uZyB7IGRpc3BsYXk6bm9uZTsgfQp9CgovKiBEUkFXRVIgT1ZFUkxBWSAobW9iaWxlKSAqLwoub3ZlcmxheSB7CiAgZGlzcGxheTpub25lOwogIHBvc2l0aW9uOmZpeGVkOyBpbnNldDowOyB6LWluZGV4OjE0MDsKICBiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjU1KTsKICBiYWNrZHJvcC1maWx0ZXI6Ymx1cigycHgpOwp9CkBtZWRpYShtYXgtd2lkdGg6OTAwcHgpewogIC5vdmVybGF5LnNob3cgeyBkaXNwbGF5OmJsb2NrOyB9Cn0KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KPGRpdiBjbGFzcz0iYXBwIj4KCjwhLS0g4pSA4pSAIEhFQURFUiDilIDilIAgLS0+CjxoZWFkZXI+CiAgPGRpdiBjbGFzcz0ibG9nbyI+CiAgICA8c3BhbiBjbGFzcz0ibGl2ZS1kb3QiPjwvc3Bhbj4KICAgIFJBREFSIE1FUC9DQ0wKICA8L2Rpdj4KICA8ZGl2IGNsYXNzPSJoZWFkZXItcmlnaHQiPgogICAgPGRpdiBjbGFzcz0iZnJlc2gtYmFkZ2UiIGlkPSJmcmVzaC1iYWRnZSI+CiAgICAgIDxzcGFuIGNsYXNzPSJmcmVzaC1kb3QiPjwvc3Bhbj4KICAgICAgPHNwYW4gaWQ9ImZyZXNoLWJhZGdlLXRleHQiPkFjdHVhbGl6YW5kb+KApjwvc3Bhbj4KICAgIDwvZGl2PgogICAgPHNwYW4gY2xhc3M9InRhZy1tZXJjYWRvIGNsb3NlZCIgaWQ9InRhZy1tZXJjYWRvIj5NZXJjYWRvIGNlcnJhZG88L3NwYW4+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLXRhc2FzIiBpZD0iYnRuVGFzYXMiIG9uY2xpY2s9InRvZ2dsZURyYXdlcigpIj4KICAgICAg8J+TiiA8c3BhbiBjbGFzcz0ibGFiZWwtbG9uZyI+Rm9uZG9zIENvbXVuZXMgZGUgSW52ZXJzacOzbjwvc3Bhbj4KICAgIDwvYnV0dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1hbGVydCI+8J+UlCBBbGVydGFzPC9idXR0b24+CiAgPC9kaXY+CjwvaGVhZGVyPgoKPCEtLSDilIDilIAgT1ZFUkxBWSAobW9iaWxlKSDilIDilIAgLS0+CjxkaXYgY2xhc3M9Im92ZXJsYXkiIGlkPSJvdmVybGF5IiBvbmNsaWNrPSJ0b2dnbGVEcmF3ZXIoKSI+PC9kaXY+Cgo8IS0tIOKUgOKUgCBCT0RZIFdSQVAg4pSA4pSAIC0tPgo8ZGl2IGNsYXNzPSJib2R5LXdyYXAiIGlkPSJib2R5V3JhcCI+CgogIDwhLS0g4pWQ4pWQ4pWQ4pWQIE1BSU4g4pWQ4pWQ4pWQ4pWQIC0tPgogIDxkaXYgY2xhc3M9Im1haW4tY29udGVudCI+CgogICAgPCEtLSBTVEFUVVMgQkFOTkVSIC0tPgogICAgPGRpdiBjbGFzcz0ic3RhdHVzLWJhbm5lciBzaW1pbGFyIiBpZD0ic3RhdHVzLWJhbm5lciI+CiAgICAgIDxkaXYgY2xhc3M9InMtbGVmdCI+CiAgICAgICAgPGRpdiBjbGFzcz0icy10aXRsZSI+CiAgICAgICAgICA8c3BhbiBpZD0ic3RhdHVzLWxhYmVsIj5NRVAg4omIIENDTDwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJzLWJhZGdlIiBpZD0ic3RhdHVzLWJhZGdlIj5TaW1pbGFyPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InMtc3ViIj5MYSBicmVjaGEgZXN0w6EgZGVudHJvIGRlbCB1bWJyYWwg4oCUIGxvcyBwcmVjaW9zIHNvbiBjb21wYXJhYmxlczwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icy1yaWdodCI+CiAgICAgICAgPGRpdj7Dmmx0aW1hIGNvcnJpZGE6IDxzdHJvbmcgaWQ9Imxhc3QtcnVuLXRpbWUiPuKAlDwvc3Ryb25nPjwvZGl2PgogICAgICAgIDxkaXYgaWQ9ImNvdW50ZG93bi10ZXh0Ij5QcsOzeGltYSBhY3R1YWxpemFjacOzbiBlbiA1OjAwPC9kaXY+CiAgICAgICAgPGRpdj5Dcm9uIEdNVC0zIMK3IEx1buKAk1ZpZSAxMDozMOKAkzE4OjAwPC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJlcnJvci1iYW5uZXIiIGlkPSJlcnJvci1iYW5uZXIiPgogICAgICA8c3BhbiBpZD0iZXJyb3ItYmFubmVyLXRleHQiPkVycm9yIGFsIGFjdHVhbGl6YXIgwrcgUmVpbnRlbnRhcjwvc3Bhbj4KICAgICAgPGJ1dHRvbiBpZD0iZXJyb3ItcmV0cnktYnRuIiB0eXBlPSJidXR0b24iPlJlaW50ZW50YXI8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDwhLS0gSEVSTyBDQVJEUyAtLT4KICAgIDxkaXYgY2xhc3M9Imhlcm8tZ3JpZCI+CiAgICAgIDxkaXYgY2xhc3M9ImhjYXJkIG1lcCI+CiAgICAgICAgPGRpdiBjbGFzcz0iYmFyIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1sYWJlbCI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0iZG90Ij48L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGlwIiBkYXRhLXQ9IkTDs2xhciBCb2xzYSDigJQgY29tcHJhL3ZlbnRhIGRlIGJvbm9zIGVuICRBUlMgeSBVU0QiPk1FUCB2ZW50YSDik5g8L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtdmFsIiBpZD0ibWVwLXZhbCI+JDEuMjY0PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtc3ViIj5kb2xhcml0by5hciDCtyB2ZW50YTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGNhcmQgY2NsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJiYXIiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLWxhYmVsIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJkb3QiPjwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0aXAiIGRhdGEtdD0iQ29udGFkbyBjb24gTGlxdWlkYWNpw7NuIOKAlCBzaW1pbGFyIGFsIE1FUCBjb24gZ2lybyBhbCBleHRlcmlvciI+Q0NMIHZlbnRhIOKTmDwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC12YWwiIGlkPSJjY2wtdmFsIj4kMS4yNzE8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1zdWIiPmRvbGFyaXRvLmFyIMK3IHZlbnRhPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoY2FyZCBnYXAiPgogICAgICAgIDxkaXYgY2xhc3M9ImJhciI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtbGFiZWwiPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImRvdCI+PC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRpcCIgZGF0YS10PSJCcmVjaGEgcmVsYXRpdmEgY29udHJhIGVsIHByb21lZGlvIGVudHJlIE1FUCB5IENDTCI+QnJlY2hhIOKTmDwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC12YWwiIGlkPSJicmVjaGEtYWJzIj4kNzwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXBjdCIgaWQ9ImJyZWNoYS1wY3QiPjAuNTUlPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtc3ViIj5kaWZlcmVuY2lhIGFic29sdXRhIMK3IHBvcmNlbnR1YWw8L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8IS0tIENIQVJUIC0tPgogICAgPGRpdiBjbGFzcz0iY2hhcnQtY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXRvcCI+CiAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtdHRsIiBpZD0idHJlbmQtdGl0bGUiPlRlbmRlbmNpYSBNRVAvQ0NMIOKAlCAxIGTDrWE8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJwaWxscyI+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJwaWxsIG9uIiBkYXRhLWZpbHRlcj0iMWQiPjEgRMOtYTwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0icGlsbCIgZGF0YS1maWx0ZXI9IjF3Ij4xIFNlbWFuYTwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0icGlsbCIgZGF0YS1maWx0ZXI9IjFtIj4xIE1lczwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibGVnZW5kcyI+CiAgICAgICAgPGRpdiBjbGFzcz0ibGVnIj48ZGl2IGNsYXNzPSJsZWctbGluZSIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tbWVwKSI+PC9kaXY+TUVQPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibGVnIj48ZGl2IGNsYXNzPSJsZWctbGluZSIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tY2NsKSI+PC9kaXY+Q0NMPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8c3ZnIGNsYXNzPSJjaGFydCIgaWQ9InRyZW5kLWNoYXJ0IiB2aWV3Qm94PSIwIDAgODYwIDE2MCIgcHJlc2VydmVBc3BlY3RSYXRpbz0ibm9uZSI+CiAgICAgICAgPGxpbmUgeDE9IjAiIHkxPSI0MCIgeDI9Ijg2MCIgeTI9IjQwIiBzdHJva2U9IiMxZTI1MzAiIHN0cm9rZS13aWR0aD0iMSIvPgogICAgICAgIDxsaW5lIHgxPSIwIiB5MT0iODAiIHgyPSI4NjAiIHkyPSI4MCIgc3Ryb2tlPSIjMWUyNTMwIiBzdHJva2Utd2lkdGg9IjEiLz4KICAgICAgICA8bGluZSB4MT0iMCIgeTE9IjEyMCIgeDI9Ijg2MCIgeTI9IjEyMCIgc3Ryb2tlPSIjMWUyNTMwIiBzdHJva2Utd2lkdGg9IjEiLz4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteS10b3AiIHg9IjIiIHk9IjM3IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXktbWlkIiB4PSIyIiB5PSI3NyIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI4IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC15LWxvdyIgeD0iMiIgeT0iMTE3IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHBvbHlsaW5lIGlkPSJ0cmVuZC1tZXAtbGluZSIgcG9pbnRzPSIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzI5YjZmNiIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgICAgICAgPHBvbHlsaW5lIGlkPSJ0cmVuZC1jY2wtbGluZSIgcG9pbnRzPSIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2IzOWRkYiIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgICAgICAgPGxpbmUgaWQ9InRyZW5kLWhvdmVyLWxpbmUiIHgxPSIwIiB5MT0iMTgiIHgyPSIwIiB5Mj0iMTMyIiBzdHJva2U9IiMyYTM0NDQiIHN0cm9rZS13aWR0aD0iMSIgb3BhY2l0eT0iMCIvPgogICAgICAgIDxjaXJjbGUgaWQ9InRyZW5kLWhvdmVyLW1lcCIgY3g9IjAiIGN5PSIwIiByPSIzLjUiIGZpbGw9IiMyOWI2ZjYiIG9wYWNpdHk9IjAiLz4KICAgICAgICA8Y2lyY2xlIGlkPSJ0cmVuZC1ob3Zlci1jY2wiIGN4PSIwIiBjeT0iMCIgcj0iMy41IiBmaWxsPSIjYjM5ZGRiIiBvcGFjaXR5PSIwIi8+CiAgICAgICAgPGcgaWQ9InRyZW5kLXRvb2x0aXAiIG9wYWNpdHk9IjAiPgogICAgICAgICAgPHJlY3QgaWQ9InRyZW5kLXRvb2x0aXAtYmciIHg9IjAiIHk9IjAiIHdpZHRoPSIxNDgiIGhlaWdodD0iNTYiIHJ4PSI2IiBmaWxsPSIjMTYxYjIyIiBzdHJva2U9IiMyYTM0NDQiLz4KICAgICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC10aXAtdGltZSIgeD0iMTAiIHk9IjE0IiBmaWxsPSIjNTU2MDcwIiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgICA8dGV4dCBpZD0idHJlbmQtdGlwLW1lcCIgeD0iMTAiIHk9IjI4IiBmaWxsPSIjMjliNmY2IiBmb250LXNpemU9IjkiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj5NRVAg4oCUPC90ZXh0PgogICAgICAgICAgPHRleHQgaWQ9InRyZW5kLXRpcC1jY2wiIHg9IjEwIiB5PSI0MCIgZmlsbD0iI2IzOWRkYiIgZm9udC1zaXplPSI5IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+Q0NMIOKAlDwvdGV4dD4KICAgICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC10aXAtZ2FwIiB4PSIxMCIgeT0iNTIiIGZpbGw9IiNmZmNjMDAiIGZvbnQtc2l6ZT0iOCIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPkJyZWNoYSDigJQ8L3RleHQ+CiAgICAgICAgPC9nPgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTEiIHg9IjI4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC0yIiB4PSIyMTgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTMiIHg9IjQxOCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtNCIgeD0iNjA4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC01IiB4PSI3OTgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICA8L3N2Zz4KICAgIDwvZGl2PgoKICAgIDwhLS0gTUVUUklDUyAtLT4KICAgIDxkaXYgY2xhc3M9Im1ldHJpY3MtZ3JpZCI+CiAgICAgIDxkaXYgY2xhc3M9Im1jYXJkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1sYWJlbCIgaWQ9Im1ldHJpYy1jb3VudC1sYWJlbCI+TXVlc3RyYXMgMSBkw61hPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtdmFsIiBpZD0ibWV0cmljLWNvdW50LTI0aCI+4oCUPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtc3ViIiBpZD0ibWV0cmljLWNvdW50LXN1YiI+cmVnaXN0cm9zIGRlbCBwZXLDrW9kbyBmaWx0cmFkbzwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLWxhYmVsIiBpZD0ibWV0cmljLXNpbWlsYXItbGFiZWwiPlZlY2VzIHNpbWlsYXI8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC12YWwiIHN0eWxlPSJjb2xvcjp2YXIoLS1ncmVlbikiIGlkPSJtZXRyaWMtc2ltaWxhci0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiIgaWQ9Im1ldHJpYy1zaW1pbGFyLXN1YiI+bW9tZW50b3MgZW4gem9uYSDiiaQxJSBvIOKJpCQxMDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLWxhYmVsIiBpZD0ibWV0cmljLW1pbi1sYWJlbCI+QnJlY2hhIG3DrW4uPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtdmFsIiBpZD0ibWV0cmljLW1pbi0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiIgaWQ9Im1ldHJpYy1taW4tc3ViIj5tw61uaW1hIGRlbCBwZXLDrW9kbyBmaWx0cmFkbzwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLWxhYmVsIiBpZD0ibWV0cmljLW1heC1sYWJlbCI+QnJlY2hhIG3DoXguPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtdmFsIiBzdHlsZT0iY29sb3I6dmFyKC0teWVsbG93KSIgaWQ9Im1ldHJpYy1tYXgtMjRoIj7igJQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1zdWIiIGlkPSJtZXRyaWMtbWF4LXN1YiI+bcOheGltYSBkZWwgcGVyw61vZG8gZmlsdHJhZG88L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8IS0tIFRBQkxFIC0tPgogICAgPGRpdiBjbGFzcz0idGFibGUtY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXRvcCI+CiAgICAgICAgPGRpdiBjbGFzcz0idGFibGUtdHRsIj5IaXN0b3JpYWwgZGUgcmVnaXN0cm9zPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0idGFibGUtcmlnaHQiPgogICAgICAgICAgPGRpdiBjbGFzcz0idGFibGUtY2FwIiBpZD0iaGlzdG9yeS1jYXAiPsOabHRpbWFzIOKAlCBtdWVzdHJhczwvZGl2PgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuLWRvd25sb2FkIiBpZD0iYnRuLWRvd25sb2FkLWNzdiIgdHlwZT0iYnV0dG9uIiBhcmlhLWxhYmVsPSJEZXNjYXJnYXIgQ1NWIj4KICAgICAgICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGFyaWEtaGlkZGVuPSJ0cnVlIj4KICAgICAgICAgICAgICA8cGF0aCBkPSJNMTIgNHYxMCI+PC9wYXRoPgogICAgICAgICAgICAgIDxwYXRoIGQ9Ik04IDEwbDQgNCA0LTQiPjwvcGF0aD4KICAgICAgICAgICAgICA8cGF0aCBkPSJNNSAxOWgxNCI+PC9wYXRoPgogICAgICAgICAgICA8L3N2Zz4KICAgICAgICAgICAgRGVzY2FyZ2FyIENTVgogICAgICAgICAgPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoaXN0b3J5LXRhYmxlLXdyYXAiPgogICAgICA8dGFibGUgaWQ9Imhpc3RvcnktdGFibGUiPgogICAgICAgIDxjb2xncm91cCBpZD0iaGlzdG9yeS1jb2xncm91cCI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSIwIj4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjEiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iMiI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSIzIj4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjQiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iNSI+CiAgICAgICAgPC9jb2xncm91cD4KICAgICAgICA8dGhlYWQ+CiAgICAgICAgICA8dHI+CiAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iY29sLWxhYmVsIj5Ew61hIC8gSG9yYTwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSIwIiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgRMOtYSAvIEhvcmEiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+TUVQPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjEiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBNRVAiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+Q0NMPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjIiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBDQ0wiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+RGlmICQ8L3NwYW4+PHNwYW4gY2xhc3M9ImNvbC1yZXNpemVyIiBkYXRhLWNvbC1pbmRleD0iMyIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIERpZiAkIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPkRpZiAlPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjQiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBEaWYgJSI+PC9zcGFuPjwvdGg+CiAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iY29sLWxhYmVsIj5Fc3RhZG88L3NwYW4+PHNwYW4gY2xhc3M9ImNvbC1yZXNpemVyIiBkYXRhLWNvbC1pbmRleD0iNSIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIEVzdGFkbyI+PC9zcGFuPjwvdGg+CiAgICAgICAgICA8L3RyPgogICAgICAgIDwvdGhlYWQ+CiAgICAgICAgPHRib2R5IGlkPSJoaXN0b3J5LXJvd3MiPjwvdGJvZHk+CiAgICAgIDwvdGFibGU+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPCEtLSBHTE9TQVJJTyAtLT4KICAgIDxkaXYgY2xhc3M9Imdsb3NhcmlvIj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iZ2xvcy1idG4iIG9uY2xpY2s9InRvZ2dsZUdsb3ModGhpcykiPgogICAgICAgIDxzcGFuPvCfk5YgR2xvc2FyaW8gZGUgdMOpcm1pbm9zPC9zcGFuPgogICAgICAgIDxzcGFuIGlkPSJnbG9zQXJyb3ciPuKWvjwvc3Bhbj4KICAgICAgPC9idXR0b24+CiAgICAgIDxkaXYgY2xhc3M9Imdsb3MtZ3JpZCIgaWQ9Imdsb3NHcmlkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+TUVQIHZlbnRhPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5QcmVjaW8gZGUgdmVudGEgZGVsIGTDs2xhciBNRVAgKE1lcmNhZG8gRWxlY3Ryw7NuaWNvIGRlIFBhZ29zKSB2w61hIGNvbXByYS92ZW50YSBkZSBib25vcyBlbiAkQVJTIHkgVVNELjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5DQ0wgdmVudGE8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPkNvbnRhZG8gY29uIExpcXVpZGFjacOzbiDigJQgc2ltaWxhciBhbCBNRVAgcGVybyBwZXJtaXRlIHRyYW5zZmVyaXIgZm9uZG9zIGFsIGV4dGVyaW9yLiBTdWVsZSBjb3RpemFyIGxldmVtZW50ZSBwb3IgZW5jaW1hLjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5EaWZlcmVuY2lhICU8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPkJyZWNoYSByZWxhdGl2YSBjYWxjdWxhZGEgY29udHJhIGVsIHByb21lZGlvIGVudHJlIE1FUCB5IENDTC4gVW1icmFsIFNJTUlMQVI6IOKJpCAxJSBvIOKJpCAkMTAgQVJTLjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5GcmVzY3VyYSBkZWwgZGF0bzwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+VGllbXBvIGRlc2RlIGVsIMO6bHRpbW8gdGltZXN0YW1wIGRlIGRvbGFyaXRvLmFyLiBFbCBjcm9uIGNvcnJlIGNhZGEgNSBtaW4gZW4gZMOtYXMgaMOhYmlsZXMuPC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPkVzdGFkbyBTSU1JTEFSPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5DdWFuZG8gTUVQIHkgQ0NMIGVzdMOhbiBkZW50cm8gZGVsIHVtYnJhbCDigJQgbW9tZW50byBpZGVhbCBwYXJhIG9wZXJhciBidXNjYW5kbyBwYXJpZGFkIGVudHJlIGFtYm9zIHRpcG9zLjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5NZXJjYWRvIEFSRzwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+VmVudGFuYSBvcGVyYXRpdmE6IGx1bmVzIGEgdmllcm5lcyBkZSAxMDozMCBhIDE3OjU5IChHTVQtMywgQnVlbm9zIEFpcmVzKS48L2Rpdj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8Zm9vdGVyPgogICAgICBGdWVudGU6IDxhIGhyZWY9IiMiPmRvbGFyaXRvLmFyPC9hPiDCtyA8YSBocmVmPSIjIj5hcmdlbnRpbmFkYXRvcy5jb208L2E+IMK3IERhdG9zIGNhZGEgNSBtaW4gZW4gZMOtYXMgaMOhYmlsZXMgwrcgPGEgaHJlZj0iIyI+UmVwb3J0YXIgcHJvYmxlbWE8L2E+CiAgICA8L2Zvb3Rlcj4KCiAgPC9kaXY+PCEtLSAvbWFpbi1jb250ZW50IC0tPgoKICA8IS0tIOKVkOKVkOKVkOKVkCBEUkFXRVIg4pWQ4pWQ4pWQ4pWQIC0tPgogIDxkaXYgY2xhc3M9ImRyYXdlciIgaWQ9ImRyYXdlciI+CiAgICA8ZGl2IGNsYXNzPSJkcmF3ZXItcmVzaXplciIgaWQ9ImRyYXdlci1yZXNpemVyIiBhcmlhLWhpZGRlbj0idHJ1ZSI+PC9kaXY+CgogICAgPGRpdiBjbGFzcz0iZHJhd2VyLWhlYWRlciI+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZHJhd2VyLXRpdGxlIj7wn5OKIEZvbmRvcyBDb211bmVzIGRlIEludmVyc2nDs248L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkcmF3ZXItc291cmNlIj5GdWVudGVzOiBhcmdlbnRpbmFkYXRvcy5jb208L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0bi1jbG9zZSIgb25jbGljaz0idG9nZ2xlRHJhd2VyKCkiPuKclTwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iZHJhd2VyLWJvZHkiPgogICAgICA8ZGl2IGNsYXNzPSJmY2ktaGVhZGVyIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmY2ktdGl0bGUtd3JhcCI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJmY2ktdGl0bGUiIGlkPSJmY2ktdGl0bGUiPlJlbnRhIGZpamEgKEZDSSBBcmdlbnRpbmEpPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJmY2ktdGFicyI+CiAgICAgICAgICAgIDxidXR0b24gaWQ9ImZjaS10YWItZmlqYSIgY2xhc3M9ImZjaS10YWItYnRuIGFjdGl2ZSIgdHlwZT0iYnV0dG9uIj5SZW50YSBmaWphPC9idXR0b24+CiAgICAgICAgICAgIDxidXR0b24gaWQ9ImZjaS10YWItdmFyaWFibGUiIGNsYXNzPSJmY2ktdGFiLWJ0biIgdHlwZT0iYnV0dG9uIj5SZW50YSB2YXJpYWJsZTwvYnV0dG9uPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmNpLW1ldGEiIGlkPSJmY2ktbGFzdC1kYXRlIj5GZWNoYTog4oCUPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmY2ktY29udHJvbHMiPgogICAgICAgIDxpbnB1dCBpZD0iZmNpLXNlYXJjaCIgY2xhc3M9ImZjaS1zZWFyY2giIHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSJCdXNjYXIgZm9uZG8uLi4iIC8+CiAgICAgICAgPGRpdiBjbGFzcz0iZmNpLXBhZ2luYXRpb24iPgogICAgICAgICAgPGJ1dHRvbiBpZD0iZmNpLXByZXYiIGNsYXNzPSJmY2ktcGFnZS1idG4iIHR5cGU9ImJ1dHRvbiI+4peAPC9idXR0b24+CiAgICAgICAgICA8ZGl2IGlkPSJmY2ktcGFnZS1pbmZvIiBjbGFzcz0iZmNpLXBhZ2UtaW5mbyI+MSAvIDE8L2Rpdj4KICAgICAgICAgIDxidXR0b24gaWQ9ImZjaS1uZXh0IiBjbGFzcz0iZmNpLXBhZ2UtYnRuIiB0eXBlPSJidXR0b24iPuKWtjwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmNpLXRhYmxlLXdyYXAiPgogICAgICAgIDx0YWJsZSBjbGFzcz0iZmNpLXRhYmxlIj4KICAgICAgICAgIDxjb2xncm91cCBpZD0iZmNpLWNvbGdyb3VwIj4KICAgICAgICAgICAgPGNvbCBzdHlsZT0id2lkdGg6MjgwcHgiPgogICAgICAgICAgICA8Y29sIHN0eWxlPSJ3aWR0aDoxNTBweCI+CiAgICAgICAgICAgIDxjb2wgc3R5bGU9IndpZHRoOjE5MHB4Ij4KICAgICAgICAgICAgPGNvbCBzdHlsZT0id2lkdGg6MTkwcHgiPgogICAgICAgICAgICA8Y29sIHN0eWxlPSJ3aWR0aDoxMjBweCI+CiAgICAgICAgICA8L2NvbGdyb3VwPgogICAgICAgICAgPHRoZWFkPgogICAgICAgICAgICA8dHI+CiAgICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJmY2ktY29sLWxhYmVsIj48c3BhbiBjbGFzcz0idGlwIHRpcC1kb3duIiBkYXRhLXQ9Ik5vbWJyZSBkZWwgRm9uZG8gQ29tw7puIGRlIEludmVyc2nDs24uIj5Gb25kbyDik5g8L3NwYW4+PC9zcGFuPjxzcGFuIGNsYXNzPSJmY2ktY29sLXJlc2l6ZXIiIGRhdGEtZmNpLWNvbC1pbmRleD0iMCIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIEZvbmRvIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImZjaS1jb2wtbGFiZWwiPjxzcGFuIGNsYXNzPSJ0aXAgdGlwLWRvd24iIGRhdGEtdD0iVkNQIOKAlCBWYWxvciBDdW90YXBhcnRlLiBQcmVjaW8gdW5pdGFyaW8gZGUgY2FkYSBjdW90YXBhcnRlLiBVc2FsbyBwYXJhIGNvbXBhcmFyIHJlbmRpbWllbnRvIGVudHJlIGZlY2hhcy4iPlZDUCDik5g8L3NwYW4+PC9zcGFuPjxzcGFuIGNsYXNzPSJmY2ktY29sLXJlc2l6ZXIiIGRhdGEtZmNpLWNvbC1pbmRleD0iMSIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIFZDUCI+PC9zcGFuPjwvdGg+CiAgICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJmY2ktY29sLWxhYmVsIj48c3BhbiBjbGFzcz0idGlwIHRpcC1kb3duIiBkYXRhLXQ9IkNDUCDigJQgQ2FudGlkYWQgZGUgQ3VvdGFwYXJ0ZXMuIFRvdGFsIGRlIGN1b3RhcGFydGVzIGVtaXRpZGFzLiBTdWJlIGN1YW5kbyBlbnRyYW4gaW52ZXJzb3JlcywgYmFqYSBjdWFuZG8gcmVzY2F0YW4uIj5DQ1Ag4pOYPC9zcGFuPjwvc3Bhbj48c3BhbiBjbGFzcz0iZmNpLWNvbC1yZXNpemVyIiBkYXRhLWZjaS1jb2wtaW5kZXg9IjIiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBDQ1AiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iZmNpLWNvbC1sYWJlbCI+PHNwYW4gY2xhc3M9InRpcCB0aXAtZG93biIgZGF0YS10PSJQYXRyaW1vbmlvIOKAlCBWQ1Agw5cgQ0NQLiBWYWxvciB0b3RhbCBhZG1pbmlzdHJhZG8gcG9yIGVsIGZvbmRvIGVuIHBlc29zIGEgZXNhIGZlY2hhLiI+UGF0cmltb25pbyDik5g8L3NwYW4+PC9zcGFuPjxzcGFuIGNsYXNzPSJmY2ktY29sLXJlc2l6ZXIiIGRhdGEtZmNpLWNvbC1pbmRleD0iMyIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIFBhdHJpbW9uaW8iPjwvc3Bhbj48L3RoPgogICAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iZmNpLWNvbC1sYWJlbCI+PHNwYW4gY2xhc3M9InRpcCB0aXAtZG93biIgZGF0YS10PSJIb3Jpem9udGUgZGUgaW52ZXJzacOzbiBzdWdlcmlkbyAoY29ydG8sIG1lZGlvIG8gbGFyZ28pLiI+SG9yaXpvbnRlIOKTmDwvc3Bhbj48L3NwYW4+PHNwYW4gY2xhc3M9ImZjaS1jb2wtcmVzaXplciIgZGF0YS1mY2ktY29sLWluZGV4PSI0IiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgSG9yaXpvbnRlIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPC90cj4KICAgICAgICAgIDwvdGhlYWQ+CiAgICAgICAgICA8dGJvZHkgaWQ9ImZjaS1yb3dzIj4KICAgICAgICAgICAgPHRyPjx0ZCBjb2xzcGFuPSI1IiBjbGFzcz0iZGltIj5DYXJnYW5kb+KApjwvdGQ+PC90cj4KICAgICAgICAgIDwvdGJvZHk+CiAgICAgICAgPC90YWJsZT4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZjaS1lbXB0eSIgaWQ9ImZjaS1lbXB0eSIgc3R5bGU9ImRpc3BsYXk6bm9uZSI+CiAgICAgICAgTm8gaGF5IGRhdG9zIGRlIEZDSSBkaXNwb25pYmxlcyBlbiBlc3RlIG1vbWVudG8uCiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjb250ZXh0LWJveCI+CiAgICAgICAgPHN0cm9uZz5UaXA6PC9zdHJvbmc+PGJyPgogICAgICAgIFNlIGxpc3RhbiBsb3MgZm9uZG9zIGRlIGxhIHNlcmllIHNlbGVjY2lvbmFkYSBvcmRlbmFkb3MgcG9yIHBhdHJpbW9uaW8gKGRlIG1heW9yIGEgbWVub3IpLjxicj4KICAgICAgICDilrIgc3ViZSDCtyDilrwgYmFqYSDCtyA9IHNpbiBjYW1iaW9zICh2cyBkw61hIGFudGVyaW9yKS4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj48IS0tIC9kcmF3ZXItYm9keSAtLT4KICA8L2Rpdj48IS0tIC9kcmF3ZXIgLS0+Cgo8L2Rpdj48IS0tIC9ib2R5LXdyYXAgLS0+CjwvZGl2PjwhLS0gL2FwcCAtLT4KPGRpdiBjbGFzcz0ic21hcnQtdGlwIiBpZD0ic21hcnQtdGlwIiByb2xlPSJ0b29sdGlwIiBhcmlhLWhpZGRlbj0idHJ1ZSI+PC9kaXY+Cgo8c2NyaXB0PgogIC8vIDEpIENvbnN0YW50ZXMgeSBjb25maWd1cmFjacOzbgogIGNvbnN0IEVORFBPSU5UUyA9IHsKICAgIG1lcENjbDogJy9hcGkvZGF0YScsCiAgICBmY2lSZW50YUZpamE6ICcvYXBpL2ZjaS9yZW50YS1maWphL3VsdGltbycsCiAgICBmY2lSZW50YUZpamFQZW51bHRpbW86ICcvYXBpL2ZjaS9yZW50YS1maWphL3BlbnVsdGltbycsCiAgICBmY2lSZW50YVZhcmlhYmxlOiAnL2FwaS9mY2kvcmVudGEtdmFyaWFibGUvdWx0aW1vJywKICAgIGZjaVJlbnRhVmFyaWFibGVQZW51bHRpbW86ICcvYXBpL2ZjaS9yZW50YS12YXJpYWJsZS9wZW51bHRpbW8nCiAgfTsKICBjb25zdCBBUkdfVFogPSAnQW1lcmljYS9BcmdlbnRpbmEvQnVlbm9zX0FpcmVzJzsKICBjb25zdCBGRVRDSF9JTlRFUlZBTF9NUyA9IDMwMDAwMDsKICBjb25zdCBDQUNIRV9LRVkgPSAncmFkYXJfY2FjaGUnOwogIGNvbnN0IEhJU1RPUllfQ09MU19LRVkgPSAncmFkYXJfaGlzdG9yeV9jb2xfd2lkdGhzX3YxJzsKICBjb25zdCBGQ0lfQ09MU19LRVkgPSAncmFkYXJfZmNpX2NvbF93aWR0aHNfdjEnOwogIGNvbnN0IERSQVdFUl9XSURUSF9LRVkgPSAncmFkYXJfZHJhd2VyX3dpZHRoX3YxJzsKICBjb25zdCBDQUNIRV9UVExfTVMgPSAxNSAqIDYwICogMTAwMDsKICBjb25zdCBSRVRSWV9ERUxBWVMgPSBbMTAwMDAsIDMwMDAwLCA2MDAwMF07CiAgY29uc3QgU0lNSUxBUl9QQ1RfVEhSRVNIT0xEID0gMTsKICBjb25zdCBTSU1JTEFSX0FSU19USFJFU0hPTEQgPSAxMDsKICBjb25zdCBUUkVORF9NQVhfUE9JTlRTID0gMjQwOwogIGNvbnN0IEZDSV9QQUdFX1NJWkUgPSAxMDsKICBjb25zdCBEUkFXRVJfTUlOX1cgPSAzNDA7CiAgY29uc3QgRFJBV0VSX01BWF9XID0gNzYwOwogIGNvbnN0IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTID0gWzE3MCwgMTYwLCAxNjAsIDEyMCwgMTIwLCAxNzBdOwogIGNvbnN0IEhJU1RPUllfTUlOX0NPTF9XSURUSFMgPSBbMTIwLCAxMTAsIDExMCwgOTAsIDkwLCAxMjBdOwogIGNvbnN0IEZDSV9ERUZBVUxUX0NPTF9XSURUSFMgPSBbMjgwLCAxNTAsIDE5MCwgMTkwLCAxMjBdOwogIGNvbnN0IEZDSV9NSU5fQ09MX1dJRFRIUyA9IFsyMjAsIDEyMCwgMTUwLCAxNTAsIDEwMF07CiAgY29uc3QgTlVNRVJJQ19JRFMgPSBbCiAgICAnbWVwLXZhbCcsICdjY2wtdmFsJywgJ2JyZWNoYS1hYnMnLCAnYnJlY2hhLXBjdCcKICBdOwogIGNvbnN0IHN0YXRlID0gewogICAgcmV0cnlJbmRleDogMCwKICAgIHJldHJ5VGltZXI6IG51bGwsCiAgICBsYXN0U3VjY2Vzc0F0OiAwLAogICAgaXNGZXRjaGluZzogZmFsc2UsCiAgICBmaWx0ZXJNb2RlOiAnMWQnLAogICAgbGFzdE1lcFBheWxvYWQ6IG51bGwsCiAgICB0cmVuZFJvd3M6IFtdLAogICAgdHJlbmRIb3ZlckJvdW5kOiBmYWxzZSwKICAgIGhpc3RvcnlSZXNpemVCb3VuZDogZmFsc2UsCiAgICBmY2lSZXNpemVCb3VuZDogZmFsc2UsCiAgICBoaXN0b3J5Q29sV2lkdGhzOiBbXSwKICAgIGZjaUNvbFdpZHRoczogW10sCiAgICBzb3VyY2VUc01zOiBudWxsLAogICAgZnJlc2hCYWRnZU1vZGU6ICdpZGxlJywKICAgIGZyZXNoVGlja2VyOiBudWxsLAogICAgZmNpVHlwZTogJ2ZpamEnLAogICAgZmNpUm93c0J5VHlwZTogeyBmaWphOiBbXSwgdmFyaWFibGU6IFtdIH0sCiAgICBmY2lQcmV2aW91c0J5Rm9uZG9CeVR5cGU6IHsgZmlqYTogbmV3IE1hcCgpLCB2YXJpYWJsZTogbmV3IE1hcCgpIH0sCiAgICBmY2lEYXRlQnlUeXBlOiB7IGZpamE6ICfigJQnLCB2YXJpYWJsZTogJ+KAlCcgfSwKICAgIGZjaVF1ZXJ5OiAnJywKICAgIGZjaVBhZ2U6IDEsCiAgICBzbWFydFRpcEJvdW5kOiBmYWxzZSwKICAgIGRyYXdlclJlc2l6ZUJvdW5kOiBmYWxzZSwKICAgIGxhdGVzdDogewogICAgICBtZXA6IG51bGwsCiAgICAgIGNjbDogbnVsbCwKICAgICAgYnJlY2hhQWJzOiBudWxsLAogICAgICBicmVjaGFQY3Q6IG51bGwKICAgIH0KICB9OwoKICAvLyAyKSBIZWxwZXJzCiAgY29uc3QgZm10QXJnVGltZSA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlcy1BUicsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICBob3VyOiAnMi1kaWdpdCcsCiAgICBtaW51dGU6ICcyLWRpZ2l0JwogIH0pOwogIGNvbnN0IGZtdEFyZ1RpbWVTZWMgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZXMtQVInLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgaG91cjogJzItZGlnaXQnLAogICAgbWludXRlOiAnMi1kaWdpdCcsCiAgICBzZWNvbmQ6ICcyLWRpZ2l0JwogIH0pOwogIGNvbnN0IGZtdEFyZ0hvdXIgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZXMtQVInLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgaG91cjogJzItZGlnaXQnLAogICAgbWludXRlOiAnMi1kaWdpdCcsCiAgICBob3VyMTI6IGZhbHNlCiAgfSk7CiAgY29uc3QgZm10QXJnRGF5TW9udGggPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZXMtQVInLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgZGF5OiAnMi1kaWdpdCcsCiAgICBtb250aDogJzItZGlnaXQnCiAgfSk7CiAgY29uc3QgZm10QXJnRGF0ZSA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1DQScsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICB5ZWFyOiAnbnVtZXJpYycsCiAgICBtb250aDogJzItZGlnaXQnLAogICAgZGF5OiAnMi1kaWdpdCcKICB9KTsKICBjb25zdCBmbXRBcmdXZWVrZGF5ID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VuLVVTJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIHdlZWtkYXk6ICdzaG9ydCcKICB9KTsKICBjb25zdCBmbXRBcmdQYXJ0cyA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1VUycsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICB3ZWVrZGF5OiAnc2hvcnQnLAogICAgaG91cjogJzItZGlnaXQnLAogICAgbWludXRlOiAnMi1kaWdpdCcsCiAgICBzZWNvbmQ6ICcyLWRpZ2l0JywKICAgIGhvdXIxMjogZmFsc2UKICB9KTsKICBjb25zdCBXRUVLREFZID0geyBNb246IDEsIFR1ZTogMiwgV2VkOiAzLCBUaHU6IDQsIEZyaTogNSwgU2F0OiA2LCBTdW46IDcgfTsKCiAgZnVuY3Rpb24gdG9OdW1iZXIodmFsdWUpIHsKICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpIHJldHVybiB2YWx1ZTsKICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7CiAgICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSB2YWx1ZS5yZXBsYWNlKC9ccy9nLCAnJykucmVwbGFjZSgnLCcsICcuJykucmVwbGFjZSgvW15cZC4tXS9nLCAnJyk7CiAgICAgIGNvbnN0IHBhcnNlZCA9IE51bWJlcihub3JtYWxpemVkKTsKICAgICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShwYXJzZWQpID8gcGFyc2VkIDogbnVsbDsKICAgIH0KICAgIHJldHVybiBudWxsOwogIH0KICBmdW5jdGlvbiBnZXRQYXRoKG9iaiwgcGF0aCkgewogICAgcmV0dXJuIHBhdGgucmVkdWNlKChhY2MsIGtleSkgPT4gKGFjYyAmJiBhY2Nba2V5XSAhPT0gdW5kZWZpbmVkID8gYWNjW2tleV0gOiB1bmRlZmluZWQpLCBvYmopOwogIH0KICBmdW5jdGlvbiBwaWNrTnVtYmVyKG9iaiwgcGF0aHMpIHsKICAgIGZvciAoY29uc3QgcGF0aCBvZiBwYXRocykgewogICAgICBjb25zdCB2ID0gZ2V0UGF0aChvYmosIHBhdGgpOwogICAgICBjb25zdCBuID0gdG9OdW1iZXIodik7CiAgICAgIGlmIChuICE9PSBudWxsKSByZXR1cm4gbjsKICAgIH0KICAgIHJldHVybiBudWxsOwogIH0KICBmdW5jdGlvbiBwaWNrQnlLZXlIaW50KG9iaiwgaGludCkgewogICAgaWYgKCFvYmogfHwgdHlwZW9mIG9iaiAhPT0gJ29iamVjdCcpIHJldHVybiBudWxsOwogICAgY29uc3QgbG93ZXIgPSBoaW50LnRvTG93ZXJDYXNlKCk7CiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhvYmopKSB7CiAgICAgIGlmIChrLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMobG93ZXIpKSB7CiAgICAgICAgY29uc3QgbiA9IHRvTnVtYmVyKHYpOwogICAgICAgIGlmIChuICE9PSBudWxsKSByZXR1cm4gbjsKICAgICAgICBpZiAodiAmJiB0eXBlb2YgdiA9PT0gJ29iamVjdCcpIHsKICAgICAgICAgIGNvbnN0IGRlZXAgPSBwaWNrQnlLZXlIaW50KHYsIGhpbnQpOwogICAgICAgICAgaWYgKGRlZXAgIT09IG51bGwpIHJldHVybiBkZWVwOwogICAgICAgIH0KICAgICAgfQogICAgICBpZiAodiAmJiB0eXBlb2YgdiA9PT0gJ29iamVjdCcpIHsKICAgICAgICBjb25zdCBkZWVwID0gcGlja0J5S2V5SGludCh2LCBoaW50KTsKICAgICAgICBpZiAoZGVlcCAhPT0gbnVsbCkgcmV0dXJuIGRlZXA7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBudWxsOwogIH0KICBmdW5jdGlvbiBnZXRBcmdOb3dQYXJ0cyhkYXRlID0gbmV3IERhdGUoKSkgewogICAgY29uc3QgcGFydHMgPSBmbXRBcmdQYXJ0cy5mb3JtYXRUb1BhcnRzKGRhdGUpLnJlZHVjZSgoYWNjLCBwKSA9PiB7CiAgICAgIGFjY1twLnR5cGVdID0gcC52YWx1ZTsKICAgICAgcmV0dXJuIGFjYzsKICAgIH0sIHt9KTsKICAgIHJldHVybiB7CiAgICAgIHdlZWtkYXk6IFdFRUtEQVlbcGFydHMud2Vla2RheV0gfHwgMCwKICAgICAgaG91cjogTnVtYmVyKHBhcnRzLmhvdXIgfHwgJzAnKSwKICAgICAgbWludXRlOiBOdW1iZXIocGFydHMubWludXRlIHx8ICcwJyksCiAgICAgIHNlY29uZDogTnVtYmVyKHBhcnRzLnNlY29uZCB8fCAnMCcpCiAgICB9OwogIH0KICBmdW5jdGlvbiBicmVjaGFQZXJjZW50KG1lcCwgY2NsKSB7CiAgICBpZiAobWVwID09PSBudWxsIHx8IGNjbCA9PT0gbnVsbCkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBhdmcgPSAobWVwICsgY2NsKSAvIDI7CiAgICBpZiAoIWF2ZykgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gKE1hdGguYWJzKG1lcCAtIGNjbCkgLyBhdmcpICogMTAwOwogIH0KICBmdW5jdGlvbiBmb3JtYXRNb25leSh2YWx1ZSwgZGlnaXRzID0gMCkgewogICAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gJyQnICsgdmFsdWUudG9Mb2NhbGVTdHJpbmcoJ2VzLUFSJywgewogICAgICBtaW5pbXVtRnJhY3Rpb25EaWdpdHM6IGRpZ2l0cywKICAgICAgbWF4aW11bUZyYWN0aW9uRGlnaXRzOiBkaWdpdHMKICAgIH0pOwogIH0KICBmdW5jdGlvbiBmb3JtYXRQZXJjZW50KHZhbHVlLCBkaWdpdHMgPSAyKSB7CiAgICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiAn4oCUJzsKICAgIHJldHVybiB2YWx1ZS50b0ZpeGVkKGRpZ2l0cykgKyAnJSc7CiAgfQogIGZ1bmN0aW9uIGZvcm1hdENvbXBhY3RNb25leSh2YWx1ZSwgZGlnaXRzID0gMikgewogICAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gdmFsdWUudG9Mb2NhbGVTdHJpbmcoJ2VzLUFSJywgewogICAgICBtaW5pbXVtRnJhY3Rpb25EaWdpdHM6IGRpZ2l0cywKICAgICAgbWF4aW11bUZyYWN0aW9uRGlnaXRzOiBkaWdpdHMKICAgIH0pOwogIH0KICBmdW5jdGlvbiBlc2NhcGVIdG1sKHZhbHVlKSB7CiAgICByZXR1cm4gU3RyaW5nKHZhbHVlID8/ICcnKS5yZXBsYWNlKC9bJjw+IiddL2csIChjaGFyKSA9PiAoCiAgICAgIHsgJyYnOiAnJmFtcDsnLCAnPCc6ICcmbHQ7JywgJz4nOiAnJmd0OycsICciJzogJyZxdW90OycsICInIjogJyYjMzk7JyB9W2NoYXJdCiAgICApKTsKICB9CiAgZnVuY3Rpb24gc2V0VGV4dChpZCwgdGV4dCwgb3B0aW9ucyA9IHt9KSB7CiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTsKICAgIGlmICghZWwpIHJldHVybjsKICAgIGNvbnN0IG5leHQgPSBTdHJpbmcodGV4dCk7CiAgICBjb25zdCBwcmV2ID0gZWwudGV4dENvbnRlbnQ7CiAgICBlbC50ZXh0Q29udGVudCA9IG5leHQ7CiAgICBlbC5jbGFzc0xpc3QucmVtb3ZlKCdza2VsZXRvbicpOwogICAgaWYgKG9wdGlvbnMuY2hhbmdlQ2xhc3MgJiYgcHJldiAhPT0gbmV4dCkgewogICAgICBlbC5jbGFzc0xpc3QuYWRkKCd2YWx1ZS1jaGFuZ2VkJyk7CiAgICAgIHNldFRpbWVvdXQoKCkgPT4gZWwuY2xhc3NMaXN0LnJlbW92ZSgndmFsdWUtY2hhbmdlZCcpLCA2MDApOwogICAgfQogIH0KICBmdW5jdGlvbiBzZXREYXNoKGlkcykgewogICAgaWRzLmZvckVhY2goKGlkKSA9PiBzZXRUZXh0KGlkLCAn4oCUJykpOwogIH0KICBmdW5jdGlvbiBzZXRMb2FkaW5nKGlkcywgaXNMb2FkaW5nKSB7CiAgICBpZHMuZm9yRWFjaCgoaWQpID0+IHsKICAgICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CiAgICAgIGlmICghZWwpIHJldHVybjsKICAgICAgZWwuY2xhc3NMaXN0LnRvZ2dsZSgnc2tlbGV0b24nLCBpc0xvYWRpbmcpOwogICAgfSk7CiAgfQogIGZ1bmN0aW9uIHNldEZyZXNoQmFkZ2UodGV4dCwgbW9kZSkgewogICAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZnJlc2gtYmFkZ2UnKTsKICAgIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZyZXNoLWJhZGdlLXRleHQnKTsKICAgIGlmICghYmFkZ2UgfHwgIWxhYmVsKSByZXR1cm47CiAgICBsYWJlbC50ZXh0Q29udGVudCA9IHRleHQ7CiAgICBzdGF0ZS5mcmVzaEJhZGdlTW9kZSA9IG1vZGUgfHwgJ2lkbGUnOwogICAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZSgnZmV0Y2hpbmcnLCBtb2RlID09PSAnZmV0Y2hpbmcnKTsKICAgIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoJ2Vycm9yJywgbW9kZSA9PT0gJ2Vycm9yJyk7CiAgICBiYWRnZS5vbmNsaWNrID0gbW9kZSA9PT0gJ2Vycm9yJyA/ICgpID0+IGZldGNoQWxsKHsgbWFudWFsOiB0cnVlIH0pIDogbnVsbDsKICB9CiAgZnVuY3Rpb24gZm9ybWF0U291cmNlQWdlTGFiZWwodHNNcykgewogICAgbGV0IG4gPSB0b051bWJlcih0c01zKTsKICAgIGlmICghTnVtYmVyLmlzRmluaXRlKG4pKSByZXR1cm4gbnVsbDsKICAgIGlmIChuIDwgMWUxMikgbiAqPSAxMDAwOwogICAgY29uc3QgYWdlTWluID0gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcigoRGF0ZS5ub3coKSAtIG4pIC8gNjAwMDApKTsKICAgIGlmIChhZ2VNaW4gPCA2MCkgcmV0dXJuIGAke2FnZU1pbn0gbWluYDsKICAgIGNvbnN0IGggPSBNYXRoLmZsb29yKGFnZU1pbiAvIDYwKTsKICAgIGNvbnN0IG0gPSBhZ2VNaW4gJSA2MDsKICAgIHJldHVybiBtID09PSAwID8gYCR7aH0gaGAgOiBgJHtofSBoICR7bX0gbWluYDsKICB9CiAgZnVuY3Rpb24gcmVmcmVzaEZyZXNoQmFkZ2VGcm9tU291cmNlKCkgewogICAgaWYgKHN0YXRlLmZyZXNoQmFkZ2VNb2RlID09PSAnZmV0Y2hpbmcnIHx8IHN0YXRlLmZyZXNoQmFkZ2VNb2RlID09PSAnZXJyb3InKSByZXR1cm47CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShzdGF0ZS5zb3VyY2VUc01zKSkgcmV0dXJuOwogICAgY29uc3QgYWdlTGFiZWwgPSBmb3JtYXRTb3VyY2VBZ2VMYWJlbChzdGF0ZS5zb3VyY2VUc01zKTsKICAgIGlmICghYWdlTGFiZWwpIHJldHVybjsKICAgIHNldEZyZXNoQmFkZ2UoYMOabHRpbWEgYWN0dWFsaXphY2nDs24gaGFjZTogJHthZ2VMYWJlbH1gLCAnaWRsZScpOwogIH0KICBmdW5jdGlvbiBzdGFydEZyZXNoVGlja2VyKCkgewogICAgaWYgKHN0YXRlLmZyZXNoVGlja2VyKSByZXR1cm47CiAgICBzdGF0ZS5mcmVzaFRpY2tlciA9IHNldEludGVydmFsKHJlZnJlc2hGcmVzaEJhZGdlRnJvbVNvdXJjZSwgMzAwMDApOwogIH0KICBmdW5jdGlvbiBzZXRNYXJrZXRUYWcoaXNPcGVuKSB7CiAgICBjb25zdCB0YWcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndGFnLW1lcmNhZG8nKTsKICAgIGlmICghdGFnKSByZXR1cm47CiAgICB0YWcudGV4dENvbnRlbnQgPSBpc09wZW4gPyAnTWVyY2FkbyBhYmllcnRvJyA6ICdNZXJjYWRvIGNlcnJhZG8nOwogICAgdGFnLmNsYXNzTGlzdC50b2dnbGUoJ2Nsb3NlZCcsICFpc09wZW4pOwogIH0KICBmdW5jdGlvbiBzZXRFcnJvckJhbm5lcihzaG93LCB0ZXh0KSB7CiAgICBjb25zdCBiYW5uZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXJyb3ItYmFubmVyJyk7CiAgICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdlcnJvci1iYW5uZXItdGV4dCcpOwogICAgaWYgKCFiYW5uZXIpIHJldHVybjsKICAgIGlmICh0ZXh0ICYmIGxhYmVsKSBsYWJlbC50ZXh0Q29udGVudCA9IHRleHQ7CiAgICBiYW5uZXIuY2xhc3NMaXN0LnRvZ2dsZSgnc2hvdycsICEhc2hvdyk7CiAgfQogIGZ1bmN0aW9uIGV4dHJhY3RSb290KGpzb24pIHsKICAgIHJldHVybiBqc29uICYmIHR5cGVvZiBqc29uID09PSAnb2JqZWN0JyA/IChqc29uLmRhdGEgfHwganNvbi5yZXN1bHQgfHwganNvbikgOiB7fTsKICB9CiAgZnVuY3Rpb24gbm9ybWFsaXplRmNpUm93cyhwYXlsb2FkKSB7CiAgICBjb25zdCByb290ID0gZXh0cmFjdFJvb3QocGF5bG9hZCk7CiAgICBpZiAoQXJyYXkuaXNBcnJheShyb290KSkgcmV0dXJuIHJvb3Q7CiAgICBpZiAoQXJyYXkuaXNBcnJheShyb290Py5pdGVtcykpIHJldHVybiByb290Lml0ZW1zOwogICAgaWYgKEFycmF5LmlzQXJyYXkocm9vdD8ucm93cykpIHJldHVybiByb290LnJvd3M7CiAgICByZXR1cm4gW107CiAgfQogIGZ1bmN0aW9uIG5vcm1hbGl6ZUZjaUZvbmRvS2V5KHZhbHVlKSB7CiAgICByZXR1cm4gU3RyaW5nKHZhbHVlIHx8ICcnKQogICAgICAudG9Mb3dlckNhc2UoKQogICAgICAubm9ybWFsaXplKCdORkQnKQogICAgICAucmVwbGFjZSgvW1x1MDMwMC1cdTAzNmZdL2csICcnKQogICAgICAucmVwbGFjZSgvXHMrL2csICcgJykKICAgICAgLnRyaW0oKTsKICB9CiAgZnVuY3Rpb24gZmNpVHJlbmREaXIoY3VycmVudCwgcHJldmlvdXMpIHsKICAgIGNvbnN0IGN1cnIgPSB0b051bWJlcihjdXJyZW50KTsKICAgIGNvbnN0IHByZXYgPSB0b051bWJlcihwcmV2aW91cyk7CiAgICBpZiAoY3VyciA9PT0gbnVsbCB8fCBwcmV2ID09PSBudWxsKSByZXR1cm4gJ25hJzsKICAgIGlmIChNYXRoLmFicyhjdXJyIC0gcHJldikgPCAxZS05KSByZXR1cm4gJ2ZsYXQnOwogICAgcmV0dXJuIGN1cnIgPiBwcmV2ID8gJ3VwJyA6ICdkb3duJzsKICB9CiAgZnVuY3Rpb24gZmNpVHJlbmRMYWJlbChkaXIpIHsKICAgIGlmIChkaXIgPT09ICd1cCcpIHJldHVybiAnU3ViacOzIHZzIGTDrWEgYW50ZXJpb3InOwogICAgaWYgKGRpciA9PT0gJ2Rvd24nKSByZXR1cm4gJ0JhasOzIHZzIGTDrWEgYW50ZXJpb3InOwogICAgaWYgKGRpciA9PT0gJ2ZsYXQnKSByZXR1cm4gJ1NpbiBjYW1iaW9zIHZzIGTDrWEgYW50ZXJpb3InOwogICAgcmV0dXJuICdTaW4gZGF0byBkZWwgZMOtYSBhbnRlcmlvcic7CiAgfQogIGZ1bmN0aW9uIHJlbmRlckZjaVRyZW5kVmFsdWUodmFsdWUsIGRpcikgewogICAgY29uc3QgZGlyZWN0aW9uID0gZGlyIHx8ICduYSc7CiAgICBjb25zdCBpY29uID0gZGlyZWN0aW9uID09PSAndXAnID8gJ+KWsicgOiBkaXJlY3Rpb24gPT09ICdkb3duJyA/ICfilrwnIDogZGlyZWN0aW9uID09PSAnZmxhdCcgPyAnPScgOiAnwrcnOwogICAgcmV0dXJuIGA8c3BhbiBjbGFzcz0iZmNpLXRyZW5kICR7ZGlyZWN0aW9ufSIgdGl0bGU9IiR7ZXNjYXBlSHRtbChmY2lUcmVuZExhYmVsKGRpcmVjdGlvbikpfSI+PHNwYW4gY2xhc3M9ImZjaS10cmVuZC1pY29uIj4ke2ljb259PC9zcGFuPjxzcGFuPiR7Zm9ybWF0Q29tcGFjdE1vbmV5KHZhbHVlLCAyKX08L3NwYW4+PC9zcGFuPmA7CiAgfQogIGZ1bmN0aW9uIGdldEhpc3RvcnlDb2xFbGVtZW50cygpIHsKICAgIGNvbnN0IGNvbGdyb3VwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hpc3RvcnktY29sZ3JvdXAnKTsKICAgIHJldHVybiBjb2xncm91cCA/IEFycmF5LmZyb20oY29sZ3JvdXAucXVlcnlTZWxlY3RvckFsbCgnY29sJykpIDogW107CiAgfQogIGZ1bmN0aW9uIGNsYW1wSGlzdG9yeVdpZHRocyh3aWR0aHMpIHsKICAgIHJldHVybiBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIUy5tYXAoKGZhbGxiYWNrLCBpKSA9PiB7CiAgICAgIGNvbnN0IHJhdyA9IE51bWJlcih3aWR0aHM/LltpXSk7CiAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHJhdykpIHJldHVybiBmYWxsYmFjazsKICAgICAgY29uc3QgbWluID0gSElTVE9SWV9NSU5fQ09MX1dJRFRIU1tpXSA/PyA4MDsKICAgICAgcmV0dXJuIE1hdGgubWF4KG1pbiwgTWF0aC5yb3VuZChyYXcpKTsKICAgIH0pOwogIH0KICBmdW5jdGlvbiBzYXZlSGlzdG9yeUNvbHVtbldpZHRocyh3aWR0aHMpIHsKICAgIHRyeSB7CiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEhJU1RPUllfQ09MU19LRVksIEpTT04uc3RyaW5naWZ5KGNsYW1wSGlzdG9yeVdpZHRocyh3aWR0aHMpKSk7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tSYWRhck1FUF0gbm8gc2UgcHVkbyBndWFyZGFyIGFuY2hvcyBkZSBjb2x1bW5hcycsIGUpOwogICAgfQogIH0KICBmdW5jdGlvbiBsb2FkSGlzdG9yeUNvbHVtbldpZHRocygpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJhdyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKEhJU1RPUllfQ09MU19LRVkpOwogICAgICBpZiAoIXJhdykgcmV0dXJuIG51bGw7CiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTsKICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHBhcnNlZCkgfHwgcGFyc2VkLmxlbmd0aCAhPT0gSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFMubGVuZ3RoKSByZXR1cm4gbnVsbDsKICAgICAgcmV0dXJuIGNsYW1wSGlzdG9yeVdpZHRocyhwYXJzZWQpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBjb25zb2xlLmVycm9yKCdbUmFkYXJNRVBdIGFuY2hvcyBkZSBjb2x1bW5hcyBpbnbDoWxpZG9zJywgZSk7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogIH0KICBmdW5jdGlvbiBhcHBseUhpc3RvcnlDb2x1bW5XaWR0aHMod2lkdGhzLCBwZXJzaXN0ID0gZmFsc2UpIHsKICAgIGNvbnN0IGNvbHMgPSBnZXRIaXN0b3J5Q29sRWxlbWVudHMoKTsKICAgIGlmIChjb2xzLmxlbmd0aCAhPT0gSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFMubGVuZ3RoKSByZXR1cm47CiAgICBjb25zdCBuZXh0ID0gY2xhbXBIaXN0b3J5V2lkdGhzKHdpZHRocyk7CiAgICBjb2xzLmZvckVhY2goKGNvbCwgaSkgPT4gewogICAgICBjb2wuc3R5bGUud2lkdGggPSBgJHtuZXh0W2ldfXB4YDsKICAgIH0pOwogICAgc3RhdGUuaGlzdG9yeUNvbFdpZHRocyA9IG5leHQ7CiAgICBpZiAocGVyc2lzdCkgc2F2ZUhpc3RvcnlDb2x1bW5XaWR0aHMobmV4dCk7CiAgfQogIGZ1bmN0aW9uIGluaXRIaXN0b3J5Q29sdW1uV2lkdGhzKCkgewogICAgY29uc3Qgc2F2ZWQgPSBsb2FkSGlzdG9yeUNvbHVtbldpZHRocygpOwogICAgYXBwbHlIaXN0b3J5Q29sdW1uV2lkdGhzKHNhdmVkIHx8IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTLCBmYWxzZSk7CiAgfQogIGZ1bmN0aW9uIGJpbmRIaXN0b3J5Q29sdW1uUmVzaXplKCkgewogICAgaWYgKHN0YXRlLmhpc3RvcnlSZXNpemVCb3VuZCkgcmV0dXJuOwogICAgY29uc3QgdGFibGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGlzdG9yeS10YWJsZScpOwogICAgaWYgKCF0YWJsZSkgcmV0dXJuOwogICAgY29uc3QgaGFuZGxlcyA9IEFycmF5LmZyb20odGFibGUucXVlcnlTZWxlY3RvckFsbCgnLmNvbC1yZXNpemVyJykpOwogICAgaWYgKCFoYW5kbGVzLmxlbmd0aCkgcmV0dXJuOwogICAgc3RhdGUuaGlzdG9yeVJlc2l6ZUJvdW5kID0gdHJ1ZTsKCiAgICBoYW5kbGVzLmZvckVhY2goKGhhbmRsZSkgPT4gewogICAgICBoYW5kbGUuYWRkRXZlbnRMaXN0ZW5lcignZGJsY2xpY2snLCAoZXZlbnQpID0+IHsKICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGNvbnN0IGlkeCA9IE51bWJlcihoYW5kbGUuZGF0YXNldC5jb2xJbmRleCk7CiAgICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoaWR4KSkgcmV0dXJuOwogICAgICAgIGNvbnN0IG5leHQgPSBzdGF0ZS5oaXN0b3J5Q29sV2lkdGhzLnNsaWNlKCk7CiAgICAgICAgbmV4dFtpZHhdID0gSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFNbaWR4XTsKICAgICAgICBhcHBseUhpc3RvcnlDb2x1bW5XaWR0aHMobmV4dCwgdHJ1ZSk7CiAgICAgIH0pOwogICAgICBoYW5kbGUuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcmRvd24nLCAoZXZlbnQpID0+IHsKICAgICAgICBpZiAoZXZlbnQuYnV0dG9uICE9PSAwKSByZXR1cm47CiAgICAgICAgY29uc3QgaWR4ID0gTnVtYmVyKGhhbmRsZS5kYXRhc2V0LmNvbEluZGV4KTsKICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShpZHgpKSByZXR1cm47CiAgICAgICAgY29uc3Qgc3RhcnRYID0gZXZlbnQuY2xpZW50WDsKICAgICAgICBjb25zdCBzdGFydFdpZHRoID0gc3RhdGUuaGlzdG9yeUNvbFdpZHRoc1tpZHhdID8/IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTW2lkeF07CiAgICAgICAgaGFuZGxlLmNsYXNzTGlzdC5hZGQoJ2FjdGl2ZScpOwogICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7CgogICAgICAgIGNvbnN0IG9uTW92ZSA9IChtb3ZlRXZlbnQpID0+IHsKICAgICAgICAgIGNvbnN0IGRlbHRhID0gbW92ZUV2ZW50LmNsaWVudFggLSBzdGFydFg7CiAgICAgICAgICBjb25zdCBtaW4gPSBISVNUT1JZX01JTl9DT0xfV0lEVEhTW2lkeF0gPz8gODA7CiAgICAgICAgICBjb25zdCBuZXh0V2lkdGggPSBNYXRoLm1heChtaW4sIE1hdGgucm91bmQoc3RhcnRXaWR0aCArIGRlbHRhKSk7CiAgICAgICAgICBjb25zdCBuZXh0ID0gc3RhdGUuaGlzdG9yeUNvbFdpZHRocy5zbGljZSgpOwogICAgICAgICAgbmV4dFtpZHhdID0gbmV4dFdpZHRoOwogICAgICAgICAgYXBwbHlIaXN0b3J5Q29sdW1uV2lkdGhzKG5leHQsIGZhbHNlKTsKICAgICAgICB9OwogICAgICAgIGNvbnN0IG9uVXAgPSAoKSA9PiB7CiAgICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcm1vdmUnLCBvbk1vdmUpOwogICAgICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJ1cCcsIG9uVXApOwogICAgICAgICAgaGFuZGxlLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpOwogICAgICAgICAgc2F2ZUhpc3RvcnlDb2x1bW5XaWR0aHMoc3RhdGUuaGlzdG9yeUNvbFdpZHRocyk7CiAgICAgICAgfTsKICAgICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcm1vdmUnLCBvbk1vdmUpOwogICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVydXAnLCBvblVwKTsKICAgICAgfSk7CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIGdldEZjaUNvbEVsZW1lbnRzKCkgewogICAgY29uc3QgY29sZ3JvdXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLWNvbGdyb3VwJyk7CiAgICByZXR1cm4gY29sZ3JvdXAgPyBBcnJheS5mcm9tKGNvbGdyb3VwLnF1ZXJ5U2VsZWN0b3JBbGwoJ2NvbCcpKSA6IFtdOwogIH0KICBmdW5jdGlvbiBjbGFtcEZjaVdpZHRocyh3aWR0aHMpIHsKICAgIHJldHVybiBGQ0lfREVGQVVMVF9DT0xfV0lEVEhTLm1hcCgoZmFsbGJhY2ssIGkpID0+IHsKICAgICAgY29uc3QgcmF3ID0gTnVtYmVyKHdpZHRocz8uW2ldKTsKICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUocmF3KSkgcmV0dXJuIGZhbGxiYWNrOwogICAgICBjb25zdCBtaW4gPSBGQ0lfTUlOX0NPTF9XSURUSFNbaV0gPz8gODA7CiAgICAgIHJldHVybiBNYXRoLm1heChtaW4sIE1hdGgucm91bmQocmF3KSk7CiAgICB9KTsKICB9CiAgZnVuY3Rpb24gc2F2ZUZjaUNvbHVtbldpZHRocyh3aWR0aHMpIHsKICAgIHRyeSB7CiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEZDSV9DT0xTX0tFWSwgSlNPTi5zdHJpbmdpZnkoY2xhbXBGY2lXaWR0aHMod2lkdGhzKSkpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBjb25zb2xlLmVycm9yKCdbUmFkYXJNRVBdIG5vIHNlIHB1ZG8gZ3VhcmRhciBhbmNob3MgZGUgY29sdW1uYXMgRkNJJywgZSk7CiAgICB9CiAgfQogIGZ1bmN0aW9uIGxvYWRGY2lDb2x1bW5XaWR0aHMoKSB7CiAgICB0cnkgewogICAgICBjb25zdCByYXcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShGQ0lfQ09MU19LRVkpOwogICAgICBpZiAoIXJhdykgcmV0dXJuIG51bGw7CiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTsKICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHBhcnNlZCkgfHwgcGFyc2VkLmxlbmd0aCAhPT0gRkNJX0RFRkFVTFRfQ09MX1dJRFRIUy5sZW5ndGgpIHJldHVybiBudWxsOwogICAgICByZXR1cm4gY2xhbXBGY2lXaWR0aHMocGFyc2VkKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgY29uc29sZS5lcnJvcignW1JhZGFyTUVQXSBhbmNob3MgZGUgY29sdW1uYXMgRkNJIGludsOhbGlkb3MnLCBlKTsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQogIGZ1bmN0aW9uIGFwcGx5RmNpQ29sdW1uV2lkdGhzKHdpZHRocywgcGVyc2lzdCA9IGZhbHNlKSB7CiAgICBjb25zdCBjb2xzID0gZ2V0RmNpQ29sRWxlbWVudHMoKTsKICAgIGlmIChjb2xzLmxlbmd0aCAhPT0gRkNJX0RFRkFVTFRfQ09MX1dJRFRIUy5sZW5ndGgpIHJldHVybjsKICAgIGNvbnN0IG5leHQgPSBjbGFtcEZjaVdpZHRocyh3aWR0aHMpOwogICAgY29scy5mb3JFYWNoKChjb2wsIGkpID0+IHsKICAgICAgY29sLnN0eWxlLndpZHRoID0gYCR7bmV4dFtpXX1weGA7CiAgICB9KTsKICAgIHN0YXRlLmZjaUNvbFdpZHRocyA9IG5leHQ7CiAgICBpZiAocGVyc2lzdCkgc2F2ZUZjaUNvbHVtbldpZHRocyhuZXh0KTsKICB9CiAgZnVuY3Rpb24gaW5pdEZjaUNvbHVtbldpZHRocygpIHsKICAgIGNvbnN0IHNhdmVkID0gbG9hZEZjaUNvbHVtbldpZHRocygpOwogICAgYXBwbHlGY2lDb2x1bW5XaWR0aHMoc2F2ZWQgfHwgRkNJX0RFRkFVTFRfQ09MX1dJRFRIUywgZmFsc2UpOwogIH0KICBmdW5jdGlvbiBiaW5kRmNpQ29sdW1uUmVzaXplKCkgewogICAgaWYgKHN0YXRlLmZjaVJlc2l6ZUJvdW5kKSByZXR1cm47CiAgICBjb25zdCB0YWJsZSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5mY2ktdGFibGUnKTsKICAgIGlmICghdGFibGUpIHJldHVybjsKICAgIGNvbnN0IGhhbmRsZXMgPSBBcnJheS5mcm9tKHRhYmxlLnF1ZXJ5U2VsZWN0b3JBbGwoJy5mY2ktY29sLXJlc2l6ZXInKSk7CiAgICBpZiAoIWhhbmRsZXMubGVuZ3RoKSByZXR1cm47CiAgICBzdGF0ZS5mY2lSZXNpemVCb3VuZCA9IHRydWU7CgogICAgaGFuZGxlcy5mb3JFYWNoKChoYW5kbGUpID0+IHsKICAgICAgaGFuZGxlLmFkZEV2ZW50TGlzdGVuZXIoJ2RibGNsaWNrJywgKGV2ZW50KSA9PiB7CiAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKICAgICAgICBjb25zdCBpZHggPSBOdW1iZXIoaGFuZGxlLmRhdGFzZXQuZmNpQ29sSW5kZXgpOwogICAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGlkeCkpIHJldHVybjsKICAgICAgICBjb25zdCBuZXh0ID0gc3RhdGUuZmNpQ29sV2lkdGhzLnNsaWNlKCk7CiAgICAgICAgbmV4dFtpZHhdID0gRkNJX0RFRkFVTFRfQ09MX1dJRFRIU1tpZHhdOwogICAgICAgIGFwcGx5RmNpQ29sdW1uV2lkdGhzKG5leHQsIHRydWUpOwogICAgICB9KTsKICAgICAgaGFuZGxlLmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJkb3duJywgKGV2ZW50KSA9PiB7CiAgICAgICAgaWYgKGV2ZW50LmJ1dHRvbiAhPT0gMCkgcmV0dXJuOwogICAgICAgIGNvbnN0IGlkeCA9IE51bWJlcihoYW5kbGUuZGF0YXNldC5mY2lDb2xJbmRleCk7CiAgICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoaWR4KSkgcmV0dXJuOwogICAgICAgIGNvbnN0IHN0YXJ0WCA9IGV2ZW50LmNsaWVudFg7CiAgICAgICAgY29uc3Qgc3RhcnRXaWR0aCA9IHN0YXRlLmZjaUNvbFdpZHRoc1tpZHhdID8/IEZDSV9ERUZBVUxUX0NPTF9XSURUSFNbaWR4XTsKICAgICAgICBoYW5kbGUuY2xhc3NMaXN0LmFkZCgnYWN0aXZlJyk7CiAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKCiAgICAgICAgY29uc3Qgb25Nb3ZlID0gKG1vdmVFdmVudCkgPT4gewogICAgICAgICAgY29uc3QgZGVsdGEgPSBtb3ZlRXZlbnQuY2xpZW50WCAtIHN0YXJ0WDsKICAgICAgICAgIGNvbnN0IG1pbiA9IEZDSV9NSU5fQ09MX1dJRFRIU1tpZHhdID8/IDgwOwogICAgICAgICAgY29uc3QgbmV4dFdpZHRoID0gTWF0aC5tYXgobWluLCBNYXRoLnJvdW5kKHN0YXJ0V2lkdGggKyBkZWx0YSkpOwogICAgICAgICAgY29uc3QgbmV4dCA9IHN0YXRlLmZjaUNvbFdpZHRocy5zbGljZSgpOwogICAgICAgICAgbmV4dFtpZHhdID0gbmV4dFdpZHRoOwogICAgICAgICAgYXBwbHlGY2lDb2x1bW5XaWR0aHMobmV4dCwgZmFsc2UpOwogICAgICAgIH07CiAgICAgICAgY29uc3Qgb25VcCA9ICgpID0+IHsKICAgICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdwb2ludGVybW92ZScsIG9uTW92ZSk7CiAgICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcnVwJywgb25VcCk7CiAgICAgICAgICBoYW5kbGUuY2xhc3NMaXN0LnJlbW92ZSgnYWN0aXZlJyk7CiAgICAgICAgICBzYXZlRmNpQ29sdW1uV2lkdGhzKHN0YXRlLmZjaUNvbFdpZHRocyk7CiAgICAgICAgfTsKICAgICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcm1vdmUnLCBvbk1vdmUpOwogICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVydXAnLCBvblVwKTsKICAgICAgfSk7CiAgICB9KTsKICB9CgogIC8vIDMpIEZ1bmNpb25lcyBkZSByZW5kZXIKICBmdW5jdGlvbiByZW5kZXJNZXBDY2wocGF5bG9hZCkgewogICAgaWYgKCFwYXlsb2FkKSB7CiAgICAgIHNldERhc2goWydtZXAtdmFsJywgJ2NjbC12YWwnLCAnYnJlY2hhLWFicycsICdicmVjaGEtcGN0J10pOwogICAgICBzZXRUZXh0KCdzdGF0dXMtbGFiZWwnLCAnRGF0b3MgaW5jb21wbGV0b3MnKTsKICAgICAgc2V0VGV4dCgnc3RhdHVzLWJhZGdlJywgJ1NpbiBkYXRvJyk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGRhdGEgPSBleHRyYWN0Um9vdChwYXlsb2FkKTsKICAgIGNvbnN0IGN1cnJlbnQgPSBkYXRhICYmIHR5cGVvZiBkYXRhLmN1cnJlbnQgPT09ICdvYmplY3QnID8gZGF0YS5jdXJyZW50IDogbnVsbDsKICAgIGNvbnN0IG1lcCA9IGN1cnJlbnQgPyB0b051bWJlcihjdXJyZW50Lm1lcCkgOiAocGlja051bWJlcihkYXRhLCBbWydtZXAnLCAndmVudGEnXSwgWydtZXAnLCAnc2VsbCddLCBbJ21lcCddLCBbJ21lcF92ZW50YSddLCBbJ2RvbGFyX21lcCddXSkgPz8gcGlja0J5S2V5SGludChkYXRhLCAnbWVwJykpOwogICAgY29uc3QgY2NsID0gY3VycmVudCA/IHRvTnVtYmVyKGN1cnJlbnQuY2NsKSA6IChwaWNrTnVtYmVyKGRhdGEsIFtbJ2NjbCcsICd2ZW50YSddLCBbJ2NjbCcsICdzZWxsJ10sIFsnY2NsJ10sIFsnY2NsX3ZlbnRhJ10sIFsnZG9sYXJfY2NsJ11dKSA/PyBwaWNrQnlLZXlIaW50KGRhdGEsICdjY2wnKSk7CiAgICBjb25zdCBhYnMgPSBjdXJyZW50ID8gdG9OdW1iZXIoY3VycmVudC5hYnNEaWZmKSA/PyAobWVwICE9PSBudWxsICYmIGNjbCAhPT0gbnVsbCA/IE1hdGguYWJzKG1lcCAtIGNjbCkgOiBudWxsKSA6IChtZXAgIT09IG51bGwgJiYgY2NsICE9PSBudWxsID8gTWF0aC5hYnMobWVwIC0gY2NsKSA6IG51bGwpOwogICAgY29uc3QgcGN0ID0gY3VycmVudCA/IHRvTnVtYmVyKGN1cnJlbnQucGN0RGlmZikgPz8gYnJlY2hhUGVyY2VudChtZXAsIGNjbCkgOiBicmVjaGFQZXJjZW50KG1lcCwgY2NsKTsKICAgIGNvbnN0IGlzU2ltaWxhciA9IGN1cnJlbnQgJiYgdHlwZW9mIGN1cnJlbnQuc2ltaWxhciA9PT0gJ2Jvb2xlYW4nCiAgICAgID8gY3VycmVudC5zaW1pbGFyCiAgICAgIDogKHBjdCAhPT0gbnVsbCAmJiBhYnMgIT09IG51bGwgJiYgKHBjdCA8PSBTSU1JTEFSX1BDVF9USFJFU0hPTEQgfHwgYWJzIDw9IFNJTUlMQVJfQVJTX1RIUkVTSE9MRCkpOwoKICAgIHNldFRleHQoJ21lcC12YWwnLCBmb3JtYXRNb25leShtZXAsIDIpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnY2NsLXZhbCcsIGZvcm1hdE1vbmV5KGNjbCwgMiksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdicmVjaGEtYWJzJywgYWJzID09PSBudWxsID8gJ+KAlCcgOiBmb3JtYXRNb25leShhYnMsIDIpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnYnJlY2hhLXBjdCcsIGZvcm1hdFBlcmNlbnQocGN0LCAyKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ3N0YXR1cy1sYWJlbCcsIGlzU2ltaWxhciA/ICdNRVAg4omIIENDTCcgOiAnTUVQIOKJoCBDQ0wnKTsKICAgIHNldFRleHQoJ3N0YXR1cy1iYWRnZScsIGlzU2ltaWxhciA/ICdTaW1pbGFyJyA6ICdObyBzaW1pbGFyJyk7CiAgICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdGF0dXMtYmFkZ2UnKTsKICAgIGlmIChiYWRnZSkgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZSgnbm9zaW0nLCAhaXNTaW1pbGFyKTsKCiAgICBjb25zdCBiYW5uZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RhdHVzLWJhbm5lcicpOwogICAgaWYgKGJhbm5lcikgewogICAgICBiYW5uZXIuY2xhc3NMaXN0LnRvZ2dsZSgnc2ltaWxhcicsICEhaXNTaW1pbGFyKTsKICAgICAgYmFubmVyLmNsYXNzTGlzdC50b2dnbGUoJ25vLXNpbWlsYXInLCAhaXNTaW1pbGFyKTsKICAgIH0KICAgIGNvbnN0IHN1YiA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJyNzdGF0dXMtYmFubmVyIC5zLXN1YicpOwogICAgaWYgKHN1YikgewogICAgICBzdWIudGV4dENvbnRlbnQgPSBpc1NpbWlsYXIKICAgICAgICA/ICdMYSBicmVjaGEgZXN0w6EgZGVudHJvIGRlbCB1bWJyYWwg4oCUIGxvcyBwcmVjaW9zIHNvbiBjb21wYXJhYmxlcycKICAgICAgICA6ICdMYSBicmVjaGEgc3VwZXJhIGVsIHVtYnJhbCDigJQgbG9zIHByZWNpb3Mgbm8gc29uIGNvbXBhcmFibGVzJzsKICAgIH0KICAgIGNvbnN0IGlzT3BlbiA9IGRhdGE/Lm1hcmtldCAmJiB0eXBlb2YgZGF0YS5tYXJrZXQuaXNPcGVuID09PSAnYm9vbGVhbicgPyBkYXRhLm1hcmtldC5pc09wZW4gOiBudWxsOwogICAgaWYgKGlzT3BlbiAhPT0gbnVsbCkgc2V0TWFya2V0VGFnKGlzT3Blbik7CiAgICBzdGF0ZS5sYXRlc3QubWVwID0gbWVwOwogICAgc3RhdGUubGF0ZXN0LmNjbCA9IGNjbDsKICAgIHN0YXRlLmxhdGVzdC5icmVjaGFBYnMgPSBhYnM7CiAgICBzdGF0ZS5sYXRlc3QuYnJlY2hhUGN0ID0gcGN0OwogIH0KCiAgZnVuY3Rpb24gaXNTaW1pbGFyUm93KHJvdykgewogICAgY29uc3QgYWJzID0gcm93LmFic19kaWZmICE9IG51bGwgPyByb3cuYWJzX2RpZmYgOiBNYXRoLmFicyhyb3cubWVwIC0gcm93LmNjbCk7CiAgICBjb25zdCBwY3QgPSByb3cucGN0X2RpZmYgIT0gbnVsbCA/IHJvdy5wY3RfZGlmZiA6IGNhbGNCcmVjaGFQY3Qocm93Lm1lcCwgcm93LmNjbCk7CiAgICByZXR1cm4gKE51bWJlci5pc0Zpbml0ZShwY3QpICYmIHBjdCA8PSBTSU1JTEFSX1BDVF9USFJFU0hPTEQpIHx8IChOdW1iZXIuaXNGaW5pdGUoYWJzKSAmJiBhYnMgPD0gU0lNSUxBUl9BUlNfVEhSRVNIT0xEKTsKICB9CgogIGZ1bmN0aW9uIGZpbHRlckRlc2NyaXB0b3IobW9kZSA9IHN0YXRlLmZpbHRlck1vZGUpIHsKICAgIGlmIChtb2RlID09PSAnMW0nKSByZXR1cm4gJzEgTWVzJzsKICAgIGlmIChtb2RlID09PSAnMXcnKSByZXR1cm4gJzEgU2VtYW5hJzsKICAgIHJldHVybiAnMSBEw61hJzsKICB9CgogIGZ1bmN0aW9uIHJlbmRlck1ldHJpY3MyNGgocGF5bG9hZCkgewogICAgY29uc3QgZmlsdGVyZWQgPSBmaWx0ZXJIaXN0b3J5Um93cyhleHRyYWN0SGlzdG9yeVJvd3MocGF5bG9hZCksIHN0YXRlLmZpbHRlck1vZGUpOwogICAgY29uc3QgcGN0VmFsdWVzID0gZmlsdGVyZWQubWFwKChyKSA9PiAoci5wY3RfZGlmZiAhPSBudWxsID8gci5wY3RfZGlmZiA6IGNhbGNCcmVjaGFQY3Qoci5tZXAsIHIuY2NsKSkpLmZpbHRlcigodikgPT4gTnVtYmVyLmlzRmluaXRlKHYpKTsKICAgIGNvbnN0IHNpbWlsYXJDb3VudCA9IGZpbHRlcmVkLmZpbHRlcigocikgPT4gaXNTaW1pbGFyUm93KHIpKS5sZW5ndGg7CiAgICBjb25zdCBkZXNjcmlwdG9yID0gZmlsdGVyRGVzY3JpcHRvcigpOwoKICAgIHNldFRleHQoJ21ldHJpYy1jb3VudC1sYWJlbCcsIGBNdWVzdHJhcyAke2Rlc2NyaXB0b3J9YCk7CiAgICBzZXRUZXh0KCdtZXRyaWMtY291bnQtMjRoJywgU3RyaW5nKGZpbHRlcmVkLmxlbmd0aCksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtY291bnQtc3ViJywgJ3JlZ2lzdHJvcyBkZWwgcGVyw61vZG8gZmlsdHJhZG8nKTsKICAgIHNldFRleHQoJ21ldHJpYy1zaW1pbGFyLWxhYmVsJywgYFZlY2VzIHNpbWlsYXIgKCR7ZGVzY3JpcHRvcn0pYCk7CiAgICBzZXRUZXh0KCdtZXRyaWMtc2ltaWxhci0yNGgnLCBTdHJpbmcoc2ltaWxhckNvdW50KSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ21ldHJpYy1zaW1pbGFyLXN1YicsICdtb21lbnRvcyBlbiB6b25hIOKJpDElIG8g4omkJDEwJyk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWluLWxhYmVsJywgYEJyZWNoYSBtw61uLiAoJHtkZXNjcmlwdG9yfSlgKTsKICAgIHNldFRleHQoJ21ldHJpYy1taW4tMjRoJywgcGN0VmFsdWVzLmxlbmd0aCA/IGZvcm1hdFBlcmNlbnQoTWF0aC5taW4oLi4ucGN0VmFsdWVzKSwgMikgOiAn4oCUJywgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ21ldHJpYy1taW4tc3ViJywgJ23DrW5pbWEgZGVsIHBlcsOtb2RvIGZpbHRyYWRvJyk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWF4LWxhYmVsJywgYEJyZWNoYSBtw6F4LiAoJHtkZXNjcmlwdG9yfSlgKTsKICAgIHNldFRleHQoJ21ldHJpYy1tYXgtMjRoJywgcGN0VmFsdWVzLmxlbmd0aCA/IGZvcm1hdFBlcmNlbnQoTWF0aC5tYXgoLi4ucGN0VmFsdWVzKSwgMikgOiAn4oCUJywgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ21ldHJpYy1tYXgtc3ViJywgJ23DoXhpbWEgZGVsIHBlcsOtb2RvIGZpbHRyYWRvJyk7CiAgICBzZXRUZXh0KCd0cmVuZC10aXRsZScsIGBUZW5kZW5jaWEgTUVQL0NDTCDigJQgJHtkZXNjcmlwdG9yfWApOwogIH0KCiAgZnVuY3Rpb24gcm93SG91ckxhYmVsKGVwb2NoKSB7CiAgICBjb25zdCBuID0gdG9OdW1iZXIoZXBvY2gpOwogICAgaWYgKG4gPT09IG51bGwpIHJldHVybiAn4oCUJzsKICAgIHJldHVybiBmbXRBcmdIb3VyLmZvcm1hdChuZXcgRGF0ZShuICogMTAwMCkpOwogIH0KICBmdW5jdGlvbiByb3dEYXlIb3VyTGFiZWwoZXBvY2gpIHsKICAgIGNvbnN0IG4gPSB0b051bWJlcihlcG9jaCk7CiAgICBpZiAobiA9PT0gbnVsbCkgcmV0dXJuICfigJQnOwogICAgY29uc3QgZGF0ZSA9IG5ldyBEYXRlKG4gKiAxMDAwKTsKICAgIHJldHVybiBgJHtmbXRBcmdEYXlNb250aC5mb3JtYXQoZGF0ZSl9ICR7Zm10QXJnSG91ci5mb3JtYXQoZGF0ZSl9YDsKICB9CiAgZnVuY3Rpb24gYXJ0RGF0ZUtleShlcG9jaCkgewogICAgY29uc3QgbiA9IHRvTnVtYmVyKGVwb2NoKTsKICAgIGlmIChuID09PSBudWxsKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiBmbXRBcmdEYXRlLmZvcm1hdChuZXcgRGF0ZShuICogMTAwMCkpOwogIH0KICBmdW5jdGlvbiBhcnRXZWVrZGF5KGVwb2NoKSB7CiAgICBjb25zdCBuID0gdG9OdW1iZXIoZXBvY2gpOwogICAgaWYgKG4gPT09IG51bGwpIHJldHVybiBudWxsOwogICAgcmV0dXJuIGZtdEFyZ1dlZWtkYXkuZm9ybWF0KG5ldyBEYXRlKG4gKiAxMDAwKSk7CiAgfQogIGZ1bmN0aW9uIGV4dHJhY3RIaXN0b3J5Um93cyhwYXlsb2FkKSB7CiAgICBjb25zdCBkYXRhID0gZXh0cmFjdFJvb3QocGF5bG9hZCk7CiAgICBjb25zdCByb3dzID0gQXJyYXkuaXNBcnJheShkYXRhLmhpc3RvcnkpID8gZGF0YS5oaXN0b3J5LnNsaWNlKCkgOiBbXTsKICAgIHJldHVybiByb3dzCiAgICAgIC5tYXAoKHIpID0+ICh7CiAgICAgICAgZXBvY2g6IHRvTnVtYmVyKHIuZXBvY2gpLAogICAgICAgIG1lcDogdG9OdW1iZXIoci5tZXApLAogICAgICAgIGNjbDogdG9OdW1iZXIoci5jY2wpLAogICAgICAgIGFic19kaWZmOiB0b051bWJlcihyLmFic19kaWZmKSwKICAgICAgICBwY3RfZGlmZjogdG9OdW1iZXIoci5wY3RfZGlmZiksCiAgICAgICAgc2ltaWxhcjogQm9vbGVhbihyLnNpbWlsYXIpCiAgICAgIH0pKQogICAgICAuZmlsdGVyKChyKSA9PiByLmVwb2NoICE9IG51bGwgJiYgci5tZXAgIT0gbnVsbCAmJiByLmNjbCAhPSBudWxsKQogICAgICAuc29ydCgoYSwgYikgPT4gYS5lcG9jaCAtIGIuZXBvY2gpOwogIH0KICBmdW5jdGlvbiBmaWx0ZXJIaXN0b3J5Um93cyhyb3dzLCBtb2RlKSB7CiAgICBpZiAoIXJvd3MubGVuZ3RoKSByZXR1cm4gW107CiAgICBjb25zdCBsYXRlc3RFcG9jaCA9IHJvd3Nbcm93cy5sZW5ndGggLSAxXS5lcG9jaDsKICAgIGlmIChtb2RlID09PSAnMW0nKSB7CiAgICAgIGNvbnN0IGN1dG9mZiA9IGxhdGVzdEVwb2NoIC0gKDMwICogMjQgKiAzNjAwKTsKICAgICAgcmV0dXJuIHJvd3MuZmlsdGVyKChyKSA9PiByLmVwb2NoID49IGN1dG9mZik7CiAgICB9CiAgICBpZiAobW9kZSA9PT0gJzF3JykgewogICAgICBjb25zdCBhbGxvd2VkRGF5cyA9IG5ldyBTZXQoKTsKICAgICAgZm9yIChsZXQgaSA9IHJvd3MubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHsKICAgICAgICBjb25zdCBkYXkgPSBhcnREYXRlS2V5KHJvd3NbaV0uZXBvY2gpOwogICAgICAgIGNvbnN0IHdkID0gYXJ0V2Vla2RheShyb3dzW2ldLmVwb2NoKTsKICAgICAgICBpZiAoIWRheSB8fCB3ZCA9PT0gJ1NhdCcgfHwgd2QgPT09ICdTdW4nKSBjb250aW51ZTsKICAgICAgICBhbGxvd2VkRGF5cy5hZGQoZGF5KTsKICAgICAgICBpZiAoYWxsb3dlZERheXMuc2l6ZSA+PSA1KSBicmVhazsKICAgICAgfQogICAgICByZXR1cm4gcm93cy5maWx0ZXIoKHIpID0+IHsKICAgICAgICBjb25zdCBkYXkgPSBhcnREYXRlS2V5KHIuZXBvY2gpOwogICAgICAgIHJldHVybiBkYXkgJiYgYWxsb3dlZERheXMuaGFzKGRheSk7CiAgICAgIH0pOwogICAgfQogICAgY29uc3QgY3V0b2ZmID0gbGF0ZXN0RXBvY2ggLSAoMjQgKiAzNjAwKTsKICAgIHJldHVybiByb3dzLmZpbHRlcigocikgPT4gci5lcG9jaCA+PSBjdXRvZmYpOwogIH0KICBmdW5jdGlvbiBkb3duc2FtcGxlUm93cyhyb3dzLCBtYXhQb2ludHMpIHsKICAgIGlmIChyb3dzLmxlbmd0aCA8PSBtYXhQb2ludHMpIHJldHVybiByb3dzOwogICAgY29uc3Qgb3V0ID0gW107CiAgICBjb25zdCBzdGVwID0gKHJvd3MubGVuZ3RoIC0gMSkgLyAobWF4UG9pbnRzIC0gMSk7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1heFBvaW50czsgaSsrKSB7CiAgICAgIG91dC5wdXNoKHJvd3NbTWF0aC5yb3VuZChpICogc3RlcCldKTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQogIGZ1bmN0aW9uIGN1cnJlbnRGaWx0ZXJMYWJlbCgpIHsKICAgIGlmIChzdGF0ZS5maWx0ZXJNb2RlID09PSAnMW0nKSByZXR1cm4gJzEgTWVzJzsKICAgIGlmIChzdGF0ZS5maWx0ZXJNb2RlID09PSAnMXcnKSByZXR1cm4gJzEgU2VtYW5hJzsKICAgIHJldHVybiAnMSBEw61hJzsKICB9CiAgZnVuY3Rpb24gZ2V0RmlsdGVyZWRIaXN0b3J5Um93cyhwYXlsb2FkID0gc3RhdGUubGFzdE1lcFBheWxvYWQpIHsKICAgIGlmICghcGF5bG9hZCkgcmV0dXJuIFtdOwogICAgcmV0dXJuIGZpbHRlckhpc3RvcnlSb3dzKGV4dHJhY3RIaXN0b3J5Um93cyhwYXlsb2FkKSwgc3RhdGUuZmlsdGVyTW9kZSk7CiAgfQogIGZ1bmN0aW9uIGNzdkVzY2FwZSh2YWx1ZSkgewogICAgY29uc3QgdiA9IFN0cmluZyh2YWx1ZSA/PyAnJyk7CiAgICByZXR1cm4gYCIke3YucmVwbGFjZSgvIi9nLCAnIiInKX0iYDsKICB9CiAgZnVuY3Rpb24gY3N2TnVtYmVyKHZhbHVlLCBkaWdpdHMgPSAyKSB7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpIHJldHVybiAn4oCUJzsKICAgIHJldHVybiB2YWx1ZS50b0ZpeGVkKGRpZ2l0cykucmVwbGFjZSgnLicsICcsJyk7CiAgfQogIGZ1bmN0aW9uIGZpbHRlckNvZGUoKSB7CiAgICBpZiAoc3RhdGUuZmlsdGVyTW9kZSA9PT0gJzFtJykgcmV0dXJuICcxbSc7CiAgICBpZiAoc3RhdGUuZmlsdGVyTW9kZSA9PT0gJzF3JykgcmV0dXJuICcxdyc7CiAgICByZXR1cm4gJzFkJzsKICB9CiAgZnVuY3Rpb24gZG93bmxvYWRIaXN0b3J5Q3N2KCkgewogICAgY29uc3QgZmlsdGVyZWQgPSBnZXRGaWx0ZXJlZEhpc3RvcnlSb3dzKCk7CiAgICBpZiAoIWZpbHRlcmVkLmxlbmd0aCkgewogICAgICBzZXRGcmVzaEJhZGdlKCdTaW4gZGF0b3MgcGFyYSBleHBvcnRhciBlbiBlbCBmaWx0cm8gYWN0aXZvJywgJ2lkbGUnKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc3QgaGVhZGVyID0gWydmZWNoYScsICdob3JhJywgJ21lcCcsICdjY2wnLCAnZGlmX2FicycsICdkaWZfcGN0JywgJ2VzdGFkbyddOwogICAgY29uc3Qgcm93cyA9IGZpbHRlcmVkLm1hcCgocikgPT4gewogICAgICBjb25zdCBkYXRlID0gbmV3IERhdGUoci5lcG9jaCAqIDEwMDApOwogICAgICBjb25zdCBtZXAgPSB0b051bWJlcihyLm1lcCk7CiAgICAgIGNvbnN0IGNjbCA9IHRvTnVtYmVyKHIuY2NsKTsKICAgICAgY29uc3QgYWJzID0gdG9OdW1iZXIoci5hYnNfZGlmZik7CiAgICAgIGNvbnN0IHBjdCA9IHRvTnVtYmVyKHIucGN0X2RpZmYpOwogICAgICBjb25zdCBlc3RhZG8gPSBCb29sZWFuKHIuc2ltaWxhcikgPyAnU0lNSUxBUicgOiAnTk8gU0lNSUxBUic7CiAgICAgIHJldHVybiBbCiAgICAgICAgZm10QXJnRGF5TW9udGguZm9ybWF0KGRhdGUpLAogICAgICAgIGZtdEFyZ0hvdXIuZm9ybWF0KGRhdGUpLAogICAgICAgIGNzdk51bWJlcihtZXAsIDIpLAogICAgICAgIGNzdk51bWJlcihjY2wsIDIpLAogICAgICAgIGNzdk51bWJlcihhYnMsIDIpLAogICAgICAgIGNzdk51bWJlcihwY3QsIDIpLAogICAgICAgIGVzdGFkbwogICAgICBdLm1hcChjc3ZFc2NhcGUpLmpvaW4oJzsnKTsKICAgIH0pOwogICAgY29uc3QgYXJ0RGF0ZSA9IGZtdEFyZ0RhdGUuZm9ybWF0KG5ldyBEYXRlKCkpOwogICAgY29uc3QgZmlsZW5hbWUgPSBgaGlzdG9yaWFsLW1lcC1jY2wtJHtmaWx0ZXJDb2RlKCl9LSR7YXJ0RGF0ZX0uY3N2YDsKICAgIGNvbnN0IGNzdiA9ICdcdUZFRkYnICsgW2hlYWRlci5qb2luKCc7JyksIC4uLnJvd3NdLmpvaW4oJ1xuJyk7CiAgICBjb25zdCBibG9iID0gbmV3IEJsb2IoW2Nzdl0sIHsgdHlwZTogJ3RleHQvY3N2O2NoYXJzZXQ9dXRmLTg7JyB9KTsKICAgIGNvbnN0IHVybCA9IFVSTC5jcmVhdGVPYmplY3RVUkwoYmxvYik7CiAgICBjb25zdCBhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYScpOwogICAgYS5ocmVmID0gdXJsOwogICAgYS5kb3dubG9hZCA9IGZpbGVuYW1lOwogICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChhKTsKICAgIGEuY2xpY2soKTsKICAgIGEucmVtb3ZlKCk7CiAgICBVUkwucmV2b2tlT2JqZWN0VVJMKHVybCk7CiAgfQogIGZ1bmN0aW9uIGFwcGx5RmlsdGVyKG1vZGUpIHsKICAgIHN0YXRlLmZpbHRlck1vZGUgPSBtb2RlOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnBpbGxbZGF0YS1maWx0ZXJdJykuZm9yRWFjaCgoYnRuKSA9PiB7CiAgICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKCdvbicsIGJ0bi5kYXRhc2V0LmZpbHRlciA9PT0gbW9kZSk7CiAgICB9KTsKICAgIGlmIChzdGF0ZS5sYXN0TWVwUGF5bG9hZCkgewogICAgICByZW5kZXJUcmVuZChzdGF0ZS5sYXN0TWVwUGF5bG9hZCk7CiAgICAgIHJlbmRlckhpc3Rvcnkoc3RhdGUubGFzdE1lcFBheWxvYWQpOwogICAgICByZW5kZXJNZXRyaWNzMjRoKHN0YXRlLmxhc3RNZXBQYXlsb2FkKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHJlbmRlckhpc3RvcnkocGF5bG9hZCkgewogICAgY29uc3QgdGJvZHkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGlzdG9yeS1yb3dzJyk7CiAgICBjb25zdCBjYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGlzdG9yeS1jYXAnKTsKICAgIGlmICghdGJvZHkpIHJldHVybjsKICAgIGNvbnN0IGZpbHRlcmVkID0gZ2V0RmlsdGVyZWRIaXN0b3J5Um93cyhwYXlsb2FkKTsKICAgIGNvbnN0IHJvd3MgPSBmaWx0ZXJlZC5zbGljZSgpLnJldmVyc2UoKTsKICAgIGlmIChjYXApIGNhcC50ZXh0Q29udGVudCA9IGAke2N1cnJlbnRGaWx0ZXJMYWJlbCgpfSDCtyAke3Jvd3MubGVuZ3RofSByZWdpc3Ryb3NgOwogICAgaWYgKCFyb3dzLmxlbmd0aCkgewogICAgICB0Ym9keS5pbm5lckhUTUwgPSAnPHRyPjx0ZCBjbGFzcz0iZGltIiBjb2xzcGFuPSI2Ij5TaW4gcmVnaXN0cm9zIHRvZGF2w61hPC90ZD48L3RyPic7CiAgICAgIHJldHVybjsKICAgIH0KICAgIHRib2R5LmlubmVySFRNTCA9IHJvd3MubWFwKChyKSA9PiB7CiAgICAgIGNvbnN0IG1lcCA9IHRvTnVtYmVyKHIubWVwKTsKICAgICAgY29uc3QgY2NsID0gdG9OdW1iZXIoci5jY2wpOwogICAgICBjb25zdCBhYnMgPSB0b051bWJlcihyLmFic19kaWZmKTsKICAgICAgY29uc3QgcGN0ID0gdG9OdW1iZXIoci5wY3RfZGlmZik7CiAgICAgIGNvbnN0IHNpbSA9IEJvb2xlYW4oci5zaW1pbGFyKTsKICAgICAgcmV0dXJuIGA8dHI+CiAgICAgICAgPHRkIGNsYXNzPSJkaW0iPjxkaXYgY2xhc3M9InRzLWRheSI+JHtmbXRBcmdEYXlNb250aC5mb3JtYXQobmV3IERhdGUoci5lcG9jaCAqIDEwMDApKX08L2Rpdj48ZGl2IGNsYXNzPSJ0cy1ob3VyIj4ke3Jvd0hvdXJMYWJlbChyLmVwb2NoKX08L2Rpdj48L3RkPgogICAgICAgIDx0ZCBzdHlsZT0iY29sb3I6dmFyKC0tbWVwKSI+JHtmb3JtYXRNb25leShtZXAsIDIpfTwvdGQ+CiAgICAgICAgPHRkIHN0eWxlPSJjb2xvcjp2YXIoLS1jY2wpIj4ke2Zvcm1hdE1vbmV5KGNjbCwgMil9PC90ZD4KICAgICAgICA8dGQ+JHtmb3JtYXRNb25leShhYnMsIDIpfTwvdGQ+CiAgICAgICAgPHRkPiR7Zm9ybWF0UGVyY2VudChwY3QsIDIpfTwvdGQ+CiAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJzYmFkZ2UgJHtzaW0gPyAnc2ltJyA6ICdub3NpbSd9Ij4ke3NpbSA/ICdTaW1pbGFyJyA6ICdObyBzaW1pbGFyJ308L3NwYW4+PC90ZD4KICAgICAgPC90cj5gOwogICAgfSkuam9pbignJyk7CiAgfQoKICBmdW5jdGlvbiBsaW5lUG9pbnRzKHZhbHVlcywgeDAsIHgxLCB5MCwgeTEsIG1pblZhbHVlLCBtYXhWYWx1ZSkgewogICAgaWYgKCF2YWx1ZXMubGVuZ3RoKSByZXR1cm4gJyc7CiAgICBjb25zdCBtaW4gPSBOdW1iZXIuaXNGaW5pdGUobWluVmFsdWUpID8gbWluVmFsdWUgOiBNYXRoLm1pbiguLi52YWx1ZXMpOwogICAgY29uc3QgbWF4ID0gTnVtYmVyLmlzRmluaXRlKG1heFZhbHVlKSA/IG1heFZhbHVlIDogTWF0aC5tYXgoLi4udmFsdWVzKTsKICAgIGNvbnN0IHNwYW4gPSBNYXRoLm1heCgwLjAwMDAwMSwgbWF4IC0gbWluKTsKICAgIHJldHVybiB2YWx1ZXMubWFwKCh2LCBpKSA9PiB7CiAgICAgIGNvbnN0IHggPSB4MCArICgoeDEgLSB4MCkgKiBpIC8gTWF0aC5tYXgoMSwgdmFsdWVzLmxlbmd0aCAtIDEpKTsKICAgICAgY29uc3QgeSA9IHkxIC0gKCh2IC0gbWluKSAvIHNwYW4pICogKHkxIC0geTApOwogICAgICByZXR1cm4gYCR7eC50b0ZpeGVkKDIpfSwke3kudG9GaXhlZCgyKX1gOwogICAgfSkuam9pbignICcpOwogIH0KICBmdW5jdGlvbiB2YWx1ZVRvWSh2YWx1ZSwgeTAsIHkxLCBtaW5WYWx1ZSwgbWF4VmFsdWUpIHsKICAgIGNvbnN0IHNwYW4gPSBNYXRoLm1heCgwLjAwMDAwMSwgbWF4VmFsdWUgLSBtaW5WYWx1ZSk7CiAgICByZXR1cm4geTEgLSAoKHZhbHVlIC0gbWluVmFsdWUpIC8gc3BhbikgKiAoeTEgLSB5MCk7CiAgfQogIGZ1bmN0aW9uIGNhbGNCcmVjaGFQY3QobWVwLCBjY2wpIHsKICAgIGlmICghTnVtYmVyLmlzRmluaXRlKG1lcCkgfHwgIU51bWJlci5pc0Zpbml0ZShjY2wpKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGF2ZyA9IChtZXAgKyBjY2wpIC8gMjsKICAgIGlmICghYXZnKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiAoTWF0aC5hYnMobWVwIC0gY2NsKSAvIGF2ZykgKiAxMDA7CiAgfQogIGZ1bmN0aW9uIGhpZGVUcmVuZEhvdmVyKCkgewogICAgY29uc3QgdGlwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLXRvb2x0aXAnKTsKICAgIGNvbnN0IGxpbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItbGluZScpOwogICAgY29uc3QgbWVwRG90ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLW1lcCcpOwogICAgY29uc3QgY2NsRG90ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLWNjbCcpOwogICAgaWYgKHRpcCkgdGlwLnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcwJyk7CiAgICBpZiAobGluZSkgbGluZS5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMCcpOwogICAgaWYgKG1lcERvdCkgbWVwRG90LnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcwJyk7CiAgICBpZiAoY2NsRG90KSBjY2xEb3Quc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzAnKTsKICB9CiAgZnVuY3Rpb24gcmVuZGVyVHJlbmRIb3Zlcihwb2ludCkgewogICAgY29uc3QgdGlwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLXRvb2x0aXAnKTsKICAgIGNvbnN0IGJnID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLXRvb2x0aXAtYmcnKTsKICAgIGNvbnN0IGxpbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItbGluZScpOwogICAgY29uc3QgbWVwRG90ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLW1lcCcpOwogICAgY29uc3QgY2NsRG90ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLWNjbCcpOwogICAgaWYgKCF0aXAgfHwgIWJnIHx8ICFsaW5lIHx8ICFtZXBEb3QgfHwgIWNjbERvdCB8fCAhcG9pbnQpIHJldHVybjsKCiAgICBsaW5lLnNldEF0dHJpYnV0ZSgneDEnLCBwb2ludC54LnRvRml4ZWQoMikpOwogICAgbGluZS5zZXRBdHRyaWJ1dGUoJ3gyJywgcG9pbnQueC50b0ZpeGVkKDIpKTsKICAgIGxpbmUuc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzEnKTsKICAgIG1lcERvdC5zZXRBdHRyaWJ1dGUoJ2N4JywgcG9pbnQueC50b0ZpeGVkKDIpKTsKICAgIG1lcERvdC5zZXRBdHRyaWJ1dGUoJ2N5JywgcG9pbnQubWVwWS50b0ZpeGVkKDIpKTsKICAgIG1lcERvdC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMScpOwogICAgY2NsRG90LnNldEF0dHJpYnV0ZSgnY3gnLCBwb2ludC54LnRvRml4ZWQoMikpOwogICAgY2NsRG90LnNldEF0dHJpYnV0ZSgnY3knLCBwb2ludC5jY2xZLnRvRml4ZWQoMikpOwogICAgY2NsRG90LnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcxJyk7CgogICAgc2V0VGV4dCgndHJlbmQtdGlwLXRpbWUnLCByb3dEYXlIb3VyTGFiZWwocG9pbnQuZXBvY2gpKTsKICAgIHNldFRleHQoJ3RyZW5kLXRpcC1tZXAnLCBgTUVQICR7Zm9ybWF0TW9uZXkocG9pbnQubWVwLCAyKX1gKTsKICAgIHNldFRleHQoJ3RyZW5kLXRpcC1jY2wnLCBgQ0NMICR7Zm9ybWF0TW9uZXkocG9pbnQuY2NsLCAyKX1gKTsKICAgIHNldFRleHQoJ3RyZW5kLXRpcC1nYXAnLCBgQnJlY2hhICR7Zm9ybWF0UGVyY2VudChwb2ludC5wY3QsIDIpfWApOwoKICAgIGNvbnN0IHRpcFcgPSAxNDg7CiAgICBjb25zdCB0aXBIID0gNTY7CiAgICBjb25zdCB0aXBYID0gTWF0aC5taW4oODQwIC0gdGlwVywgTWF0aC5tYXgoMzAsIHBvaW50LnggKyAxMCkpOwogICAgY29uc3QgdGlwWSA9IE1hdGgubWluKDEwMCwgTWF0aC5tYXgoMTgsIE1hdGgubWluKHBvaW50Lm1lcFksIHBvaW50LmNjbFkpIC0gdGlwSCAtIDQpKTsKICAgIHRpcC5zZXRBdHRyaWJ1dGUoJ3RyYW5zZm9ybScsIGB0cmFuc2xhdGUoJHt0aXBYLnRvRml4ZWQoMil9ICR7dGlwWS50b0ZpeGVkKDIpfSlgKTsKICAgIGJnLnNldEF0dHJpYnV0ZSgnd2lkdGgnLCBTdHJpbmcodGlwVykpOwogICAgYmcuc2V0QXR0cmlidXRlKCdoZWlnaHQnLCBTdHJpbmcodGlwSCkpOwogICAgdGlwLnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcxJyk7CiAgfQogIGZ1bmN0aW9uIGJpbmRUcmVuZEhvdmVyKCkgewogICAgaWYgKHN0YXRlLnRyZW5kSG92ZXJCb3VuZCkgcmV0dXJuOwogICAgY29uc3QgY2hhcnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtY2hhcnQnKTsKICAgIGlmICghY2hhcnQpIHJldHVybjsKICAgIHN0YXRlLnRyZW5kSG92ZXJCb3VuZCA9IHRydWU7CgogICAgY2hhcnQuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VsZWF2ZScsICgpID0+IGhpZGVUcmVuZEhvdmVyKCkpOwogICAgY2hhcnQuYWRkRXZlbnRMaXN0ZW5lcignbW91c2Vtb3ZlJywgKGV2ZW50KSA9PiB7CiAgICAgIGlmICghc3RhdGUudHJlbmRSb3dzLmxlbmd0aCkgcmV0dXJuOwogICAgICBjb25zdCBjdG0gPSBjaGFydC5nZXRTY3JlZW5DVE0oKTsKICAgICAgaWYgKCFjdG0pIHJldHVybjsKICAgICAgY29uc3QgcHQgPSBjaGFydC5jcmVhdGVTVkdQb2ludCgpOwogICAgICBwdC54ID0gZXZlbnQuY2xpZW50WDsKICAgICAgcHQueSA9IGV2ZW50LmNsaWVudFk7CiAgICAgIGNvbnN0IGxvY2FsID0gcHQubWF0cml4VHJhbnNmb3JtKGN0bS5pbnZlcnNlKCkpOwogICAgICBjb25zdCB4ID0gTWF0aC5tYXgoMzAsIE1hdGgubWluKDg0MCwgbG9jYWwueCkpOwogICAgICBsZXQgbmVhcmVzdCA9IHN0YXRlLnRyZW5kUm93c1swXTsKICAgICAgbGV0IGJlc3QgPSBNYXRoLmFicyhuZWFyZXN0LnggLSB4KTsKICAgICAgZm9yIChsZXQgaSA9IDE7IGkgPCBzdGF0ZS50cmVuZFJvd3MubGVuZ3RoOyBpKyspIHsKICAgICAgICBjb25zdCBkID0gTWF0aC5hYnMoc3RhdGUudHJlbmRSb3dzW2ldLnggLSB4KTsKICAgICAgICBpZiAoZCA8IGJlc3QpIHsKICAgICAgICAgIGJlc3QgPSBkOwogICAgICAgICAgbmVhcmVzdCA9IHN0YXRlLnRyZW5kUm93c1tpXTsKICAgICAgICB9CiAgICAgIH0KICAgICAgcmVuZGVyVHJlbmRIb3ZlcihuZWFyZXN0KTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyVHJlbmQocGF5bG9hZCkgewogICAgY29uc3QgaGlzdG9yeSA9IGRvd25zYW1wbGVSb3dzKGZpbHRlckhpc3RvcnlSb3dzKGV4dHJhY3RIaXN0b3J5Um93cyhwYXlsb2FkKSwgc3RhdGUuZmlsdGVyTW9kZSksIFRSRU5EX01BWF9QT0lOVFMpOwogICAgY29uc3QgbWVwTGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1tZXAtbGluZScpOwogICAgY29uc3QgY2NsTGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1jY2wtbGluZScpOwogICAgaWYgKCFtZXBMaW5lIHx8ICFjY2xMaW5lKSByZXR1cm47CiAgICBiaW5kVHJlbmRIb3ZlcigpOwogICAgaWYgKCFoaXN0b3J5Lmxlbmd0aCkgewogICAgICBtZXBMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgJycpOwogICAgICBjY2xMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgJycpOwogICAgICBzdGF0ZS50cmVuZFJvd3MgPSBbXTsKICAgICAgaGlkZVRyZW5kSG92ZXIoKTsKICAgICAgWyd0cmVuZC15LXRvcCcsICd0cmVuZC15LW1pZCcsICd0cmVuZC15LWxvdycsICd0cmVuZC14LTEnLCAndHJlbmQteC0yJywgJ3RyZW5kLXgtMycsICd0cmVuZC14LTQnLCAndHJlbmQteC01J10uZm9yRWFjaCgoaWQpID0+IHNldFRleHQoaWQsICfigJQnKSk7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICBjb25zdCByb3dzID0gaGlzdG9yeQogICAgICAubWFwKChyKSA9PiAoewogICAgICAgIGVwb2NoOiByLmVwb2NoLAogICAgICAgIG1lcDogdG9OdW1iZXIoci5tZXApLAogICAgICAgIGNjbDogdG9OdW1iZXIoci5jY2wpLAogICAgICAgIHBjdDogdG9OdW1iZXIoci5wY3RfZGlmZikKICAgICAgfSkpCiAgICAgIC5maWx0ZXIoKHIpID0+IHIubWVwICE9IG51bGwgJiYgci5jY2wgIT0gbnVsbCk7CiAgICBpZiAoIXJvd3MubGVuZ3RoKSByZXR1cm47CgogICAgY29uc3QgbWVwVmFscyA9IHJvd3MubWFwKChyKSA9PiByLm1lcCk7CiAgICBjb25zdCBjY2xWYWxzID0gcm93cy5tYXAoKHIpID0+IHIuY2NsKTsKCiAgICAvLyBFc2NhbGEgY29tcGFydGlkYSBwYXJhIE1FUCB5IENDTDogY29tcGFyYWNpw7NuIHZpc3VhbCBmaWVsLgogICAgY29uc3QgYWxsUHJpY2VWYWxzID0gbWVwVmFscy5jb25jYXQoY2NsVmFscyk7CiAgICBjb25zdCByYXdNaW4gPSBNYXRoLm1pbiguLi5hbGxQcmljZVZhbHMpOwogICAgY29uc3QgcmF3TWF4ID0gTWF0aC5tYXgoLi4uYWxsUHJpY2VWYWxzKTsKICAgIGNvbnN0IHByaWNlUGFkID0gTWF0aC5tYXgoMSwgKHJhd01heCAtIHJhd01pbikgKiAwLjA4KTsKICAgIGNvbnN0IHByaWNlTWluID0gcmF3TWluIC0gcHJpY2VQYWQ7CiAgICBjb25zdCBwcmljZU1heCA9IHJhd01heCArIHByaWNlUGFkOwoKICAgIG1lcExpbmUuc2V0QXR0cmlidXRlKCdwb2ludHMnLCBsaW5lUG9pbnRzKG1lcFZhbHMsIDMwLCA4NDAsIDI1LCAxMzAsIHByaWNlTWluLCBwcmljZU1heCkpOwogICAgY2NsTGluZS5zZXRBdHRyaWJ1dGUoJ3BvaW50cycsIGxpbmVQb2ludHMoY2NsVmFscywgMzAsIDg0MCwgMjUsIDEzMCwgcHJpY2VNaW4sIHByaWNlTWF4KSk7CiAgICBzdGF0ZS50cmVuZFJvd3MgPSByb3dzLm1hcCgociwgaSkgPT4gewogICAgICBjb25zdCB4ID0gMzAgKyAoKDg0MCAtIDMwKSAqIGkgLyBNYXRoLm1heCgxLCByb3dzLmxlbmd0aCAtIDEpKTsKICAgICAgcmV0dXJuIHsKICAgICAgICBlcG9jaDogci5lcG9jaCwKICAgICAgICBtZXA6IHIubWVwLAogICAgICAgIGNjbDogci5jY2wsCiAgICAgICAgcGN0OiBjYWxjQnJlY2hhUGN0KHIubWVwLCByLmNjbCksCiAgICAgICAgeCwKICAgICAgICBtZXBZOiB2YWx1ZVRvWShyLm1lcCwgMjUsIDEzMCwgcHJpY2VNaW4sIHByaWNlTWF4KSwKICAgICAgICBjY2xZOiB2YWx1ZVRvWShyLmNjbCwgMjUsIDEzMCwgcHJpY2VNaW4sIHByaWNlTWF4KQogICAgICB9OwogICAgfSk7CiAgICBoaWRlVHJlbmRIb3ZlcigpOwoKICAgIGNvbnN0IG1pZCA9IChwcmljZU1pbiArIHByaWNlTWF4KSAvIDI7CiAgICBzZXRUZXh0KCd0cmVuZC15LXRvcCcsIChwcmljZU1heCAvIDEwMDApLnRvRml4ZWQoMykpOwogICAgc2V0VGV4dCgndHJlbmQteS1taWQnLCAobWlkIC8gMTAwMCkudG9GaXhlZCgzKSk7CiAgICBzZXRUZXh0KCd0cmVuZC15LWxvdycsIChwcmljZU1pbiAvIDEwMDApLnRvRml4ZWQoMykpOwoKICAgIGNvbnN0IGlkeCA9IFswLCAwLjI1LCAwLjUsIDAuNzUsIDFdLm1hcCgocCkgPT4gTWF0aC5taW4ocm93cy5sZW5ndGggLSAxLCBNYXRoLmZsb29yKChyb3dzLmxlbmd0aCAtIDEpICogcCkpKTsKICAgIGNvbnN0IGxhYnMgPSBpZHgubWFwKChpKSA9PiByb3dEYXlIb3VyTGFiZWwocm93c1tpXT8uZXBvY2gpKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtMScsIGxhYnNbMF0gfHwgJ+KAlCcpOwogICAgc2V0VGV4dCgndHJlbmQteC0yJywgbGFic1sxXSB8fCAn4oCUJyk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTMnLCBsYWJzWzJdIHx8ICfigJQnKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtNCcsIGxhYnNbM10gfHwgJ+KAlCcpOwogICAgc2V0VGV4dCgndHJlbmQteC01JywgbGFic1s0XSB8fCAn4oCUJyk7CiAgfQoKICBmdW5jdGlvbiBnZXRGY2lUeXBlTGFiZWwodHlwZSkgewogICAgcmV0dXJuIHR5cGUgPT09ICd2YXJpYWJsZScgPyAnUmVudGEgdmFyaWFibGUgKEZDSSBBcmdlbnRpbmEpJyA6ICdSZW50YSBmaWphIChGQ0kgQXJnZW50aW5hKSc7CiAgfQoKICBmdW5jdGlvbiBzZXRGY2lUeXBlKHR5cGUpIHsKICAgIGNvbnN0IG5leHQgPSB0eXBlID09PSAndmFyaWFibGUnID8gJ3ZhcmlhYmxlJyA6ICdmaWphJzsKICAgIGlmIChzdGF0ZS5mY2lUeXBlID09PSBuZXh0KSByZXR1cm47CiAgICBzdGF0ZS5mY2lUeXBlID0gbmV4dDsKICAgIHN0YXRlLmZjaVBhZ2UgPSAxOwogICAgcmVuZGVyRmNpUmVudGFGaWphKCk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJGY2lSZW50YUZpamEocGF5bG9hZCwgcHJldmlvdXNQYXlsb2FkLCB0eXBlID0gc3RhdGUuZmNpVHlwZSkgewogICAgY29uc3Qgbm9ybWFsaXplZFR5cGUgPSB0eXBlID09PSAndmFyaWFibGUnID8gJ3ZhcmlhYmxlJyA6ICdmaWphJzsKICAgIGNvbnN0IHJvd3NFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktcm93cycpOwogICAgY29uc3QgZW1wdHlFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktZW1wdHknKTsKICAgIGlmICghcm93c0VsIHx8ICFlbXB0eUVsKSByZXR1cm47CgogICAgY29uc3QgdGl0bGVFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktdGl0bGUnKTsKICAgIGlmICh0aXRsZUVsKSB0aXRsZUVsLnRleHRDb250ZW50ID0gZ2V0RmNpVHlwZUxhYmVsKHN0YXRlLmZjaVR5cGUpOwogICAgY29uc3QgdGFiRmlqYSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktdGFiLWZpamEnKTsKICAgIGNvbnN0IHRhYlZhcmlhYmxlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS10YWItdmFyaWFibGUnKTsKICAgIGlmICh0YWJGaWphKSB0YWJGaWphLmNsYXNzTGlzdC50b2dnbGUoJ2FjdGl2ZScsIHN0YXRlLmZjaVR5cGUgPT09ICdmaWphJyk7CiAgICBpZiAodGFiVmFyaWFibGUpIHRhYlZhcmlhYmxlLmNsYXNzTGlzdC50b2dnbGUoJ2FjdGl2ZScsIHN0YXRlLmZjaVR5cGUgPT09ICd2YXJpYWJsZScpOwoKICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID4gMSkgewogICAgICBjb25zdCBwcmV2aW91c1Jvd3MgPSBub3JtYWxpemVGY2lSb3dzKHByZXZpb3VzUGF5bG9hZCkKICAgICAgICAubWFwKChpdGVtKSA9PiB7CiAgICAgICAgICBjb25zdCBmb25kbyA9IFN0cmluZyhpdGVtPy5mb25kbyB8fCBpdGVtPy5ub21icmUgfHwgaXRlbT8uZmNpIHx8ICcnKS50cmltKCk7CiAgICAgICAgICByZXR1cm4gewogICAgICAgICAgICBmb25kbywKICAgICAgICAgICAgdmNwOiB0b051bWJlcihpdGVtPy52Y3ApLAogICAgICAgICAgICBjY3A6IHRvTnVtYmVyKGl0ZW0/LmNjcCksCiAgICAgICAgICAgIHBhdHJpbW9uaW86IHRvTnVtYmVyKGl0ZW0/LnBhdHJpbW9uaW8pLAogICAgICAgICAgfTsKICAgICAgICB9KQogICAgICAgIC5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uZm9uZG8pOwogICAgICBjb25zdCBwcmV2aW91c0J5Rm9uZG8gPSBuZXcgTWFwKCk7CiAgICAgIHByZXZpb3VzUm93cy5mb3JFYWNoKChpdGVtKSA9PiB7CiAgICAgICAgcHJldmlvdXNCeUZvbmRvLnNldChub3JtYWxpemVGY2lGb25kb0tleShpdGVtLmZvbmRvKSwgaXRlbSk7CiAgICAgIH0pOwogICAgICBzdGF0ZS5mY2lQcmV2aW91c0J5Rm9uZG9CeVR5cGVbbm9ybWFsaXplZFR5cGVdID0gcHJldmlvdXNCeUZvbmRvOwogICAgfQogICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPiAwKSB7CiAgICAgIGNvbnN0IHJvd3MgPSBub3JtYWxpemVGY2lSb3dzKHBheWxvYWQpCiAgICAgICAgLm1hcCgoaXRlbSkgPT4gewogICAgICAgICAgY29uc3QgZm9uZG8gPSBTdHJpbmcoaXRlbT8uZm9uZG8gfHwgaXRlbT8ubm9tYnJlIHx8IGl0ZW0/LmZjaSB8fCAnJykudHJpbSgpOwogICAgICAgICAgY29uc3QgZmVjaGEgPSBTdHJpbmcoaXRlbT8uZmVjaGEgfHwgJycpLnRyaW0oKTsKICAgICAgICAgIGNvbnN0IHZjcCA9IHRvTnVtYmVyKGl0ZW0/LnZjcCk7CiAgICAgICAgICBjb25zdCBjY3AgPSB0b051bWJlcihpdGVtPy5jY3ApOwogICAgICAgICAgY29uc3QgcGF0cmltb25pbyA9IHRvTnVtYmVyKGl0ZW0/LnBhdHJpbW9uaW8pOwogICAgICAgICAgY29uc3QgaG9yaXpvbnRlID0gU3RyaW5nKGl0ZW0/Lmhvcml6b250ZSB8fCAnJykudHJpbSgpOwogICAgICAgICAgY29uc3QgcHJldmlvdXMgPSBzdGF0ZS5mY2lQcmV2aW91c0J5Rm9uZG9CeVR5cGVbbm9ybWFsaXplZFR5cGVdLmdldChub3JtYWxpemVGY2lGb25kb0tleShmb25kbykpOwogICAgICAgICAgcmV0dXJuIHsKICAgICAgICAgICAgZm9uZG8sCiAgICAgICAgICAgIGZlY2hhLAogICAgICAgICAgICB2Y3AsCiAgICAgICAgICAgIGNjcCwKICAgICAgICAgICAgcGF0cmltb25pbywKICAgICAgICAgICAgaG9yaXpvbnRlLAogICAgICAgICAgICB2Y3BUcmVuZDogZmNpVHJlbmREaXIodmNwLCBwcmV2aW91cz8udmNwKSwKICAgICAgICAgICAgY2NwVHJlbmQ6IGZjaVRyZW5kRGlyKGNjcCwgcHJldmlvdXM/LmNjcCksCiAgICAgICAgICAgIHBhdHJpbW9uaW9UcmVuZDogZmNpVHJlbmREaXIocGF0cmltb25pbywgcHJldmlvdXM/LnBhdHJpbW9uaW8pLAogICAgICAgICAgfTsKICAgICAgICB9KQogICAgICAgIC5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uZm9uZG8gJiYgKGl0ZW0udmNwICE9PSBudWxsIHx8IGl0ZW0uZmVjaGEpKTsKICAgICAgY29uc3Qgc29ydGVkUm93cyA9IHJvd3Muc2xpY2UoKS5zb3J0KChhLCBiKSA9PiAoYi5wYXRyaW1vbmlvID8/IC1JbmZpbml0eSkgLSAoYS5wYXRyaW1vbmlvID8/IC1JbmZpbml0eSkpOwogICAgICBzdGF0ZS5mY2lSb3dzQnlUeXBlW25vcm1hbGl6ZWRUeXBlXSA9IHNvcnRlZFJvd3M7CiAgICAgIHN0YXRlLmZjaURhdGVCeVR5cGVbbm9ybWFsaXplZFR5cGVdID0gc29ydGVkUm93cy5maW5kKChyb3cpID0+IHJvdy5mZWNoYSk/LmZlY2hhIHx8ICfigJQnOwogICAgICBpZiAobm9ybWFsaXplZFR5cGUgPT09IHN0YXRlLmZjaVR5cGUpIHN0YXRlLmZjaVBhZ2UgPSAxOwogICAgfQoKICAgIGNvbnN0IGFjdGl2ZVJvd3MgPSBzdGF0ZS5mY2lSb3dzQnlUeXBlW3N0YXRlLmZjaVR5cGVdIHx8IFtdOwogICAgY29uc3QgcXVlcnkgPSBzdGF0ZS5mY2lRdWVyeS50cmltKCkudG9Mb3dlckNhc2UoKTsKICAgIGNvbnN0IGZpbHRlcmVkID0gcXVlcnkKICAgICAgPyBhY3RpdmVSb3dzLmZpbHRlcigocm93KSA9PiByb3cuZm9uZG8udG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxdWVyeSkpCiAgICAgIDogYWN0aXZlUm93cy5zbGljZSgpOwoKICAgIGNvbnN0IHRvdGFsUGFnZXMgPSBNYXRoLm1heCgxLCBNYXRoLmNlaWwoZmlsdGVyZWQubGVuZ3RoIC8gRkNJX1BBR0VfU0laRSkpOwogICAgc3RhdGUuZmNpUGFnZSA9IE1hdGgubWluKE1hdGgubWF4KDEsIHN0YXRlLmZjaVBhZ2UpLCB0b3RhbFBhZ2VzKTsKICAgIGNvbnN0IGZyb20gPSAoc3RhdGUuZmNpUGFnZSAtIDEpICogRkNJX1BBR0VfU0laRTsKICAgIGNvbnN0IHBhZ2VSb3dzID0gZmlsdGVyZWQuc2xpY2UoZnJvbSwgZnJvbSArIEZDSV9QQUdFX1NJWkUpOwoKICAgIGNvbnN0IGRhdGVFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktbGFzdC1kYXRlJyk7CiAgICBjb25zdCBmaXJzdERhdGUgPSBmaWx0ZXJlZC5maW5kKChyb3cpID0+IHJvdy5mZWNoYSk/LmZlY2hhIHx8IHN0YXRlLmZjaURhdGVCeVR5cGVbc3RhdGUuZmNpVHlwZV0gfHwgJ+KAlCc7CiAgICBpZiAoZGF0ZUVsKSBkYXRlRWwudGV4dENvbnRlbnQgPSBgRmVjaGE6ICR7Zmlyc3REYXRlfWA7CiAgICBzZXRUZXh0KCdmY2ktcGFnZS1pbmZvJywgYCR7c3RhdGUuZmNpUGFnZX0gLyAke3RvdGFsUGFnZXN9YCk7CiAgICBjb25zdCBwcmV2QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1wcmV2Jyk7CiAgICBjb25zdCBuZXh0QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1uZXh0Jyk7CiAgICBpZiAocHJldkJ0bikgcHJldkJ0bi5kaXNhYmxlZCA9IHN0YXRlLmZjaVBhZ2UgPD0gMTsKICAgIGlmIChuZXh0QnRuKSBuZXh0QnRuLmRpc2FibGVkID0gc3RhdGUuZmNpUGFnZSA+PSB0b3RhbFBhZ2VzOwoKICAgIGlmICghcGFnZVJvd3MubGVuZ3RoKSB7CiAgICAgIHJvd3NFbC5pbm5lckhUTUwgPSAnJzsKICAgICAgaWYgKHF1ZXJ5KSBlbXB0eUVsLnRleHRDb250ZW50ID0gJ05vIGhheSByZXN1bHRhZG9zIHBhcmEgbGEgYsO6c3F1ZWRhIGluZGljYWRhLic7CiAgICAgIGVsc2UgZW1wdHlFbC50ZXh0Q29udGVudCA9IGBObyBoYXkgZGF0b3MgZGUgJHtzdGF0ZS5mY2lUeXBlID09PSAndmFyaWFibGUnID8gJ3JlbnRhIHZhcmlhYmxlJyA6ICdyZW50YSBmaWphJ30gZGlzcG9uaWJsZXMgZW4gZXN0ZSBtb21lbnRvLmA7CiAgICAgIGVtcHR5RWwuc3R5bGUuZGlzcGxheSA9ICdibG9jayc7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICBlbXB0eUVsLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgICByb3dzRWwuaW5uZXJIVE1MID0gcGFnZVJvd3MubWFwKChyb3cpID0+IGAKICAgICAgPHRyPgogICAgICAgIDx0ZCB0aXRsZT0iJHtlc2NhcGVIdG1sKHJvdy5mb25kbyl9Ij4ke2VzY2FwZUh0bWwocm93LmZvbmRvKX08L3RkPgogICAgICAgIDx0ZD4ke3JlbmRlckZjaVRyZW5kVmFsdWUocm93LnZjcCwgcm93LnZjcFRyZW5kKX08L3RkPgogICAgICAgIDx0ZD4ke3JlbmRlckZjaVRyZW5kVmFsdWUocm93LmNjcCwgcm93LmNjcFRyZW5kKX08L3RkPgogICAgICAgIDx0ZD4ke3JlbmRlckZjaVRyZW5kVmFsdWUocm93LnBhdHJpbW9uaW8sIHJvdy5wYXRyaW1vbmlvVHJlbmQpfTwvdGQ+CiAgICAgICAgPHRkPiR7ZXNjYXBlSHRtbChyb3cuaG9yaXpvbnRlIHx8ICfigJQnKX08L3RkPgogICAgICA8L3RyPgogICAgYCkuam9pbignJyk7CiAgfQoKICAvLyA0KSBGdW5jacOzbiBjZW50cmFsIGZldGNoQWxsKCkKICBhc3luYyBmdW5jdGlvbiBmZXRjaEpzb24odXJsKSB7CiAgICBjb25zdCBjdHJsID0gbmV3IEFib3J0Q29udHJvbGxlcigpOwogICAgY29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4gY3RybC5hYm9ydCgpLCAxMjAwMCk7CiAgICB0cnkgewogICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6ICduby1zdG9yZScsIHNpZ25hbDogY3RybC5zaWduYWwgfSk7CiAgICAgIGlmICghcmVzLm9rKSB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXMuc3RhdHVzfWApOwogICAgICByZXR1cm4gYXdhaXQgcmVzLmpzb24oKTsKICAgIH0gZmluYWxseSB7CiAgICAgIGNsZWFyVGltZW91dCh0aW1lb3V0KTsKICAgIH0KICB9CgogIGFzeW5jIGZ1bmN0aW9uIGZldGNoQWxsKG9wdGlvbnMgPSB7fSkgewogICAgaWYgKHN0YXRlLmlzRmV0Y2hpbmcpIHJldHVybjsKICAgIHN0YXRlLmlzRmV0Y2hpbmcgPSB0cnVlOwogICAgc2V0TG9hZGluZyhOVU1FUklDX0lEUywgdHJ1ZSk7CiAgICBzZXRGcmVzaEJhZGdlKCdBY3R1YWxpemFuZG/igKYnLCAnZmV0Y2hpbmcnKTsKICAgIHNldEVycm9yQmFubmVyKGZhbHNlKTsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHRhc2tzID0gWwogICAgICAgIFsnbWVwQ2NsJywgRU5EUE9JTlRTLm1lcENjbF0sCiAgICAgICAgWydmY2lSZW50YUZpamEnLCBFTkRQT0lOVFMuZmNpUmVudGFGaWphXSwKICAgICAgICBbJ2ZjaVJlbnRhRmlqYVBlbnVsdGltbycsIEVORFBPSU5UUy5mY2lSZW50YUZpamFQZW51bHRpbW9dLAogICAgICAgIFsnZmNpUmVudGFWYXJpYWJsZScsIEVORFBPSU5UUy5mY2lSZW50YVZhcmlhYmxlXSwKICAgICAgICBbJ2ZjaVJlbnRhVmFyaWFibGVQZW51bHRpbW8nLCBFTkRQT0lOVFMuZmNpUmVudGFWYXJpYWJsZVBlbnVsdGltb10KICAgICAgXTsKCiAgICAgIGNvbnN0IHNldHRsZWQgPSBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQodGFza3MubWFwKGFzeW5jIChbbmFtZSwgdXJsXSkgPT4gewogICAgICAgIHRyeSB7CiAgICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgZmV0Y2hKc29uKHVybCk7CiAgICAgICAgICByZXR1cm4geyBuYW1lLCBkYXRhIH07CiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtSYWRhck1FUF0gZXJyb3IgZW4gJHtuYW1lfWAsIGVycm9yKTsKICAgICAgICAgIHRocm93IHsgbmFtZSwgZXJyb3IgfTsKICAgICAgICB9CiAgICAgIH0pKTsKCiAgICAgIGNvbnN0IGJhZyA9IHsKICAgICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksCiAgICAgICAgbWVwQ2NsOiBudWxsLAogICAgICAgIGZjaVJlbnRhRmlqYTogbnVsbCwKICAgICAgICBmY2lSZW50YUZpamFQZW51bHRpbW86IG51bGwsCiAgICAgICAgZmNpUmVudGFWYXJpYWJsZTogbnVsbCwKICAgICAgICBmY2lSZW50YVZhcmlhYmxlUGVudWx0aW1vOiBudWxsCiAgICAgIH07CiAgICAgIGNvbnN0IGZhaWxlZCA9IFtdOwogICAgICBzZXR0bGVkLmZvckVhY2goKHIsIGlkeCkgPT4gewogICAgICAgIGNvbnN0IG5hbWUgPSB0YXNrc1tpZHhdWzBdOwogICAgICAgIGlmIChyLnN0YXR1cyA9PT0gJ2Z1bGZpbGxlZCcpIGJhZ1tuYW1lXSA9IHIudmFsdWUuZGF0YTsKICAgICAgICBlbHNlIGZhaWxlZC5wdXNoKG5hbWUpOwogICAgICB9KTsKCiAgICAgIHJlbmRlck1lcENjbChiYWcubWVwQ2NsKTsKICAgICAgaWYgKGJhZy5mY2lSZW50YUZpamEgfHwgYmFnLmZjaVJlbnRhRmlqYVBlbnVsdGltbykgewogICAgICAgIHJlbmRlckZjaVJlbnRhRmlqYShiYWcuZmNpUmVudGFGaWphLCBiYWcuZmNpUmVudGFGaWphUGVudWx0aW1vLCAnZmlqYScpOwogICAgICB9CiAgICAgIGlmIChiYWcuZmNpUmVudGFWYXJpYWJsZSB8fCBiYWcuZmNpUmVudGFWYXJpYWJsZVBlbnVsdGltbykgewogICAgICAgIHJlbmRlckZjaVJlbnRhRmlqYShiYWcuZmNpUmVudGFWYXJpYWJsZSwgYmFnLmZjaVJlbnRhVmFyaWFibGVQZW51bHRpbW8sICd2YXJpYWJsZScpOwogICAgICB9CiAgICAgIHJlbmRlckZjaVJlbnRhRmlqYSgpOwogICAgICBzdGF0ZS5sYXN0TWVwUGF5bG9hZCA9IGJhZy5tZXBDY2w7CiAgICAgIHJlbmRlck1ldHJpY3MyNGgoYmFnLm1lcENjbCk7CiAgICAgIHJlbmRlclRyZW5kKGJhZy5tZXBDY2wpOwogICAgICByZW5kZXJIaXN0b3J5KGJhZy5tZXBDY2wpOwogICAgICBjb25zdCBtZXBSb290ID0gZXh0cmFjdFJvb3QoYmFnLm1lcENjbCk7CiAgICAgIGNvbnN0IHVwZGF0ZWRBcnQgPSB0eXBlb2YgbWVwUm9vdD8udXBkYXRlZEF0SHVtYW5BcnQgPT09ICdzdHJpbmcnID8gbWVwUm9vdC51cGRhdGVkQXRIdW1hbkFydCA6IG51bGw7CiAgICAgIGNvbnN0IHNvdXJjZVRzTXMgPSB0b051bWJlcihtZXBSb290Py5zb3VyY2VTdGF0dXM/LmxhdGVzdFNvdXJjZVRzTXMpCiAgICAgICAgPz8gdG9OdW1iZXIobWVwUm9vdD8uY3VycmVudD8ubWVwVHNNcykKICAgICAgICA/PyB0b051bWJlcihtZXBSb290Py5jdXJyZW50Py5jY2xUc01zKQogICAgICAgID8/IG51bGw7CiAgICAgIHN0YXRlLnNvdXJjZVRzTXMgPSBzb3VyY2VUc01zOwogICAgICBzZXRUZXh0KCdsYXN0LXJ1bi10aW1lJywgdXBkYXRlZEFydCB8fCBmbXRBcmdUaW1lU2VjLmZvcm1hdChuZXcgRGF0ZSgpKSk7CgogICAgICBjb25zdCBzdWNjZXNzQ291bnQgPSB0YXNrcy5sZW5ndGggLSBmYWlsZWQubGVuZ3RoOwogICAgICBpZiAoc3VjY2Vzc0NvdW50ID4gMCkgewogICAgICAgIHN0YXRlLmxhc3RTdWNjZXNzQXQgPSBEYXRlLm5vdygpOwogICAgICAgIHN0YXRlLnJldHJ5SW5kZXggPSAwOwogICAgICAgIGlmIChzdGF0ZS5yZXRyeVRpbWVyKSBjbGVhclRpbWVvdXQoc3RhdGUucmV0cnlUaW1lcik7CiAgICAgICAgc2F2ZUNhY2hlKGJhZyk7CiAgICAgICAgY29uc3QgYWdlTGFiZWwgPSBzb3VyY2VUc01zICE9IG51bGwgPyBmb3JtYXRTb3VyY2VBZ2VMYWJlbChzb3VyY2VUc01zKSA6IG51bGw7CiAgICAgICAgY29uc3QgYmFkZ2VCYXNlID0gYWdlTGFiZWwgPyBgw5psdGltYSBhY3R1YWxpemFjacOzbiBoYWNlOiAke2FnZUxhYmVsfWAgOiBgQWN0dWFsaXphZG8gwrcgJHtmbXRBcmdUaW1lLmZvcm1hdChuZXcgRGF0ZSgpKX1gOwogICAgICAgIGlmIChmYWlsZWQubGVuZ3RoKSBzZXRGcmVzaEJhZGdlKGBBY3R1YWxpemFjacOzbiBwYXJjaWFsIMK3ICR7YmFkZ2VCYXNlfWAsICdpZGxlJyk7CiAgICAgICAgZWxzZSBzZXRGcmVzaEJhZGdlKGJhZGdlQmFzZSwgJ2lkbGUnKTsKICAgICAgICByZWZyZXNoRnJlc2hCYWRnZUZyb21Tb3VyY2UoKTsKICAgICAgfSBlbHNlIHsKICAgICAgICBjb25zdCBhdHRlbXB0ID0gc3RhdGUucmV0cnlJbmRleCArIDE7CiAgICAgICAgaWYgKHN0YXRlLnJldHJ5SW5kZXggPCBSRVRSWV9ERUxBWVMubGVuZ3RoKSB7CiAgICAgICAgICBjb25zdCBkZWxheSA9IFJFVFJZX0RFTEFZU1tzdGF0ZS5yZXRyeUluZGV4XTsKICAgICAgICAgIHN0YXRlLnJldHJ5SW5kZXggKz0gMTsKICAgICAgICAgIHNldEZyZXNoQmFkZ2UoYEVycm9yIMK3IFJlaW50ZW50byBlbiAke01hdGgucm91bmQoZGVsYXkgLyAxMDAwKX1zYCwgJ2Vycm9yJyk7CiAgICAgICAgICBpZiAoc3RhdGUucmV0cnlUaW1lcikgY2xlYXJUaW1lb3V0KHN0YXRlLnJldHJ5VGltZXIpOwogICAgICAgICAgc3RhdGUucmV0cnlUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gZmV0Y2hBbGwoeyBtYW51YWw6IHRydWUgfSksIGRlbGF5KTsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgc2V0RnJlc2hCYWRnZSgnRXJyb3IgwrcgUmVpbnRlbnRhcicsICdlcnJvcicpOwogICAgICAgICAgc2V0RXJyb3JCYW5uZXIodHJ1ZSwgJ0Vycm9yIGFsIGFjdHVhbGl6YXIgwrcgUmVpbnRlbnRhcicpOwogICAgICAgICAgY29uc29sZS5lcnJvcihgW1JhZGFyTUVQXSBzZSBhZ290YXJvbiByZXRyaWVzICgke2F0dGVtcHR9IGludGVudG9zKWApOwogICAgICAgICAgaWYgKHdpbmRvdy5zY2hlZHVsZXIpIHdpbmRvdy5zY2hlZHVsZXIuc3RvcCgpOwogICAgICAgIH0KICAgICAgfQogICAgfSBmaW5hbGx5IHsKICAgICAgc2V0TG9hZGluZyhOVU1FUklDX0lEUywgZmFsc2UpOwogICAgICBzdGF0ZS5pc0ZldGNoaW5nID0gZmFsc2U7CiAgICB9CiAgfQoKICAvLyA1KSBDbGFzZSBNYXJrZXRTY2hlZHVsZXIKICBjbGFzcyBNYXJrZXRTY2hlZHVsZXIgewogICAgY29uc3RydWN0b3IoZmV0Y2hGbiwgaW50ZXJ2YWxNcyA9IDMwMDAwMCkgewogICAgICB0aGlzLmZldGNoRm4gPSBmZXRjaEZuOwogICAgICB0aGlzLmludGVydmFsTXMgPSBpbnRlcnZhbE1zOwogICAgICB0aGlzLnRpbWVyID0gbnVsbDsKICAgICAgdGhpcy53YWl0VGltZXIgPSBudWxsOwogICAgICB0aGlzLmNvdW50ZG93blRpbWVyID0gbnVsbDsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBudWxsOwogICAgICB0aGlzLnJ1bm5pbmcgPSBmYWxzZTsKICAgICAgdGhpcy5wYXVzZWQgPSBmYWxzZTsKICAgIH0KCiAgICBzdGFydCgpIHsKICAgICAgaWYgKHRoaXMucnVubmluZykgcmV0dXJuOwogICAgICB0aGlzLnJ1bm5pbmcgPSB0cnVlOwogICAgICB0aGlzLnBhdXNlZCA9IGZhbHNlOwogICAgICBpZiAodGhpcy5pc01hcmtldE9wZW4oKSkgewogICAgICAgIHNldE1hcmtldFRhZyh0cnVlKTsKICAgICAgICB0aGlzLl9zY2hlZHVsZSh0aGlzLmludGVydmFsTXMpOwogICAgICB9IGVsc2UgewogICAgICAgIHNldE1hcmtldFRhZyhmYWxzZSk7CiAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgfQogICAgICB0aGlzLl9zdGFydENvdW50ZG93bigpOwogICAgfQoKICAgIHBhdXNlKCkgewogICAgICB0aGlzLnBhdXNlZCA9IHRydWU7CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLnRpbWVyKTsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMud2FpdFRpbWVyKTsKICAgICAgdGhpcy50aW1lciA9IG51bGw7CiAgICAgIHRoaXMud2FpdFRpbWVyID0gbnVsbDsKICAgICAgdGhpcy5fc3RvcENvdW50ZG93bigpOwogICAgICBjb25zdCBjb3VudGRvd24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY291bnRkb3duLXRleHQnKTsKICAgICAgaWYgKGNvdW50ZG93bikgY291bnRkb3duLnRleHRDb250ZW50ID0gJ0FjdHVhbGl6YWNpw7NuIHBhdXNhZGEnOwogICAgfQoKICAgIHJlc3VtZSgpIHsKICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcpIHRoaXMucnVubmluZyA9IHRydWU7CiAgICAgIHRoaXMucGF1c2VkID0gZmFsc2U7CiAgICAgIGNvbnN0IGNvbnRpbnVlUmVzdW1lID0gKCkgPT4gewogICAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcodHJ1ZSk7CiAgICAgICAgICB0aGlzLl9zY2hlZHVsZSh0aGlzLmludGVydmFsTXMpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcoZmFsc2UpOwogICAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgICB9CiAgICAgICAgdGhpcy5fc3RhcnRDb3VudGRvd24oKTsKICAgICAgfTsKICAgICAgaWYgKERhdGUubm93KCkgLSBzdGF0ZS5sYXN0U3VjY2Vzc0F0ID4gdGhpcy5pbnRlcnZhbE1zKSB7CiAgICAgICAgUHJvbWlzZS5yZXNvbHZlKHRoaXMuZmV0Y2hGbih7IG1hbnVhbDogdHJ1ZSB9KSkuZmluYWxseShjb250aW51ZVJlc3VtZSk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgY29udGludWVSZXN1bWUoKTsKICAgICAgfQogICAgfQoKICAgIHN0b3AoKSB7CiAgICAgIHRoaXMucnVubmluZyA9IGZhbHNlOwogICAgICB0aGlzLnBhdXNlZCA9IGZhbHNlOwogICAgICBjbGVhclRpbWVvdXQodGhpcy50aW1lcik7CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLndhaXRUaW1lcik7CiAgICAgIHRoaXMudGltZXIgPSBudWxsOwogICAgICB0aGlzLndhaXRUaW1lciA9IG51bGw7CiAgICAgIHRoaXMubmV4dFJ1bkF0ID0gbnVsbDsKICAgICAgdGhpcy5fc3RvcENvdW50ZG93bigpOwogICAgfQoKICAgIGlzTWFya2V0T3BlbigpIHsKICAgICAgY29uc3QgcCA9IGdldEFyZ05vd1BhcnRzKCk7CiAgICAgIGNvbnN0IGJ1c2luZXNzRGF5ID0gcC53ZWVrZGF5ID49IDEgJiYgcC53ZWVrZGF5IDw9IDU7CiAgICAgIGNvbnN0IHNlY29uZHMgPSBwLmhvdXIgKiAzNjAwICsgcC5taW51dGUgKiA2MCArIHAuc2Vjb25kOwogICAgICBjb25zdCBmcm9tID0gMTAgKiAzNjAwICsgMzAgKiA2MDsKICAgICAgY29uc3QgdG8gPSAxOCAqIDM2MDA7CiAgICAgIHJldHVybiBidXNpbmVzc0RheSAmJiBzZWNvbmRzID49IGZyb20gJiYgc2Vjb25kcyA8IHRvOwogICAgfQoKICAgIGdldE5leHRSdW5UaW1lKCkgewogICAgICByZXR1cm4gdGhpcy5uZXh0UnVuQXQgPyBuZXcgRGF0ZSh0aGlzLm5leHRSdW5BdCkgOiBudWxsOwogICAgfQoKICAgIF9zY2hlZHVsZShkZWxheU1zKSB7CiAgICAgIGlmICghdGhpcy5ydW5uaW5nIHx8IHRoaXMucGF1c2VkKSByZXR1cm47CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLnRpbWVyKTsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBEYXRlLm5vdygpICsgZGVsYXlNczsKICAgICAgdGhpcy50aW1lciA9IHNldFRpbWVvdXQoYXN5bmMgKCkgPT4gewogICAgICAgIGlmICghdGhpcy5ydW5uaW5nIHx8IHRoaXMucGF1c2VkKSByZXR1cm47CiAgICAgICAgaWYgKCF0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcoZmFsc2UpOwogICAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgc2V0TWFya2V0VGFnKHRydWUpOwogICAgICAgIGF3YWl0IHRoaXMuZmV0Y2hGbigpOwogICAgICAgIHRoaXMuX3NjaGVkdWxlKHRoaXMuaW50ZXJ2YWxNcyk7CiAgICAgIH0sIGRlbGF5TXMpOwogICAgfQoKICAgIF93YWl0Rm9yT3BlbigpIHsKICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMud2FpdFRpbWVyKTsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBEYXRlLm5vdygpICsgNjAwMDA7CiAgICAgIHRoaXMud2FpdFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7CiAgICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgICBpZiAodGhpcy5pc01hcmtldE9wZW4oKSkgewogICAgICAgICAgc2V0TWFya2V0VGFnKHRydWUpOwogICAgICAgICAgdGhpcy5mZXRjaEZuKHsgbWFudWFsOiB0cnVlIH0pOwogICAgICAgICAgdGhpcy5fc2NoZWR1bGUodGhpcy5pbnRlcnZhbE1zKTsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgc2V0TWFya2V0VGFnKGZhbHNlKTsKICAgICAgICAgIHRoaXMuX3dhaXRGb3JPcGVuKCk7CiAgICAgICAgfQogICAgICB9LCA2MDAwMCk7CiAgICB9CgogICAgX3N0YXJ0Q291bnRkb3duKCkgewogICAgICB0aGlzLl9zdG9wQ291bnRkb3duKCk7CiAgICAgIHRoaXMuY291bnRkb3duVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7CiAgICAgICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY291bnRkb3duLXRleHQnKTsKICAgICAgICBpZiAoIWVsIHx8IHRoaXMucGF1c2VkKSByZXR1cm47CiAgICAgICAgY29uc3QgbmV4dCA9IHRoaXMuZ2V0TmV4dFJ1blRpbWUoKTsKICAgICAgICBpZiAoIW5leHQpIHsKICAgICAgICAgIGVsLnRleHRDb250ZW50ID0gdGhpcy5pc01hcmtldE9wZW4oKSA/ICdQcsOzeGltYSBhY3R1YWxpemFjacOzbiBlbiDigJQnIDogJ01lcmNhZG8gY2VycmFkbyc7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIGNvbnN0IGRpZmYgPSBNYXRoLm1heCgwLCBuZXh0LmdldFRpbWUoKSAtIERhdGUubm93KCkpOwogICAgICAgIGNvbnN0IG0gPSBNYXRoLmZsb29yKGRpZmYgLyA2MDAwMCk7CiAgICAgICAgY29uc3QgcyA9IE1hdGguZmxvb3IoKGRpZmYgJSA2MDAwMCkgLyAxMDAwKTsKICAgICAgICBpZiAodGhpcy5pc01hcmtldE9wZW4oKSkgZWwudGV4dENvbnRlbnQgPSBgUHLDs3hpbWEgYWN0dWFsaXphY2nDs24gZW4gJHttfToke1N0cmluZyhzKS5wYWRTdGFydCgyLCAnMCcpfWA7CiAgICAgICAgZWxzZSBlbC50ZXh0Q29udGVudCA9ICdNZXJjYWRvIGNlcnJhZG8nOwogICAgICB9LCAxMDAwKTsKICAgIH0KCiAgICBfc3RvcENvdW50ZG93bigpIHsKICAgICAgY2xlYXJJbnRlcnZhbCh0aGlzLmNvdW50ZG93blRpbWVyKTsKICAgICAgdGhpcy5jb3VudGRvd25UaW1lciA9IG51bGw7CiAgICB9CiAgfQoKICAvLyA2KSBMw7NnaWNhIGRlIGNhY2jDqQogIGZ1bmN0aW9uIHNhdmVDYWNoZShkYXRhKSB7CiAgICB0cnkgewogICAgICBzZXNzaW9uU3RvcmFnZS5zZXRJdGVtKENBQ0hFX0tFWSwgSlNPTi5zdHJpbmdpZnkoewogICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSwKICAgICAgICBtZXBDY2w6IGRhdGEubWVwQ2NsLAogICAgICAgIGZjaVJlbnRhRmlqYTogZGF0YS5mY2lSZW50YUZpamEsCiAgICAgICAgZmNpUmVudGFGaWphUGVudWx0aW1vOiBkYXRhLmZjaVJlbnRhRmlqYVBlbnVsdGltbywKICAgICAgICBmY2lSZW50YVZhcmlhYmxlOiBkYXRhLmZjaVJlbnRhVmFyaWFibGUsCiAgICAgICAgZmNpUmVudGFWYXJpYWJsZVBlbnVsdGltbzogZGF0YS5mY2lSZW50YVZhcmlhYmxlUGVudWx0aW1vCiAgICAgIH0pKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgY29uc29sZS5lcnJvcignW1JhZGFyTUVQXSBubyBzZSBwdWRvIGd1YXJkYXIgY2FjaGUnLCBlKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIGxvYWRDYWNoZSgpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJhdyA9IHNlc3Npb25TdG9yYWdlLmdldEl0ZW0oQ0FDSEVfS0VZKTsKICAgICAgaWYgKCFyYXcpIHJldHVybiBudWxsOwogICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdyk7CiAgICAgIGlmICghcGFyc2VkLnRpbWVzdGFtcCB8fCBEYXRlLm5vdygpIC0gcGFyc2VkLnRpbWVzdGFtcCA+IENBQ0hFX1RUTF9NUykgcmV0dXJuIG51bGw7CiAgICAgIHJldHVybiBwYXJzZWQ7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tSYWRhck1FUF0gY2FjaGUgaW52w6FsaWRhJywgZSk7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogIH0KCiAgZnVuY3Rpb24gY2xhbXBEcmF3ZXJXaWR0aChweCkgewogICAgcmV0dXJuIE1hdGgubWF4KERSQVdFUl9NSU5fVywgTWF0aC5taW4oRFJBV0VSX01BWF9XLCBNYXRoLnJvdW5kKHB4KSkpOwogIH0KICBmdW5jdGlvbiBzYXZlRHJhd2VyV2lkdGgocHgpIHsKICAgIHRyeSB7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKERSQVdFUl9XSURUSF9LRVksIFN0cmluZyhjbGFtcERyYXdlcldpZHRoKHB4KSkpOyB9IGNhdGNoIHt9CiAgfQogIGZ1bmN0aW9uIGxvYWREcmF3ZXJXaWR0aCgpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJhdyA9IE51bWJlcihsb2NhbFN0b3JhZ2UuZ2V0SXRlbShEUkFXRVJfV0lEVEhfS0VZKSk7CiAgICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUocmF3KSA/IGNsYW1wRHJhd2VyV2lkdGgocmF3KSA6IG51bGw7CiAgICB9IGNhdGNoIHsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQogIGZ1bmN0aW9uIGFwcGx5RHJhd2VyV2lkdGgocHgsIHBlcnNpc3QgPSBmYWxzZSkgewogICAgaWYgKHdpbmRvdy5pbm5lcldpZHRoIDw9IDkwMCkgcmV0dXJuOwogICAgY29uc3QgbmV4dCA9IGNsYW1wRHJhd2VyV2lkdGgocHgpOwogICAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LnN0eWxlLnNldFByb3BlcnR5KCctLWRyYXdlci13JywgYCR7bmV4dH1weGApOwogICAgaWYgKHBlcnNpc3QpIHNhdmVEcmF3ZXJXaWR0aChuZXh0KTsKICB9CiAgZnVuY3Rpb24gaW5pdERyYXdlcldpZHRoKCkgewogICAgY29uc3Qgc2F2ZWQgPSBsb2FkRHJhd2VyV2lkdGgoKTsKICAgIGlmIChzYXZlZCAhPT0gbnVsbCkgYXBwbHlEcmF3ZXJXaWR0aChzYXZlZCwgZmFsc2UpOwogIH0KICBmdW5jdGlvbiBiaW5kRHJhd2VyUmVzaXplKCkgewogICAgaWYgKHN0YXRlLmRyYXdlclJlc2l6ZUJvdW5kKSByZXR1cm47CiAgICBjb25zdCBoYW5kbGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZHJhd2VyLXJlc2l6ZXInKTsKICAgIGNvbnN0IGRyYXdlciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdkcmF3ZXInKTsKICAgIGlmICghaGFuZGxlIHx8ICFkcmF3ZXIpIHJldHVybjsKICAgIHN0YXRlLmRyYXdlclJlc2l6ZUJvdW5kID0gdHJ1ZTsKICAgIGhhbmRsZS5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVyZG93bicsIChldmVudCkgPT4gewogICAgICBpZiAod2luZG93LmlubmVyV2lkdGggPD0gOTAwIHx8IGV2ZW50LmJ1dHRvbiAhPT0gMCkgcmV0dXJuOwogICAgICBjb25zdCBzdGFydFggPSBldmVudC5jbGllbnRYOwogICAgICBjb25zdCBzdGFydFdpZHRoID0gZHJhd2VyLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLndpZHRoOwogICAgICBoYW5kbGUuY2xhc3NMaXN0LmFkZCgnYWN0aXZlJyk7CiAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7CiAgICAgIGNvbnN0IG9uTW92ZSA9IChtb3ZlRXZlbnQpID0+IHsKICAgICAgICBjb25zdCBkZWx0YSA9IG1vdmVFdmVudC5jbGllbnRYIC0gc3RhcnRYOwogICAgICAgIGFwcGx5RHJhd2VyV2lkdGgoc3RhcnRXaWR0aCAtIGRlbHRhLCBmYWxzZSk7CiAgICAgIH07CiAgICAgIGNvbnN0IG9uVXAgPSAoKSA9PiB7CiAgICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJtb3ZlJywgb25Nb3ZlKTsKICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcnVwJywgb25VcCk7CiAgICAgICAgaGFuZGxlLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpOwogICAgICAgIGNvbnN0IHdpZHRoID0gZHJhd2VyLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLndpZHRoOwogICAgICAgIGFwcGx5RHJhd2VyV2lkdGgod2lkdGgsIHRydWUpOwogICAgICB9OwogICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcm1vdmUnLCBvbk1vdmUpOwogICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcnVwJywgb25VcCk7CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIGhpZGVTbWFydFRpcCgpIHsKICAgIGNvbnN0IHRpcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzbWFydC10aXAnKTsKICAgIGlmICghdGlwKSByZXR1cm47CiAgICB0aXAuY2xhc3NMaXN0LnJlbW92ZSgnc2hvdycpOwogICAgdGlwLnNldEF0dHJpYnV0ZSgnYXJpYS1oaWRkZW4nLCAndHJ1ZScpOwogIH0KICBmdW5jdGlvbiBzaG93U21hcnRUaXAoYW5jaG9yKSB7CiAgICBjb25zdCB0aXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc21hcnQtdGlwJyk7CiAgICBpZiAoIXRpcCB8fCAhYW5jaG9yKSByZXR1cm47CiAgICBjb25zdCB0ZXh0ID0gYW5jaG9yLmdldEF0dHJpYnV0ZSgnZGF0YS10Jyk7CiAgICBpZiAoIXRleHQpIHJldHVybjsKICAgIHRpcC50ZXh0Q29udGVudCA9IHRleHQ7CiAgICB0aXAuY2xhc3NMaXN0LmFkZCgnc2hvdycpOwogICAgdGlwLnNldEF0dHJpYnV0ZSgnYXJpYS1oaWRkZW4nLCAnZmFsc2UnKTsKCiAgICBjb25zdCBtYXJnaW4gPSA4OwogICAgY29uc3QgcmVjdCA9IGFuY2hvci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICAgIGNvbnN0IHRpcFJlY3QgPSB0aXAuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgICBsZXQgbGVmdCA9IHJlY3QubGVmdDsKICAgIGlmIChsZWZ0ICsgdGlwUmVjdC53aWR0aCArIG1hcmdpbiA+IHdpbmRvdy5pbm5lcldpZHRoKSBsZWZ0ID0gd2luZG93LmlubmVyV2lkdGggLSB0aXBSZWN0LndpZHRoIC0gbWFyZ2luOwogICAgaWYgKGxlZnQgPCBtYXJnaW4pIGxlZnQgPSBtYXJnaW47CiAgICBsZXQgdG9wID0gcmVjdC5ib3R0b20gKyA4OwogICAgaWYgKHRvcCArIHRpcFJlY3QuaGVpZ2h0ICsgbWFyZ2luID4gd2luZG93LmlubmVySGVpZ2h0KSB0b3AgPSBNYXRoLm1heChtYXJnaW4sIHJlY3QudG9wIC0gdGlwUmVjdC5oZWlnaHQgLSA4KTsKICAgIHRpcC5zdHlsZS5sZWZ0ID0gYCR7TWF0aC5yb3VuZChsZWZ0KX1weGA7CiAgICB0aXAuc3R5bGUudG9wID0gYCR7TWF0aC5yb3VuZCh0b3ApfXB4YDsKICB9CiAgZnVuY3Rpb24gaW5pdFNtYXJ0VGlwcygpIHsKICAgIGlmIChzdGF0ZS5zbWFydFRpcEJvdW5kKSByZXR1cm47CiAgICBzdGF0ZS5zbWFydFRpcEJvdW5kID0gdHJ1ZTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50aXAudGlwLWRvd24nKS5mb3JFYWNoKChlbCkgPT4gewogICAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWVudGVyJywgKCkgPT4gc2hvd1NtYXJ0VGlwKGVsKSk7CiAgICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ2ZvY3VzJywgKCkgPT4gc2hvd1NtYXJ0VGlwKGVsKSk7CiAgICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKGV2ZW50KSA9PiB7CiAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKICAgICAgICBzaG93U21hcnRUaXAoZWwpOwogICAgICB9KTsKICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VsZWF2ZScsIGhpZGVTbWFydFRpcCk7CiAgICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ2JsdXInLCBoaWRlU21hcnRUaXApOwogICAgfSk7CiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignc2Nyb2xsJywgaGlkZVNtYXJ0VGlwLCB0cnVlKTsKICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdyZXNpemUnLCAoKSA9PiB7CiAgICAgIGhpZGVTbWFydFRpcCgpOwogICAgICBpbml0RHJhd2VyV2lkdGgoKTsKICAgIH0pOwogICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZXZlbnQpID0+IHsKICAgICAgaWYgKCEoZXZlbnQudGFyZ2V0IGluc3RhbmNlb2YgRWxlbWVudCkpIHJldHVybjsKICAgICAgaWYgKCFldmVudC50YXJnZXQuY2xvc2VzdCgnLnRpcC50aXAtZG93bicpICYmICFldmVudC50YXJnZXQuY2xvc2VzdCgnI3NtYXJ0LXRpcCcpKSBoaWRlU21hcnRUaXAoKTsKICAgIH0pOwogIH0KCiAgLy8gNykgSW5pY2lhbGl6YWNpw7NuCiAgc3RhcnRGcmVzaFRpY2tlcigpOwogIGluaXREcmF3ZXJXaWR0aCgpOwogIGJpbmREcmF3ZXJSZXNpemUoKTsKICBpbml0U21hcnRUaXBzKCk7CiAgZnVuY3Rpb24gdG9nZ2xlRHJhd2VyKCkgewogICAgY29uc3QgZHJhd2VyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2RyYXdlcicpOwogICAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdib2R5V3JhcCcpOwogICAgY29uc3QgYnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2J0blRhc2FzJyk7CiAgICBjb25zdCBvdmwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnb3ZlcmxheScpOwogICAgY29uc3QgaXNPcGVuID0gZHJhd2VyLmNsYXNzTGlzdC5jb250YWlucygnb3BlbicpOwogICAgZHJhd2VyLmNsYXNzTGlzdC50b2dnbGUoJ29wZW4nLCAhaXNPcGVuKTsKICAgIHdyYXAuY2xhc3NMaXN0LnRvZ2dsZSgnZHJhd2VyLW9wZW4nLCAhaXNPcGVuKTsKICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCAhaXNPcGVuKTsKICAgIG92bC5jbGFzc0xpc3QudG9nZ2xlKCdzaG93JywgIWlzT3Blbik7CiAgfQoKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucGlsbFtkYXRhLWZpbHRlcl0nKS5mb3JFYWNoKChwKSA9PiB7CiAgICBwLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gYXBwbHlGaWx0ZXIocC5kYXRhc2V0LmZpbHRlcikpOwogIH0pOwogIGNvbnN0IGNzdkJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdidG4tZG93bmxvYWQtY3N2Jyk7CiAgaWYgKGNzdkJ0bikgY3N2QnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZG93bmxvYWRIaXN0b3J5Q3N2KTsKICBjb25zdCBmY2lUYWJGaWphID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS10YWItZmlqYScpOwogIGlmIChmY2lUYWJGaWphKSB7CiAgICBmY2lUYWJGaWphLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gc2V0RmNpVHlwZSgnZmlqYScpKTsKICB9CiAgY29uc3QgZmNpVGFiVmFyaWFibGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLXRhYi12YXJpYWJsZScpOwogIGlmIChmY2lUYWJWYXJpYWJsZSkgewogICAgZmNpVGFiVmFyaWFibGUuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBzZXRGY2lUeXBlKCd2YXJpYWJsZScpKTsKICB9CiAgY29uc3QgZmNpU2VhcmNoID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1zZWFyY2gnKTsKICBpZiAoZmNpU2VhcmNoKSB7CiAgICBmY2lTZWFyY2guYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoKSA9PiB7CiAgICAgIHN0YXRlLmZjaVF1ZXJ5ID0gZmNpU2VhcmNoLnZhbHVlIHx8ICcnOwogICAgICBzdGF0ZS5mY2lQYWdlID0gMTsKICAgICAgcmVuZGVyRmNpUmVudGFGaWphKCk7CiAgICB9KTsKICB9CiAgY29uc3QgZmNpUHJldiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktcHJldicpOwogIGlmIChmY2lQcmV2KSB7CiAgICBmY2lQcmV2LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICBzdGF0ZS5mY2lQYWdlID0gTWF0aC5tYXgoMSwgc3RhdGUuZmNpUGFnZSAtIDEpOwogICAgICByZW5kZXJGY2lSZW50YUZpamEoKTsKICAgIH0pOwogIH0KICBjb25zdCBmY2lOZXh0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1uZXh0Jyk7CiAgaWYgKGZjaU5leHQpIHsKICAgIGZjaU5leHQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIHN0YXRlLmZjaVBhZ2UgKz0gMTsKICAgICAgcmVuZGVyRmNpUmVudGFGaWphKCk7CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIHRvZ2dsZUdsb3MoKSB7CiAgICBjb25zdCBncmlkID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2dsb3NHcmlkJyk7CiAgICBjb25zdCBhcnJvdyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdnbG9zQXJyb3cnKTsKICAgIGNvbnN0IG9wZW4gPSBncmlkLmNsYXNzTGlzdC50b2dnbGUoJ29wZW4nKTsKICAgIGFycm93LnRleHRDb250ZW50ID0gb3BlbiA/ICfilrQnIDogJ+KWvic7CiAgfQoKICBjb25zdCByZXRyeUJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdlcnJvci1yZXRyeS1idG4nKTsKICBpZiAocmV0cnlCdG4pIHsKICAgIHJldHJ5QnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICBpZiAod2luZG93LnNjaGVkdWxlcikgd2luZG93LnNjaGVkdWxlci5yZXN1bWUoKTsKICAgICAgZmV0Y2hBbGwoeyBtYW51YWw6IHRydWUgfSk7CiAgICB9KTsKICB9CgogIGNvbnN0IGNhY2hlZCA9IGxvYWRDYWNoZSgpOwogIGluaXRIaXN0b3J5Q29sdW1uV2lkdGhzKCk7CiAgYmluZEhpc3RvcnlDb2x1bW5SZXNpemUoKTsKICBpbml0RmNpQ29sdW1uV2lkdGhzKCk7CiAgYmluZEZjaUNvbHVtblJlc2l6ZSgpOwogIGlmIChjYWNoZWQpIHsKICAgIHN0YXRlLmxhc3RNZXBQYXlsb2FkID0gY2FjaGVkLm1lcENjbDsKICAgIGlmIChjYWNoZWQuZmNpUmVudGFGaWphIHx8IGNhY2hlZC5mY2lSZW50YUZpamFQZW51bHRpbW8pIHsKICAgICAgcmVuZGVyRmNpUmVudGFGaWphKGNhY2hlZC5mY2lSZW50YUZpamEsIGNhY2hlZC5mY2lSZW50YUZpamFQZW51bHRpbW8sICdmaWphJyk7CiAgICB9CiAgICBpZiAoY2FjaGVkLmZjaVJlbnRhVmFyaWFibGUgfHwgY2FjaGVkLmZjaVJlbnRhVmFyaWFibGVQZW51bHRpbW8pIHsKICAgICAgcmVuZGVyRmNpUmVudGFGaWphKGNhY2hlZC5mY2lSZW50YVZhcmlhYmxlLCBjYWNoZWQuZmNpUmVudGFWYXJpYWJsZVBlbnVsdGltbywgJ3ZhcmlhYmxlJyk7CiAgICB9CiAgICByZW5kZXJGY2lSZW50YUZpamEoKTsKICAgIHJlbmRlck1lcENjbChjYWNoZWQubWVwQ2NsKTsKICAgIHJlbmRlck1ldHJpY3MyNGgoY2FjaGVkLm1lcENjbCk7CiAgICByZW5kZXJUcmVuZChjYWNoZWQubWVwQ2NsKTsKICAgIHJlbmRlckhpc3RvcnkoY2FjaGVkLm1lcENjbCk7CiAgICBjb25zdCBjYWNoZWRSb290ID0gZXh0cmFjdFJvb3QoY2FjaGVkLm1lcENjbCk7CiAgICBzdGF0ZS5zb3VyY2VUc01zID0gdG9OdW1iZXIoY2FjaGVkUm9vdD8uc291cmNlU3RhdHVzPy5sYXRlc3RTb3VyY2VUc01zKQogICAgICA/PyB0b051bWJlcihjYWNoZWRSb290Py5jdXJyZW50Py5tZXBUc01zKQogICAgICA/PyB0b051bWJlcihjYWNoZWRSb290Py5jdXJyZW50Py5jY2xUc01zKQogICAgICA/PyBudWxsOwogICAgcmVmcmVzaEZyZXNoQmFkZ2VGcm9tU291cmNlKCk7CiAgfQoKICBhcHBseUZpbHRlcihzdGF0ZS5maWx0ZXJNb2RlKTsKCiAgd2luZG93LnNjaGVkdWxlciA9IG5ldyBNYXJrZXRTY2hlZHVsZXIoZmV0Y2hBbGwsIEZFVENIX0lOVEVSVkFMX01TKTsKICB3aW5kb3cuc2NoZWR1bGVyLnN0YXJ0KCk7CiAgZmV0Y2hBbGwoeyBtYW51YWw6IHRydWUgfSk7CgogIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3Zpc2liaWxpdHljaGFuZ2UnLCAoKSA9PiB7CiAgICBpZiAoZG9jdW1lbnQuaGlkZGVuKSB3aW5kb3cuc2NoZWR1bGVyLnBhdXNlKCk7CiAgICBlbHNlIHdpbmRvdy5zY2hlZHVsZXIucmVzdW1lKCk7CiAgfSk7Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K`;

function decodeBase64Utf8(b64) {
  const compact = b64.replace(/\s+/g, "");
  const binary = atob(compact);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function renderDashboardHtml() {
  return decodeBase64Utf8(DASHBOARD_HTML_B64);
}
