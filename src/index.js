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
const STATE_KEY = "mep_ccl_state_v1";
const HISTORY_KEY = "mep_ccl_history_v1";
const SNAPSHOT_PREFIX = "mep_ccl_snapshot_";
const UX_REDESIGN_DATE = "2026-02-26";
const MAX_HISTORY_ITEMS = 500;
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
    ctx.waitUntil(runUpdate(env));
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
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Radar MEP/CCL</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Source+Sans+3:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root{--bg:#040811;--bg2:#081123;--line:#1c2f4f;--card:#08101b;--card2:#0a1522;--ink:#dde8f7;--muted:#7891b1;--blue:#3fb4ff;--violet:#ab83ff;--yellow:#f5ce42;--green:#15d66f;--red:#ff4f6d;--neutral:#f0b83d}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;font-family:"Source Sans 3",sans-serif;color:var(--ink);background:linear-gradient(rgba(40,78,134,.14) 1px, transparent 1px),linear-gradient(90deg, rgba(40,78,134,.14) 1px, transparent 1px),radial-gradient(1200px 700px at 110% -20%, rgba(34,118,208,.22), transparent 55%),radial-gradient(900px 600px at -10% -10%, rgba(33,163,142,.18), transparent 60%),linear-gradient(160deg,var(--bg) 0%, var(--bg2) 100%);background-size:80px 80px,80px 80px,auto,auto,auto;padding:20px}
    .card{max-width:1320px;margin:0 auto;border:1px solid #203556;border-radius:18px;background:rgba(6,13,24,.85);backdrop-filter:blur(3px);box-shadow:0 22px 70px rgba(0,0,0,.45);overflow:hidden}
    h1,h2,h3{font-family:"Space Grotesk",sans-serif;margin:0}
    .head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 22px;border-bottom:1px solid #1d3252}
    h1{font-size:42px;letter-spacing:.06em;font-weight:700;text-transform:uppercase}
    .head-right{display:flex;gap:10px;flex-wrap:wrap}
    .chip{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:11px;border:1px solid #29466c;background:#0d1a2c;color:#a5bfdc;font-weight:700;font-size:14px}
    .chip.ok{background:#0f381f;border-color:#1d7642;color:#57f197}
    .chip.alert{background:#0f301f;border-color:#20a455;color:#45f087;cursor:pointer}
    .chip.alert.on{background:#0f6a36;color:#eafff3}
    .content{padding:18px 22px 22px}
    .hero{display:grid;grid-template-columns:1.5fr 1fr;gap:14px;border:1px solid #245236;border-radius:16px;padding:18px;background:linear-gradient(90deg, rgba(8,57,38,.72), rgba(10,43,35,.38));margin-bottom:14px}
    .hero-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .hero-title h2{font-size:62px;line-height:1}
    .hero-sub{margin-top:8px;color:#9cb5cf;font-size:20px}
    .status-pill{font-family:"Space Grotesk",sans-serif;padding:8px 14px;border-radius:8px;font-size:28px;line-height:1;font-weight:700;text-transform:uppercase}
    .status-pill.similar{background:#1de177;color:#032a14}
    .status-pill.neutral{background:#ffd95a;color:#442f00}
    .status-pill.far{background:#ff5b78;color:#2b0210}
    .hero-meta{display:flex;flex-direction:column;align-items:flex-end;justify-content:center;text-align:right;color:#8eabd0;font-size:17px;gap:3px}
    .hero-meta b{color:#b7cae6}
    .hero-meta .cron{margin-top:8px;font-size:15px;color:#7f9ec7}
    .main-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
    .metric{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid #203351;border-radius:14px;padding:18px;min-height:168px}
    .metric.mep{border-top:3px solid var(--blue)} .metric.ccl{border-top:3px solid var(--violet)} .metric.brecha{border-top:3px solid var(--yellow)}
    .k{font-size:30px;letter-spacing:.08em;text-transform:uppercase;color:#8aa5c7;font-family:"Space Grotesk",sans-serif}
    .info-tip{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1px solid #3f5d85;font-size:12px;color:#9fbbdb;cursor:help;position:relative}
    .info-tip:hover::after{content:attr(data-tip);position:absolute;left:50%;bottom:125%;transform:translateX(-50%);background:#0b1b31;color:#dbe7f8;border:1px solid #34527c;padding:7px 9px;border-radius:8px;white-space:nowrap;font-size:12px;z-index:20}
    .v{font-size:74px;font-weight:700;line-height:1.02;font-family:"Space Grotesk",sans-serif;margin-top:10px}
    .v.blue{color:var(--blue)} .v.violet{color:var(--violet)} .v.yellow{color:var(--yellow)} .v.small{font-size:56px}
    .muted{color:var(--muted);font-size:16px;margin-top:8px}
    .chart-card{margin-top:14px;background:linear-gradient(180deg,#07101a,#08111d);border:1px solid #1f3351;border-radius:14px;padding:18px}
    .chart-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
    .chart-top h3{font-size:38px}
    .chart-legend{display:flex;gap:18px;flex-wrap:wrap;color:#8ea9c8;margin-top:10px}
    .legend-item{display:flex;align-items:center;gap:8px;font-size:16px}
    .line{display:inline-block;width:26px;height:0;border-top:3px solid}
    .range-btns{display:flex;gap:8px;flex-wrap:wrap}
    .range-btn{background:transparent;border:1px solid #37557e;color:#a3bfdf;border-radius:999px;padding:6px 14px;font-size:16px;font-weight:700;cursor:pointer}
    .range-btn.active{background:#35a9ff;color:#021528;border-color:#35a9ff}
    .chart-wrap{position:relative;margin-top:10px}
    .chart-tooltip{position:absolute;pointer-events:none;background:#101f34;border:1px solid #314f77;color:#d5e4f8;padding:8px 10px;border-radius:10px;font-size:14px;line-height:1.3;opacity:0;transform:translate(-50%,-120%);transition:opacity .12s ease;white-space:nowrap;z-index:10}
    canvas{display:block;width:100%;height:380px;background:#091420;border:1px solid #1f3452;border-radius:12px}
    .kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:14px}
    .kpi{background:linear-gradient(180deg,#0a1523,#0d1a2b);border:1px solid #1f3352;border-radius:12px;padding:14px}
    .kpi .k{font-size:24px} .kpi .v{font-size:56px;margin-top:6px} .kpi .v.green{color:var(--green)} .kpi .v.yellow{color:var(--yellow)}
    .history{margin-top:14px;background:linear-gradient(180deg,#08111d,#08101b);border:1px solid #1f3452;border-radius:14px;overflow:hidden}
    .history-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #1c3050}
    .history-head h3{font-size:34px}
    table{width:100%;border-collapse:collapse;font-size:17px}
    th,td{padding:12px 14px;text-align:left;border-bottom:1px solid #1a2c48}
    th{color:#7993b3;background:#101c2d;font-size:15px;letter-spacing:.08em;text-transform:uppercase}
    td{color:#d6e2f4}
    td.mepv{color:var(--blue);font-weight:700} td.cclv{color:var(--violet);font-weight:700}
    .state-pill{display:inline-block;padding:4px 10px;border-radius:7px;font-size:15px;font-family:"Space Grotesk",sans-serif;font-weight:700}
    .state-pill.similar{background:#0f3b22;color:#37ed88;border:1px solid #206944}
    .state-pill.neutral{background:#4a3708;color:#ffd86a;border:1px solid #947127}
    .state-pill.far{background:#421321;color:#ff6988;border:1px solid #8c2b44}
    .loading-row td{color:#6f89a8}
    .history-mobile{display:none}
    .hcard{padding:10px;border-bottom:1px solid #1a2d49}
    .hcard:last-child{border-bottom:none}
    .hrow{display:flex;justify-content:space-between;gap:8px;color:#b8cbe5;font-size:14px}
    .hrow strong{color:#e8f0fb}
    .foot{color:#7f9cc1;font-size:14px;padding:12px 2px}
    details.glossary{margin-top:14px;border:1px solid #1f3352;border-radius:14px;background:linear-gradient(180deg,#08111d,#08101a)}
    details.glossary summary{cursor:pointer;list-style:none;padding:14px 16px;color:#9cb6d4;font-family:"Space Grotesk",sans-serif;font-size:28px}
    details.glossary summary::-webkit-details-marker{display:none}
    .guide-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0;border-top:1px solid #1a2c48}
    .guide-item{padding:16px;border-right:1px solid #1a2c48;border-bottom:1px solid #1a2c48}
    .guide-item:nth-child(2n){border-right:none}
    .guide-item h3{font-size:24px;color:#89a5c8}
    .guide-item p{margin:8px 0 0;color:#7f98b8;font-size:15px;line-height:1.45}
    .warn{margin:12px 0;padding:10px 12px;border-radius:10px;background:#3e2f0e;border:1px solid #806226;color:#ffd681}
    @media (max-width:1020px){h1{font-size:30px}.hero{grid-template-columns:1fr}.hero-title h2{font-size:46px}.main-cards{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.v{font-size:58px}}
    @media (max-width:760px){body{padding:10px}.head,.content{padding:12px}.chip{font-size:12px;padding:7px 10px}.hero-title h2{font-size:36px}.status-pill{font-size:18px}.hero-sub{font-size:16px}.hero-meta{align-items:flex-start;text-align:left;font-size:14px}.k{font-size:20px}.v{font-size:46px}canvas{height:290px}table{display:none}.history-mobile{display:block}.guide-grid{grid-template-columns:1fr}.guide-item{border-right:none}}
  </style>
</head>
<body>
  <div class="card">
    <div class="head">
      <h1>Radar MEP/CCL</h1>
      <div class="head-right">
        <span class="chip" id="freshChip">Actualizado hace ...</span>
        <span class="chip ok" id="marketChip">Mercado ...</span>
        <button class="chip alert" id="notifyBtn">Activar alertas</button>
      </div>
    </div>
    <div class="content">
      <div id="warnArea"></div>

      <section class="hero" id="heroBox">
        <div>
          <div class="hero-title">
            <h2>MEP ~ CCL</h2>
            <span class="status-pill" id="statusPill">...</span>
          </div>
          <div class="hero-sub" id="heroText">Evaluando similitud actual...</div>
        </div>
        <div class="hero-meta">
          <div><b>Ultima corrida:</b> <span id="opLastOk">N/D</span></div>
          <div><b>Proxima:</b> <span id="opNextRun">N/D</span></div>
          <div class="cron">Cron GMT-3 - Lun-Vie 10:30-18:00</div>
        </div>
      </section>

      <section class="main-cards">
        <article class="metric mep">
          <div class="k">MEP VENTA <span class="info-tip" data-tip="Precio de venta del dolar MEP.">i</span></div>
          <div class="v blue" id="mep">$0.00</div>
          <div class="muted" id="mepRef">dolarito.ar · venta</div>
        </article>
        <article class="metric ccl">
          <div class="k">CCL VENTA <span class="info-tip" data-tip="Precio de venta del dolar CCL.">i</span></div>
          <div class="v violet" id="ccl">$0.00</div>
          <div class="muted" id="cclRef">dolarito.ar · venta</div>
        </article>
        <article class="metric brecha">
          <div class="k">BRECHA <span class="info-tip" data-tip="Diferencia absoluta y porcentual entre MEP y CCL.">i</span></div>
          <div class="v small" id="absDiff">$0.00</div>
          <div class="v small yellow" id="pctDiff">0.00%</div>
          <div class="muted">diferencia absoluta · porcentual</div>
        </article>
      </section>

      <section class="chart-card">
        <div class="chart-top">
          <h3>Tendencia de brecha - ultimas 24h</h3>
          <div class="range-btns">
            <button class="range-btn" data-range="20">20 pts</button>
            <button class="range-btn active" data-range="40">40 pts</button>
            <button class="range-btn" data-range="all">Todo</button>
          </div>
        </div>
        <div class="chart-legend">
          <span class="legend-item"><span class="line" style="border-color:#3fb4ff"></span>MEP venta</span>
          <span class="legend-item"><span class="line" style="border-color:#ab83ff"></span>CCL venta</span>
          <span class="legend-item"><span class="line" style="border-color:#f5ce42"></span>Brecha %</span>
        </div>
        <div class="chart-wrap">
          <canvas id="trendChart"></canvas>
          <div id="chartTooltip" class="chart-tooltip"></div>
        </div>
      </section>

      <section class="kpis">
        <article class="kpi"><div class="k">Muestras 24h</div><div class="v" id="mCount">0</div><div class="muted">registros del periodo</div></article>
        <article class="kpi"><div class="k">Veces Similar</div><div class="v green" id="mSimilar">0</div><div class="muted">momentos en zona similar</div></article>
        <article class="kpi"><div class="k">Brecha Min.</div><div class="v" id="mMin">0.00%</div><div class="muted">minima registrada hoy</div></article>
        <article class="kpi"><div class="k">Brecha Max.</div><div class="v yellow" id="mMax">0.00%</div><div class="muted">maxima registrada hoy</div></article>
      </section>

      <section class="history">
        <div class="history-head">
          <h3>Historial de registros</h3>
          <div class="muted">Ultimas 8 muestras</div>
        </div>
        <table>
          <thead><tr><th>Hora</th><th>MEP</th><th>CCL</th><th>Dif $</th><th>Dif %</th><th>Estado</th></tr></thead>
          <tbody id="historyRows">
            <tr class="loading-row"><td colspan="6">Cargando historial...</td></tr>
          </tbody>
        </table>
        <div class="history-mobile" id="historyMobile"></div>
      </section>

      <details class="glossary">
        <summary>Glosario de terminos</summary>
        <div class="guide-grid">
          <article class="guide-item"><h3>MEP VENTA</h3><p>Precio de venta del dolar MEP (Mercado Electronico de Pagos), obtenido mediante compra/venta de bonos.</p></article>
          <article class="guide-item"><h3>CCL VENTA</h3><p>Contado con liquidacion. Similar al MEP pero permite transferir divisas al exterior.</p></article>
          <article class="guide-item"><h3>DIFERENCIA %</h3><p>Brecha relativa calculada contra el promedio entre MEP y CCL.</p></article>
          <article class="guide-item"><h3>FRESCURA DATO</h3><p>Tiempo transcurrido desde el ultimo timestamp recibido de la fuente.</p></article>
          <article class="guide-item"><h3>ESTADO</h3><p>SIMILAR cuando la brecha entra en umbral. NO SIMILAR cuando se aleja. Zona gris para borde.</p></article>
          <article class="guide-item"><h3>MERCADO ARG</h3><p>Ventana operativa visible: 10:30 a 17:59 (GMT-3, Buenos Aires).</p></article>
        </div>
      </details>

      <p class="foot" id="ruleText"></p>
      <p class="foot">Fuente: <a id="sourceLink" href="#" target="_blank" rel="noopener noreferrer">dolarito.ar</a></p>
    </div>
  </div>

  <script>
    let latestState = null;
    let chartRange = "40";
    let chartPoints = [];
    let chartHitboxes = [];
    let chartHoverIndex = -1;

    function fmtMoney(v){ return Number.isFinite(v) ? "$" + v.toFixed(2) : "N/D"; }
    function fmtPct(v){ return Number.isFinite(v) ? v.toFixed(2) + "%" : "N/D"; }

    function setText(id, text){ const el = document.getElementById(id); if (el) el.textContent = text; }

    function syncNotifyButton() {
      const btn = document.getElementById("notifyBtn");
      if (!("Notification" in window)) { btn.textContent = "Alertas no soportadas"; btn.disabled = true; return; }
      if (Notification.permission === "granted") { btn.textContent = "Alertas activas"; btn.classList.add("on"); return; }
      if (Notification.permission === "denied") { btn.textContent = "Alertas bloqueadas"; return; }
      btn.textContent = "Activar alertas";
    }

    async function loadData() {
      try {
        const res = await fetch("/api/data?t=" + Date.now(), { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        render(data);
      } catch (err) {
        const warn = document.getElementById("warnArea");
        warn.innerHTML = '<div class="warn">No se pudo actualizar desde API. Reintentando...</div>';
      }
    }

    function stateTier(state) {
      if (!state?.sourceStatus?.ok) return "neutral";
      if (state?.current?.similar) return "similar";
      const pct = Number(state?.current?.pctDiff);
      const edge = Number(state?.thresholds?.maxPctDiff || 1) * 1.5;
      if (Number.isFinite(pct) && pct <= edge) return "neutral";
      return "far";
    }

    function formatRelativeMinutes(epochSec) {
      if (!Number.isFinite(epochSec)) return "Actualizado recien";
      const delta = Math.max(0, Math.floor((Date.now() / 1000 - epochSec) / 60));
      if (delta < 1) return "Actualizado recien";
      if (delta === 1) return "Actualizado hace 1 min";
      if (delta < 60) return "Actualizado hace " + delta + " min";
      const h = Math.floor(delta / 60);
      return "Actualizado hace " + h + " h";
    }

    function render(state) {
      latestState = state;
      const tier = stateTier(state);
      const statusPill = document.getElementById("statusPill");
      const hero = document.getElementById("heroBox");
      const freshChip = document.getElementById("freshChip");
      const marketChip = document.getElementById("marketChip");

      statusPill.className = "status-pill " + (tier === "similar" ? "similar" : tier === "far" ? "far" : "neutral");
      statusPill.textContent = tier === "similar" ? "SIMILAR" : tier === "far" ? "NO SIMILAR" : "ZONA GRIS";
      hero.style.borderColor = tier === "similar" ? "#245236" : tier === "far" ? "#5a2230" : "#6b5620";

      setText("heroText", tier === "similar"
        ? "La brecha esta dentro del umbral - los precios son comparables"
        : tier === "far"
          ? "La brecha supera el umbral - los precios estan alejados"
          : "La brecha esta cerca del umbral - seguimiento recomendado");

      freshChip.textContent = formatRelativeMinutes(Number(state.updatedAtEpoch));
      marketChip.textContent = state.market?.isOpen ? "MERCADO ABIERTO" : "MERCADO CERRADO";
      marketChip.className = "chip ok";
      marketChip.style.background = state.market?.isOpen ? "#0f381f" : "#41210f";
      marketChip.style.borderColor = state.market?.isOpen ? "#1d7642" : "#7f3e1d";
      marketChip.style.color = state.market?.isOpen ? "#57f197" : "#ffc28e";

      setText("opLastOk", state.operational?.lastSuccessAtHumanArt || "N/D");
      setText("opNextRun", state.operational?.nextRunAtHumanArt || "N/D");
      setText("mCount", String(state.metrics24h?.count ?? 0));
      setText("mSimilar", String(state.metrics24h?.similarCount ?? 0));
      setText("mMin", fmtPct(state.metrics24h?.minPct));
      setText("mMax", fmtPct(state.metrics24h?.maxPct));

      setText("mep", fmtMoney(state.current?.mep));
      setText("ccl", fmtMoney(state.current?.ccl));
      setText("mepRef", (state.current?.mepTsHuman || "s/dato"));
      setText("cclRef", (state.current?.cclTsHuman || "s/dato"));
      setText("absDiff", fmtMoney(state.current?.absDiff));
      setText("pctDiff", fmtPct(state.current?.pctDiff));

      setText("ruleText", "Condicion de similitud: diferencia <= " + state.thresholds.maxAbsDiffArs + " ARS o <= " + state.thresholds.maxPctDiff + "%");
      const sourceLink = document.getElementById("sourceLink");
      sourceLink.href = state.sourceUrl || "https://www.dolarito.ar/cotizacion/dolar-hoy";
      sourceLink.textContent = sourceLink.href;

      const warnings = [];
      if (!state.sourceStatus?.ok) warnings.push("No se pudieron obtener datos nuevos. Se muestra el ultimo estado disponible.");
      if (state.sourceStatus?.freshWarn) warnings.push("El dato de fuente esta desactualizado (> 60 min).");
      const warnArea = document.getElementById("warnArea");
      warnArea.innerHTML = warnings.map((w) => '<div class="warn">' + w + "</div>").join("");

      drawHistory(state.history || []);
      maybeNotify(state);
    }

    function maybeNotify(state) {
      if (!("Notification" in window)) return;
      if (Notification.permission !== "granted") return;
      if (!state.sourceStatus?.ok || !state.current?.similar) return;

      const key = "mepccl_last_notified_version";
      const last = Number(localStorage.getItem(key) || "0");
      const currentVersion = Number(state.version || 0);
      if (currentVersion > last) {
        new Notification("Radar MEP/CCL", { body: "MEP y CCL están en zona SIMILAR." });
        localStorage.setItem(key, String(currentVersion));
      }
    }

    function drawHistory(history) {
      const rows = document.getElementById("historyRows");
      const mobile = document.getElementById("historyMobile");
      rows.innerHTML = "";
      mobile.innerHTML = "";
      const visible = history.slice(-20).reverse();
      if (!visible.length) {
        rows.innerHTML = '<tr class="loading-row"><td colspan="6">Sin datos todavia. Esperando proxima corrida...</td></tr>';
      }
      for (const r of visible) {
        const tier = r.similar ? "similar" : (Number(r.pct_diff) <= 1.5 ? "neutral" : "far");
        const tr = document.createElement("tr");
        tr.innerHTML = "<td>" + r.label + "</td>"
          + "<td class=\"mepv\">" + fmtMoney(Number(r.mep)) + "</td>"
          + "<td class=\"cclv\">" + fmtMoney(Number(r.ccl)) + "</td>"
          + "<td>" + fmtMoney(Number(r.abs_diff)) + "</td>"
          + "<td>" + fmtPct(Number(r.pct_diff)) + "</td>"
          + "<td><span class=\"state-pill " + tier + "\">" + (tier === "similar" ? "SIMILAR" : tier === "neutral" ? "ZONA GRIS" : "NO SIMILAR") + "</span></td>";
        rows.appendChild(tr);

        const card = document.createElement("div");
        card.className = "hcard";
        card.innerHTML = "<div class=\"hrow\"><span>Hora</span><strong>" + r.label + "</strong></div>"
          + "<div class=\"hrow\"><span>MEP</span><strong>" + fmtMoney(Number(r.mep)) + "</strong></div>"
          + "<div class=\"hrow\"><span>CCL</span><strong>" + fmtMoney(Number(r.ccl)) + "</strong></div>"
          + "<div class=\"hrow\"><span>Dif</span><strong>" + fmtMoney(Number(r.abs_diff)) + " · " + fmtPct(Number(r.pct_diff)) + "</strong></div>"
          + "<div class=\"hrow\"><span>Estado</span><span class=\"state-pill " + tier + "\">" + (tier === "similar" ? "SIMILAR" : tier === "neutral" ? "ZONA GRIS" : "NO SIMILAR") + "</span></div>";
        mobile.appendChild(card);
      }

      const canvas = document.getElementById("trendChart");
      const tooltip = document.getElementById("chartTooltip");
      const ctx = canvas.getContext("2d");
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const cssWidth = Math.max(320, canvas.clientWidth || 780);
      const cssHeight = Math.max(220, canvas.clientHeight || 320);
      canvas.width = Math.floor(cssWidth * dpr);
      canvas.height = Math.floor(cssHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      const maxPoints = chartRange === "all" ? history.length : Number(chartRange || 40);
      const data = history.slice(-maxPoints);
      chartPoints = data;
      chartHitboxes = [];
      if (!data.length) {
        ctx.fillStyle = "#8ea6c5";
        ctx.font = "14px Arial";
        ctx.fillText("Sin historial disponible", 20, 40);
        tooltip.style.opacity = "0";
        return;
      }

      const values = data.flatMap((d) => [Number(d.mep), Number(d.ccl)]).filter((n) => Number.isFinite(n));
      const pctValues = data.map((d) => Number(d.pct_diff)).filter((n) => Number.isFinite(n));
      if (!values.length) return;

      const min = Math.min(...values) * 0.995;
      const max = Math.max(...values) * 1.005;
      const minPct = Math.max(0, Math.min(...pctValues) * 0.9);
      const maxPct = Math.max(1, Math.max(...pctValues) * 1.15);
      const w = cssWidth;
      const h = cssHeight;
      const padL = 56;
      const padR = 56;
      const padY = 34;
      const chartW = w - padL - padR;
      const chartH = h - padY * 2;
      const x = (i) => padL + (i * chartW) / Math.max(data.length - 1, 1);
      const y = (v) => h - padY - ((v - min) * chartH) / Math.max(max - min, 1);
      const yPct = (v) => h - padY - ((v - minPct) * chartH) / Math.max(maxPct - minPct, 1);

      ctx.strokeStyle = "#1b3250";
      ctx.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        const yy = padY + (i * chartH) / 3;
        ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
        const priceTick = (max - ((max - min) * i) / 3).toFixed(0);
        const pctTick = (maxPct - ((maxPct - minPct) * i) / 3).toFixed(2) + "%";
        ctx.fillStyle = "#607c9f";
        ctx.font = "12px Source Sans 3";
        ctx.fillText("$" + priceTick, 8, yy + 4);
        ctx.fillText(pctTick, w - padR + 8, yy + 4);
      }

      const drawLine = (key, color) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        data.forEach((d, i) => {
          const px = x(i), py = y(Number(d[key]));
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          if (key === "mep") chartHitboxes.push({ x: px, yMep: py, yCcl: y(Number(d.ccl)), yPct: yPct(Number(d.pct_diff)), i });
        });
        ctx.stroke();
      };
      drawLine("mep", "#3fb4ff");
      drawLine("ccl", "#ab83ff");

      ctx.strokeStyle = "#f5ce42";
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      data.forEach((d, i) => {
        const px = x(i), py = yPct(Number(d.pct_diff));
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      const xTickIndexes = [0, Math.floor((data.length - 1) / 2), data.length - 1];
      ctx.fillStyle = "#607c9f";
      ctx.font = "12px Source Sans 3";
      xTickIndexes.forEach((idx) => {
        if (idx < 0 || !data[idx]) return;
        const label = String(data[idx].label).slice(11, 16);
        ctx.fillText(label, x(idx) - 16, h - 8);
      });

      // Hover indicator + labels
      if (chartHoverIndex >= 0 && chartHoverIndex < data.length) {
        const row = data[chartHoverIndex];
        const px = x(chartHoverIndex);
        const pyM = y(Number(row.mep));
        const pyC = y(Number(row.ccl));
        const pyP = yPct(Number(row.pct_diff));
        ctx.strokeStyle = "rgba(173,197,230,.35)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px, padY); ctx.lineTo(px, h - padY); ctx.stroke();

        ctx.fillStyle = "#3fb4ff";
        ctx.beginPath(); ctx.arc(px, pyM, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#ab83ff";
        ctx.beginPath(); ctx.arc(px, pyC, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#f5ce42";
        ctx.beginPath(); ctx.arc(px, pyP, 4, 0, Math.PI * 2); ctx.fill();
      }
    }

    function bindChartInteractions() {
      const canvas = document.getElementById("trendChart");
      const tooltip = document.getElementById("chartTooltip");
      const rangeButtons = Array.from(document.querySelectorAll(".range-btn"));

      rangeButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          rangeButtons.forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          chartRange = btn.getAttribute("data-range") || "40";
          chartHoverIndex = -1;
          drawHistory(latestState?.history || []);
        });
      });

      canvas.addEventListener("mousemove", (ev) => {
        if (!chartPoints.length) return;
        const rect = canvas.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        let bestIdx = -1;
        let bestDist = Infinity;
        chartHitboxes.forEach((h) => {
          const d = Math.abs(h.x - x);
          if (d < bestDist) { bestDist = d; bestIdx = h.i; }
        });
        if (bestIdx < 0) return;
        chartHoverIndex = bestIdx;
        drawHistory(latestState?.history || []);

        const row = chartPoints[bestIdx];
        tooltip.innerHTML = row.label + "<br>MEP $" + Number(row.mep).toFixed(2) + "<br>CCL $" + Number(row.ccl).toFixed(2) + "<br>Brecha " + Number(row.pct_diff).toFixed(2) + "%";
        tooltip.style.left = x + "px";
        tooltip.style.top = (ev.clientY - rect.top) + "px";
        tooltip.style.opacity = "1";
      });

      canvas.addEventListener("mouseleave", () => {
        chartHoverIndex = -1;
        tooltip.style.opacity = "0";
        drawHistory(latestState?.history || []);
      });

      window.addEventListener("resize", () => drawHistory(latestState?.history || []));
    }

    document.getElementById("notifyBtn").addEventListener("click", async () => {
      if (!("Notification" in window)) return;
      if (Notification.permission === "granted") return;
      await Notification.requestPermission();
      syncNotifyButton();
      if (latestState?.sourceStatus?.ok && latestState?.current?.similar && Notification.permission === "granted") {
        new Notification("Radar MEP/CCL", { body: "Estado actual: SIMILAR. Revisá la brecha en el panel." });
      }
    });

    syncNotifyButton();
    bindChartInteractions();
    loadData();
    setInterval(loadData, 60000);
  </script>
</body>
</html>`;
}
